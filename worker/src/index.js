// Tibo Beg - API worker.
// Google OAuth (needs client_secret, hence a server), session minting,
// and a thin router in front of the BegRoom Durable Object.

export { BegRoom } from './room.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// Deliberately no `email` scope. The leaderboard needs a name and a picture;
// asking for an address we would never show is a liability, not a feature.
const SCOPE = 'openid profile';

// Identity ids are namespaced by provider so a second provider could never
// collide with a Google `sub`.
const UID_PREFIX = 'google:';

const SESSION_TTL = 60 * 60 * 24 * 30; // 30d
const STATE_TTL = 60 * 10; // 10min

// ---------------------------------------------------------------- utilities

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

// Compact signed token: base64url(payload).base64url(hmac). Not a full JWT --
// we control both ends, so the header buys nothing.
async function sign(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

async function verify(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(mac), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function corsHeaders(req, env) {
  const origin = req.headers.get('origin');
  const allow = allowedOrigins(env);
  const h = {
    vary: 'origin',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
  };
  if (origin && allow.includes(origin.replace(/\/$/, ''))) h['access-control-allow-origin'] = origin;
  return h;
}

function json(req, env, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req, env), ...extra },
  });
}

function safeRedirect(env, candidate) {
  const allow = allowedOrigins(env);
  try {
    const url = new URL(candidate);
    if (allow.includes(url.origin)) return url.toString();
  } catch {
    /* fall through to the default below */
  }
  // APP_URL first: on a project site the allowed origin is the bare host, and
  // landing a failed sign-in there is a 404, not the app.
  return String(env.APP_URL || '') || allow[0] || '';
}

function room(env) {
  return env.BEG_ROOM.get(env.BEG_ROOM.idFromName(env.ROOM_NAME || 'global'));
}

async function bearer(req, env) {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : new URL(req.url).searchParams.get('t');
  return token ? verify(token, env.SESSION_SECRET) : null;
}

// ---------------------------------------------------------------- oauth flow

async function authStart(req, env) {
  const url = new URL(req.url);
  const back = safeRedirect(env, url.searchParams.get('redirect') || '');
  // Without these the redirect would carry client_id=undefined and the visitor
  // would land on a Meta error page with no idea what went wrong.
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.redirect(`${back}#error=google_not_configured`, 302);
  }
  const state = await sign(
    { r: back, n: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + STATE_TTL },
    env.SESSION_SECRET,
  );
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${url.origin}/api/auth/google/callback`);
  authorize.searchParams.set('scope', SCOPE);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('state', state);
  // Skip the account chooser only when the visitor has one account anyway.
  authorize.searchParams.set('prompt', 'select_account');
  return Response.redirect(authorize.toString(), 302);
}

async function authCallback(req, env) {
  const url = new URL(req.url);
  const state = await verify(url.searchParams.get('state') || '', env.SESSION_SECRET);
  const back = safeRedirect(env, state?.r || '');
  const fail = (why) => Response.redirect(`${back}#error=${encodeURIComponent(why)}`, 302);

  if (!state) return fail('bad_state');
  const code = url.searchParams.get('code');
  // Google reports a cancelled consent as error=access_denied with no code.
  // Passing the provider's own error through keeps "I changed my mind" from
  // being reported to the user as a failure.
  if (!code) return fail(url.searchParams.get('error') || 'no_code');

  const form = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: `${url.origin}/api/auth/google/callback`,
    code,
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const token = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !token?.access_token) return fail('token_exchange_failed');

  const profileRes = await fetch(PROFILE_URL, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const profile = await profileRes.json().catch(() => null);
  if (!profileRes.ok || !profile?.sub) return fail('profile_failed');

  // The Google access token has done its job (identity). We deliberately do not
  // store it -- nothing downstream acts on the user's behalf. `sub` is Google's
  // stable opaque id; `email` was never requested, so there is none to leak.
  const session = await sign(
    {
      uid: UID_PREFIX + String(profile.sub),
      un: String(profile.name || 'anonymous'),
      av: String(profile.picture || ''),
      cc: (req.cf && req.cf.country) || null,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    },
    env.SESSION_SECRET,
  );
  return Response.redirect(`${back}#token=${encodeURIComponent(session)}`, 302);
}

// ---------------------------------------------------------------- entrypoint

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });

    if (path === '/api/auth/google/start') return authStart(req, env);
    if (path === '/api/auth/google/callback') return authCallback(req, env);

    if (path === '/api/me') {
      const session = await bearer(req, env);
      if (!session) return json(req, env, { error: 'unauthorized' }, 401);
      // The chosen name lives in the Durable Object, not in the token, so that
      // renaming takes effect without forcing a re-login.
      const stored = await room(env)
        .fetch(`https://room/profile?uid=${encodeURIComponent(session.uid)}`)
        .then((r) => r.json())
        .catch(() => null);
      return json(req, env, {
        uid: session.uid,
        username: stored?.display_name || session.un,
        provider_name: session.un,
        display_name: stored?.display_name || null,
        avatar: session.av,
        country: session.cc,
        // Without these the button's personal counter restarts at 0 on reload
        // for anyone who is not in the top slice of the board.
        count: stored?.count ?? 0,
        rank: stored?.rank ?? null,
      });
    }

    if (path === '/api/name' && req.method === 'POST') {
      const session = await bearer(req, env);
      if (!session) return json(req, env, { error: 'unauthorized' }, 401);
      const payload = await req.json().catch(() => ({}));
      const res = await room(env).fetch('https://room/name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uid: session.uid,
          un: session.un,
          av: session.av,
          cc: session.cc,
          name: payload?.name ?? null,
        }),
      });
      const body = await res.json().catch(() => null);
      return json(req, env, body ?? { error: 'upstream' }, res.status);
    }

    if (path === '/api/live') {
      if (req.headers.get('upgrade') !== 'websocket') return json(req, env, { error: 'expected_websocket' }, 426);
      return room(env).fetch(new Request(`https://room/ws${url.search}`, req));
    }

    if (path === '/api/leaderboard' || path === '/api/stats') {
      const limit = url.searchParams.get('limit') || '25';
      const res = await room(env).fetch(`https://room/board?limit=${encodeURIComponent(limit)}`);
      // The client picks its language from this when the browser's own language
      // tags did not already settle it. Country only -- never anything finer.
      const body = await res.json().catch(() => null);
      if (body && typeof body === 'object') body.viewer_country = (req.cf && req.cf.country) || null;
      return json(req, env, body ?? { error: 'upstream' }, res.status);
    }

    if (path === '/api/beg' && req.method === 'POST') {
      const session = await bearer(req, env);
      if (!session) return json(req, env, { error: 'unauthorized' }, 401);
      const payload = await req.json().catch(() => ({}));
      const res = await room(env).fetch('https://room/beg', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uid: session.uid,
          un: session.un,
          av: session.av,
          cc: session.cc,
          n: payload?.n,
          request_id: payload?.request_id,
        }),
      });
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req, env) },
      });
    }

    return json(req, env, { error: 'not_found' }, 404);
  },
};
