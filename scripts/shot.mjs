// Render board.html and save it as the image the daily post attaches.
//
//   node scripts/shot.mjs --url https://user.github.io/tibo-beg/board.html \
//                         --api https://tibo-beg-api.workers.dev \
//                         --out out/board.png
//
// board.html sets data-ready="1" once it has painted real numbers, so we wait
// on that instead of guessing with a sleep.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pageUrl = arg('url', process.env.BOARD_URL);
const api = arg('api', process.env.API_BASE || '');
const theme = arg('theme', process.env.BOARD_THEME || 'light');
const out = resolve(arg('out', 'out/board.png'));

if (!pageUrl) {
  console.error('shot: --url (or BOARD_URL) is required');
  process.exit(1);
}

const target = new URL(pageUrl);
if (api) target.searchParams.set('api', api);
target.searchParams.set('limit', arg('limit', '10'));
target.searchParams.set('theme', theme);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 675 },
    deviceScaleFactor: 2, // 2400x1350 -- comfortably above X's downscaling floor
  });
  await page.goto(target.toString(), { waitUntil: 'networkidle', timeout: 45_000 });
  // Either state resolves the wait, so a backend failure surfaces as a clear
  // error here instead of a 20s timeout with no explanation.
  await page.waitForSelector('body[data-ready]', { timeout: 20_000 });
  const ready = await page.evaluate(() => ({
    state: document.body.dataset.ready,
    reason: document.body.dataset.error || '',
  }));
  if (ready.state !== '1') {
    throw new Error(
      `board card could not load real data (${ready.reason || ready.state}). ` +
        'Refusing to screenshot -- posting placeholder numbers would be worse than posting nothing.',
    );
  }
  await page.waitForTimeout(400); // let avatars and the webfont settle
  await mkdir(dirname(out), { recursive: true });
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 675 } });
  console.log(`shot: wrote ${out}`);
} finally {
  await browser.close();
}
