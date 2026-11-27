import assert from 'node:assert/strict';
import test from 'node:test';
import { createMockInvoiceYooKassa, createTestYooKassa, reconcileRoyaltyAttempt, reconcileRoyaltyInvoice, royaltyTestConfig } from '../../scripts/royalty-yookassa.mjs';

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

const invoiceId = 'in-e44e8088-bd73-43b1-959a-954f3a7d0c54';
const invoiceLink = 'https://yookassa.ru/my/i/example/a';
const invoiceJob = { ...job, invoice_name: '  Иван   Петров ', first_dispatch_at: new Date('2026-12-05T12:00:00Z') };
const invoiceMetadata = { royalty_attempt_id: job.id, royalty_month: '2026-11' };
const invoiceCart = [{ description: 'Оплата роялти за ноябрь 2026', quantity: 1, price: { value: '1234.05', currency: 'RUB' } }];
const invoiceResponse = (overrides = {}) => Response.json({
  id: invoiceId,
  status: 'pending',
  cart: invoiceCart,
  metadata: invoiceMetadata,
  delivery_method: { type: 'self', url: invoiceLink },
  ...overrides,
});

test('issues a one-time invoice and includes buyer, period and verification text in the invoice description', async () => {
  const sent = [];
  const client = createMockInvoiceYooKassa('http://127.0.0.1:54349', async (url, init) => {
    sent.push({ url, method: init.method, key: new Headers(init.headers).get('Idempotence-Key'), payload: JSON.parse(init.body) });
    return invoiceResponse();
  });
  const observed = await reconcileRoyaltyInvoice(invoiceJob, client);
  await reconcileRoyaltyInvoice(invoiceJob, client);
  assert.deepEqual(observed, { providerId: invoiceId, status: 'pending', checkoutUrl: invoiceLink, paidOn: null });
  assert.equal(sent[0].url, 'http://127.0.0.1:54349/v3/invoices');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].key, job.id);
  const payload = sent[0].payload;
  assert.equal(payload.description, 'Иван Петров · Роялти за ноябрь 2026 года. Перед оплатой проверьте, правильно ли указаны данные.');
  assert.deepEqual(payload.delivery_method_data, { type: 'self' });
  assert.deepEqual(payload.cart, invoiceCart);
  assert.equal(payload.payment_data.capture, true);
  assert.deepEqual(payload.payment_data.amount, { value: '1234.05', currency: 'RUB' });
  assert.equal(payload.payment_data.receipt.tax_system_code, 2);
  assert.equal(payload.payment_data.receipt.items[0].vat_code, 7);
  assert.equal(payload.payment_data.receipt.items[0].payment_subject, 'commodity');
  assert.equal(payload.payment_data.receipt.items[0].payment_mode, 'full_prepayment');
  assert.equal(payload.expires_at, '2026-12-06T12:00:00.000Z');
  assert.deepEqual(sent[1], sent[0]);
});

test('keeps the month and verification text when the buyer name exceeds the description limit', async () => {
  const client = createMockInvoiceYooKassa('http://localhost:54349', async (_url, init) => {
    const { description } = JSON.parse(init.body);
    assert.ok(description.length <= 128);
    assert.match(description, /^Я+… · Роялти за ноябрь 2026 года\. Перед оплатой проверьте, правильно ли указаны данные\.$/u);
    return invoiceResponse();
  });
  await reconcileRoyaltyInvoice({ ...invoiceJob, invoice_name: 'Я'.repeat(160) }, client);
  await assert.rejects(reconcileRoyaltyInvoice({ ...invoiceJob, invoice_name: ' ' }, client), /buyer name/);
});

test('checks the payment linked to a successful invoice before returning a settlement date', async () => {
  let linkedInvoice = invoiceId;
  const client = createMockInvoiceYooKassa('http://127.0.0.1:54349', async (url, init) => {
    assert.equal(init.method, 'GET');
    if (url.endsWith('/v3/invoices/' + invoiceId)) {
      return invoiceResponse({ status: 'succeeded', payment_details: { id: providerId, status: 'succeeded' } });
    }
    assert.ok(url.endsWith('/v3/payments/' + providerId));
    return response({
      invoice_details: { id: linkedInvoice }, status: 'succeeded', paid: true, captured_at: '2026-12-05T22:00:00Z',
    });
  });
  const attempt = { ...invoiceJob, provider_id: invoiceId };
  assert.deepEqual(await reconcileRoyaltyInvoice(attempt, client),
    { providerId: invoiceId, status: 'succeeded', checkoutUrl: null, paidOn: '2026-12-06' });
  linkedInvoice = 'in-06d106bd-ae6e-4c5e-a277-3cffea026c0b';
  await assert.rejects(reconcileRoyaltyInvoice(attempt, client), /Mismatched invoice payment/);
});

test('invoice verification accepts only a loopback mock endpoint', async () => {
  for (const url of ['https://api.yookassa.ru', 'http://user@localhost:54349', 'http://localhost:54349/example']) {
    assert.throws(() => createMockInvoiceYooKassa(url), /loopback mock/);
  }
});

const liveSettings = { shopId: '123456', key: 'live_fixture' };
const liveEnv = {
  BRON_YOOKASSA_MODE: 'invoice_live', YOOKASSA_LIVE_SHOP_ID: liveSettings.shopId,
  YOOKASSA_LIVE_SECRET: liveSettings.key, BRON_ROYALTY_LIVE_DATABASE_URL: 'postgres://worker@db.example/postgres',
};
const liveJob = { ...invoiceJob, invoice_receipt_email: 'buyer@example.test' };

test('uses only explicit live credentials and a distinct database for live invoices', async () => {
  const { royaltyLiveInvoiceConfig } = await import('../../scripts/royalty-yookassa.mjs');
  assert.equal(typeof royaltyLiveInvoiceConfig, 'function');
  assert.deepEqual(royaltyLiveInvoiceConfig(liveEnv), { ...liveSettings, databaseUrl: liveEnv.BRON_ROYALTY_LIVE_DATABASE_URL });
  for (const invalid of [
    { YOOKASSA_LIVE_SECRET: 'test_fixture' }, { YOOKASSA_LIVE_SECRET: undefined },
    { BRON_YOOKASSA_MODE: 'invoice_mock' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { BRON_ROYALTY_LIVE_DATABASE_URL: 'postgres://worker@localhost/bron_royalty_test' },
    { BRON_ROYALTY_LIVE_DATABASE_URL: 'postgres://worker@localhost/postgres?dbname=bron_royalty_test' },
  ]) assert.throws(() => royaltyLiveInvoiceConfig({ ...liveEnv, ...invalid }));
});

test('issues invoices on the fixed HTTPS origin with a receipt email and without redirecting credentials', async () => {
  const { createLiveInvoiceYooKassa } = await import('../../scripts/royalty-yookassa.mjs');
  const calls = [];
  const client = createLiveInvoiceYooKassa(liveSettings, async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return invoiceResponse();
  });
  assert.equal((await reconcileRoyaltyInvoice(liveJob, client)).checkoutUrl, invoiceLink);
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/invoices');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Basic ' + Buffer.from('123456:live_fixture').toString('base64'));
  assert.equal(new Headers(calls[0].init.headers).get('Idempotence-Key'), job.id);
  assert.deepEqual(calls[0].body.payment_data.receipt.customer, { email: 'buyer@example.test' });
  assert.equal(calls[0].body.payment_data.receipt.items[0].measure, 'piece');
  await assert.rejects(reconcileRoyaltyInvoice({ ...liveJob, invoice_receipt_email: ' ' }, client), /receipt email/);
  assert.equal(calls.length, 1);
});

test('records a live invoice payment only when the payment belongs to its live shop and invoice', async () => {
  const { createLiveInvoiceYooKassa } = await import('../../scripts/royalty-yookassa.mjs');
  let payment = {};
  const client = createLiveInvoiceYooKassa(liveSettings, async (url, init) => {
    assert.equal(init.method, 'GET');
    if (url.endsWith('/invoices/' + invoiceId)) {
      return invoiceResponse({ status: 'succeeded', payment_details: { id: providerId, status: 'succeeded' } });
    }
    assert.equal(url, 'https://api.yookassa.ru/v3/payments/' + providerId);
    return response({ invoice_details: { id: invoiceId }, status: 'succeeded', paid: true, test: false,
      captured_at: '2026-12-05T22:00:00Z', ...payment });
  });
  const attempt = { ...liveJob, provider_id: invoiceId };
  assert.deepEqual(await reconcileRoyaltyInvoice(attempt, client),
    { providerId: invoiceId, status: 'succeeded', checkoutUrl: null, paidOn: '2026-12-06' });
  for (const mismatch of [{ test: true }, { test: undefined }, { recipient: { account_id: '654321' } }]) {
    payment = mismatch;
    await assert.rejects(reconcileRoyaltyInvoice(attempt, client), /Mismatched invoice payment/);
  }
});

test('reports provider rejection without including the response body', async () => {
  const { createLiveInvoiceYooKassa, YooKassaHttpError } = await import('../../scripts/royalty-yookassa.mjs');
  const client = createLiveInvoiceYooKassa(liveSettings, async () => new Response('private response', { status: 401 }));
  await assert.rejects(client.getPayment(providerId), error =>
    error instanceof YooKassaHttpError && error.status === 401 && error.message === 'YooKassa HTTP 401');
});
