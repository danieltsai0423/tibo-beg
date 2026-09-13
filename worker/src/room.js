// BegRoom - the single Durable Object that owns the count.
//
// Everything lives in one instance on purpose: a global leaderboard has to be
// globally consistent, and a DO is the cheapest way to get a single-writer
// counter plus fan-out WebSockets without standing up a database.

const BROADCAST_MS = 200; // coalesce bursts into one frame
// Write-behind interval. It is short because the room hibernates: an evicted
// object loses whatever is still only in memory, and eviction follows a short
// stretch of inactivity -- which is exactly when the last begs are sitting
// unwritten. Keeping the window well inside that stretch bounds the loss. The
// interval only costs anything while the room is busy, and a busy room is
// never the one at risk of eviction.
const PERSIST_MS = 3_000;
const BOARD_SIZE = 15; // rows pushed over the wire
const MAX_PER_REQUEST = 10; // client batches at 10, so anything above is a forgery
const BUCKET_CAPACITY = 40; // burst allowance per user
const BUCKET_REFILL = 8; // sustained begs/sec per user
const RATE_WINDOW_MS = 5000; // window for the global begs/sec readout
// The board ranks on the last 24 hours, not on lifetime begs. A leaderboard
// that only ever accumulates is won permanently by whoever left an autoclicker
// running longest, and once it is won nobody else has a reason to click. A
// rolling window makes the rank something you have to keep, and gives the daily
// post a different name to @ each day. Lifetime totals are still kept and still
// shown -- they just do not decide the order.
const WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;
const NAME_MIN = 2;
const NAME_MAX = 20;
const RENAME_COOLDOWN_MS = 2000; // between renames that reach the uniqueness scan

// Impersonating the man we are all begging is the one abuse worth hard-coding
// against. Everything else is handled by uniqueness.
const RESERVED = new Set(['thsottiaux', 'tibosottiaux', 'tibo', 'begboard', 'admin', 'moderator', 'mod', 'system']);

// Invisible and direction-flipping characters: they let a name render as
// something other than what it is, so they never survive normalisation.
const INVISIBLE = /[\u0000-\u001F\u007F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

// A display name is shown on a public board and pasted verbatim into a post
// sent from the operator's own X account. Anything that X would turn into a
// mention, a hashtag, a cashtag or a link is therefore refused outright: those
// characters let one user speak through someone else's account.
const LOOKS_LIKE_HANDLE = /[@#$]/;
// Any unspaced "word.word" is treated as a domain. A TLD allow-list is the
// wrong shape here: it has to be kept current, and the cost of being wrong is a
// link posted from someone else's account. A false positive costs a user one
// retry on a 20-character nickname.
const LOOKS_LIKE_LINK = /(?:https?:\/\/|[\p{L}\p{N}_-]+\.[\p{L}]{2,})/iu;

/** Returns a cleaned name, or null when it cannot be made acceptable. */
function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Count by code points so emoji and CJK are measured the way a reader sees
  // them, not by UTF-16 units.
  const length = [...cleaned].length;
  if (length < NAME_MIN || length > NAME_MAX) return null;
  if (LOOKS_LIKE_HANDLE.test(cleaned) || LOOKS_LIKE_LINK.test(cleaned)) return null;
  return cleaned;
}

/** Case- and spacing-insensitive key, so "Beg Board" cannot sit next to "begboard". */
function nameKey(name) {
  return name.toLowerCase().replace(/[\s_.-]/g, '');
}

/** The name a user chose, falling back to the one their provider gave. */
function displayName(user) {
  return user.dn || user.un;
}

// ------------------------------------------------------------ rolling window
//
// Each user carries 24 hourly buckets (`w`) plus the absolute hour of the most
// recent one (`wh`). Storing counts per hour rather than one timestamp per beg
// keeps a user's record a fixed 24 numbers no matter how hard they click, which
// matters precisely because the people this exists to handle click a lot.

export function hourIndex(now = Date.now()) {
  return Math.floor(now / HOUR_MS);
}

/**
 * Begs still inside the window, without mutating the record. Reads happen on
 * every rank and every board row, so they must not dirty a user or the
 * write-behind buffer would never drain.
 */
export function windowScore(user, hour) {
  const w = user?.w;
  if (!Array.isArray(w)) return 0;
  const gap = hour - (user.wh ?? hour);
  if (gap >= WINDOW_HOURS) return 0; // everything has aged out
  let sum = 0;
  // Buckets hold hours `wh` down to `wh - 23`; once `gap` hours have passed,
  // the oldest `gap` of them are outside the window and are simply not read.
  for (let i = 0; i < WINDOW_HOURS - Math.max(0, gap); i += 1) {
    sum += w[(((user.wh - i) % WINDOW_HOURS) + WINDOW_HOURS) % WINDOW_HOURS] || 0;
  }
  return sum;
}

/** Credits `n` begs to the current hour, clearing whatever has aged out. */
export function bumpWindow(user, hour, n) {
  if (!Array.isArray(user.w)) {
    user.w = new Array(WINDOW_HOURS).fill(0);
    user.wh = hour;
  }
  const gap = hour - user.wh;
  if (gap > 0) {
    if (gap >= WINDOW_HOURS) user.w.fill(0);
    else for (let i = 1; i <= gap; i += 1) user.w[(user.wh + i) % WINDOW_HOURS] = 0;
    user.wh = hour;
  }
  user.w[((hour % WINDOW_HOURS) + WINDOW_HOURS) % WINDOW_HOURS] += n;
  return user;
}

export class BegRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {Map<string, {un: string, av: string, cc: string|null, n: number}>} */
    this.users = new Map();
    this.total = 0;

    this.buckets = new Map(); // uid -> {tokens, last}
    this.dirty = new Set();
    this.pending = []; // burst events awaiting the next frame
    this.recent = []; // timestamps for begs/sec
    this.broadcastTimer = null;

    this.sorted = [];
    this.sortDirty = false;
    // A cached order also goes stale when the hour turns, because that is when
    // begs fall out of the window -- not only when someone writes.
    this.sortHour = -1;

    // Who begged first, ever. Written once and never overwritten -- the moment
    // is unrecoverable if it is not captured as it happens.
    this.first = null;

    this.state.blockConcurrencyWhile(async () => {
      const meta = await this.state.storage.get('meta');
      this.total = meta?.total ?? 0;
      this.first = meta?.first ?? null;
      let cursor;
      // storage.list caps at 1000 entries per call.
      for (;;) {
        const page = await this.state.storage.list({ prefix: 'u:', limit: 1000, startAfter: cursor });
        if (page.size === 0) break;
        for (const [key, value] of page) {
          cursor = key;
          this.users.set(key.slice(2), value);
        }
        if (page.size < 1000) break;
      }
      this.resort();
    });
  }

  // -------------------------------------------------------------- accounting

  resort() {
    const hour = hourIndex();
    this.sorted = [...this.users.entries()]
      .map(([uid, user]) => [uid, user, windowScore(user, hour)])
      .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));
    this.sortDirty = false;
    this.sortHour = hour;
  }

  // Sorting is deferred to whoever actually needs an ordered list. Both callers
  // (the 200ms broadcast and /board) are rate-limited, so a click storm never
  // triggers more than a handful of sorts per second.
  ranking() {
    if (this.sortDirty || this.sortHour !== hourIndex()) this.resort();
    return this.sorted;
  }

  // One user's rank does not need the whole list ordered -- counting the users
  // ahead of them is O(n) with no allocation, and unlike a cached sort it is
  // never stale, which matters because the client drives its overtake animation
  // off this number.
  rankOf(uid) {
    const mine = this.users.get(uid);
    if (!mine) return null;
    const hour = hourIndex();
    const score = windowScore(mine, hour);
    let ahead = 0;
    for (const [id, user] of this.users) {
      const other = windowScore(user, hour);
      if (other > score || (other === score && id.localeCompare(uid) < 0)) ahead += 1;
    }
    return ahead + 1;
  }

  board(limit = BOARD_SIZE) {
    return this.ranking()
      .slice(0, limit)
      .map(([uid, u, score], i) => ({
        rank: i + 1,
        uid,
        username: displayName(u),
        avatar: u.av,
        country: u.cc,
        // `count` is what the row is ordered by, so it has to be the window
        // score -- a board sorted by a number it does not show reads as broken.
        count: score,
        lifetime: u.n,
      }));
  }

  firstBeggar() {
    if (!this.first) return null;
    const user = this.users.get(this.first.uid);
    return {
      uid: this.first.uid,
      name: user ? displayName(user) : null,
      at: new Date(this.first.at).toISOString(),
      count: user?.n ?? 0,
    };
  }

  bps() {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (this.recent.length && this.recent[0][0] < cutoff) this.recent.shift();
    const sum = this.recent.reduce((acc, [, n]) => acc + n, 0);
    return Math.round((sum / (RATE_WINDOW_MS / 1000)) * 10) / 10;
  }

  // Token bucket. Without it the leaderboard measures autoclicker quality,
  // not devotion.
  spend(uid, want) {
    const now = Date.now();
    const bucket = this.buckets.get(uid) || { tokens: BUCKET_CAPACITY, last: now };
    bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + ((now - bucket.last) / 1000) * BUCKET_REFILL);
    bucket.last = now;
    const granted = Math.floor(Math.min(want, bucket.tokens));
    bucket.tokens -= granted;
    this.buckets.set(uid, bucket);
    return granted;
  }

  // -------------------------------------------------------------- fan-out

  scheduleBroadcast() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.flush();
    }, BROADCAST_MS);
  }

  flush() {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      this.pending = [];
      return;
    }
    const frame = JSON.stringify({
      type: 'tick',
      total: this.total,
      bps: this.bps(),
      board: this.board(),
      events: this.pending.slice(-24),
    });
    this.pending = [];
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // A socket that throws on send is already gone; the runtime will hand
        // it to webSocketClose. There is no local set to prune any more.
      }
    }
  }

  async persist() {
    if (this.dirty.size === 0) return;
    const batch = {};
    for (const uid of this.dirty) {
      const user = this.users.get(uid);
      if (user) batch[`u:${uid}`] = user;
    }
    this.dirty.clear();
    batch.meta = { total: this.total, first: this.first, updated_at: new Date().toISOString() };
    // storage.put accepts at most 128 keys per call.
    const entries = Object.entries(batch);
    for (let i = 0; i < entries.length; i += 128) {
      await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }
  }

  // A bucket that has refilled to capacity carries no information, so dropping
  // it is free. Without this the map keeps one entry per user seen, forever.
  pruneBuckets() {
    const now = Date.now();
    for (const [uid, bucket] of this.buckets) {
      const refilled = bucket.tokens + ((now - bucket.last) / 1000) * BUCKET_REFILL;
      if (refilled >= BUCKET_CAPACITY) this.buckets.delete(uid);
    }
  }

  // The alarm chain stops as soon as everything is written. It deliberately
  // does NOT keep itself alive just because sockets are open: an alarm every
  // few seconds would wake the room forever, which is the whole thing
  // hibernation exists to avoid. Idle spectators cost nothing; only writes
  // schedule work.
  async alarm() {
    this.pruneBuckets();
    await this.persist();
    if (this.dirty.size > 0) await this.state.storage.setAlarm(Date.now() + PERSIST_MS);
  }

  async armAlarm() {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + PERSIST_MS);
    }
  }

  // ---------------------------------------------------- hibernating sockets
  //
  // Clients never send anything -- begs go over HTTP so they can be
  // authenticated and answered individually -- but a handler has to exist or
  // an unexpected frame tears the connection down.

  webSocketMessage(ws) {
    try {
      ws.send(JSON.stringify({ type: 'pong' }));
    } catch {
      // Nothing to clean up: the runtime owns the socket set.
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed. `wasClean` is not acted on; there is no per-socket
      // state to reconcile.
      void wasClean;
    }
  }

  webSocketError() {
    // The runtime drops the socket for us.
  }

  // -------------------------------------------------------------- routes

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation, not `server.accept()`. With a plain accept, one open
      // socket pins the object in memory and bills duration for as long as it
      // stays open -- so a single browser tab left running overnight keeps the
      // whole room resident. Handing the socket to the runtime lets the room be
      // evicted between begs while the connection survives.
      this.state.acceptWebSocket(server);
      server.send(
        JSON.stringify({
          type: 'hello',
          total: this.total,
          bps: this.bps(),
          board: this.board(),
          first_beggar: this.firstBeggar(),
          events: [],
        }),
      );
      // No alarm here on purpose. Connecting is not a write, and arming the
      // chain for a spectator would wake the room for nothing.
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/profile') {
      const uid = url.searchParams.get('uid') || '';
      const user = this.users.get(uid);
      return Response.json({
        display_name: user?.dn || null,
        provider_name: user?.un || null,
        // Same number the board shows, or the button's counter and the row
        // disagree about the user's own score.
        count: user ? windowScore(user, hourIndex()) : 0,
        lifetime: user?.n ?? 0,
        rank: user ? this.rankOf(uid) : null,
      });
    }

    // Renaming lives in the Durable Object rather than the router because the
    // uniqueness check has to see every other name at once -- which it does,
    // for free, since this object is the single writer and holds them all.
    if (url.pathname === '/name' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      const uid = body?.uid;
      if (!uid) return Response.json({ error: 'bad_request' }, { status: 400 });

      const user = this.users.get(uid) || { un: body.un, av: body.av, cc: body.cc, n: 0 };

      // An empty name is how a user goes back to their provider name.
      if (body.name === null || body.name === '') {
        delete user.dn;
        this.users.set(uid, user);
        this.dirty.add(uid);
        this.sortDirty = true;
        this.scheduleBroadcast();
        await this.armAlarm();
        return Response.json({ display_name: null, name: displayName(user) });
      }

      // Cheap checks first, and they cost the caller nothing: a typo or a
      // hostile string is rejected before anything expensive runs, so it
      // neither burns the cooldown nor amplifies into work.
      const raw = String(body.name).normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
      if (LOOKS_LIKE_HANDLE.test(raw) || LOOKS_LIKE_LINK.test(raw)) {
        return Response.json({ error: 'name_lookalike' }, { status: 400 });
      }
      const name = normalizeName(body.name);
      if (!name) return Response.json({ error: 'name_invalid', min: NAME_MIN, max: NAME_MAX }, { status: 400 });

      const key = nameKey(name);
      if (RESERVED.has(key)) return Response.json({ error: 'name_reserved' }, { status: 409 });

      // Past this point the request scans every user, so it is rate limited.
      // The clock lives on the user record, which is already persisted and
      // already bounded -- no extra map to grow or prune. It is deliberately
      // separate from the beg budget: renaming should not cost you begs.
      const now = Date.now();
      if (now - (user.rn ?? 0) < RENAME_COOLDOWN_MS) {
        return Response.json({ error: 'name_too_often' }, { status: 429 });
      }
      user.rn = now;
      for (const [otherId, other] of this.users) {
        if (otherId !== uid && nameKey(displayName(other) || '') === key) {
          return Response.json({ error: 'name_taken' }, { status: 409 });
        }
      }

      user.dn = name;
      user.av = body.av || user.av;
      this.users.set(uid, user);
      this.dirty.add(uid);
      this.sortDirty = true;
      this.scheduleBroadcast();
      await this.armAlarm();
      return Response.json({ display_name: name, name });
    }

    if (url.pathname === '/board') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || BOARD_SIZE));
      return Response.json({
        total: this.total,
        bps: this.bps(),
        beggars: this.users.size,
        board: this.board(limit),
        first_beggar: this.firstBeggar(),
        generated_at: new Date().toISOString(),
      });
    }

    if (url.pathname === '/beg' && req.method === 'POST') {
      const body = await req.json().catch(() => null);
      const uid = body?.uid;
      if (!uid) return Response.json({ error: 'bad_request' }, { status: 400 });

      const want = Math.max(1, Math.min(MAX_PER_REQUEST, Math.floor(Number(body.n) || 1)));
      const credited = this.spend(uid, want);

      const user = this.users.get(uid) || { un: body.un, av: body.av, cc: body.cc, n: 0 };
      // `un` tracks the provider; `dn` is the user's own choice and is never
      // overwritten from the session token.
      user.un = body.un || user.un;
      user.av = body.av || user.av;
      user.cc = body.cc ?? user.cc;

      if (credited > 0) {
        // Only the id and the timestamp are frozen; the name is resolved at read
        // time so a later rename is reflected rather than stale.
        if (!this.first) this.first = { uid, at: Date.now() };
        user.n += credited; // lifetime, never decays
        bumpWindow(user, hourIndex(), credited); // what the rank is made of
        this.total += credited;
        this.recent.push([Date.now(), credited]);
        this.pending.push({
          uid,
          username: displayName(user),
          avatar: user.av,
          country: user.cc,
          n: credited,
          request_id: body.request_id ?? null,
        });
        this.dirty.add(uid);
        this.sortDirty = true;
        this.scheduleBroadcast();
      }
      this.users.set(uid, user);
      await this.armAlarm();

      return Response.json({
        total: this.total,
        count: windowScore(user, hourIndex()),
        lifetime: user.n,
        rank: this.rankOf(uid),
        credited,
        throttled: want - credited,
      });
    }

    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}
