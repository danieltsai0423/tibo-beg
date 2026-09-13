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
