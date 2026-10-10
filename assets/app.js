(() => {
  'use strict';
  const config = window.ADMIN_PANEL_CONFIG || {};
  const apiBase = typeof config.API_BASE_URL === 'string' ? config.API_BASE_URL.trim().replace(/\/+$/, '') : '';
  const $ = (id) => document.getElementById(id);
  const state = { session: '', user: null, tokens: [], audit: [], busy: false, action: null };
  const pages = { overview: 'نمای کلی', tokens: 'توکن‌های مدیریتی', audit: 'گزارش فعالیت‌ها', settings: 'راه‌اندازی' };
  let toastTimer;

  function toast(message, error = false) {
    const el = $('toast'); el.textContent = message; el.className = `toast${error ? ' error' : ''}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
  }
  function notice(message) { $('notice').textContent = message; $('notice').classList.toggle('show', Boolean(message)); }
  function goto(page) {
    if (!Object.hasOwn(pages, page)) return;
    for (const key of Object.keys(pages)) $('page-' + key).classList.toggle('hidden', page !== key);
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.toggle('active', el.dataset.page === page));
    $('breadcrumbTitle').textContent = pages[page];
  }
  function time(iso) {
    if (!iso) return '—';
    const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('fa-IR-u-ca-gregory', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
  }
  function status(t) {
    if (t.revoked_at) return ['لغوشده', 'revoked'];
    if (new Date(t.expires_at).getTime() <= Date.now()) return ['منقضی', 'expired'];
    return ['فعال', 'active'];
  }
  function td(tr, val, cls = '') { const cell = document.createElement('td'); cell.textContent = val; if (cls) cell.className = cls; tr.appendChild(cell); return cell; }
  function makeButton(parent, title, action, token, disabled = false, dangerous = false) {
    const b = document.createElement('button'); b.type = 'button'; b.className = `mini-btn${dangerous ? ' danger' : ''}`;
    b.textContent = title; b.disabled = disabled; b.addEventListener('click', () => openAction(action, token)); parent.appendChild(b);
  }
  function renderTokens() {
    const tbody = $('tokensBody'); tbody.replaceChildren();
    if (!state.user) { const tr = document.createElement('tr'); td(tr, 'برای مشاهدهٔ توکن‌ها وارد شوید.', 'table-empty').colSpan = 5; tbody.appendChild(tr); return; }
    if (!state.tokens.length) { const tr = document.createElement('tr'); td(tr, 'هنوز توکن مدیریتی صادر نشده است.', 'table-empty').colSpan = 5; tbody.appendChild(tr); return; }
    for (const t of state.tokens) {
      const tr = document.createElement('tr');
      const name = td(tr, t.label || 'بدون عنوان');
      const id = document.createElement('small'); id.className = 'meta'; id.textContent = `ID: ${t.id.slice(0, 8)}`; name.appendChild(id);
      const s = td(tr, ''); const pill = document.createElement('span'); const [label, key] = status(t); pill.textContent = label; pill.className = `token-state ${key}`; s.appendChild(pill);
      td(tr, time(t.created_at)); td(tr, time(t.expires_at));
      const actions = td(tr, ''); const buttons = document.createElement('div'); buttons.className = 'table-actions'; actions.appendChild(buttons);
      const disabled = key !== 'active';
      makeButton(buttons, 'تمدید', 'extend', t, key === 'revoked');
      makeButton(buttons, 'چرخش', 'rotate', t, disabled);
      makeButton(buttons, 'لغو', 'revoke', t, disabled, true);
      tbody.appendChild(tr);
    }
  }
  function renderAudit(target, limit) {
    const host = $(target); host.replaceChildren();
    if (!state.user || !state.audit.length) { const el = document.createElement('div'); el.className = 'empty-mini'; el.textContent = state.user ? 'رویدادی ثبت نشده است.' : 'پس از ورود، رویدادها نمایش داده می‌شوند.'; host.appendChild(el); return; }
    const labels = { issue: 'صدور توکن مدیریتی', rotate: 'چرخش توکن مدیریتی', extend: 'تمدید اعتبار توکن', revoke: 'لغو توکن مدیریتی' };
    for (const event of state.audit.slice(0, limit)) {
      const item = document.createElement('div'); item.className = 'feed-item';
      const badge = document.createElement('span'); badge.className = 'feed-mark'; badge.textContent = '✓';
      const body = document.createElement('div'); const title = document.createElement('strong'); title.textContent = labels[event.action] || event.action;
      const meta = document.createElement('p'); meta.textContent = `${event.actor_login || 'مدیر'} · ${time(event.created_at)} · شناسه ${String(event.token_id || '').slice(0, 8)}`;
      body.append(title, meta); item.append(badge, body); host.appendChild(item);
    }
  }
  function render() {
    const counts = { active: 0, revoked: 0, expired: 0 };
    state.tokens.forEach(t => counts[status(t)[1]]++);
    $('activeCount').textContent = state.user ? String(counts.active) : '—';
    $('revokedCount').textContent = state.user ? String(counts.revoked) : '—';
    $('expiredCount').textContent = state.user ? String(counts.expired) : '—';
    $('identity').textContent = state.user ? `@${state.user.login}` : 'ورود انجام نشده';
    $('signInBtn').classList.toggle('hidden', Boolean(state.user));
    $('signOutBtn').classList.toggle('hidden', !state.user);
    $('createTokenBtn').disabled = !state.user || state.busy;
    $('connectionStatus').textContent = state.user ? '● اتصال ایمن برقرار است' : apiBase ? '● اتصال تعریف شده' : '● در انتظار پیکربندی';
    $('connectionStatus').classList.toggle('online', Boolean(state.user));
    $('apiUrlText').textContent = apiBase || 'تنظیم نشده';
    renderTokens(); renderAudit('recentAudit', 4); renderAudit('auditList', 50);
  }
  async function api(path, opts = {}) {
    if (!apiBase || !state.session) throw new Error('ابتدا باید وارد شوید و اتصال API را تنظیم کنید.');
    const res = await fetch(apiBase + path, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${state.session}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store', credentials: 'omit'
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) { signOut(false); throw new Error('نشست شما منقضی شده یا اجازهٔ دسترسی ندارید.'); }
    if (!res.ok) throw new Error(data.error || `خطای سرور (${res.status})`);
    return data;
  }
  async function refresh() {
    if (!state.session) return;
    try {
      const [tokens, audit] = await Promise.all([api('/api/admin-tokens'), api('/api/audit')]);
      state.tokens = Array.isArray(tokens.tokens) ? tokens.tokens : [];
      state.audit = Array.isArray(audit.events) ? audit.events : [];
      render();
    } catch (e) { toast(e.message, true); }
  }
  function signOut(callServer = true) {
    const old = state.session; state.session = ''; state.user = null; state.tokens = []; state.audit = []; render();
    if (callServer && old && apiBase) fetch(apiBase + '/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${old}` }, credentials: 'omit' }).catch(() => {});
  }
  function getSessionFromFragment() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const session = hash.get('session'); const problem = hash.get('error');
    if (session || problem) history.replaceState(null, '', location.pathname + location.search);
    if (problem) toast(problem === 'access_denied' ? 'این حساب در فهرست مدیران مجاز نیست.' : 'احراز هویت ناموفق بود.', true);
    if (session && /^[A-Za-z0-9_-]{35,}$/.test(session)) state.session = session;
  }
  async function initAuth() {
    if (!state.session) return;
    try { const result = await api('/api/me'); state.user = result.user; notice(''); render(); await refresh(); }
    catch (e) { signOut(false); toast(e.message, true); }
  }
  function showSecret(value) { $('secretValue').value = value; $('secretDialog').showModal(); }
  function openAction(action, token) {
    if (!state.user || status(token)[1] !== 'active') return;
    state.action = { action, token };
    const labels = { revoke: ['لغو توکن', 'پس از لغو، توکن دیگر معتبر نخواهد بود. این عملیات قابل بازگشت نیست.'], rotate: ['چرخش توکن', 'توکن فعلی باطل می‌شود و مقدار جدید فقط یک بار نمایش داده خواهد شد.'], extend: ['تمدید توکن', 'به مدت اعتبار توکن مدیریتی افزوده می‌شود.'] };
    $('actionTitle').textContent = labels[action][0]; $('actionDescription').textContent = `${labels[action][1]}\nعنوان: ${token.label}`;
    $('extendFields').classList.toggle('hidden', action !== 'extend'); $('confirmActionBtn').className = `button ${action === 'revoke' ? 'danger' : 'primary'}`;
    $('actionDialog').showModal();
  }
  async function runMutation(path, payload) {
    if (state.busy) return;
    state.busy = true; render();
    try {
      const result = await api(path, { method: 'POST', body: payload || {} });
      document.querySelectorAll('dialog[open]').forEach(d => d.close());
      if (result.token) showSecret(result.token);
      await refresh(); toast('عملیات مدیریتی با موفقیت انجام شد.');
    } catch (e) { toast(e.message, true); }
    finally { state.busy = false; render(); }
  }
  function wire() {
    document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => goto(el.dataset.page)));
    document.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => goto(el.dataset.goto)));
    document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $(el.dataset.close).close()));
    $('signInBtn').addEventListener('click', () => {
      if (!apiBase || !/^https:\/\//.test(apiBase)) { goto('settings'); toast('ابتدا نشانی HTTPS سرویس API را در فایل config.js تنظیم کنید.', true); return; }
      window.location.assign(apiBase + '/auth/start');
    });
    $('signOutBtn').addEventListener('click', () => signOut());
    $('createTokenBtn').addEventListener('click', () => $('createDialog').showModal());
    $('refreshBtn').addEventListener('click', refresh);
    $('auditRefreshBtn').addEventListener('click', refresh);
    $('createForm').addEventListener('submit', e => {
      e.preventDefault(); const form = e.currentTarget;
      runMutation('/api/admin-tokens', { label: $('tokenLabel').value.trim(), days: Number($('tokenDays').value) }); form.reset();
    });
    $('confirmActionBtn').addEventListener('click', () => {
      if (!state.action) return;
      const { action, token } = state.action;
      runMutation(`/api/admin-tokens/${encodeURIComponent(token.id)}/${action}`, action === 'extend' ? { days: Number($('extendDays').value) } : {});
      state.action = null;
    });
    $('copySecretBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('secretValue').value); toast('توکن کپی شد.'); } catch { toast('کپی خودکار ممکن نبود؛ مقدار را دستی کپی کنید.', true); } });
    $('secretDialog').addEventListener('close', () => { $('secretValue').value = ''; });
  }
  wire(); getSessionFromFragment(); render();
  if (!apiBase) notice('برای فعال‌شدن عملیات واقعی، ابتدا Cloudflare Worker را راه‌اندازی کرده و نشانی آن را در config.js قرار دهید.');
  initAuth();
})();
