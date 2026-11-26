import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestYooKassa, reconcileRoyaltyAttempt, royaltyTestConfig } from '../../scripts/royalty-yookassa.mjs';

const job = {
  id: '4d41be19-a505-4e3b-802d-fbbc7ed77928',
  lease: '4d41be19-a505-4e3b-802d-fbbc7ed77929',
  month: '2026-11-01',
  amount_minor: '123405',
  provider_id: null,
};
const link = 'https://yoomoney.ru/api-pages/v2/payment-confirm/epl?orderId=example';
const providerId = '243bc8ba-046d-5aab-a34e-ab9316d31fb2';
const response = (overrides = {}) => Response.json({
  id: providerId,
  status: 'pending',
  paid: false,
  test: true,
  amount: { value: '1234.05', currency: 'RUB' },
  confirmation: { type: 'redirect', confirmation_url: link },
  recipient: { account_id: '123456', gateway_id: '501' },
  metadata: { royalty_attempt_id: job.id, royalty_month: '2026-11' },
  ...overrides,
});

test('fails closed without an isolated test database and test credentials', () => {
  const env = {
    BRON_YOOKASSA_MODE: 'test',
    BRON_ROYALTY_TEST_DATABASE_URL: 'postgres://test@localhost/bron_royalty_test',
    YOOKASSA_TEST_SHOP_ID: '123456',
    YOOKASSA_TEST_SECRET: 'test_example',
  };
  assert.equal(royaltyTestConfig(env).shopId, '123456');
  for (const bad of [
    { BRON_YOOKASSA_MODE: 'live' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { YOOKASSA_TEST_SECRET: 'live_example' },
    { BRON_ROYALTY_TEST_DATABASE_URL: 'postgres://test@localhost/postgres' },
    { BRON_ROYALTY_TEST_DATABASE_URL: 'postgres://test@production.example/bron_royalty_test' },
    { BRON_ROYALTY_TEST_DATABASE_URL: 'postgres://test@localhost/bron_royalty_test?database=postgres' },
  ]) assert.throws(() => royaltyTestConfig({ ...env, ...bad }));
});

test('creates a test checkout with the exact month in the visible description and stable retry key', async () => {
  const sent = [];
  const client = createTestYooKassa({ shopId: '123456', key: 'test_example' }, async (url, init) => {
    sent.push({ url: url.toString(), method: init.method, key: new Headers(init.headers).get('Idempotence-Key'), payload: JSON.parse(init.body) });
    return response();
  });
  const observed = await reconcileRoyaltyAttempt(job, client);
  assert.equal(observed.checkoutUrl, link);
  await reconcileRoyaltyAttempt(job, client);
  assert.equal(sent[0].url, 'https://api.yookassa.ru/v3/payments');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].payload.description, 'Роялти за ноябрь 2026 года');
  assert.equal(sent[0].payload.confirmation.return_url, 'http://localhost:5173/#/?royalty_checkout=' + job.id);
  assert.deepEqual(sent[0].payload.amount, { value: '1234.05', currency: 'RUB' });
  assert.equal(sent[0].key, job.id);
  assert.deepEqual(sent[1], sent[0]);
});

test('uses a confirmed completed payment and its Moscow date on repeat observations', async () => {
  const client = createTestYooKassa({ shopId: '123456', key: 'test_example' }, async (url, init) => {
    assert.equal(url.toString(), 'https://api.yookassa.ru/v3/payments/' + providerId);
    assert.equal(init.method, 'GET');
    return response({ status: 'succeeded', paid: true, captured_at: '2026-12-05T22:00:00Z', confirmation: undefined });
  });
  const existing = { ...job, provider_id: providerId };
  const expected = { providerId, status: 'succeeded', checkoutUrl: null, paidOn: '2026-12-06' };
  assert.deepEqual(await reconcileRoyaltyAttempt(existing, client), expected);
  assert.deepEqual(await reconcileRoyaltyAttempt(existing, client), expected);
});

test('reports a canceled attempt without a link or a payment date', async () => {
  const client = createTestYooKassa({ shopId: '123456', key: 'test_example' }, async () =>
    response({ status: 'canceled', confirmation: undefined }));
  assert.deepEqual(await reconcileRoyaltyAttempt({ ...job, provider_id: providerId }, client),
    { providerId, status: 'canceled', checkoutUrl: null, paidOn: null });
});

test('rejects a response for a different amount, month, shop, non-test payment or untrusted checkout', async () => {
  for (const mismatch of [
    { amount: { value: '12.34', currency: 'RUB' } },
    { amount: { value: '1234.05', currency: 'USD' } },
    { metadata: { royalty_attempt_id: job.id, royalty_month: '2026-12' } },
    { recipient: { account_id: '654321' } },
    { test: false },
    { confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.ru.example/pay' } },
  ]) {
    const client = createTestYooKassa({ shopId: '123456', key: 'test_example' }, async () => response(mismatch));
    await assert.rejects(reconcileRoyaltyAttempt(job, client));
  }
});
