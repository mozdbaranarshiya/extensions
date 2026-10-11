import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../src/index.js';
const env = { FRONTEND_URL: 'https://mozdbaranarshiya.github.io/extensions/', EXTENSION_VERSION: '4.6.4' };
const origin = 'https://mozdbaranarshiya.github.io';
const worker = 'https://example.workers.dev';
const saved = globalThis.fetch;
function req(path, method = 'GET', token = '', body = undefined, headers = {}) {
  return new Request(worker + path, {
    method,
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
function fakeServer() {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...options, bodyJSON: options.body ? JSON.parse(options.body) : undefined });
    if (path === '/accupdator/validate') {
      const token = options.body && JSON.parse(options.body).token;
      return Response.json(token === '@valid' ? { message: 'ok', account: { name: 'Admin' }, agent: { type: 'gpt' } } : { message: 'token rejected' }, { status: token === '@valid' ? 200 : 401 });
    }
    if (path === '/accupdator/subscribers/all') return Response.json({ subscribers: [{ subscriptionId: 'x1', name: 'Customer', token: 'user-1' }] });
    return Response.json({ message: 'ok' });
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = saved; });
test('rejects normal user token on login BEFORE contacting upstream', async () => {
  const calls = fakeServer();
  const res = await handler.fetch(req('/api/login', 'POST', '', { token: 'ordinary-user' }), env);
  assert.equal(res.status, 401); assert.equal(calls.length, 0);
});
test('rejects fake @ admin tokens on server validation', async () => {
  const calls = fakeServer();
  const res = await handler.fetch(req('/api/login', 'POST', '', { token: '@fake' }), env);
  assert.equal(res.status, 401); assert.deepEqual(calls.map(c => c.path), ['/accupdator/validate']);
});
test('accepts only real upstream-validated @ administrator', async () => {
  const calls = fakeServer();
  const res = await handler.fetch(req('/api/login', 'POST', '', { token: '@valid' }), env);
  assert.equal(res.status, 200); assert.equal((await res.json()).profile.account.name, 'Admin');
  assert.equal(calls[0].bodyJSON.version, '4.6.4');
});
test('does not allow ordinary users on ANY manager action', async () => {
  const calls = fakeServer();
  const res = await handler.fetch(req('/api/subscribers', 'GET', 'not-admin'), env);
  assert.equal(res.status, 401); assert.equal(calls.length, 0);
});
test('revalidates admin token on every action and uses the correct upstream path', async () => {
  const calls = fakeServer();
  const res = await handler.fetch(req('/api/subscribers', 'GET', '@valid'), env);
  assert.equal(res.status, 200); assert.equal((await res.json()).subscribers[0].name, 'Customer');
  assert.deepEqual(calls.map(c => c.path), ['/accupdator/validate', '/accupdator/subscribers/all']);
});
test('allows GPT Yar subscriber operations for verified admins', async () => {
  const calls = fakeServer();
  const create = await handler.fetch(req('/api/subscribers', 'POST', '@valid', { name: 'New Subscriber' }), env);
  const edit = await handler.fetch(req('/api/subscribers/x1', 'PATCH', '@valid', { expiresAt: '2027-05-08T23:59:59.000Z' }), env);
  const remove = await handler.fetch(req('/api/subscribers/x1', 'DELETE', '@valid'), env);
  assert.equal(create.status, 200); assert.equal(edit.status, 200); assert.equal(remove.status, 200);
  assert.deepEqual(calls.filter(c => c.path !== '/accupdator/validate').map(c => c.path), ['/accupdator/subscribers/create', '/accupdator/subscribers/update', '/accupdator/subscribers/delete']);
});
test('blocks unknown passthrough endpoints, even for admins', async () => {
  const calls = fakeServer();
  const res = await handler.fetch(req('/api/client/validate', 'GET', '@valid'), env);
  assert.equal(res.status, 404); assert.equal(calls.length, 1);
});
test('does not authorize browser requests from other origins', async () => {
  const calls = fakeServer();
  const res = await handler.fetch(req('/api/login', 'POST', '', { token: '@valid' }, { Origin: 'https://evil.example' }), env);
  assert.equal(res.status, 403); assert.equal(calls.length, 0);
});
test('cookie updates use fixed service, validated structure, and never allow upstream URL injection', async () => {
  const calls = fakeServer();
  const bad = await handler.fetch(req('/api/cookies', 'POST', '@valid', { cookie_type: 'https://evil.example', cookies: [] }), env);
  assert.equal(bad.status, 400);
  const good = await handler.fetch(req('/api/cookies', 'POST', '@valid', { cookie_type: 'gpt', cookies: [{ name: 'safe', value: 'value', domain: '.chatgpt.com', path: '/' }] }), env);
  assert.equal(good.status, 200);
  const last = calls.at(-1);
  assert.equal(last.path, '/accupdator/update-cookies');
  assert.equal(last.bodyJSON.cookie_type, 'gpt'); assert.equal(last.bodyJSON.token, '@valid');
});
test('restricts proxy view to validated admin', async () => {
  const calls = fakeServer();
  const result = await handler.fetch(req('/api/proxies', 'GET', '@valid'), env);
  assert.equal(result.status, 200); assert.equal(calls.at(-1).path, '/client/proxy-info');
});
