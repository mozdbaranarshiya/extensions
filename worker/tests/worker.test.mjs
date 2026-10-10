import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const DB = new DatabaseSync(':memory:');
DB.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
const dbAdapter = {
  prepare(sql) {
    return {
      all: async () => ({ results: DB.prepare(sql).all() }),
      first: async () => DB.prepare(sql).get() || null,
      run: async () => ({ meta: { changes: DB.prepare(sql).run().changes } }),
      bind(...args) {
        return {
          first: async () => DB.prepare(sql).get(...args) || null,
          all: async () => ({ results: DB.prepare(sql).all(...args) }),
          run: async () => ({ meta: { changes: DB.prepare(sql).run(...args).changes } })
        };
      }
    };
  },
  async batch(statements) {
    DB.exec('BEGIN');
    try { for (const s of statements) await s.run(); DB.exec('COMMIT'); }
    catch (e) { DB.exec('ROLLBACK'); throw e; }
  }
};
const env = {
  DB: dbAdapter, FRONTEND_URL: 'https://mozdbaranarshiya.github.io/extensions/',
  PUBLIC_WORKER_ORIGIN: 'https://example.workers.dev', ALLOWED_GITHUB_IDS: '12345',
  GITHUB_CLIENT_ID: 'fake_test_client_id', GITHUB_CLIENT_SECRET: 'fake_test_client_secret',
  TOKEN_PEPPER: 'long-test-only-pepper-not-a-real-secret--123',
  INTROSPECTION_KEY: 'different-server-only-introspection-key--123'
};
const session = 'sample_session_0123456789abcdefghijklmnopqrstuvwxyz012345';
const digest = createHash('sha256').update(session).digest('hex');
DB.prepare('INSERT INTO sessions(session_hash,github_id,github_login,expires_at) VALUES (?,?,?,?)')
  .run(digest, '12345', 'adminowner', new Date(Date.now() + 3600_000).toISOString());
async function req(path, method = 'GET', body = null, token = session) {
  const options = { method, headers: { Origin: 'https://mozdbaranarshiya.github.io', Authorization: 'Bearer ' + token } };
  if (body !== null) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await worker.fetch(new Request(env.PUBLIC_WORKER_ORIGIN + path, options), env);
  return { status: response.status, data: await response.json(), headers: response.headers };
}

test('no user/subscriber endpoints exist (even for admin)', async () => {
  assert.equal((await req('/accupdator/subscribers/all')).status, 404);
  assert.equal((await req('/api/user-tokens', 'POST', { label: 'user' })).status, 404);
  assert.equal((await req('/api/admin-tokens')).status, 200);
});

test('unauthenticated requests are denied', async () => {
  assert.equal((await req('/api/admin-tokens', 'GET', null, 'wrong_session_abcdefghijklmnopqrstuvwxyz123456789')).status, 401);
});

let tokenID, secret;
test('admin token can be issued and never saved in plain text', async () => {
  const r = await req('/api/admin-tokens', 'POST', { label: 'Main admin', days: 7 });
  assert.equal(r.status, 201);
  assert.match(r.data.token, /^adm_[A-Za-z0-9_-]{43}$/);
  tokenID = r.data.id; secret = r.data.token;
  const row = DB.prepare('SELECT * FROM admin_tokens WHERE id = ?').get(tokenID);
  assert.ok(row.token_hash);
  assert.ok(!JSON.stringify(row).includes(secret));
  const list = await req('/api/admin-tokens');
  assert.equal(list.data.tokens.length, 1);
  assert.equal(list.data.tokens[0].label, 'Main admin');
  assert.ok(!JSON.stringify(list.data).includes(secret));
});

test('introspection requires a separate server-side secret', async () => {
  assert.equal((await req('/api/introspect', 'POST', { token: secret })).status, 401);
  const r = await req('/api/introspect', 'POST', { token: secret }, env.INTROSPECTION_KEY);
  assert.equal(r.status, 200);
  assert.equal(r.data.active, true);
  assert.equal(r.data.scope, 'admin');
});

test('extend, rotate and revoke token; audit events written', async () => {
  assert.equal((await req(`/api/admin-tokens/${tokenID}/extend`, 'POST', { days: 30 })).status, 200);
  const rotate = await req(`/api/admin-tokens/${tokenID}/rotate`, 'POST', {});
  assert.equal(rotate.status, 200);
  assert.notEqual(rotate.data.token, secret);
  assert.equal((await req('/api/introspect', 'POST', { token: secret }, env.INTROSPECTION_KEY)).data.active, false);
  assert.equal((await req('/api/introspect', 'POST', { token: rotate.data.token }, env.INTROSPECTION_KEY)).data.active, true);
  assert.equal((await req(`/api/admin-tokens/${rotate.data.id}/revoke`, 'POST', {})).status, 200);
  assert.equal((await req('/api/introspect', 'POST', { token: rotate.data.token }, env.INTROSPECTION_KEY)).data.active, false);
  const log = await req('/api/audit');
  assert.deepEqual(log.data.events.map(x => x.action), ['revoke', 'rotate', 'extend', 'issue']);
});
