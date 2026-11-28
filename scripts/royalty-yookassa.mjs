// Private worker for the test and live royalty queues. No public ingress.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseConfig } from './database-config.mjs';

const yookassaOrigin = 'https://api.yookassa.ru';
const api = yookassaOrigin + '/v3/payments';
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

function requireLiveCredentials(shopId, key) {
  if (!/^\d+$/.test(shopId ?? '') || !/^live_[!-~]+$/.test(key ?? '')) throw new Error('Live YooKassa shop credentials are required');
}

function royaltyLiveCredentials(env) {
  if (env.BRON_YOOKASSA_MODE !== 'invoice_live' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Explicit live invoice mode with verified TLS is required');
  }
  const shopId = env.YOOKASSA_LIVE_SHOP_ID;
  const key = env.YOOKASSA_LIVE_SECRET;
  requireLiveCredentials(shopId, key);
  return { shopId, key };
}

export function royaltyLiveInvoiceConfig(env) {
  const credentials = royaltyLiveCredentials(env);
  const url = new URL(env.BRON_ROYALTY_LIVE_DATABASE_URL ?? '');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || name === 'bron_royalty_test') throw new Error('A distinct working database is required');
  const databaseUrl = url.toString();
  databaseConfig(databaseUrl, env);
  return { ...credentials, databaseUrl };
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
    throw new Error('Unconfirmed payment');
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
  return createInvoiceClient(base.origin, { test: true }, fetchImpl);
}

export function createLiveInvoiceYooKassa({ shopId, key }, fetchImpl = fetch) {
  requireLiveCredentials(shopId, key);
  return createInvoiceClient(yookassaOrigin, { shopId, test: false,
    authorization: 'Basic ' + Buffer.from(shopId + ':' + key).toString('base64') }, fetchImpl);
}

export class YooKassaHttpError extends Error {
  constructor(status) {
    super(`YooKassa HTTP ${status}`);
    this.status = status;
  }
}

function createInvoiceClient(origin, { shopId, test, authorization }, fetchImpl) {
  async function request(path, options) {
    const headers = { Accept: 'application/json', ...options.headers };
    if (authorization) headers.Authorization = authorization;
    const response = await fetchImpl(origin + '/v3/' + path, {
      ...options, headers, redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new YooKassaHttpError(response.status);
    return response.json();
  }
  return { shopId, test,
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

async function verifiedInvoicePayment(client, invoiceId, paymentId, amount) {
  if (!invoiceIdPattern.test(invoiceId) || !paymentIdPattern.test(paymentId)) throw new Error('Missing invoice payment');
  const payment = await client.getPayment(paymentId);
  if (payment?.id !== paymentId || payment.invoice_details?.id !== invoiceId || payment.test !== client.test ||
      (client.test === false && String(payment.recipient?.account_id) !== client.shopId) ||
      payment.status !== 'succeeded' || !matchingAmount(payment.amount, amount)) throw new Error('Mismatched invoice payment');
  const paidOn = verifiedPaidOn(payment);
  if (client.test !== false) return { paidOn };

  const refund = payment.refunded_amount;
  if (refund === undefined) return { paidOn, paymentId, refundedMinor: '0' };
  if (refund?.currency !== amount.currency || !/^\d+\.\d{2}$/.test(refund.value)) throw new Error('Invalid invoice refund amount');
  const refunded = BigInt(refund.value.replace('.', ''));
  if (refunded > BigInt(amount.value.replace('.', ''))) throw new Error('Invalid invoice refund amount');
  return { paidOn, paymentId, refundedMinor: refunded.toString() };
}

export async function reconcileRoyaltyInvoice(attempt, client) {
  const { amount, period, metadata } = royaltyTerms(attempt);
  if (attempt.provider_id !== null && !invoiceIdPattern.test(attempt.provider_id)) throw new Error('Invalid saved invoice ID');
  if (attempt.provider_id === null && BigInt(attempt.amount_minor) < 100n) throw new Error('Invoice amount is below the minimum');
  const item = `Оплата роялти за ${period}`;
  let invoice;
  if (attempt.provider_id) {
    invoice = await client.getInvoice(attempt.provider_id);
  } else {
    const line = { description: item, amount, quantity: 1, vat_code: 7,
      payment_mode: 'full_prepayment', payment_subject: 'commodity' };
    const receipt = { tax_system_code: 2, items: [line] };
    if (client.test === false) {
      const email = attempt.invoice_receipt_email;
      if (typeof email !== 'string' || email.length > 254 || !/^[^\s@<>]+@[^.\s@<>]+(?:\.[^.\s@<>]+)+$/u.test(email)) {
        throw new Error('Missing or invalid royalty receipt email');
      }
      receipt.customer = { email };
      line.measure = 'piece';
    }
    invoice = await client.createInvoice(attempt.id, {
      description: invoiceDescription(attempt.invoice_name, period),
      payment_data: { amount, capture: true, description: item, metadata, receipt },
      cart: [{ description: item, price: amount, quantity: 1 }],
      delivery_method_data: { type: 'self' },
      expires_at: new Date(attempt.first_dispatch_at.getTime() + 24 * 60 * 60_000).toISOString(),
      metadata,
    });
  }

  const line = invoice?.cart?.[0];
  if (!invoiceIdPattern.test(invoice?.id) || (attempt.provider_id && attempt.provider_id !== invoice.id) ||
      !matchingMetadata(invoice.metadata, metadata) || invoice.cart?.length !== 1 || line?.description !== item ||
      line.quantity !== 1 || line.discount_price || !matchingAmount(line.price, amount) ||
      !['pending', 'canceled', 'succeeded'].includes(invoice.status)) throw new Error('Mismatched invoice');

  let checkoutUrl = null;
  if (invoice.status === 'pending') {
    if (invoice.delivery_method?.type !== 'self') throw new Error('Untrusted checkout URL');
    checkoutUrl = verifiedCheckoutUrl(invoice.delivery_method.url);
  }
  if (invoice.status === 'succeeded') {
    if (invoice.payment_details?.status !== 'succeeded') throw new Error('Missing invoice payment');
    const detail = await verifiedInvoicePayment(client, invoice.id, invoice.payment_details.id, amount);
    return { providerId: invoice.id, status: invoice.status, checkoutUrl, ...detail };
  }
  if (invoice.status === 'canceled' && invoice.payment_details && invoice.payment_details.status !== 'canceled') {
    throw new Error('Cancellation has an unresolved payment');
  }
  return { providerId: invoice.id, status: invoice.status, checkoutUrl, paidOn: null };
}

export async function reconcileRoyaltyRefund(attempt, client) {
  if (client.test !== false || !invoiceIdPattern.test(attempt.provider_id)) throw new Error('Invalid refund check');
  const settled = attempt.payment_id
    ? await verifiedInvoicePayment(client, attempt.provider_id, attempt.payment_id, royaltyTerms(attempt).amount)
    : await reconcileRoyaltyInvoice(attempt, client);
  if (!settled.paymentId) throw new Error('Missing verified invoice payment for refund check');
  return { paymentId: settled.paymentId, refundedMinor: settled.refundedMinor };
}

async function run(env) {
  const live = env.BRON_YOOKASSA_MODE === 'invoice_live';
  const mock = env.BRON_YOOKASSA_MODE === 'invoice_mock';
  const useInvoice = live || mock;
  const config = live ? royaltyLiveInvoiceConfig(env)
    : mock ? { databaseUrl: royaltyTestDatabaseUrl(env) } : royaltyTestConfig(env);
  const client = live ? createLiveInvoiceYooKassa(config)
    : mock ? createMockInvoiceYooKassa(env.BRON_YOOKASSA_INVOICE_MOCK_URL) : createTestYooKassa(config);
  const reconcile = useInvoice ? reconcileRoyaltyInvoice : reconcileRoyaltyAttempt;
  const jobSql = live ? `select id, lease, month::text as month, amount_minor, provider_id, invoice_name, first_dispatch_at, invoice_receipt_email
    from app_private.royalty_live_invoice_checkout_work(1,$1)`
    : mock ? `select id, lease, month::text as month, amount_minor, provider_id, invoice_name, first_dispatch_at
    from app_private.royalty_invoice_checkout_work(1)` : `select id, lease, month::text as month, amount_minor, provider_id
    from app_private.royalty_checkout_work(1)`;
  const db = new pg.Client({
    ...databaseConfig(config.databaseUrl, env),
    statement_timeout: 10_000, query_timeout: 12_000, application_name: live ? 'bron-royalty-invoice' : 'bron-royalty-test',
  });
  await db.connect();
  try {
    // Lease just before calling the provider so earlier HTTP requests cannot age this lease.
    for (let processed = 0; processed < 5; processed++) {
      const { rows: [attempt] } = await db.query(jobSql, live ? [config.shopId] : []);
      if (!attempt) break;
      try {
        const p = await reconcile(attempt, client);
        const observation = [attempt.id, attempt.lease, p.providerId, p.status, p.checkoutUrl, p.paidOn];
        if (live) {
          await db.query('select app_private.royalty_live_invoice_checkout_observe($1,$2,$3,$4,$5,$6,$7,$8)',
            [...observation, p.paymentId ?? null, p.refundedMinor ?? null]);
        } else {
          await db.query('select app_private.royalty_checkout_observe($1,$2,$3,$4,$5,$6)', observation);
        }
      } catch (error) {
        // An uncertain request is retried only with the same key; it never produces a journal entry.
        console.error(error instanceof YooKassaHttpError ? error.message : 'Royalty payment could not be reconciled');
        process.exitCode = 1;
      }
    }
    if (live) {
      const { rows: settled } = await db.query(
        `select id,lease,month::text as month,amount_minor,provider_id,payment_id
         from app_private.royalty_live_refund_work(3,$1)`, [config.shopId]);
      const results = await Promise.allSettled(settled.map(async (payment) => {
        const refund = await reconcileRoyaltyRefund(payment, client);
        await db.query('select app_private.royalty_live_refund_observe($1,$2,$3,$4)',
          [payment.id, payment.lease, refund.paymentId, refund.refundedMinor]);
      }));
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(result.reason instanceof YooKassaHttpError ? result.reason.message : 'Royalty refund could not be reconciled');
          process.exitCode = 1;
        }
      }
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, id, ...extra] = process.argv.slice(2);
    if (action === '--verify-payment' && paymentIdPattern.test(id) && !extra.length) {
      const settings = royaltyLiveCredentials(process.env);
      const client = createLiveInvoiceYooKassa(settings);
      const payment = await client.getPayment(id);
      if (payment?.id !== id || payment.test !== false || payment.paid !== true || payment.status !== 'succeeded' ||
          String(payment.recipient?.account_id) !== client.shopId) throw new Error('Unverified live shop');
      console.log('Verified access to the live YooKassa shop via an existing payment');
    } else if (process.argv.length === 2) await run(process.env);
    else throw new Error('Unknown royalty worker arguments');
  } catch (error) {
    console.error(error instanceof YooKassaHttpError ? error.message : 'Royalty worker configuration, database or provider is unavailable');
    process.exitCode = 1;
  }
}
