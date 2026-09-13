// Post the daily board card to X.
//
//   node scripts/post-to-x.mjs --image out/board.png [--dry-run]
//
// Uses OAuth 1.0a user context, which is what both the v2 media upload and the
// v2 post endpoint accept for posting as a specific account. App-only bearer
// tokens cannot create posts, so there is no simpler option here.
//
// Env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
//      API_BASE (optional, to fetch live numbers for the caption)
//      MENTION   (default @thsottiaux)
//      MIN_BEGGARS (default 3) -- below this the day is skipped entirely

import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MEDIA_URL = 'https://api.x.com/2/media/upload';
const TWEET_URL = 'https://api.x.com/2/tweets';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const imagePath = arg('image', 'out/board.png');
const mention = process.env.MENTION || '@thsottiaux';
const apiBase = String(process.env.API_BASE || '').replace(/\/+$/, '');
const minBeggars = Number(process.env.MIN_BEGGARS ?? 3);

/**
 * An empty board is not worth a post. @-mentioning a real person daily with
 * "0 begs from 0 people" is closer to pestering than to a tribute, so a thin
 * day is skipped rather than sent. Exits 0: a skip is a normal outcome, not a
 * build failure.
 */
async function shouldPost() {
  if (!apiBase) return { ok: false, why: 'API_BASE is not set, so there are no real numbers to post' };
  let data;
  try {
    const res = await fetch(`${apiBase}/api/leaderboard?limit=3`, { cache: 'no-store' });
    if (!res.ok) return { ok: false, why: `leaderboard returned HTTP ${res.status}` };
    data = await res.json();
  } catch (err) {
    return { ok: false, why: `leaderboard unreachable: ${err.message}` };
  }
  const beggars = Number(data?.beggars || 0);
  const total = Number(data?.total || 0);
  if (beggars < minBeggars) {
    return { ok: false, why: `only ${beggars} beggar(s), need ${minBeggars}`, beggars, total };
  }
  if (total < 1) return { ok: false, why: 'nobody has begged yet', beggars, total };
  return { ok: true, beggars, total };
}

const creds = {
  key: process.env.X_API_KEY,
  secret: process.env.X_API_SECRET,
  token: process.env.X_ACCESS_TOKEN,
  tokenSecret: process.env.X_ACCESS_SECRET,
};

// ------------------------------------------------------------------ oauth 1.0a

const rfc3986 = (s) =>
  encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function authHeader(method, url) {
  const target = new URL(url);
  const oauth = {
    oauth_consumer_key: creds.key,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };

  // Only oauth_* and query params sign. A multipart or JSON body does not --
  // getting this wrong is the usual cause of a mystery 401.
  const params = { ...oauth };
  for (const [k, v] of target.searchParams) params[k] = v;

  const normalized = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join('&');
  const base = [method.toUpperCase(), rfc3986(`${target.origin}${target.pathname}`), rfc3986(normalized)].join('&');
  const signingKey = `${rfc3986(creds.secret)}&${rfc3986(creds.tokenSecret)}`;
  oauth.oauth_signature = createHmac('sha1', signingKey).update(base).digest('base64');

  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(oauth[k])}"`)
    .join(', ')}`;
}

// ------------------------------------------------------------------- caption

const MAX_CHARS = 280;
const NEWLINE = String.fromCharCode(10);

// 1-2 hashtags measurably help; 3+ measurably hurt, and a wall of them reads as
// spam next to a daily @-mention of a real person. Overridable, but capped.
const MAX_HASHTAGS = 2;

function hashtags() {
  const raw = (process.env.HASHTAGS ?? '#Codex #OpenAI').trim();
  if (!raw) return '';
  const tags = raw.split(/\s+/).filter(Boolean).map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
  if (tags.length > MAX_HASHTAGS) {
    console.warn(
      `post-to-x: ${tags.length} hashtags given, keeping the first ${MAX_HASHTAGS} — ` +
        'more than two reduces reach rather than increasing it.',
    );
  }
  return tags.slice(0, MAX_HASHTAGS).join(' ');
}

async function board() {
  if (!apiBase) return null;
  try {
    const res = await fetch(`${apiBase}/api/leaderboard?limit=3`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function caption() {
  const date = new Date().toISOString().slice(0, 10);
  const data = await board();
  const n = (value) => Number(value || 0).toLocaleString('en-US');

  const podium = (data?.board || [])
    .slice(0, 3)
    .map((entry, i) => `${['🥇', '🥈', '🥉'][i]} ${entry.username} ${n(entry.count)}`)
    .join(' · ');

  // The mention is deliberately NOT first: a post that begins with @name is
  // treated as a reply and only reaches people who follow both accounts.
  const hook = data ? `${n(data.total)} begs for a Codex reset so far.` : `Beg Board — ${date}`;
  const people = data ? `${n(data.beggars)} people begging, ${date}.` : '';
  const tail = `${people} ${mention} — the people have spoken 🙏`.trim();
  const tags = hashtags();

  // Assemble from the tail backwards: the mention and the hashtags are the point
  // of the post, so anything dropped for length is dropped from the middle.
  const required = [hook, tail, tags].filter(Boolean).join(NEWLINE);
  const withPodium = [hook, podium, tail, tags].filter(Boolean).join(NEWLINE);

  if (withPodium.length <= MAX_CHARS) return withPodium;
  if (required.length <= MAX_CHARS) return required;
  // Only the hook can still be too long, and only absurdly so; trim that alone.
  const room = MAX_CHARS - (required.length - hook.length) - 1;
  return [hook.slice(0, Math.max(0, room)), tail, tags].filter(Boolean).join(NEWLINE);
}

// ---------------------------------------------------------------------- post

async function uploadMedia(bytes) {
  const form = new FormData();
  form.append('media', new Blob([bytes], { type: 'image/png' }), 'board.png');
  form.append('media_category', 'tweet_image');

  const res = await fetch(MEDIA_URL, {
    method: 'POST',
    headers: { authorization: authHeader('POST', MEDIA_URL) },
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`media upload ${res.status}: ${JSON.stringify(data)}`);
  const id = data?.data?.id || data?.id || data?.media_id_string;
  if (!id) throw new Error(`media upload gave no id: ${JSON.stringify(data)}`);
  return String(id);
}

async function createPost(text, mediaId) {
  const res = await fetch(TWEET_URL, {
    method: 'POST',
    headers: { authorization: authHeader('POST', TWEET_URL), 'content-type': 'application/json' },
    body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`create post ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const gate = await shouldPost();
const text = await caption();

if (dryRun) {
  console.log('--- dry run, nothing sent ---');
  console.log(gate.ok ? `would post (${gate.beggars} beggars, ${gate.total} begs)` : `would SKIP: ${gate.why}`);
  console.log(text);
  console.log(`image: ${imagePath}`);
  process.exit(0);
}

if (!gate.ok) {
  console.log(`post-to-x: skipping today -- ${gate.why}`);
  process.exit(0);
}

for (const [name, value] of Object.entries(creds)) {
  if (!value) {
    console.error(`post-to-x: missing credential (${name}). Set X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET.`);
    process.exit(1);
  }
}

const bytes = await readFile(imagePath);
const mediaId = await uploadMedia(bytes);
const result = await createPost(text, mediaId);
console.log(`posted: https://x.com/i/status/${result?.data?.id}`);
