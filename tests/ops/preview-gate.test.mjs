import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createPreviewGate } from '../../deploy/preview/gate.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('the preview proxies ordinary account login, restricts access to data and limits failed logins', async t => {
  const origin = 'https://preview.example.test';
  const signIn = '/auth/v1/token?grant_type=password';
  let now = 1_800_000_000_000;
  const api = createServer(async (req, res) => {
    if (req.url === signIn) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const { password } = JSON.parse(Buffer.concat(chunks).toString());
      if (password !== 'fixture-test-password') res.statusCode = 400;
    }
    res.end(JSON.stringify({ authorization: req.headers.authorization, forwardedCookie: req.headers.cookie ?? null }));
  });
  const apiPort = await listen(api);
  const gate = createPreviewGate({ origin, apiPort, now: () => now });
  const port = await listen(gate);
  t.after(() => { gate.close(); api.close(); });
  const request = (path, options) => fetch('http://127.0.0.1:' + port + path, options);
  const login = (password, sender = origin) => request(signIn, {
    method: 'POST', headers: { Origin: sender, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal((await request('/auth/v1/health')).status, 200);
  assert.equal((await request('/rest/v1/rpc/ping', { method: 'POST' })).status, 200);
  assert.equal((await request('/_preview/access')).status, 404);
  assert.equal((await request('/rest/v1/rpc/me', { method: 'POST' })).status, 401);
  assert.equal((await login('fixture-test-password', 'https://other.example.test')).status, 403);
  const opened = await login('fixture-test-password');
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get('set-cookie'), null);
  const headers = { Cookie: 'discard=1', Authorization: 'Bearer bearer.fixture.signature' };
  const forwarded = await request('/rest/v1/rpc/me', { method: 'POST', headers });
  assert.deepEqual(await forwarded.json(), { authorization: 'Bearer bearer.fixture.signature', forwardedCookie: null });
  assert.equal((await request('/auth/v1/admin/users', { headers })).status, 404);
  for (let index = 0; index < 12; index++) assert.equal((await login('wrong')).status, 400);
  assert.equal((await login('fixture-test-password')).status, 429);
  now += 16 * 60 * 1000;
  assert.equal((await login('fixture-test-password')).status, 200);
});
