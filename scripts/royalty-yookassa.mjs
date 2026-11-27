// Private test-mode worker. No public ingress or live payment credentials.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseConfig } from './database-config.mjs';

const api = 'https://api.yookassa.ru/v3/payments';
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const checkoutHosts = new Set(['yoomoney.ru', 'yookassa.ru']);
const paymentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invoiceIdPattern = /^in-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function royaltyTestDatabaseUrl(env) {
  const url = new URL(env.BRON_ROYALTY_TEST_DATABASE_URL ?? '');
  if (!localHosts.has(url.hostname) || url.pathname !== '/bron_royalty_test' ||
      ['host', 'hostaddr', 'database', 'dbname'].some(name => url.searchParams.has(name))) {
    throw new Error('An isolated local bron_royalty_test database is required');
  }
  return url.toString();
}

export function royaltyTestConfig(env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('YooKassa requires verified TLS');
  const shopId = env.YOOKASSA_TEST_SHOP_ID;
  const key = env.YOOKASSA_TEST_SECRET;
  if (env.BRON_YOOKASSA_MODE !== 'test' || !/^\d+$/.test(shopId ?? '') || !/^test_\S+$/.test(key ?? '')) {
    throw new Error('Test shop ID, test secret and explicit test mode are required');
  }

  const databaseUrl = royaltyTestDatabaseUrl(env);
  const returnUrl = new URL(env.BRON_ROYALTY_TEST_RETURN_URL ?? 'http://localhost:5173/');
  if (!localHosts.has(returnUrl.hostname) || returnUrl.username || returnUrl.password ||
      !['http:', 'https:'].includes(returnUrl.protocol)) {
    throw new Error('A local return URL is required for the test checkout');
  }
  return { shopId, key, databaseUrl, returnUrl: returnUrl.href };
}

export function createTestYooKassa({ shopId, key, returnUrl = 'http://localhost:5173/' }, fetchImpl = fetch) {
  if (!/^\d+$/.test(shopId ?? '') || !/^test_\S+$/.test(key ?? '')) throw new Error('Test shop credentials are required');
  const authorization = 'Basic ' + Buffer.from(shopId + ':' + key).toString('base64');

  return { shopId, returnUrl, async request(existingId, attemptId, body) {
    if (existingId !== null && !paymentIdPattern.test(existingId)) throw new Error('Invalid saved payment ID');
    const url = existingId ? `${api}/${existingId}` : api;
    const headers = { Authorization: authorization, Accept: 'application/json' };
    if (!existingId) {
      headers['Content-Type'] = 'application/json';
      headers['Idempotence-Key'] = attemptId;
    }
    const response = await fetchImpl(url, {
      method: existingId ? 'GET' : 'POST',
      headers,
      body: existingId ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Test YooKassa HTTP ${response.status}`);
    return response.json();
  } };
}

function royaltyTerms(attempt) {
  if (!paymentIdPattern.test(attempt.id) || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(attempt.month) ||
      !/^\d+$/.test(String(attempt.amount_minor)) || BigInt(attempt.amount_minor) <= 0n) {
    throw new Error('Invalid royalty attempt');
  }
  const digits = String(BigInt(attempt.amount_minor)).padStart(3, '0');
  const value = digits.slice(0, -2) + '.' + digits.slice(-2);
  const parts = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .formatToParts(new Date(attempt.month));
  const monthName = parts.find(part => part.type === 'month').value;
  const year = parts.find(part => part.type === 'year').value;
  return { amount: { value, currency: 'RUB' }, period: `${monthName} ${year}`,
    metadata: { royalty_attempt_id: attempt.id, royalty_month: attempt.month.slice(0, 7) } };
}

function matchingMetadata(received, expected) {
  return received?.royalty_attempt_id === expected.royalty_attempt_id && received?.royalty_month === expected.royalty_month;
}

function matchingAmount(received, expected) {
  return received?.currency === expected.currency && received?.value === expected.value;
}

function verifiedCheckoutUrl(link) {
  const url = new URL(link ?? '');
  if (!checkoutHosts.has(url.hostname) || url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new Error('Untrusted checkout URL');
  }
  return url.href;
}

function verifiedPaidOn(payment) {
  if (payment.paid !== true || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(payment.captured_at ?? '')) {
    throw new Error('Unconfirmed test payment');
  }
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(payment.captured_at));
}

export async function reconcileRoyaltyAttempt(attempt, client) {
  const { amount, period, metadata } = royaltyTerms(attempt);
  const returnUrl = new URL(client.returnUrl);
  returnUrl.hash = '/?royalty_checkout=' + attempt.id;
  const payment = await client.request(attempt.provider_id, attempt.id, {
    amount,
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl.href },
    description: `Роялти за ${period} года`,
    metadata,
  });

  if (!paymentIdPattern.test(payment?.id) || (attempt.provider_id && attempt.provider_id !== payment.id) ||
      payment.test !== true || String(payment.recipient?.account_id) !== client.shopId ||
      !matchingAmount(payment.amount, amount) || !matchingMetadata(payment.metadata, metadata) ||
      !['pending', 'canceled', 'succeeded'].includes(payment.status)) {
    throw new Error('Mismatched test payment');
  }

  let checkoutUrl = null;
  if (payment.status === 'pending' && (!attempt.provider_id || payment.confirmation?.confirmation_url)) {
    if (payment.confirmation?.type !== 'redirect') throw new Error('Untrusted checkout URL');
    checkoutUrl = verifiedCheckoutUrl(payment.confirmation.confirmation_url);
  }
  const paidOn = payment.status === 'succeeded' ? verifiedPaidOn(payment) : null;
  return { providerId: payment.id, status: payment.status, checkoutUrl, paidOn };
}

// YooKassa does not issue invoices in a test shop. This transport uses the
// documented invoice API contract against a local server, without credentials.
export function createMockInvoiceYooKassa(baseUrl, fetchImpl = fetch) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !localHosts.has(base.hostname) || !base.port ||
      base.href !== base.origin + '/') throw new Error('A loopback mock URL with a port is required');
  async function request(path, options) {
    const response = await fetchImpl(base.origin + '/v3/' + path, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Mock YooKassa HTTP ${response.status}`);
    return response.json();
  }
  return {
    createInvoice: (id, body) => request('invoices', { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Idempotence-Key': id } }),
    getInvoice: id => request('invoices/' + id, { method: 'GET' }),
    getPayment: id => request('payments/' + id, { method: 'GET' }),
  };
}

function invoiceDescription(buyerName, period) {
  const name = buyerName?.trim().replace(/\s+/gu, ' ');
  if (!name) throw new Error('Missing invoice buyer name');
  const suffix = ` · Роялти за ${period} года. Перед оплатой проверьте, правильно ли указаны данные.`;
  const budget = 128 - suffix.length;
  const visibleName = name.length <= budget ? name : name.slice(0, budget - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + '…';
  return visibleName + suffix;
}

export async function reconcileRoyaltyInvoice(attempt, client) {
  const { amount, period, metadata } = royaltyTerms(attempt);
  if (attempt.provider_id !== null && !invoiceIdPattern.test(attempt.provider_id)) throw new Error('Invalid saved invoice ID');
  if (attempt.provider_id === null && BigInt(attempt.amount_minor) < 100n) throw new Error('Invoice amount is below the minimum');
  const item = `Оплата роялти за ${period}`;
  const invoice = attempt.provider_id ? await client.getInvoice(attempt.provider_id) : await client.createInvoice(attempt.id, {
    description: invoiceDescription(attempt.invoice_name, period),
    payment_data: { amount, capture: true, description: item, metadata,
      // Fiscal treatment for the local mock fixture. The working store's
      // item subject and settlement method must be verified before launch.
      receipt: { tax_system_code: 2, items: [{ description: item, amount, quantity: 1,
        vat_code: 7, payment_mode: 'full_payment', payment_subject: 'service' }] } },
    cart: [{ description: item, price: amount, quantity: 1 }],
    delivery_method_data: { type: 'self' },
    expires_at: new Date(attempt.first_dispatch_at.getTime() + 24 * 60 * 60_000).toISOString(),
    metadata,
  });

  const line = invoice?.cart?.[0];
  if (!invoiceIdPattern.test(invoice?.id) || (attempt.provider_id && attempt.provider_id !== invoice.id) ||
      !matchingMetadata(invoice.metadata, metadata) || invoice.cart?.length !== 1 || line?.description !== item ||
      line.quantity !== 1 || line.discount_price || !matchingAmount(line.price, amount) ||
      !['pending', 'canceled', 'succeeded'].includes(invoice.status)) throw new Error('Mismatched test invoice');

  let checkoutUrl = null;
  let paidOn = null;
  if (invoice.status === 'pending') {
    if (invoice.delivery_method?.type !== 'self') throw new Error('Untrusted checkout URL');
    checkoutUrl = verifiedCheckoutUrl(invoice.delivery_method.url);
  }
  if (invoice.status === 'succeeded') {
    const paymentId = invoice.payment_details?.id;
    if (!paymentIdPattern.test(paymentId) || invoice.payment_details.status !== 'succeeded') throw new Error('Missing invoice payment');
    const payment = await client.getPayment(paymentId);
    if (payment?.id !== paymentId || payment.invoice_details?.id !== invoice.id || payment.test !== true ||
        payment.status !== 'succeeded' || !matchingAmount(payment.amount, amount)) throw new Error('Mismatched invoice payment');
    paidOn = verifiedPaidOn(payment);
  }
  return { providerId: invoice.id, status: invoice.status, checkoutUrl, paidOn };
}

async function run() {
  const useInvoice = process.env.BRON_YOOKASSA_MODE === 'invoice_mock';
  const config = useInvoice ? { databaseUrl: royaltyTestDatabaseUrl(process.env) } : royaltyTestConfig(process.env);
  const client = useInvoice ? createMockInvoiceYooKassa(process.env.BRON_YOOKASSA_INVOICE_MOCK_URL) : createTestYooKassa(config);
  const reconcile = useInvoice ? reconcileRoyaltyInvoice : reconcileRoyaltyAttempt;
  const jobSql = useInvoice ? `select id, lease, month::text as month, amount_minor, provider_id, invoice_name, first_dispatch_at
    from app_private.royalty_invoice_checkout_work(1)` : `select id, lease, month::text as month, amount_minor, provider_id
    from app_private.royalty_checkout_work(1)`;
  const db = new pg.Client({
    ...databaseConfig(config.databaseUrl),
    statement_timeout: 10_000, query_timeout: 12_000, application_name: 'bron-royalty-test',
  });
  await db.connect();
  try {
    // Lease just before calling the provider so earlier HTTP requests cannot age this lease.
    for (let processed = 0; processed < 5; processed++) {
      const { rows: [attempt] } = await db.query(jobSql);
      if (!attempt) break;
      try {
        const p = await reconcile(attempt, client);
        await db.query('select app_private.royalty_checkout_observe($1,$2,$3,$4,$5,$6)',
          [attempt.id, attempt.lease, p.providerId, p.status, p.checkoutUrl, p.paidOn]);
      } catch {
        // An uncertain request is retried only with the same key; it never produces a journal entry.
        console.error('Test royalty payment could not be reconciled');
        process.exitCode = 1;
      }
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run();
  } catch {
    console.error('Test royalty worker configuration or database is unavailable');
    process.exitCode = 1;
  }
}
