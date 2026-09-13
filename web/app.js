// Beg Board client.
//
// Click handling follows the pattern codex-resets.com uses: every click paints
// locally at once, and the network sees a batched POST. The UI never waits on
// the wire, so a click storm stays at 60fps and the server sees ~10 requests
// per 100 clicks instead of 100.

import {
  fillCount,
  initLang,
  isAutoDetected,
  lang,
  locale,
  localeForCountry,
  nextLang,
  onLangChange,
  setLang,
  t,
} from './i18n.js';

const CONFIG = window.TIBO_BEG_CONFIG || {};
const API = String(CONFIG.API_BASE || '').replace(/\/+$/, '');
const DEMO = !API; // no backend configured -> drive the page locally
const TOKEN_KEY = 'tibo-beg.token';
const THEME_KEY = 'tibo-beg.theme';

const FLUSH_MS = 100;
const FLUSH_AT = 10; // matches the server's per-request cap
const COMBO_DECAY_MS = 1200;
const BPS_FULL = 40; // begs/sec that fills the pulse bar

const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const el = {
  auth: $('auth'),
  connection: $('connection'),
  total: $('total'),
  pulseLabel: $('pulse-label'),
  pulseFill: $('pulse-fill'),
  beg: $('beg'),
  begEmoji: $('beg-emoji'),
  begCount: $('beg-count'),
  bursts: $('bursts'),
  combo: $('combo'),
  comboLabel: $('combo-label'),
  comboCount: $('combo-count'),
  help: $('help'),
  podium: $('podium'),
  board: $('board'),
  boardEmpty: $('board-empty'),
  boardSub: $('board-sub'),
  toasts: $('toasts'),
  themeIcon: $('theme-icon'),
  langFace: $('lang-face'),
  idol: $('idol-link'),
  altar: document.querySelector('.altar'),
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  token: null,
  me: null,
  total: 0,
  myCount: 0,
  myRank: null,
  bps: 0,
  board: [],
  beggars: 0,
  pending: 0,
  requestId: null,
  flushTimer: null,
  mine: new Set(), // request ids we already painted locally
  combo: 0,
  comboTimer: null,
  socket: null,
  pollTimer: null,
  retries: 0,
  retryTimer: null,
};

// ------------------------------------------------------------------ helpers

// Rebuilt on a language change so grouping follows the active locale.
let nf = new Intl.NumberFormat(locale());

function flagOf(cc) {
  if (typeof cc !== 'string' || !/^[A-Za-z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
}

function toast(message, kind) {
  const node = document.createElement('div');
  node.className = kind ? `toast toast--${kind}` : 'toast';
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => node.remove(), 3000);
}

// Digit-level diffing so only the digits that actually changed animate.
function odometer(node, value) {
  const text = nf.format(Math.max(0, Math.round(value)));
  const previous = [...node.children].map((c) => c.textContent);
  if (previous.join('') === text) return;
  const chars = [...text];
  node.textContent = '';
  for (let i = 0; i < chars.length; i++) {
    const span = document.createElement('span');
    span.className = 'digit';
    span.textContent = chars[i];
    const sameLength = previous.length === chars.length;
    if (!sameLength || previous[i] !== chars[i]) span.classList.add('is-changing');
    node.appendChild(span);
  }
}

// ------------------------------------------------------------------- theme

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  el.themeIcon.textContent = theme === 'dark' ? '☀' : '☾';
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: the choice just will not persist */
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* ignore */
  }
  const dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'dark' : 'light');
  document.getElementById('theme-toggle').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}

// -------------------------------------------------------------------- auth

function readToken() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromHash = hash.get('token');
  const error = hash.get('error');
  if (fromHash || error) history.replaceState(null, '', location.pathname + location.search);
  if (error) toast(t('toastSignInFailed', { error }), 'warn');
  if (fromHash) {
    try {
      localStorage.setItem(TOKEN_KEY, fromHash);
    } catch {
      /* ignore */
    }
    return fromHash;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function signOut() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  location.reload();
}

function renderAuth() {
  el.auth.textContent = '';
  if (state.me) {
    const wrap = document.createElement('div');
    wrap.className = 'auth-user';
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (state.me.avatar) img.src = state.me.avatar;
    const name = document.createElement('span');
    name.textContent = `@${state.me.username}`;
    wrap.append(img, name);

    const out = document.createElement('button');
    out.className = 'chip';
    out.type = 'button';
    out.textContent = t('signOut');
    out.addEventListener('click', signOut);

    el.auth.append(wrap, out);
    el.beg.disabled = false;
    el.help.textContent = t(DEMO ? 'helpDemo' : 'helpLive');
  } else {
    const link = document.createElement('a');
    link.className = 'btn btn--primary';
    link.textContent = t('signIn');
    link.href = DEMO ? '#' : `${API}/api/auth/threads/start?redirect=${encodeURIComponent(location.href.split('#')[0])}`;
    if (DEMO) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        demoSignIn();
      });
    }
    el.auth.append(link);
    el.beg.disabled = true;
    el.help.textContent = t('helpSignedOut');
  }
}

async function loadMe() {
  if (!state.token) return null;
  if (DEMO) return state.me;
  try {
    const res = await fetch(`${API}/api/me`, { headers: { authorization: `Bearer ${state.token}` } });
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ bursts

function spawn(content, { remote = false, size = 26 } = {}) {
  if (reduceMotion.matches) return;
  const node = document.createElement('span');
  node.className = remote ? 'burst burst--remote' : 'burst';
  const spread = remote ? 70 : 110;
  node.style.setProperty('--burst-x', `${Math.round(Math.random() * spread - spread / 2)}px`);
  node.style.setProperty('--burst-y', `${-70 - Math.round(Math.random() * 60)}px`);
  node.style.setProperty('--burst-rotate', `${Math.round(Math.random() * 30 - 15)}deg`);
  node.style.setProperty('--burst-size', `${size}px`);
  if (typeof content === 'string') {
    node.textContent = content;
  } else {
    node.appendChild(content);
  }
  el.bursts.appendChild(node);
  while (el.bursts.childElementCount > 18) el.bursts.firstElementChild.remove();
  node.addEventListener('animationend', () => node.remove(), { once: true });
}

function avatarBurst(url, remote) {
  if (!url) return spawn(remote ? '🙏' : '✨', { remote });
  const img = document.createElement('img');
  img.className = 'burst-avatar';
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  spawn(img, { remote, size: remote ? 24 : 34 });
}

const COMBO_TIERS = [
  { at: 0, key: 'comboWarming', emoji: '🙏', level: 0 },
  { at: 8, key: 'comboDevout', emoji: '✨', level: 1 },
  { at: 25, key: 'comboFervent', emoji: '🔥', level: 2 },
  { at: 60, key: 'comboUnhinged', emoji: '👑', level: 3 },
];

function tierFor(combo) {
  let tier = COMBO_TIERS[0];
  for (const candidate of COMBO_TIERS) if (combo >= candidate.at) tier = candidate;
  return tier;
}

function bumpCombo() {
  state.combo += 1;
  const tier = tierFor(state.combo);
  el.beg.dataset.combo = String(tier.level);
  el.altar.dataset.combo = String(tier.level); // brightens the halo
  el.begEmoji.textContent = tier.emoji;
  el.combo.hidden = state.combo < 5;
  el.comboLabel.textContent = t(tier.key);
  el.comboCount.textContent = `x${state.combo}`;
  clearTimeout(state.comboTimer);
  state.comboTimer = setTimeout(() => {
    state.combo = 0;
    el.beg.dataset.combo = '0';
    el.altar.dataset.combo = '0';
    el.begEmoji.textContent = '🙏';
    el.combo.hidden = true;
  }, COMBO_DECAY_MS);
  return tier;
}

// -------------------------------------------------------------- leaderboard

function renderBoard() {
  const board = state.board;
  el.boardEmpty.hidden = board.length > 0;
  fillCount(el.boardSub, 'boardLabel', nf.format(state.beggars || board.length));

  el.podium.textContent = '';
  for (const entry of board.slice(0, 3)) {
    const li = document.createElement('li');
    li.dataset.rank = String(entry.rank);
    const crown = document.createElement('span');
    crown.className = 'crown';
    crown.textContent = ['👑', '🥈', '🥉'][entry.rank - 1] || '';
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (entry.avatar) img.src = entry.avatar;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `@${entry.username}${flagOf(entry.country) ? ` ${flagOf(entry.country)}` : ''}`;
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = nf.format(entry.count);
    li.append(crown, img, name, score);
    el.podium.appendChild(li);
  }

  // FLIP: measure, re-render, then play the delta so rows visibly overtake
  // each other instead of teleporting.
  const before = new Map();
  for (const row of el.board.children) before.set(row.dataset.uid, row.getBoundingClientRect().top);

  el.board.textContent = '';
  for (const entry of board.slice(3)) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.uid = entry.uid;
    if (state.me && entry.uid === state.me.uid) li.classList.add('is-you');

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `#${entry.rank}`;
    const img = document.createElement('img');
    img.className = 'avatar';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (entry.avatar) img.src = entry.avatar;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `@${entry.username}`;
    const flag = flagOf(entry.country);
    if (flag) {
      const span = document.createElement('span');
      span.className = 'flag';
      span.textContent = flag;
      name.appendChild(span);
    }
    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = nf.format(entry.count);
    li.append(rank, img, name, score);
    el.board.appendChild(li);
  }

  if (reduceMotion.matches) return;
  for (const row of el.board.children) {
    const previous = before.get(row.dataset.uid);
    if (previous === undefined) continue;
    const delta = previous - row.getBoundingClientRect().top;
    if (!delta) continue;
    row.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
      { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }
}

function noteRank(rank) {
  if (rank === null) return;
  const previous = state.myRank;
  state.myRank = rank;
  if (previous !== null && rank < previous) {
    const passed = state.board.find((entry) => entry.rank === rank + 1);
    toast(passed ? t('toastPassed', { rank, user: passed.username }) : t('toastRank', { rank }));
  }
}

function applySnapshot(data) {
  // The edge knows where the visitor is; use it only when the browser's own
  // language tags said nothing about Traditional Chinese.
  if (data.viewer_country && isAutoDetected() && lang() === 'en') {
    const geo = localeForCountry(data.viewer_country);
    if (geo) setLang(geo);
  }

  if (typeof data.total === 'number') state.total = Math.max(state.total, data.total);
  if (typeof data.bps === 'number') state.bps = data.bps;
  if (typeof data.beggars === 'number') state.beggars = data.beggars;
  if (Array.isArray(data.board)) state.board = data.board;

  odometer(el.total, state.total);
  fillCount(el.pulseLabel, 'pulseLabel', state.bps.toFixed(1));
  el.pulseFill.style.width = `${Math.min(100, (state.bps / BPS_FULL) * 100)}%`;
  renderBoard();

  if (state.me) {
    const mine = state.board.find((entry) => entry.uid === state.me.uid);
    if (mine) {
      state.myCount = Math.max(state.myCount, mine.count);
      odometer(el.begCount, state.myCount);
      noteRank(mine.rank);
    }
  }
}

// ----------------------------------------------------------------- realtime

const CONNECTION_KEYS = { connecting: 'connConnecting', live: 'connLive', offline: 'connOffline' };

function setConnection(status) {
  el.connection.dataset.state = status;
  el.connection.textContent = t(CONNECTION_KEYS[status] || status);
}

async function poll() {
  if (DEMO) return;
  try {
    const res = await fetch(`${API}/api/leaderboard?limit=15`, { cache: 'no-store' });
    if (res.ok) applySnapshot(await res.json());
  } catch {
    /* the reconnect loop is the retry */
  }
}

function startPolling() {
  if (state.pollTimer || DEMO) return;
  poll();
  state.pollTimer = setInterval(poll, 5000);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = undefined;
}

function scheduleReconnect() {
  if (document.hidden || state.retryTimer || DEMO) return;
  startPolling(); // keep numbers moving while the socket is down
  const delay = Math.min(30000, 1000 * 2 ** state.retries);
  state.retries += 1;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = undefined;
    connect();
  }, delay);
}

function connect() {
  if (DEMO || document.hidden || state.socket?.readyState === WebSocket.OPEN) return;
  clearTimeout(state.retryTimer);
  state.retryTimer = undefined;
  setConnection('connecting');

  const base = API.replace(/^http/, 'ws');
  const query = state.token ? `?t=${encodeURIComponent(state.token)}` : '';
  let socket;
  try {
    socket = new WebSocket(`${base}/api/live${query}`);
  } catch {
    scheduleReconnect();
    return;
  }
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.retries = 0;
    stopPolling();
    setConnection('live');
  });

  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (data.type !== 'tick' && data.type !== 'hello') return;
    applySnapshot(data);
    for (const burst of data.events || []) {
      // Our own clicks already painted optimistically; do not double-count them.
      if (burst.request_id && state.mine.has(burst.request_id)) continue;
      if (state.me && burst.uid === state.me.uid) continue;
      avatarBurst(burst.avatar, true);
    }
  });

  socket.addEventListener('close', () => {
    state.socket = null;
    setConnection('offline');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => socket.close());
}

// -------------------------------------------------------------- click path

async function flush() {
  clearTimeout(state.flushTimer);
  state.flushTimer = null;
  const n = state.pending;
  const requestId = state.requestId;
  state.pending = 0;
  state.requestId = null;
  if (n < 1 || !requestId) return;

  if (DEMO) {
    demoCredit(n);
    return;
  }

  try {
    const res = await fetch(`${API}/api/beg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ n, request_id: requestId }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) {
      toast(t('toastExpired'), 'warn');
      signOut();
      return;
    }
    if (!res.ok || !data) return;
    state.total = Math.max(state.total, data.total);
    state.myCount = data.count;
    odometer(el.total, state.total);
    odometer(el.begCount, state.myCount);
    noteRank(data.rank);
    if (data.throttled > 0 && state.combo > 20) toast(t('toastThrottled'), 'warn');
  } catch {
    /* dropped begs are not worth a retry queue */
  }
}

function onBeg() {
  if (!state.me) return;
  const tier = bumpCombo();
  el.begEmoji.classList.remove('is-praying');
  void el.begEmoji.offsetWidth; // restart the keyframe
  el.begEmoji.classList.add('is-praying');

  // He acknowledges every third plea. Reacting to every click reads as jitter.
  if (state.combo % 3 === 1) {
    el.idol.classList.remove('is-blessed');
    void el.idol.offsetWidth;
    el.idol.classList.add('is-blessed');
  }

  // Paint first, account later.
  state.myCount += 1;
  state.total += 1;
  odometer(el.begCount, state.myCount);
  odometer(el.total, state.total);
  if (state.combo % 4 === 1) avatarBurst(state.me.avatar, false);
  else spawn(tier.emoji, { size: 22 + Math.round(Math.random() * 10) });

  state.pending += 1;
  if (!state.requestId) {
    state.requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random()}`;
    const id = state.requestId;
    state.mine.add(id);
    setTimeout(() => state.mine.delete(id), 30000);
  }
  if (state.pending >= FLUSH_AT) {
    flush();
    return;
  }
  if (!state.flushTimer) state.flushTimer = setTimeout(flush, FLUSH_MS);
}

// -------------------------------------------------------------- demo driver

const DEMO_NAMES = [
  ['ratelimited', 'TW'], ['tokenburner', 'US'], ['ctx_window', 'JP'], ['nightlybuild', 'DE'],
  ['promptgoblin', 'BR'], ['yak_shaver', 'GB'], ['four_o_four', 'IN'], ['semicolon', 'FR'],
  ['cachemiss', 'KR'], ['bikeshedder', 'NL'], ['off_by_one', 'CA'], ['null_island', 'AU'],
];

function demoAvatar(seed) {
  const hue = (seed * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="hsl(${hue} 80% 62%)"/><circle cx="20" cy="16" r="7" fill="rgba(255,255,255,.85)"/><rect x="8" y="26" width="24" height="14" rx="7" fill="rgba(255,255,255,.85)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const demo = {
  users: DEMO_NAMES.map(([un, cc], i) => ({
    uid: `demo-${i}`,
    username: un,
    country: cc,
    avatar: demoAvatar(i + 3),
    count: Math.round(400 + Math.random() * 3200),
  })),
};

function demoRender() {
  const sorted = [...demo.users].sort((a, b) => b.count - a.count);
  applySnapshot({
    total: sorted.reduce((sum, u) => sum + u.count, 0),
    bps: Math.round((3 + Math.random() * 22) * 10) / 10,
    beggars: sorted.length,
    board: sorted.map((u, i) => ({ rank: i + 1, ...u })),
  });
}

function demoCredit(n) {
  const me = demo.users.find((u) => u.uid === state.me.uid);
  if (me) me.count += n;
  demoRender();
}

function demoSignIn() {
  state.me = { uid: 'demo-you', username: 'you', avatar: demoAvatar(11), country: 'TW' };
  demo.users.push({ ...state.me, count: 0 });
  state.token = 'demo';
  renderAuth();
  demoRender();
  toast(t('toastDemo'));
}

function startDemo() {
  setConnection('live');
  demoRender();
  setInterval(() => {
    // Someone else out there is begging.
    const picks = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < picks; i++) {
      const user = demo.users[Math.floor(Math.random() * demo.users.length)];
      if (user.uid === state.me?.uid) continue;
      user.count += 1 + Math.floor(Math.random() * 4);
      avatarBurst(user.avatar, true);
    }
    demoRender();
  }, 700);
}

// ------------------------------------------------------------------ language

function repaintDynamic() {
  nf = new Intl.NumberFormat(locale());
  el.langFace.textContent = t('langToggleFace');
  setConnection(el.connection.dataset.state);
  renderAuth();
  el.comboLabel.textContent = t(tierFor(state.combo).key);
  // Numbers are re-formatted for the new locale, so force the odometers to
  // rebuild rather than diff against the old grouping.
  el.total.textContent = '';
  el.begCount.textContent = '';
  odometer(el.total, state.total);
  odometer(el.begCount, state.myCount);
  fillCount(el.pulseLabel, 'pulseLabel', state.bps.toFixed(1));
  renderBoard();
}

function initLanguage() {
  initLang();
  onLangChange(repaintDynamic);
  el.langFace.textContent = t('langToggleFace');
  setConnection('connecting');
  // Three languages, so the chip cycles and shows the one currently active
  // rather than the one it would switch to.
  document.getElementById('lang-toggle').addEventListener('click', () => {
    setLang(nextLang(), { remember: true });
  });
}

// -------------------------------------------------------------------- boot

async function main() {
  initLanguage();
  initTheme();
  odometer(el.total, 0);
  odometer(el.begCount, 0);

  state.token = readToken();
  state.me = await loadMe();
  renderAuth();

  el.beg.addEventListener('click', onBeg);
  el.beg.addEventListener('keydown', (event) => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });

  if (DEMO) {
    startDemo();
    return;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
      state.socket?.close(1000, 'hidden');
    } else {
      connect();
    }
  });
  window.addEventListener('pagehide', () => flush());
  poll();
  connect();
}

main();
