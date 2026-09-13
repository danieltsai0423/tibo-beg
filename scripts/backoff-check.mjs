// Does the client actually stop hammering when the server refuses begs?
//
//   cd worker && npx wrangler dev --port 8787 --local   # terminal 1
//   npm run serve                                       # terminal 2
//   npm run backoff                                     # terminal 3
//
// This is measured in a real browser rather than asserted from the source
// because the thing being tested is a rate -- requests per second -- and the
// batching window is time-driven. Reading the code tells you the interval
// doubles; only running it tells you how many requests a click storm actually
// costs, which is the number that decides whether the free plan's daily quota
// survives someone leaving a phone auto-tapping.
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';

const PAGE = 'http://localhost:4173/index.html';
const API = 'http://127.0.0.1:8787';
const SECRET = 'dev-secret-not-for-production';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

const TAPS_PER_SEC = 30;
// The storm runs long enough to reach steady state, and only the tail is
// measured. The opening seconds are not representative: the token bucket holds
// 40, so the first ~1.3 s is credited in full and the backoff has not engaged
// yet. An auto-tapper left running overnight spends all of its time in the
// tail, so the tail is the number that decides whether the daily quota holds.
const STORM_MS = 16_000;
const MEASURE_LAST_MS = 8000;
// Unthrottled the client sends 10 requests a second, so the same 8 s window
// costs ~80. At the backoff ceiling of one request per 3.2 s, each carrying up
// to 40 begs, it should cost 3. The budget is set to catch a regression back to
// the smaller batch or the shorter ceiling, not to pin the exact number.
const BUDGET = 8;

function mint(uid, un, cc) {
  const body = b64(
    JSON.stringify({ uid, un, av: `https://example.test/${uid}.png`, cc, exp: Math.floor(Date.now() / 1000) + 600 }),
  );
  return `${body}.${b64(createHmac('sha256', SECRET).update(body).digest())}`;
}

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const run = Math.random().toString(36).slice(2, 8);
const token = mint(`storm-${run}`, 'stormy', 'TW');

const browser = await chromium.launch();
const page = await browser.newPage();

// The token has to be in place before the page boots, but the API base cannot
// be: web/config.js is a plain script that assigns window.TIBO_BEG_CONFIG
// outright, so anything set earlier is overwritten and the page quietly falls
// back to demo mode -- where no request is ever made and every assertion below
// would pass for the wrong reason. Serving a replacement config.js is the only
// point that wins.
await page.addInitScript((tok) => {
  try {
    localStorage.setItem('tibo-beg.token', tok);
  } catch {
    /* the test cannot proceed without it; the assertions will say so */
  }
}, token);

await page.route('**/config.js', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `window.TIBO_BEG_CONFIG = { API_BASE: ${JSON.stringify(API)} };`,
  }),
);

let begRequests = 0;
page.on('request', (req) => {
  if (req.method() === 'POST' && req.url().endsWith('/api/beg')) begRequests += 1;
});

await page.goto(PAGE, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-role="beg"]');
check('signed in and the beg button is live', await page.isVisible('[data-role="beg"]'));

// A short burst first: the bucket is full, nothing is refused, so the client
// should still be flushing eagerly. This is the regression guard -- a backoff
// that also slows down ordinary clicking would be a worse bug than the one it
// fixes.
begRequests = 0;
await page.evaluate(async () => {
  const btn = document.querySelector('[data-role="beg"]');
  for (let i = 0; i < 10; i += 1) btn.click();
  await new Promise((r) => setTimeout(r, 400));
});
check('a short burst is still sent at once', begRequests >= 1, `requests=${begRequests}`);

// Now the storm. Tap steadily past what the server will credit, and start
// counting only once the cadence has had time to settle.
const storm = page.evaluate(
  async ([ms, rate]) => {
    const btn = document.querySelector('[data-role="beg"]');
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      btn.click();
      await new Promise((r) => setTimeout(r, 1000 / rate));
    }
  },
  [STORM_MS, TAPS_PER_SEC],
);
await page.waitForTimeout(STORM_MS - MEASURE_LAST_MS);
begRequests = 0;
await storm;

const perSec = (begRequests / (MEASURE_LAST_MS / 1000)).toFixed(2);
check(
  `sustained tapping costs under ${BUDGET} requests per ${MEASURE_LAST_MS / 1000}s`,
  begRequests < BUDGET,
  `requests=${begRequests} (${perSec}/s, vs 10/s unthrottled → ${Math.round(begRequests * 10800)}/day)`,
);

// The rate that used to slip through everything: steady, but under the server's
// 8-a-second ceiling, so nothing is ever refused and a refusal-driven backoff
// never engages. Each click lands more than 100 ms after the last, so without a
// storm window every one of them buys its own request. This was measured on the
// live site at 5 clicks/s costing 5 requests/s.
await page.waitForTimeout(1500); // let the previous storm's combo lapse
begRequests = 0;
const steady = page.evaluate(async () => {
  const btn = document.querySelector('[data-role="beg"]');
  const stop = Date.now() + 12_000;
  while (Date.now() < stop) {
    btn.click();
    await new Promise((r) => setTimeout(r, 200)); // 5 clicks a second
  }
});
await page.waitForTimeout(4000);
begRequests = 0;
await steady;
check(
  'steady sub-throttle tapping batches instead of one request per click',
  begRequests <= 12,
  `requests=${begRequests} in 8s (was ~40 before the storm window)`,
);

// Backing off must not mean giving up: the begs the server was willing to
// credit still have to arrive.
const mine = await fetch(`${API}/api/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
check('begs were still credited while backed off', mine.count > 20, `count=${mine.count}`);

// And the cadence has to come back on its own, or the next click after a storm
// feels broken.
await page.waitForTimeout(1500); // longer than COMBO_DECAY_MS
begRequests = 0;
await page.evaluate(async () => {
  const btn = document.querySelector('[data-role="beg"]');
  for (let i = 0; i < 10; i += 1) btn.click();
  await new Promise((r) => setTimeout(r, 400));
});
check('the cadence recovers once the storm is over', begRequests >= 1, `requests=${begRequests}`);

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall green');
process.exit(fails.length ? 1 : 0);
