// Three locales: Traditional Chinese (Taiwan / Hong Kong / Macau), Simplified
// Chinese, and English for everyone else.
//
// Resolution order, first hit wins:
//   1. an explicit choice the visitor made (localStorage)
//   2. ?lang=zh-Hant / ?lang=zh-Hans / ?lang=en  -- for testing and sharing
//   3. navigator.languages -- the FIRST Chinese tag decides the script, so a
//      visitor who lists zh-CN ahead of zh-TW gets Simplified
//   4. the viewer's country, which the API reports from the edge
//
// 3 is synchronous so the first paint is already correct. 4 arrives with the
// first API response and only applies when the earlier signals said nothing,
// so the usual case never shows a flash of the wrong language.

const STORE_KEY = 'tibo-beg.lang';
const FALLBACK = 'en';

// Geo is only consulted when the browser said nothing about Chinese, so this
// list stays deliberately narrow. Singapore and Malaysia are left out: they are
// multilingual, and someone there running an English browser most likely wants
// English -- their Chinese-locale visitors are already caught a step earlier.
const COUNTRY_LOCALE = new Map([
  ['TW', 'zh-Hant'],
  ['HK', 'zh-Hant'],
  ['MO', 'zh-Hant'],
  ['CN', 'zh-Hans'],
]);

// The order the toggle cycles through.
const CYCLE = ['zh-Hant', 'zh-Hans', 'en'];

// Rich entries are authored here, never built from user input, so setting them
// as innerHTML is safe. Everything that touches a username stays textContent.
export const STRINGS = {
  en: {
    _htmlLang: 'en',
    _locale: 'en-US',
    _font: null,
    docTitle: 'Beg Board — who begs hardest for a Codex reset',
    docDescription:
      'Sign in with Google, hit the button, and find out who on earth begs hardest for a Codex limit reset.',

    brand: 'Beg Board',
    tagline:
      'Unofficial. Fan-made. We beg <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a> for a Codex reset, and we keep score.',

    themeToggle: 'Toggle dark mode',
    langToggle: 'Change language',
    langToggleFace: 'EN',

    idolCaption: '— the man with the reset button',
    idolAria: 'Tibo Sottiaux on X (opens in a new site)',

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

    helpSignedOut: 'Sign in with Google to have your begs counted.',
    helpLive: 'Rate-limited to 8 begs/sec. Past that the button still feels good but the score does not move.',
    helpDemo: 'Demo mode — nothing is sent anywhere. Point config.js at your Worker to go live.',

    signIn: 'Sign in with Google',
    signOut: 'sign out',

    nameEdit: 'Change your display name',
    nameTitle: 'Display name',
    nameHint: 'Leave it empty to go back to your Google name. 2–20 characters.',
    namePlaceholder: 'e.g. ratelimited',
    nameSave: 'save',
    nameCancel: 'cancel',
    nameSaved: 'Now showing as {name}',
    nameReset: 'Back to your Google name',
    err_name_invalid: 'That name needs to be 2–20 characters.',
    err_name_reserved: 'That name is reserved. Pick another one.',
    err_name_taken: 'Someone is already begging under that name.',

    boardTitle: 'Leaderboard',
    boardLabel: '{n} beggars · updates live',
    podiumAria: 'Top three beggars',
    boardAria: 'Ranks four and below',
    boardEmpty: 'Nobody has begged yet. Be the first.',

    notesTitle: 'How this works',
    notes: [
      '<strong>Google sign-in</strong> reads only your name and profile picture. Your email address is never requested, and no token of yours is stored.',
      '<strong>Clicks are rate-limited</strong> to 8/sec sustained per account. Autoclickers gain nothing past that, so the board measures stamina, not scripting.',
      'A screenshot of this board is posted to X once a day, mentioning <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a>. He can mute us.',
      'Not affiliated with OpenAI, Google, or <a href="https://codex-resets.com" rel="noopener">codex-resets.com</a> — whose beg button started this.',
    ],

    toastSignInFailed: 'Sign-in failed: {error}',
    err_google_not_configured: 'Google sign-in is not switched on yet — the leaderboard below is live though.',
    toastPassed: '#{rank} — passed {user}',
    toastRank: 'You are now #{rank}',
    toastExpired: 'Session expired — sign in again',
    toastThrottled: 'easy — the counter caps at 8/sec',
    toastDemo: 'Demo mode: no data leaves this browser',
  },

  'zh-Hant': {
    _htmlLang: 'zh-Hant',
    _locale: 'zh-Hant-TW',
    _font: 'Noto+Sans+TC',
    docTitle: 'Beg Board — 誰最會跪求 Codex reset',
    docDescription: '用 Google 登入、狂按按鈕，看看全世界誰最想要 Codex 額度重置。',

    // Product name, left untranslated the way brands usually are. Swap this for
    // 「跪求排行榜」if you would rather it read as Chinese.
    brand: 'Beg Board',
    tagline:
      '非官方，粉絲自製。我們替大家跪求 <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a> 重置 Codex 額度，順便記分。',

    themeToggle: '切換深色模式',
    langToggle: '切換語言',
    langToggleFace: '繁',

    idolCaption: '—— 握著重置開關的男人',
    idolAria: '前往 Tibo Sottiaux 的 X 頁面',

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

    helpSignedOut: '用 Google 登入，你的跪求才會被計分。',
    helpLive: '每秒最多計 8 次。超過的部分按起來一樣爽，但分數不會動。',
    helpDemo: '展示模式 —— 什麼都不會送出。把 config.js 指向你的 Worker 才會真的上線。',

    signIn: '用 Google 登入',
    signOut: '登出',

    nameEdit: '修改顯示名稱',
    nameTitle: '顯示名稱',
    nameHint: '留空就恢復成你的 Google 名稱。2–20 個字。',
    namePlaceholder: '例如 ratelimited',
    nameSave: '儲存',
    nameCancel: '取消',
    nameSaved: '現在顯示為 {name}',
    nameReset: '已恢復成你的 Google 名稱',
    err_name_invalid: '名稱要 2–20 個字。',
    err_name_reserved: '這個名稱被保留了，換一個吧。',
    err_name_taken: '已經有人用這個名字在跪求了。',

    boardTitle: '排行榜',
    boardLabel: '{n} 人跪求中 · 即時更新',
    podiumAria: '跪求前三名',
    boardAria: '第四名以後',
    boardEmpty: '還沒有人跪求。當第一個。',

    notesTitle: '運作方式',
    notes: [
      '<strong>Google 登入</strong>只會讀你的名稱與頭像。<strong>不會要你的 email</strong>，也不會保存你的任何 token。',
      '<strong>點擊有速率上限</strong>，每個帳號每秒 8 次。連點器超過這條線也拿不到分，所以這裡比的是耐力不是腳本。',
      '這個排行榜每天會截圖發到 X 一次，並 tag <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a>。他可以把我們靜音。',
      '與 OpenAI、Google 或 <a href="https://codex-resets.com" rel="noopener">codex-resets.com</a> 均無關聯 —— 後者的 beg 按鈕是這一切的起點。',
    ],

    toastSignInFailed: '登入失敗：{error}',
    err_google_not_configured: 'Google 登入還沒開通 —— 但下面的排行榜已經是即時的了。',
    toastPassed: '第 {rank} 名 —— 超車 {user}',
    toastRank: '你現在是第 {rank} 名',
    toastExpired: '登入階段已過期，請重新登入',
    toastThrottled: '慢一點 —— 每秒最多算 8 次',
    toastDemo: '展示模式：資料不會離開這個瀏覽器',
  },

  'zh-Hans': {
    _htmlLang: 'zh-Hans',
    _locale: 'zh-Hans-CN',
    _font: 'Noto+Sans+SC',
    docTitle: 'Beg Board — 谁最会跪求 Codex reset',
    docDescription: '用 Google 登录、狂点按钮，看看全世界谁最想要 Codex 额度重置。',

    brand: 'Beg Board',
    tagline:
      '非官方，粉丝自制。我们替大家跪求 <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a> 重置 Codex 额度，顺便记分。',

    themeToggle: '切换深色模式',
    langToggle: '切换语言',
    langToggleFace: '简',

    idolCaption: '—— 握着重置开关的男人',
    idolAria: '前往 Tibo Sottiaux 的 X 页面',

    altarTitle: '本轮总跪求次数',
    connConnecting: '连接中',
    connLive: '实时',
    connOffline: '已离线',
    pulseLabel: '全球每秒 {n} 次跪求',

    begLabel: '跪求',
    comboWarming: '热身中',
    comboDevout: '虔诚',
    comboFervent: '狂热',
    comboUnhinged: '走火入魔',

    helpSignedOut: '用 Google 登录，你的跪求才会被计分。',
    helpLive: '每秒最多计 8 次。超过的部分点起来一样爽，但分数不会动。',
    helpDemo: '演示模式 —— 什么都不会发出。把 config.js 指向你的 Worker 才会真的上线。',

    signIn: '用 Google 登录',
    signOut: '退出登录',

    nameEdit: '修改显示名称',
    nameTitle: '显示名称',
    nameHint: '留空就恢复成你的 Google 名称。2–20 个字。',
    namePlaceholder: '例如 ratelimited',
    nameSave: '保存',
    nameCancel: '取消',
    nameSaved: '现在显示为 {name}',
    nameReset: '已恢复成你的 Google 名称',
    err_name_invalid: '名称要 2–20 个字。',
    err_name_reserved: '这个名称被保留了，换一个吧。',
    err_name_taken: '已经有人用这个名字在跪求了。',

    boardTitle: '排行榜',
    boardLabel: '{n} 人跪求中 · 实时更新',
    podiumAria: '跪求前三名',
    boardAria: '第四名以后',
    boardEmpty: '还没有人跪求。当第一个。',

    notesTitle: '运作方式',
    notes: [
      '<strong>Google 登录</strong>只会读你的名称与头像。<strong>不会要你的 email</strong>，也不会保存你的任何 token。',
      '<strong>点击有速率上限</strong>，每个账号每秒 8 次。连点器超过这条线也拿不到分，所以这里比的是耐力不是脚本。',
      '这个排行榜每天会截图发到 X 一次，并 tag <a href="https://x.com/thsottiaux" rel="noopener">@thsottiaux</a>。他可以把我们静音。',
      '与 OpenAI、Google 或 <a href="https://codex-resets.com" rel="noopener">codex-resets.com</a> 均无关联 —— 后者的 beg 按钮是这一切的起点。',
    ],

    toastSignInFailed: '登录失败：{error}',
    err_google_not_configured: 'Google 登录还没开通 —— 但下面的排行榜已经是实时的了。',
    toastPassed: '第 {rank} 名 —— 超越 {user}',
    toastRank: '你现在是第 {rank} 名',
    toastExpired: '登录状态已过期，请重新登录',
    toastThrottled: '慢一点 —— 每秒最多算 8 次',
    toastDemo: '演示模式：数据不会离开这个浏览器',
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
    if (!lower.startsWith('zh')) continue;
    // zh-Hant, zh-TW, zh-HK, zh-MO, zh-Hant-HK all mean Traditional. Every
    // other Chinese tag -- zh, zh-CN, zh-Hans, zh-SG -- means Simplified.
    // Returning on the first Chinese tag respects the visitor's own ordering.
    return /hant|-tw|-hk|-mo/.test(lower) ? 'zh-Hant' : 'zh-Hans';
  }
  return null;
}

export function localeForCountry(country) {
  return COUNTRY_LOCALE.get(String(country || '').toUpperCase()) || null;
}

/** The next language in the toggle's cycle. */
export function nextLang() {
  const index = CYCLE.indexOf(current);
  return CYCLE[(index + 1) % CYCLE.length];
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

/** Whether a key exists in the active locale or the English fallback. */
export function hasString(key) {
  return key in STRINGS[current] || key in STRINGS[FALLBACK];
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
function ensureCjkFont(family) {
  if (!family) return;
  const id = `cjk-font-${family}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${family}:wght@500;700&display=swap`;
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
  ensureCjkFont(dict._font);

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
