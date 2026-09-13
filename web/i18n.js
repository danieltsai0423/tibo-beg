// Two locales: Traditional Chinese for Taiwan / Hong Kong / Macau, English for
// everyone else.
//
// Resolution order, first hit wins:
//   1. an explicit choice the visitor made (localStorage)
//   2. ?lang=zh-Hant / ?lang=en in the URL  -- handy for testing and sharing
//   3. navigator.languages carrying a Traditional Chinese tag
//   4. the viewer's country, which the API reports from the edge (TW/HK/MO)
//
// 3 is synchronous so the first paint is already correct. 4 arrives with the
// first API response and only applies when the earlier signals said nothing,
// so the usual case never shows a flash of the wrong language.
//
// Note on zh-Hans: a zh-CN / zh-SG visitor gets English, because the brief was
// "Traditional Chinese for the zh-Hant regions, English elsewhere". Adding a
// Simplified locale means a third entry in STRINGS, not a change to this logic.

const STORE_KEY = 'tibo-beg.lang';
const ZH_HANT_COUNTRIES = new Set(['TW', 'HK', 'MO']);
const FALLBACK = 'en';

// Rich entries are authored here, never built from user input, so setting them
// as innerHTML is safe. Everything that touches a username stays textContent.
export const STRINGS = {
  en: {
    _htmlLang: 'en',
    _locale: 'en-US',
    docTitle: 'Beg Board — who begs hardest for a Codex reset',
    docDescription:
      'Sign in with Threads, hit the button, and find out who on earth begs hardest for a Codex limit reset.',

    brand: 'Beg Board',
    tagline:
      'Unofficial. Fan-made. We beg <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a> for a Codex reset, and we keep score.',

    themeToggle: 'Toggle dark mode',
    langToggle: 'Switch to Traditional Chinese',
    langToggleFace: '中',

    altarTitle: 'Total begs this cycle',
    connConnecting: 'connecting',
    connLive: 'live',
    connOffline: 'offline',
    pulseLabel: '{n} begs / sec worldwide',

    begLabel: 'beg',
    comboWarming: 'warming up',
    comboDevout: 'devout',
    comboFervent: 'fervent',
    comboUnhinged: 'unhinged',

    helpSignedOut: 'Sign in with Threads to have your begs counted.',
    helpLive: 'Rate-limited to 8 begs/sec. Past that the button still feels good but the score does not move.',
    helpDemo: 'Demo mode — nothing is sent anywhere. Point config.js at your Worker to go live.',

    signIn: 'Sign in with Threads',
    signOut: 'sign out',

    boardTitle: 'Leaderboard',
    boardLabel: '{n} beggars · updates live',
    podiumAria: 'Top three beggars',
    boardAria: 'Ranks four and below',
    boardEmpty: 'Nobody has begged yet. Be the first.',

    notesTitle: 'How this works',
    notes: [
      '<strong>Threads sign-in</strong> only reads your handle and avatar. No token of yours is stored.',
      '<strong>Clicks are rate-limited</strong> to 8/sec sustained per account. Autoclickers gain nothing past that, so the board measures stamina, not scripting.',
      'A screenshot of this board is posted to X once a day, mentioning <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a>. He can mute us.',
      'Not affiliated with OpenAI, Threads, or <a href="https://codex-resets.com" rel="noopener">codex-resets.com</a> — whose beg button started this.',
    ],

    toastSignInFailed: 'Sign-in failed: {error}',
    toastPassed: '#{rank} — passed @{user}',
    toastRank: 'You are now #{rank}',
    toastExpired: 'Session expired — sign in again',
    toastThrottled: 'easy — the counter caps at 8/sec',
    toastDemo: 'Demo mode: no data leaves this browser',
  },

  'zh-Hant': {
    _htmlLang: 'zh-Hant',
    _locale: 'zh-Hant-TW',
    docTitle: 'Beg Board — 誰最會跪求 Codex reset',
    docDescription: '用 Threads 登入、狂按按鈕，看看全世界誰最想要 Codex 額度重置。',

    // Product name, left untranslated the way brands usually are. Swap this for
    // 「跪求排行榜」if you would rather it read as Chinese.
    brand: 'Beg Board',
    tagline:
      '非官方，粉絲自製。我們替大家跪求 <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a> 重置 Codex 額度，順便記分。',

    themeToggle: '切換深色模式',
    langToggle: 'Switch to English',
    langToggleFace: 'EN',

    altarTitle: '本輪總跪求次數',
    connConnecting: '連線中',
    connLive: '即時',
    connOffline: '已離線',
    pulseLabel: '全球每秒 {n} 次跪求',

    begLabel: '跪求',
    comboWarming: '暖身中',
    comboDevout: '虔誠',
    comboFervent: '狂熱',
    comboUnhinged: '走火入魔',

    helpSignedOut: '用 Threads 登入，你的跪求才會被計分。',
    helpLive: '每秒最多計 8 次。超過的部分按起來一樣爽，但分數不會動。',
    helpDemo: '展示模式 —— 什麼都不會送出。把 config.js 指向你的 Worker 才會真的上線。',

    signIn: '用 Threads 登入',
    signOut: '登出',

    boardTitle: '排行榜',
    boardLabel: '{n} 人跪求中 · 即時更新',
    podiumAria: '跪求前三名',
    boardAria: '第四名以後',
    boardEmpty: '還沒有人跪求。當第一個。',

    notesTitle: '運作方式',
    notes: [
      '<strong>Threads 登入</strong>只會讀你的帳號名稱與頭像，不會保存你的任何 token。',
      '<strong>點擊有速率上限</strong>，每個帳號每秒 8 次。連點器超過這條線也拿不到分，所以這裡比的是耐力不是腳本。',
      '這個排行榜每天會截圖發到 X 一次，並 tag <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a>。他可以把我們靜音。',
      '與 OpenAI、Threads 或 <a href="https://codex-resets.com" rel="noopener">codex-resets.com</a> 均無關聯 —— 後者的 beg 按鈕是這一切的起點。',
    ],

    toastSignInFailed: '登入失敗：{error}',
    toastPassed: '第 {rank} 名 —— 超車 @{user}',
    toastRank: '你現在是第 {rank} 名',
    toastExpired: '登入階段已過期，請重新登入',
    toastThrottled: '慢一點 —— 每秒最多算 8 次',
    toastDemo: '展示模式：資料不會離開這個瀏覽器',
  },
};

let current = FALLBACK;
const listeners = new Set();

// --------------------------------------------------------------- detection

function stored() {
  try {
    const value = localStorage.getItem(STORE_KEY);
    return value && STRINGS[value] ? value : null;
  } catch {
    return null; // private mode
  }
}

function fromQuery() {
  const value = new URLSearchParams(location.search).get('lang');
  return value && STRINGS[value] ? value : null;
}

function fromNavigator() {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    const lower = String(tag || '').toLowerCase();
    // zh-Hant, zh-TW, zh-HK, zh-MO, zh-Hant-HK all mean Traditional.
    if (lower.startsWith('zh') && /hant|-tw|-hk|-mo/.test(lower)) return 'zh-Hant';
  }
  return null;
}

export function localeForCountry(country) {
  return ZH_HANT_COUNTRIES.has(String(country || '').toUpperCase()) ? 'zh-Hant' : null;
}

/** True when the visitor has not pinned a language, so geo may still decide. */
export function isAutoDetected() {
  return !stored() && !fromQuery();
}

// ------------------------------------------------------------------ lookup

export function lang() {
  return current;
}

export function locale() {
  return STRINGS[current]._locale;
}

export function t(key, params) {
  const raw = STRINGS[current][key] ?? STRINGS[FALLBACK][key] ?? key;
  if (!params) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// --------------------------------------------------------------- applying

// Fredoka has no CJK glyphs, so the browser falls through to the next family
// per character. Loading Noto Sans TC only when it is needed keeps the English
// page from paying for a font it will never draw.
function ensureCjkFont() {
  if (document.getElementById('cjk-font')) return;
  const link = document.createElement('link');
  link.id = 'cjk-font';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@500;700&display=swap';
  document.head.appendChild(link);
}

function fill(node, template, value) {
  // Rebuild rather than string-replace so the number keeps its own element and
  // the two languages can put it in different places.
  const [before, after] = String(template).split('{n}');
  node.textContent = '';
  if (before) node.appendChild(document.createTextNode(before));
  const strong = document.createElement('strong');
  strong.textContent = value;
  node.appendChild(strong);
  if (after) node.appendChild(document.createTextNode(after));
}

export function fillCount(node, key, value) {
  fill(node, t(key), value);
}

function paint() {
  const dict = STRINGS[current];
  document.documentElement.lang = dict._htmlLang;
  document.title = dict.docTitle;
  document.querySelector('meta[name="description"]')?.setAttribute('content', dict.docDescription);
  if (current !== 'en') ensureCjkFont();

  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-html]')) {
    node.innerHTML = t(node.dataset.i18nHtml);
  }
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  }

  const notes = document.querySelector('[data-role="notes"]');
  if (notes) {
    notes.textContent = '';
    for (const item of dict.notes) {
      const li = document.createElement('li');
      li.innerHTML = item;
      notes.appendChild(li);
    }
  }
}

export function setLang(next, { remember = false } = {}) {
  if (!STRINGS[next] || next === current) return false;
  current = next;
  if (remember) {
    try {
      localStorage.setItem(STORE_KEY, next);
    } catch {
      /* the choice just will not survive a reload */
    }
  }
  paint();
  for (const fn of listeners) fn(current);
  return true;
}

export function onLangChange(fn) {
  listeners.add(fn);
}

/** Synchronous first pass. Geo can still refine it later via setLang(). */
export function initLang() {
  current = stored() || fromQuery() || fromNavigator() || FALLBACK;
  paint();
  return current;
}
