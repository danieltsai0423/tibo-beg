// End-to-end smoke test for the worker API.
//
//   cd worker && npx wrangler dev --port 8787 --local     # terminal 1
//   npm run smoke                                          # terminal 2
//
// Needs worker/.dev.vars to contain SESSION_SECRET=dev-secret-not-for-production
// so this file can mint sessions the way the OAuth callback would. The test
// makes no assumptions about starting state, so it is safe to re-run.
//
// It does not cover the Threads OAuth exchange -- that needs a real app and a
// human at the consent screen.
import { createHmac } from 'node:crypto';
// The rolling-window arithmetic is pure, so it is tested directly rather than
// through the API: expiry cannot be observed over HTTP without waiting an hour.
import { bumpWindow, windowScore } from '../worker/src/room.js';

const BASE = 'http://127.0.0.1:8787';
const SECRET = 'dev-secret-not-for-production';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

function mint(uid, un, cc) {
  const body = b64(
    JSON.stringify({ uid, un, av: `https://example.test/${uid}.png`, cc, exp: Math.floor(Date.now() / 1000) + 600 }),
  );
  const mac = createHmac('sha256', SECRET).update(body).digest();
  return `${body}.${b64(mac)}`;
}

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

// 0. rolling window -- no server needed.
//
// These are the cases that decide whether an overnight autoclicker can hold
// first place forever, which is the only reason the window exists.
const H = 1_000_000; // an arbitrary absolute hour

let u = bumpWindow({}, H, 5);
check('window credits the current hour', windowScore(u, H) === 5, String(windowScore(u, H)));

bumpWindow(u, H + 1, 7);
check('window sums across hours', windowScore(u, H + 1) === 12, String(windowScore(u, H + 1)));

// The window is the 24 hours ending now, so at H+23 both buckets are still in.
check('a beg 23 h old still counts', windowScore(u, H + 23) === 12, String(windowScore(u, H + 23)));
check('the oldest hour drops out at 24 h', windowScore(u, H + 24) === 7, String(windowScore(u, H + 24)));
check('everything ages out after 24 h idle', windowScore(u, H + 25) === 0, String(windowScore(u, H + 25)));

// The buckets are a ring, so an hour that lands on a previously used slot must
// clear it rather than add to it. Getting this wrong is invisible for a day and
// then doubles someone's score.
u = bumpWindow({}, H, 100);
bumpWindow(u, H + 24, 3);
check('a reused ring slot is cleared, not added to', windowScore(u, H + 24) === 3, String(windowScore(u, H + 24)));

u = bumpWindow({}, H, 100);
bumpWindow(u, H + 200, 4);
check('a long gap clears the whole ring', windowScore(u, H + 200) === 4, String(windowScore(u, H + 200)));

check('a user who never begged scores 0', windowScore({}, H) === 0);

// Reading must never mutate: the board scores every user on every frame, and a
// read that dirtied a record would keep the write-behind buffer from draining
// -- which is also what keeps the room from hibernating.
u = bumpWindow({}, H, 9);
const before = JSON.stringify(u);
windowScore(u, H + 30);
check('scoring does not mutate the record', JSON.stringify(u) === before, `${before} -> ${JSON.stringify(u)}`);

// 1. anonymous read
let res = await fetch(`${BASE}/api/leaderboard`);
let board = await res.json();
check('GET /api/leaderboard', res.ok && Array.isArray(board.board), JSON.stringify(board));

// 2. auth required
res = await fetch(`${BASE}/api/beg`, { method: 'POST', body: '{}' });
check('POST /api/beg without token -> 401', res.status === 401);

// 3. bad signature rejected
res = await fetch(`${BASE}/api/beg`, {
  method: 'POST',
  headers: { authorization: `Bearer ${mint('x', 'x', 'TW').slice(0, -3)}aaa` },
  body: JSON.stringify({ n: 1 }),
});
check('POST /api/beg with tampered token -> 401', res.status === 401);

// Fresh identities each run so the test does not depend on leftover local state.
const run = Math.random().toString(36).slice(2, 8);
const base0 = board.total;

// 4. /api/me
const alice = mint(`a-${run}`, 'alice', 'TW');
res = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${alice}` } });
const me = await res.json();
check('GET /api/me', res.ok && me.username === 'alice', JSON.stringify(me));

// 5. websocket first, so it sees the begs that follow
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/live`);
const frames = [];
ws.addEventListener('message', (e) => frames.push(JSON.parse(e.data)));
await new Promise((r, j) => {
  ws.addEventListener('open', r);
  ws.addEventListener('error', j);
  setTimeout(() => j(new Error('ws open timeout')), 5000);
});
check('WebSocket /api/live opens', true);

// 6. begging
const beg = async (token, n) => {
  const r = await fetch(`${BASE}/api/beg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ n, request_id: `req-${Math.random()}` }),
  });
  return r.json();
};

let out = await beg(alice, 5);
check('beg credits 5', out.count === 5 && out.total === base0 + 5 && out.rank !== null, JSON.stringify(out));
// A fresh user's window score and lifetime tally are the same number; they only
// diverge once begs start ageing out, which no test can wait for.
check('beg reports both window and lifetime', out.lifetime === 5 && out.count === out.lifetime, JSON.stringify(out));
const aliceRank = out.rank;

const bob = mint(`b-${run}`, 'bob', 'JP');
out = await beg(bob, 9);
const bobRank = out.rank;
check('bob outranks alice', out.count === 9 && out.total === base0 + 14 && bobRank < aliceRank + 1, JSON.stringify(out));

// ...and alice must be told she slipped, which is what drives the client toast.
const aliceAfter = await beg(alice, 1);
check(
  'overtaken user sees a worse rank',
  aliceAfter.rank > bobRank,
  `alice ${aliceRank} -> ${aliceAfter.rank}, bob ${bobRank}`,
);

// 7. per-request cap: ask for 500, server must clamp to 10
out = await beg(alice, 500);
check('n is clamped to 10 per request', out.credited <= 10, JSON.stringify(out));

// 8. token bucket: hammer past the burst allowance
let throttled = 0;
for (let i = 0; i < 12; i++) {
  const r = await beg(bob, 10);
  throttled += r.throttled;
}
check('token bucket throttles a click storm', throttled > 0, `throttled=${throttled}`);

// 9. broadcast arrived
await new Promise((r) => setTimeout(r, 600));
const ticks = frames.filter((f) => f.type === 'tick');
check('WebSocket broadcast a tick', ticks.length > 0, `frames=${frames.length}`);
check(
  'tick carries board + events',
  ticks.some((t) => t.board?.length > 0 && t.events?.length > 0),
  JSON.stringify(ticks.at(-1)?.board?.slice(0, 2) || []),
);

// 9b. Display names: optional, unique, and never clobbered by a later beg.
const nameReq = async (token, name) => {
  const r = await fetch(`${BASE}/api/name`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// Renaming is rate limited per user, so cases that reach the uniqueness scan
// each get their own identity. Tests that share one would only be measuring
// the cooldown.
const namer = (label) => mint(`n-${label}-${run}`, `user-${label}`, 'TW');

const pick = `Rate Limited ${run}`;
let r = await nameReq(alice, pick);
check('a display name can be set', r.status === 200 && r.body.display_name === pick, JSON.stringify(r.body));

r = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${alice}` } }).then((x) => x.json());
check('/api/me reports the chosen name', r.username === pick && r.provider_name === 'alice', JSON.stringify(r));

await beg(alice, 1);
r = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${alice}` } }).then((x) => x.json());
check('begging does not clobber the chosen name', r.username === pick, JSON.stringify(r));

r = await nameReq(namer('dup'), pick.toLowerCase().replace(/\s/g, ''));
check('uniqueness ignores case and spacing', r.status === 409 && r.body.error === 'name_taken', JSON.stringify(r.body));

r = await nameReq(namer('res'), 'thsottiaux');
check('impersonating Tibo is refused', r.status === 409 && r.body.error === 'name_reserved', JSON.stringify(r.body));

// Cheap refusals: rejected before anything expensive runs, so they can share
// one identity and must not consume its cooldown.
const cheap = namer('cheap');
r = await nameReq(cheap, 'x');
check('too-short name is refused', r.status === 400 && r.body.error === 'name_invalid', JSON.stringify(r.body));

r = await nameReq(cheap, 'a'.repeat(21));
check('too-long name is refused', r.status === 400 && r.body.error === 'name_invalid', JSON.stringify(r.body));

// A display name is pasted into a post sent from the operator's own X account,
// so it must never be able to look like a handle, a tag or a link.
for (const hostile of ['@elonmusk', '#FreeCrypto', '$TSLA', 'evil.example/win', 'http://evil.example', 'beg-board.com']) {
  const res = await nameReq(cheap, hostile);
  check(
    `hostile name refused: ${hostile}`,
    res.status === 400 && res.body.error === 'name_lookalike',
    JSON.stringify(res.body),
  );
}

r = await nameReq(cheap, `Still Fine ${run}`);
check('cheap refusals do not burn the cooldown', r.status === 200, JSON.stringify(r.body));

// A zero-width space is the classic way to smuggle a look-alike name past a
// uniqueness check. Stripping happens first, so it collides and is refused --
// the two defences only work because they run in that order.
r = await nameReq(namer('zw1'), `Rate​ Limited ${run}`);
check(
  'invisible characters cannot smuggle a duplicate name through',
  r.status === 409 && r.body.error === 'name_taken',
  JSON.stringify(r.body),
);

r = await nameReq(namer('zw2'), `Yak​Shaver ${run}`);
check(
  'invisible characters are stripped from an accepted name',
  r.status === 200 && !/​/.test(r.body.display_name || '') && r.body.display_name === `YakShaver ${run}`,
  JSON.stringify(r.body),
);

// Renaming twice in a row reaches the scan twice, so the second is throttled.
const cool = namer('cool');
await nameReq(cool, `Cooldown A ${run}`);
r = await nameReq(cool, `Cooldown B ${run}`);
check('back-to-back renames are throttled', r.status === 429 && r.body.error === 'name_too_often', JSON.stringify(r.body));

await new Promise((resolve) => setTimeout(resolve, 2200));
r = await nameReq(cool, `Cooldown B ${run}`);
check('renaming works again after the cooldown', r.status === 200, JSON.stringify(r.body));

const reset = namer('reset');
await nameReq(reset, `Temporary ${run}`);
r = await nameReq(reset, '');
check('an empty name restores the provider name', r.status === 200 && r.body.display_name === null, JSON.stringify(r.body));

r = await fetch(`${BASE}/api/name`, { method: 'POST', body: JSON.stringify({ name: 'nope' }) });
check('renaming requires a session', r.status === 401);

// 9c. The first beggar is recorded once and survives later begs by others.
r = await fetch(`${BASE}/api/leaderboard`).then((x) => x.json());
const first = r.first_beggar;
check('a first beggar is on record', !!first?.uid && !!first?.at, JSON.stringify(first));

await beg(bob, 3);
const after = await fetch(`${BASE}/api/leaderboard`).then((x) => x.json());
check(
  'later begs do not overwrite who was first',
  after.first_beggar?.uid === first.uid && after.first_beggar?.at === first.at,
  JSON.stringify(after.first_beggar),
);

// 9d. /api/me must carry the personal tally, or the button's counter shows 0
// again after every reload for anyone outside the visible slice of the board.
const mine = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${alice}` } }).then((x) => x.json());
const aliceBoard = await fetch(`${BASE}/api/leaderboard?limit=100`)
  .then((x) => x.json())
  .then((d) => d.board.find((e) => e.uid === `a-${run}`));
check(
  '/api/me carries the personal count and rank',
  mine.count === aliceBoard.count && mine.rank === aliceBoard.rank,
  `me=${mine.count}/${mine.rank} board=${aliceBoard.count}/${aliceBoard.rank}`,
);
check(
  'board rows and /api/me both carry the lifetime tally',
  typeof aliceBoard.lifetime === 'number' && mine.lifetime === aliceBoard.lifetime,
  `me=${mine.lifetime} board=${aliceBoard.lifetime}`,
);

// 9e. The page shows a cycle total and a 24-hour ranking side by side, so the
// board has to ship the number its own rows add up to. Without it the two
// figures on screen look like they disagree -- with a single beggar, obviously
// so.
const full = await fetch(`${BASE}/api/leaderboard?limit=100`).then((x) => x.json());
const rowSum = full.board.reduce((sum, e) => sum + e.count, 0);
check(
  'window_total matches the sum of the rows',
  full.window_total === rowSum,
  `window_total=${full.window_total} rows=${rowSum}`,
);
check(
  'the cycle total is the sum of every lifetime tally',
  full.total === full.board.reduce((sum, e) => sum + e.lifetime, 0) && full.total >= full.window_total,
  `total=${full.total} window=${full.window_total}`,
);

// 10. final board
res = await fetch(`${BASE}/api/leaderboard?limit=5`);
board = await res.json();
check(
  'leaderboard is sorted and names users',
  board.board[0].count >= board.board[1].count && board.beggars >= 2,
  JSON.stringify(board.board),
);

ws.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall green');
process.exit(fails.length ? 1 : 0);
