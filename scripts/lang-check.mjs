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
async function open({ locale, withApi = false, url = PAGE }) {
  const context = await browser.newContext({ locale });
  const page = await context.newPage();
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

// 3. zh-CN browser -> English, per the brief (Traditional regions only).
{
  const { context, page } = await open({ locale: 'zh-CN' });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const lang = await htmlLang(page);
  check('zh-CN browser -> en', lang === 'en', `lang=${lang}`);
  await context.close();
}

// 4. ?lang= beats everything the browser says.
{
  const { context, page } = await open({ locale: 'en-US', url: `${PAGE}?lang=zh-Hant` });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant');
  check('?lang=zh-Hant overrides an en-US browser', true);
  await context.close();
}

// 5. The manual toggle wins and survives a reload.
{
  const { context, page } = await open({ locale: 'zh-TW' });
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant');
  await page.click('#lang-toggle');
  const afterClick = await htmlLang(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const afterReload = await htmlLang(page);
  check('toggle switches language', afterClick === 'en', `lang=${afterClick}`);
  check('toggle is remembered across reloads', afterReload === 'en', `lang=${afterReload}`);
  await context.close();
}

// 6. The geo fallback: an en-US browser sitting in a zh-Hant country.
if (apiUp) {
  const country = await fetch(`${API}/api/leaderboard`)
    .then((r) => r.json())
    .then((d) => d.viewer_country)
    .catch(() => null);
  const { context, page } = await open({ locale: 'en-US', withApi: true });
  await page.waitForFunction(() => document.querySelector('[data-role="help"]').textContent.length > 0);
  const first = await htmlLang(page);
  const expectZh = ['TW', 'HK', 'MO'].includes(String(country || '').toUpperCase());
  if (expectZh) {
    await page
      .waitForFunction(() => document.documentElement.lang === 'zh-Hant', null, { timeout: 5000 })
      .catch(() => {});
    const after = await htmlLang(page);
    check('en-US browser starts in English', first === 'en', `lang=${first}`);
    check(`geo ${country} flips it to zh-Hant`, after === 'zh-Hant', `lang=${after}`);
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
