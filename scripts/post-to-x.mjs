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

async function caption() {
  const date = new Date().toISOString().slice(0, 10);
  let lines = [`Daily Beg Board — ${date}`];
  if (apiBase) {
    try {
      const res = await fetch(`${apiBase}/api/leaderboard?limit=3`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const top = (data.board || [])
          .slice(0, 3)
          .map((e, i) => `${['🥇', '🥈', '🥉'][i]} @${e.username} ${e.count.toLocaleString('en-US')}`)
          .join('  ');
        lines = [
          `Daily Beg Board — ${date}`,
          `${Number(data.total || 0).toLocaleString('en-US')} begs from ${Number(
            data.beggars || 0,
          ).toLocaleString('en-US')} people.`,
          top,
        ].filter(Boolean);
      }
    } catch {
      /* caption falls back to the date-only version */
    }
  }
  lines.push(`${mention} the people have spoken 🙏`);
  const text = lines.join('\n');
  return text.length > 275 ? `${text.slice(0, 272)}...` : text;
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

const text = await caption();

if (dryRun) {
  console.log('--- dry run, nothing sent ---');
  console.log(text);
  console.log(`image: ${imagePath}`);
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
