/**
 * Admin-token-only service for a GitHub Pages dashboard.
 * This service DOES NOT issue GPT Yar / api.gptyar.com credentials.
 * No subscriber or end-user token routes exist in this service.
 */
const encoder = new TextEncoder();
const DAY = 86_400_000;
const SESSION_MS = 60 * 60 * 1000;
const MAX_JSON_SIZE = 2048;

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
function err(message, code = 400) { return json({ error: message }, code); }
function rand(bytes = 32) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(arr);
}
function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(text) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))); }
async function tokenHash(text, pepper) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text))));
}
function allowed(env, id) { return String(env.ALLOWED_GITHUB_IDS || '').split(',').map(s => s.trim()).filter(Boolean).includes(String(id)); }
function frontend(env) {
  const url = new URL(env.FRONTEND_URL);
  if (url.protocol !== 'https:' || url.search || url.hash) throw new Error('FRONTEND_URL must be a clean HTTPS URL');
  return url;
}
function cors(request, env) {
  const origin = request.headers.get('Origin');
  return origin && origin === frontend(env).origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  } : {};
}
function finish(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors(request, env))) headers.set(k, v);
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(response.body, { status: response.status, headers });
}
function go(url, headers = {}) { return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers } }); }
function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const found = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return found ? found.slice(name.length + 1) : '';
}
const expiredStateCookie = 'admin_oauth_state=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
async function bodyJSON(request) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_JSON_SIZE) return null;
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return null;
  const raw = await request.text(); if (raw.length > MAX_JSON_SIZE) return null;
  try { const result = JSON.parse(raw); return result && typeof result === 'object' && !Array.isArray(result) ? result : null; }
  catch { return null; }
}
function validDays(days) { return Number.isInteger(days) && [7, 30, 90].includes(days); }
function stamp(ms = Date.now()) { return new Date(ms).toISOString(); }
function present(row) {
  return { id: row.id, label: row.label, created_at: row.created_at, expires_at: row.expires_at, revoked_at: row.revoked_at, created_by: row.created_by, rotated_from: row.rotated_from };
}
function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{35,200})$/.exec(h);
  return match ? match[1] : '';
}
async function auth(request, env) {
  const session = bearer(request);
  if (!session) return null;
  const digest = await sha256(session);
  const row = await env.DB.prepare('SELECT github_id, github_login, expires_at FROM sessions WHERE session_hash = ?').bind(digest).first();
  if (!row || row.expires_at <= stamp() || !allowed(env, row.github_id)) return null;
  return { id: row.github_id, login: row.github_login };
}
async function oauthStart(env) {
  const state = rand(24);
  const callback = new URL('/auth/callback', env.PUBLIC_WORKER_ORIGIN).toString();
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', callback);
  u.searchParams.set('scope', 'read:user');
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  return go(u.toString(), { 'Set-Cookie': `admin_oauth_state=${state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600` });
}
async function oauthCallback(request, env) {
  const url = new URL(request.url);
  const home = frontend(env).toString();
  const fail = (message) => go(home + '#error=' + encodeURIComponent(message), { 'Set-Cookie': expiredStateCookie });
  const state = url.searchParams.get('state') || '';
  const fromCookie = cookie(request, 'admin_oauth_state');
  if (!state || state.length < 20 || !fromCookie || state !== fromCookie) return fail('invalid_state');
  if (!url.searchParams.get('code') || url.searchParams.has('error')) return fail('oauth_denied');
  const redirectUri = new URL('/auth/callback', env.PUBLIC_WORKER_ORIGIN).toString();
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: redirectUri })
  });
  if (!response.ok) return fail('oauth_exchange_failed');
  const grant = await response.json();
  if (typeof grant.access_token !== 'string') return fail('oauth_exchange_failed');
  const account = await fetch('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'extensions-admin-token-panel', Authorization: `Bearer ${grant.access_token}` }
  });
  if (!account.ok) return fail('oauth_profile_failed');
  const profile = await account.json();
  if (!profile.id || !allowed(env, profile.id)) return fail('access_denied');
  const secret = rand(32);
  await env.DB.prepare('INSERT INTO sessions (session_hash,github_id,github_login,expires_at) VALUES (?,?,?,?)')
    .bind(await sha256(secret), String(profile.id), String(profile.login || '').slice(0, 80), stamp(Date.now() + SESSION_MS)).run();
  return go(home + '#session=' + encodeURIComponent(secret), { 'Set-Cookie': expiredStateCookie });
}
async function tokenList(env) {
  const { results } = await env.DB.prepare('SELECT id,label,created_at,expires_at,revoked_at,created_by,rotated_from FROM admin_tokens ORDER BY created_at DESC LIMIT 200').all();
  return json({ tokens: results.map(present) });
}
async function auditList(env) {
  const { results } = await env.DB.prepare('SELECT action,actor_login,token_id,created_at FROM audit_events ORDER BY id DESC LIMIT 75').all();
  return json({ events: results });
}
function audit(env, action, user, id) {
  return env.DB.prepare('INSERT INTO audit_events(action,actor_id,actor_login,token_id,created_at) VALUES(?,?,?,?,?)')
    .bind(action, String(user.id), user.login, id, stamp());
}
async function issue(request, env, user) {
  const params = await bodyJSON(request);
  if (!params || typeof params.label !== 'string' || params.label.trim().length < 2 || params.label.trim().length > 60 || !validDays(params.days)) return err('عنوان ۲ تا ۶۰ نویسه و اعتبار ۷، ۳۰ یا ۹۰ روز الزامی است.');
  const label = params.label.trim();
  const id = crypto.randomUUID(); const secret = 'adm_' + rand(32); const createdAt = stamp();
  const expires = stamp(Date.now() + params.days * DAY);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO admin_tokens(id,label,token_hash,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?)')
      .bind(id, label, await tokenHash(secret, env.TOKEN_PEPPER), createdAt, expires, String(user.id)),
    audit(env, 'issue', user, id)
  ]);
  return json({ token: secret, id, expires_at: expires }, 201);
}
async function mutate(request, env, user, id, action) {
  const row = await env.DB.prepare('SELECT * FROM admin_tokens WHERE id=?').bind(id).first();
  if (!row) return err('توکن مدیریتی پیدا نشد.', 404);
  if (row.revoked_at) return err('این توکن قبلاً لغو شده است.', 409);
  const now = Date.now();
  if (action !== 'extend' && new Date(row.expires_at).getTime() <= now) return err('توکن منقضی‌شده را نمی‌توان چرخش یا لغو کرد.', 409);
  if (action === 'revoke') {
    const result = await env.DB.prepare('UPDATE admin_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .bind(stamp(now), id).run();
    if (!result.meta.changes) return err('توکن قبلاً لغو شده است.', 409);
    await audit(env, action, user, id).run();
    return json({ ok: true });
  }
  if (action === 'extend') {
    const params = await bodyJSON(request);
    if (!params || !validDays(params.days)) return err('مدت تمدید باید ۷، ۳۰ یا ۹۰ روز باشد.');
    const base = Math.max(now, new Date(row.expires_at).getTime());
    const newExpiry = base + params.days * DAY;
    if (newExpiry > now + 365 * DAY) return err('اعتبار یک توکن نباید بیش از ۳۶۵ روز از امروز باشد.');
    const result = await env.DB.prepare('UPDATE admin_tokens SET expires_at=? WHERE id=? AND revoked_at IS NULL AND expires_at=?')
      .bind(stamp(newExpiry), id, row.expires_at).run();
    if (!result.meta.changes) return err('اطلاعات توکن تغییر کرده است. دوباره تلاش کنید.', 409);
    await audit(env, action, user, id).run();
    return json({ ok: true, expires_at: stamp(newExpiry) });
  }
  if (action === 'rotate') {
    const newID = crypto.randomUUID(); const token = 'adm_' + rand(32); const newExpiry = row.expires_at;
    // D1 batches are transactional; UNIQUE(rotated_from) prevents concurrent double-rotation.
    await env.DB.batch([
      env.DB.prepare('UPDATE admin_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(stamp(now), id),
      env.DB.prepare('INSERT INTO admin_tokens(id,label,token_hash,created_at,expires_at,created_by,rotated_from) VALUES(?,?,?,?,?,?,?)')
        .bind(newID, row.label, await tokenHash(token, env.TOKEN_PEPPER), stamp(now), newExpiry, String(user.id), id),
      audit(env, 'rotate', user, id)
    ]);
    return json({ ok: true, token, id: newID, expires_at: newExpiry });
  }
  return err('مسیر مجاز نیست.', 404);
}
async function introspect(request, env) {
  const provided = bearer(request);
  if (!provided || !env.INTROSPECTION_KEY || (await sha256(provided)) !== (await sha256(env.INTROSPECTION_KEY))) return err('غیرمجاز', 401);
  const data = await bodyJSON(request);
  if (!data || typeof data.token !== 'string' || !/^adm_[A-Za-z0-9_-]{43}$/.test(data.token)) return err('قالب توکن نامعتبر است.');
  const digest = await tokenHash(data.token, env.TOKEN_PEPPER);
  const row = await env.DB.prepare('SELECT id,label,expires_at,revoked_at FROM admin_tokens WHERE token_hash=?').bind(digest).first();
  if (!row || row.revoked_at || row.expires_at <= stamp()) return json({ active: false });
  return json({ active: true, id: row.id, label: row.label, expires_at: row.expires_at, scope: 'admin' });
}
export default {
  async fetch(request, env) {
    try {
      if (!env.DB || !env.FRONTEND_URL || !env.PUBLIC_WORKER_ORIGIN || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32 || !env.ALLOWED_GITHUB_IDS) return err('پیکربندی امن سرور کامل نیست.', 503);
      const url = new URL(request.url); const path = url.pathname;
      // Reject requests addressed to anything but this worker's exact public origin.
      if (url.origin !== new URL(env.PUBLIC_WORKER_ORIGIN).origin) return err('نشانی نامعتبر است.', 403);
      if (request.method === 'OPTIONS') {
        if (path.startsWith('/api/') && path !== '/api/introspect' && request.headers.get('Origin') === frontend(env).origin) {
          return finish(new Response(null, { status: 204 }), request, env);
        }
        return err('غیرمجاز', 403);
      }
      if (path === '/auth/start' && request.method === 'GET') return oauthStart(env);
      if (path === '/auth/callback' && request.method === 'GET') return oauthCallback(request, env);
      if (path === '/api/introspect' && request.method === 'POST') return introspect(request, env);
      if (!path.startsWith('/api/')) return err('مسیر وجود ندارد.', 404);
      const origin = request.headers.get('Origin');
      if (origin && origin !== frontend(env).origin) return err('مبدأ غیرمجاز است.', 403);
      const user = await auth(request, env);
      if (!user) return finish(err('برای این عملیات احراز هویت مدیر لازم است.', 401), request, env);
      let response;
      if (path === '/api/me' && request.method === 'GET') response = json({ user });
      else if (path === '/api/logout' && request.method === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE session_hash = ?').bind(await sha256(bearer(request))).run();
        response = json({ ok: true });
      } else if (path === '/api/admin-tokens' && request.method === 'GET') response = await tokenList(env);
      else if (path === '/api/admin-tokens' && request.method === 'POST') response = await issue(request, env, user);
      else if (path === '/api/audit' && request.method === 'GET') response = await auditList(env);
      else {
        const hit = /^\/api\/admin-tokens\/([a-f0-9-]{36})\/(revoke|rotate|extend)$/.exec(path);
        response = hit && request.method === 'POST' ? await mutate(request, env, user, hit[1], hit[2]) : err('مسیر پشتیبانی نمی‌شود.', 404);
      }
      return finish(response, request, env);
    } catch (e) {
      // Do not return backend internals, raw secrets, or SQL to visitors.
      console.error('Admin worker failed:', e instanceof Error ? e.name : 'unknown');
      return err('خطای داخلی سرور؛ پیکربندی یا اتصال پایگاه داده را بررسی کنید.', 500);
    }
  }
};
