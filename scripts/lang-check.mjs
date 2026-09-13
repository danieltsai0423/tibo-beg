// Language-detection checks for the web page.
//
//   npm run serve                                          # terminal 1
//   cd worker && npx wrangler dev --port 8787 --local      # terminal 2 (optional)
//   node scripts/lang-check.mjs                            # terminal 3
//
// Playwright can set a real browser locale, which is the only honest way to
// test the navigator.languages path. The geo path needs the worker running;
// that case is skipped with a note when the API is not up.

import { chromium } from 'playwright';

const PAGE = process.env.PAGE_URL || 'http://localhost:4173/index.html';
const API = process.env.API_BASE || 'http://127.0.0.1:8787';

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const apiUp = await fetch(`${API}/api/leaderboard`)
  .then((r) => r.ok)
  .catch(() => false);

const browser = await chromium.launch();

/** Opens the page under a given browser locale, optionally wired to the API. */
async function open({ locale, withApi = false, url = PAGE, delayApiMs = 0 }) {
  const context = await browser.newContext({ locale });
  const page = await context.newPage();
  if (delayApiMs) {
    // Hold the leaderboard response back so the "does it paint English first"
    // assertion has a window to sample in. Without this the geo answer can beat
    // the test to the first read and the check becomes a coin flip.
    await page.route('**/api/leaderboard*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, delayApiMs));
      await route.continue();
    });
  }
  if (withApi) {
    // Point the page at the worker without editing the committed config.js.
    await page.route('**/config.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `window.TIBO_BEG_CONFIG = { API_BASE: ${JSON.stringify(API)} };`,
      }),
    );
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

const htmlLang = (page) => page.evaluate(() => document.documentElement.lang);

// 1. zh-TW browser, no backend -> Traditional Chinese on the first paint.
{
  const { context, page } = await open({ locale: 'zh-TW' });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const lang = await htmlLang(page);
  const help = await page.textContent('[data-role="help"]');
  check('zh-TW browser -> zh-Hant', lang === 'zh-Hant', `lang=${lang}`);
  check('zh-Hant strings render', /登入/.test(help), help);
  await context.close();
}

// 2. en-US browser, no backend -> English.
{
  const { context, page } = await open({ locale: 'en-US' });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const lang = await htmlLang(page);
  check('en-US browser -> en', lang === 'en', `lang=${lang}`);
  await context.close();
}

// 3. zh-CN browser -> Simplified Chinese.
{
  const { context, page } = await open({ locale: 'zh-CN' });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const lang = await htmlLang(page);
  const help = await page.textContent('[data-role="help"]');
  check('zh-CN browser -> zh-Hans', lang === 'zh-Hans', `lang=${lang}`);
  check('zh-Hans strings render', /登录/.test(help), help);
  await context.close();
}

// 3b. Each script pulls its own Noto and leaves the other alone.
for (const [locale, expected, unwanted] of [
  ['zh-TW', 'Noto+Sans+TC', 'Noto+Sans+SC'],
  ['zh-CN', 'Noto+Sans+SC', 'Noto+Sans+TC'],
]) {
  const { context, page } = await open({ locale });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).join(' '),
  );
  const family = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--font-cjk').trim(),
  );
  check(`${locale} loads ${expected} only`, hrefs.includes(expected) && !hrefs.includes(unwanted), hrefs);
  check(`${locale} font stack uses ${expected.replace(/\+/g, ' ')}`, family.includes(expected.split('+').pop()), family);
  await context.close();
}

// 3c. English downloads neither CJK font.
{
  const { context, page } = await open({ locale: 'en-US' });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).join(' '),
  );
  check('en loads no CJK font', !/Noto\+Sans\+(TC|SC)/.test(hrefs), hrefs);
  await context.close();
}

// 4. ?lang= beats everything the browser says.
{
  const { context, page } = await open({ locale: 'en-US', url: `${PAGE}?lang=zh-Hant` });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant');
  check('?lang=zh-Hant overrides an en-US browser', true);
  await context.close();
}

// 5. The toggle cycles through all three and the choice survives a reload.
{
  const { context, page } = await open({ locale: 'zh-TW' });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant');
  const seen = [await htmlLang(page)];
  for (let i = 0; i < 3; i++) {
    await page.click('#lang-toggle');
    seen.push(await htmlLang(page));
  }
  check(
    'toggle cycles zh-Hant -> zh-Hans -> en -> zh-Hant',
    seen.join(',') === 'zh-Hant,zh-Hans,en,zh-Hant',
    seen.join(' -> '),
  );

  await page.click('#lang-toggle'); // land on zh-Hans
  const pinned = await htmlLang(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const afterReload = await htmlLang(page);
  check('choice is remembered across reloads', afterReload === pinned, `${pinned} -> ${afterReload}`);
  await context.close();
}

// 6. The geo fallback: an en-US browser sitting in a zh-Hant country.
if (apiUp) {
  const country = await fetch(`${API}/api/leaderboard`)
    .then((r) => r.json())
    .then((d) => d.viewer_country)
    .catch(() => null);
  const { context, page } = await open({ locale: 'en-US', withApi: true, delayApiMs: 800 });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const first = await htmlLang(page);
  const expected = { TW: 'zh-Hant', HK: 'zh-Hant', MO: 'zh-Hant', CN: 'zh-Hans' }[
    String(country || '').toUpperCase()
  ];
  if (expected) {
    await page
      .waitForFunction((want) => document.documentElement.lang === want, expected, { timeout: 5000 })
      .catch(() => {});
    const after = await htmlLang(page);
    check('en-US browser paints English before geo arrives', first === 'en', `lang=${first}`);
    check(`geo ${country} flips it to ${expected}`, after === expected, `lang=${after}`);
  } else {
    await page.waitForTimeout(1200);
    const after = await htmlLang(page);
    check(`geo ${country} leaves it in English`, after === 'en', `lang=${after}`);
  }
  await context.close();
} else {
  console.log(`SKIP  geo fallback (no API at ${API})`);
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall green');
process.exit(fails.length ? 1 : 0);
