// Private test-mode worker. No public ingress or live payment credentials.
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { databaseConfig } from './database-config.mjs';

const api = 'https://api.yookassa.ru/v3/payments';
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const checkoutHosts = new Set(['yoomoney.ru', 'yookassa.ru']);
const paymentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function royaltyTestConfig(env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('YooKassa requires verified TLS');
  const shopId = env.YOOKASSA_TEST_SHOP_ID;
  const key = env.YOOKASSA_TEST_SECRET;
  if (env.BRON_YOOKASSA_MODE !== 'test' || !/^\d+$/.test(shopId ?? '') || !/^test_\S+$/.test(key ?? '')) {
    throw new Error('Test shop ID, test secret and explicit test mode are required');
  }

  const databaseUrl = new URL(env.BRON_ROYALTY_TEST_DATABASE_URL ?? '');
  if (!localHosts.has(databaseUrl.hostname) || databaseUrl.pathname !== '/bron_royalty_test' ||
      ['host', 'hostaddr', 'database', 'dbname'].some(name => databaseUrl.searchParams.has(name))) {
    throw new Error('An isolated local bron_royalty_test database is required');
  }

  const returnUrl = new URL(env.BRON_ROYALTY_TEST_RETURN_URL ?? 'http://localhost:5173/');
  if (!localHosts.has(returnUrl.hostname) || returnUrl.username || returnUrl.password ||
      !['http:', 'https:'].includes(returnUrl.protocol)) {
    throw new Error('A local return URL is required for the test checkout');
  }
  return { shopId, key, databaseUrl: databaseUrl.toString(), returnUrl: returnUrl.href };
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

export async function reconcileRoyaltyAttempt(attempt, client) {
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
  const metadata = { royalty_attempt_id: attempt.id, royalty_month: attempt.month.slice(0, 7) };
  const payment = await client.request(attempt.provider_id, attempt.id, {
    amount: { value, currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: client.returnUrl },
    description: `Роялти за ${monthName} ${year} года`,
    metadata,
  });

  if (!paymentIdPattern.test(payment?.id) || (attempt.provider_id && attempt.provider_id !== payment.id) ||
      payment.test !== true || String(payment.recipient?.account_id) !== client.shopId ||
      payment.amount?.currency !== 'RUB' || payment.amount?.value !== value ||
      payment.metadata?.royalty_attempt_id !== metadata.royalty_attempt_id ||
      payment.metadata?.royalty_month !== metadata.royalty_month ||
      !['pending', 'canceled', 'succeeded'].includes(payment.status)) {
    throw new Error('Mismatched test payment');
  }

  let checkoutUrl = null;
  let paidOn = null;
  if (payment.status === 'pending' && (!attempt.provider_id || payment.confirmation?.confirmation_url)) {
    const url = new URL(payment.confirmation?.confirmation_url ?? '');
    if (payment.confirmation.type !== 'redirect' || !checkoutHosts.has(url.hostname) ||
        url.protocol !== 'https:' || url.port || url.username || url.password) {
      throw new Error('Untrusted checkout URL');
    }
    checkoutUrl = url.href;
  }
  if (payment.status === 'succeeded') {
    if (payment.paid !== true || !/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(payment.captured_at ?? '')) {
      throw new Error('Unconfirmed test payment');
    }
    paidOn = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(payment.captured_at));
  }
  return { providerId: payment.id, status: payment.status, checkoutUrl, paidOn };
}

async function run() {
  const config = royaltyTestConfig(process.env);
  const client = createTestYooKassa(config);
  const db = new pg.Client({
    ...databaseConfig(config.databaseUrl),
    statement_timeout: 10_000, query_timeout: 12_000, application_name: 'bron-royalty-test',
  });
  await db.connect();
  try {
    // Lease just before calling the provider so earlier HTTP requests cannot age this lease.
    for (let processed = 0; processed < 5; processed++) {
      const { rows: [attempt] } = await db.query(`
        select id, lease, month::text as month, amount_minor, provider_id
        from app_private.royalty_checkout_work(1)
      `);
      if (!attempt) break;
      try {
        const p = await reconcileRoyaltyAttempt(attempt, client);
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
