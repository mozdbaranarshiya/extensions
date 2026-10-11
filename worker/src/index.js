/** GPT Yar admin gateway. All privileges are verified by GPT Yar itself, every request. */
const DEFAULT_GPTYAR = 'https://api.gptyar.com';
const MAX_TOKEN = 512;
const MAX_JSON = 450_000;
const METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const secure = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...secure, 'Content-Type': 'application/json; charset=utf-8' } });
}
function fail(message, status = 400) { return response({ error: message }, status); }
function frontOrigin(env) { try { const u = new URL(env.FRONTEND_URL); return u.protocol === 'https:' ? u.origin : ''; } catch { return ''; } }
function upstreamOrigin(env) { const url = new URL(DEFAULT_GPTYAR); return url.origin; }
function cors(res, request, env) {
  const origin = request.headers.get('Origin');
  const headers = new Headers(res.headers);
  if (origin === frontOrigin(env)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', METHODS);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Max-Age', '300');
    headers.set('Vary', 'Origin');
  }
  for (const [key, val] of Object.entries(secure)) headers.set(key, val);
  return new Response(res.body, { status: res.status, headers });
}
function validToken(token) {
  return typeof token === 'string' && token.length >= 2 && token.length <= MAX_TOKEN && /^@[^\s\u0000-\u001f\u007f]+$/.test(token);
}
function parseBearer(req) {
  const authorization = req.headers.get('Authorization') || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}
async function readJSON(request) {
  const length = Number(request.headers.get('Content-Length') || '0');
  if (length > MAX_JSON) return null;
  const body = await request.text();
  if (body.length > MAX_JSON) return null;
  try { const value = JSON.parse(body); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
async function gptyar(path, method, token, payload = undefined) {
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  const resp = await fetch(`${DEFAULT_GPTYAR}${path}`, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
    redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); } catch { return { ok: false, status: 502, data: null }; }
  return { ok: resp.ok, status: resp.status, data };
}
async function authorize(token, env) {
  if (!validToken(token)) return null;
  const v = await gptyar('/accupdator/validate', 'POST', token, { token, version: env.EXTENSION_VERSION || '4.6.4' });
  if (!v.ok || !v.data || typeof v.data !== 'object') return null;
  // Same positive validation signals used by the extension, *plus* HTTP success.
  if (!v.data.message || !v.data.account || !v.data.agent) return null;
  return v.data;
}
function safeId(s) { return typeof s === 'string' && s.length > 0 && s.length <= 160 && /^[\p{L}\p{N}_:-]+$/u.test(s); }
function dateValue(s) { return typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s)) && Date.parse(s) > Date.now() - 86_400_000; }
function safeCookieTypes(s) { return typeof s === 'string' && ['gpt', 'grok', 'claude', 'midjourney'].includes(s); }
function upstreamResult(result) {
  if (result.ok) return response(result.data);
  if (result.status === 401 || result.status === 403) return fail('مجوز توکن مدیریتی در GPT Yar رد شد.', 401);
  return fail(`سرویس GPT Yar عملیات را نپذیرفت (کد ${result.status}).`, result.status >= 400 && result.status < 500 ? result.status : 502);
}
async function handle(request, env) {
  if (!frontOrigin(env)) return fail('تنظیم FRONTEND_URL در Worker ضروری است.', 503);
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return fail('مسیر پیدا نشد.', 404);
  const origin = request.headers.get('Origin');
  if (origin && origin !== frontOrigin(env)) return fail('مبدأ درخواست مجاز نیست.', 403);
  if (request.method === 'OPTIONS') {
    if (origin !== frontOrigin(env)) return fail('مبدأ مجاز نیست.', 403);
    return new Response(null, { status: 204, headers: secure });
  }
  const path = url.pathname;
  // Login accepts a token only in POST body, never URL or browser storage.
  if (path === '/api/login' && request.method === 'POST') {
    const body = await readJSON(request);
    if (!body || !validToken(body.token)) return fail('فقط توکن مدیریتی که با @ شروع می‌شود قابل ورود است.', 401);
    const profile = await authorize(body.token, env);
    return profile ? response({ ok: true, profile }) : fail('توکن مدیریتی توسط GPT Yar تأیید نشد.', 401);
  }
  const token = parseBearer(request);
  if (!validToken(token)) return fail('فقط مدیر مجاز است؛ توکن کاربران پذیرفته نمی‌شود.', 401);
  const profile = await authorize(token, env);
  if (!profile) return fail('توکن مدیریتی نامعتبر یا منقضی است.', 401);
  if (path === '/api/account' && request.method === 'GET') return response({ profile });
  if (path === '/api/subscribers' && request.method === 'GET') return upstreamResult(await gptyar('/accupdator/subscribers/all', 'GET', token));
  if (path === '/api/subscribers' && request.method === 'POST') {
    const data = await readJSON(request);
    const name = data && typeof data.name === 'string' ? data.name.trim() : '';
    if (name.length < 1 || name.length > 100 || (data.expiresAt && !dateValue(data.expiresAt))) return fail('نام یا تاریخ انقضا معتبر نیست.');
    return upstreamResult(await gptyar('/accupdator/subscribers/create', 'POST', token, { name, ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}) }));
  }
  const match = /^\/api\/subscribers\/([^/]+)$/.exec(path);
  if (match && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const id = decodeURIComponent(match[1]);
    if (!safeId(id)) return fail('شناسهٔ اشتراک معتبر نیست.');
    if (request.method === 'DELETE') return upstreamResult(await gptyar('/accupdator/subscribers/delete', 'DELETE', token, { subscriptionId: id }));
    const data = await readJSON(request);
    if (!data || !dateValue(data.expiresAt)) return fail('تاریخ جدید معتبر نیست.');
    return upstreamResult(await gptyar('/accupdator/subscribers/update', 'PATCH', token, { subscriptionId: id, expiresAt: data.expiresAt }));
  }
  if (path === '/api/cookies/status' && request.method === 'GET') return upstreamResult(await gptyar('/accupdator/fetch-cookies', 'POST', token, { token }));
  if (path === '/api/cookies' && request.method === 'DELETE') return upstreamResult(await gptyar('/accupdator/delete-cookies', 'DELETE', token, { token }));
  if (path === '/api/cookies' && request.method === 'POST') {
    const data = await readJSON(request);
    if (!data || !safeCookieTypes(data.cookie_type) || !Array.isArray(data.cookies) || data.cookies.length > 300 || !data.cookies.length) return fail('نوع سرویس یا آرایهٔ کوکی‌ها معتبر نیست.');
    const cookies = data.cookies.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const { name, value, domain, path, expirationDate } = item;
      if (typeof name !== 'string' || !name || name.length > 150 || typeof value !== 'string' || value.length > 12000 || typeof domain !== 'string' || domain.length > 250 || typeof path !== 'string' || path.length > 250) return null;
      return { name, value, domain, path, expirationDate: Number.isFinite(Number(expirationDate)) ? Number(expirationDate) : 0 };
    });
    if (cookies.includes(null)) return fail('ساختار کوکی معتبر نیست.');
    return upstreamResult(await gptyar('/accupdator/update-cookies', 'POST', token, { token, cookie_type: data.cookie_type, cookies }));
  }
  if (path === '/api/proxies' && request.method === 'GET') {
    // Read-only proxy listing: browser proxy switching needs extension permissions.
    return upstreamResult(await gptyar('/client/proxy-info', 'POST', token, { token }));
  }
  return fail('این عملیات در فهرست مجاز مدیریت وجود ندارد.', 404);
}
export default {
  async fetch(request, env) {
    try { return cors(await handle(request, env), request, env); }
    catch (e) { console.error('Admin gateway error:', e instanceof Error ? e.name : 'unknown'); return cors(fail('ارتباط ایمن با GPT Yar برقرار نشد؛ دوباره تلاش کنید.', 502), request, env); }
  }
};
