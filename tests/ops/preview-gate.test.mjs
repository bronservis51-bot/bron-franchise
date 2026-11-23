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

test('preview opens only with a current gate cookie and forwards only preview API traffic', async t => {
  const origin = 'https://preview.example.test';
  const code = 'synthetic-proof-code-123';
  const secret = 'synthetic-signing-secret-0123456789';
  let now = 1_800_000_000_000;
  const api = createServer((req, res) => {
    res.end(JSON.stringify({ authorization: req.headers.authorization, forwardedCookie: req.headers.cookie ?? null }));
  });
  const apiPort = await listen(api);
  const gate = createPreviewGate({ origin, code, secret, apiPort, now: () => now });
  const port = await listen(gate);
  t.after(() => { gate.close(); api.close(); });
  const request = (path, options) => fetch('http://127.0.0.1:' + port + path, { redirect: 'manual', ...options });
  const form = await request('/_preview/access');
  const formToken = (await form.text()).match(/name="form_token" value="([^"]+)"/)?.[1];
  const formCookie = form.headers.get('set-cookie')?.split(';')[0];
  assert.ok(formToken && formCookie);
  const unlock = (body, sender = origin, cookie = formCookie, token = formToken) => request('/_preview/access', {
    method: 'POST', headers: { Origin: sender, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access: body, form_token: token }),
  });
  assert.equal((await request('/_preview/check')).status, 401);
  assert.equal((await request('/_preview/check', { headers: { 'X-Forwarded-Uri': '/' } })).headers.get('location'), '/_preview/access');
  assert.equal((await unlock('wrong')).status, 401);
  assert.equal((await unlock(code, 'https://other.example.test')).status, 403);
  assert.equal((await unlock(code, 'null', '')).status, 403);
  const opened = await unlock(code, 'null');
  assert.equal(opened.status, 303);
  const cookie = opened.headers.get('set-cookie');
  assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
  const headers = { Cookie: cookie.split(';')[0], Authorization: 'Bearer fixture' };
  assert.equal((await request('/_preview/check', { headers })).status, 204);
  const forwarded = await request('/rest/v1/rpc/me', { method: 'POST', headers });
  assert.deepEqual(await forwarded.json(), { authorization: 'Bearer fixture', forwardedCookie: null });
  assert.equal((await request('/auth/v1/admin/users', { headers })).status, 404);
  assert.equal((await request('/rest/v1/rpc/me')).status, 401);
  assert.equal((await request('/_preview/check', { headers: { Cookie: headers.Cookie + 'x' } })).status, 401);
  now += 31 * 24 * 60 * 60 * 1000;
  assert.equal((await request('/_preview/check', { headers })).status, 401);
});
