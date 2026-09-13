// BegRoom - the single Durable Object that owns the count.
//
// Everything lives in one instance on purpose: a global leaderboard has to be
// globally consistent, and a DO is the cheapest way to get a single-writer
// counter plus fan-out WebSockets without standing up a database.

const BROADCAST_MS = 200; // coalesce bursts into one frame
const PERSIST_MS = 10_000; // write-behind to storage
const BOARD_SIZE = 15; // rows pushed over the wire
const MAX_PER_REQUEST = 10; // client batches at 10, so anything above is a forgery
const BUCKET_CAPACITY = 40; // burst allowance per user
const BUCKET_REFILL = 8; // sustained begs/sec per user
const RATE_WINDOW_MS = 5000; // window for the global begs/sec readout

export class BegRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {Map<string, {un: string, av: string, cc: string|null, n: number}>} */
    this.users = new Map();
    this.total = 0;

    this.sockets = new Set();
    this.buckets = new Map(); // uid -> {tokens, last}
    this.dirty = new Set();
    this.pending = []; // burst events awaiting the next frame
    this.recent = []; // timestamps for begs/sec
    this.broadcastTimer = null;

    this.sorted = [];
    this.sortDirty = false;

    this.state.blockConcurrencyWhile(async () => {
      const meta = await this.state.storage.get('meta');
      this.total = meta?.total ?? 0;
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
    this.sorted = [...this.users.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
    this.sortDirty = false;
  }

  // Sorting is deferred to whoever actually needs an ordered list. Both callers
  // (the 200ms broadcast and /board) are rate-limited, so a click storm never
  // triggers more than a handful of sorts per second.
  ranking() {
    if (this.sortDirty) this.resort();
    return this.sorted;
  }

  // One user's rank does not need the whole list ordered -- counting the users
  // ahead of them is O(n) with no allocation, and unlike a cached sort it is
  // never stale, which matters because the client drives its overtake animation
  // off this number.
  rankOf(uid) {
    const mine = this.users.get(uid);
    if (!mine) return null;
    let ahead = 0;
    for (const [id, user] of this.users) {
      if (user.n > mine.n || (user.n === mine.n && id.localeCompare(uid) < 0)) ahead += 1;
    }
    return ahead + 1;
  }

  board(limit = BOARD_SIZE) {
    return this.ranking()
      .slice(0, limit)
      .map(([uid, u], i) => ({ rank: i + 1, uid, username: u.un, avatar: u.av, country: u.cc, count: u.n }));
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
    if (this.sockets.size === 0) {
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
    for (const ws of [...this.sockets]) {
      try {
        ws.send(frame);
      } catch {
        this.sockets.delete(ws);
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
    batch.meta = { total: this.total, updated_at: new Date().toISOString() };
    // storage.put accepts at most 128 keys per call.
    const entries = Object.entries(batch);
    for (let i = 0; i < entries.length; i += 128) {
      await this.state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    }
  }

  async alarm() {
    await this.persist();
    if (this.dirty.size > 0 || this.sockets.size > 0) await this.state.storage.setAlarm(Date.now() + PERSIST_MS);
  }

  async armAlarm() {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + PERSIST_MS);
    }
  }

  // -------------------------------------------------------------- routes

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.add(server);
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));
      server.send(
        JSON.stringify({ type: 'hello', total: this.total, bps: this.bps(), board: this.board(), events: [] }),
      );
      await this.armAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/board') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || BOARD_SIZE));
      return Response.json({
        total: this.total,
        bps: this.bps(),
        beggars: this.users.size,
        board: this.board(limit),
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
      user.un = body.un || user.un;
      user.av = body.av || user.av;
      user.cc = body.cc ?? user.cc;

      if (credited > 0) {
        user.n += credited;
        this.total += credited;
        this.recent.push([Date.now(), credited]);
        this.pending.push({
          uid,
          username: user.un,
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
        count: user.n,
        rank: this.rankOf(uid),
        credited,
        throttled: want - credited,
      });
    }

    return Response.json({ error: 'not_found' }, { status: 404 });
  }
}
