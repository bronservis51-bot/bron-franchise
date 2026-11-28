import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoyaltyInvoiceGateway } from '../../scripts/royalty-invoice-gateway.mjs';
import { createLiveInvoiceYooKassa } from '../../scripts/royalty-yookassa.mjs';

const attempt = 'ae84cd37-44e2-496b-9ede-eb1ab35861f0';
const payment = 'b53e4f64-2a31-41ea-8fa5-9eb176957c01';
const item = 'Оплата роялти за ноябрь 2026';
const shopId = '123456';
const secret = 'live_fixture';
const header = { 'Content-Type': 'application/json', 'Idempotence-Key': attempt };

function invoice() {
  const amount = { value: '125.00', currency: 'RUB' };
  const metadata = { royalty_attempt_id: attempt, royalty_month: '2026-11' };
  return {
    description: 'Франчайзи · Ноябрь 2026',
    metadata, delivery_method_data: { type: 'self' },
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    cart: [{ description: item, price: amount, quantity: 1 }],
    payment_data: { amount, capture: true, description: item, metadata, receipt: {
      tax_system_code: 2, customer: { email: 'buyer@example.test' },
      items: [{ description: item, amount, quantity: 1, vat_code: 7, payment_mode: 'full_prepayment',
        payment_subject: 'commodity', measure: 'piece' }],
    } },
  };
}

function send(socketPath, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers: { 'X-Bron-Royalty-Shop-Id': shopId, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function gateway(t, upstream) {
  const directory = await mkdtemp(join(tmpdir(), 'bron-invoice-'));
  const socketPath = join(directory, 'gateway.sock');
  const server = createRoyaltyInvoiceGateway({ shopId, secret }, upstream);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  return socketPath;
}

test('the real gateway listener rejects every mutation other than creating an invoice before contacting YooKassa', async t => {
  let forwarded = 0;
  const socket = await gateway(t, () => { forwarded++; return Response.json({}); });
  for (const [method, route] of [
    ['POST', '/v3/refunds'], ['POST', '/v3/payments'], ['POST', '/v3/payments/' + payment + '/capture'],
    ['POST', '/v3/payments/' + payment + '/cancel'], ['POST', '/v3/payouts'], ['POST', '/v3/receipts'],
    ['DELETE', '/v3/invoices/in-' + attempt], ['POST', '/v3/invoices?operation=refund'],
    ['POST', '/v3/invoices/../refunds'], ['POST', '/v3/%72efunds'], ['POST', 'https://api.yookassa.ru/v3/refunds'],
    ['GET', '/v3/payments/' + payment + '?expand=another'], ['GET', '/v3/refunds'],
  ]) {
    assert.equal((await send(socket, method, route, undefined, { 'X-HTTP-Method-Override': 'POST' })).status, 403);
  }
  assert.equal(forwarded, 0);
});

test('the invoice gateway authorizes only the established one-time invoice payload on the fixed origin', async t => {
  const sent = [];
  const socket = await gateway(t, (url, init) => {
    sent.push({ url, init });
    return Response.json({ id: 'in-' + attempt, status: 'pending' });
  });
  const valid = invoice();
  const dangerousFields = [
    { ...valid, payment_data: { ...valid.payment_data, save_payment_method: true } },
    { ...valid, payment_data: { ...valid.payment_data, payment_method_id: payment } },
    { ...valid, payment_data: { ...valid.payment_data, capture: false } },
    { ...valid, delivery_method_data: { type: 'sms', phone: '70000000000' } },
    { ...valid, cart: [{ ...valid.cart[0], price: { value: '124.99', currency: 'RUB' } }] },
    { ...valid, metadata: { ...valid.metadata, royalty_attempt_id: payment } },
  ];
  for (const body of dangerousFields) assert.equal((await send(socket, 'POST', '/v3/invoices', body, header)).status, 400);
  assert.equal(sent.length, 0);
  const result = await send(socket, 'POST', '/v3/invoices', valid,
    { ...header, Authorization: 'untrusted', Host: 'another.example', 'X-HTTP-Method-Override': 'DELETE' });
  assert.equal(result.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.yookassa.ru/v3/invoices');
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(sent[0].init.redirect, 'error');
  const headers = new Headers(sent[0].init.headers);
  assert.equal(headers.get('Authorization'), 'Basic ' + Buffer.from(shopId + ':' + secret).toString('base64'));
  assert.equal(headers.get('Idempotence-Key'), attempt);
  assert.equal(headers.get('X-HTTP-Method-Override'), null);
  assert.equal(headers.get('Host'), null);
  assert.equal(headers.get('X-Bron-Royalty-Shop-Id'), null);
  assert.deepEqual(JSON.parse(sent[0].init.body), valid);
});

test('gateway rejects a shop mismatch on writes and reads without contacting YooKassa', async t => {
  let forwarded = 0;
  const socket = await gateway(t, () => { forwarded++; return Response.json({}); });
  const unexpectedShop = { 'X-Bron-Royalty-Shop-Id': '654321' };
  assert.equal((await send(socket, 'POST', '/v3/invoices', invoice(), { ...header, ...unexpectedShop })).status, 403);
  assert.equal((await send(socket, 'GET', '/v3/payments/' + payment, undefined, unexpectedShop)).status, 403);
  assert.equal(forwarded, 0);
});

test('gateway permits verified payment and invoice lookups but does not expose upstream error bodies', async t => {
  const sent = [];
  const socket = await gateway(t, (url, init) => {
    sent.push({ url, method: init.method, body: init.body });
    return new Response('untrusted diagnostic, never relay', { status: 401 });
  });
  for (const path of ['/v3/payments/' + payment, '/v3/invoices/in-' + attempt]) {
    const res = await send(socket, 'GET', path);
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.body, /untrusted diagnostic/);
    assert.equal(sent.at(-1).url, 'https://api.yookassa.ru' + path);
    assert.equal(sent.at(-1).method, 'GET');
    assert.equal(sent.at(-1).body, undefined);
  }
});

test('production client sends invoices and reconciles refund status through the Unix gateway', async t => {
  const socketPath = await gateway(t, (url) => url.endsWith('/invoices')
    ? Response.json({ id: 'in-' + attempt, status: 'pending' })
    : Response.json({ id: payment, status: 'succeeded', paid: true, test: false, recipient: { account_id: shopId },
        refunded_amount: { value: '5.00', currency: 'RUB' }, payment_method: { card: { last4: '1111' } } }));
  const client = createLiveInvoiceYooKassa({ shopId, socketPath });
  const created = await client.createInvoice(attempt, invoice());
  assert.equal(created.id, 'in-' + attempt);
  const paid = await client.getPayment(payment);
  assert.deepEqual(paid.refunded_amount, { value: '5.00', currency: 'RUB' });
  assert.equal(paid.recipient.account_id, shopId);
  assert.equal(paid.payment_method, undefined);
});
