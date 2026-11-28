// The gateway owns the shop key. Its Unix socket is the worker's only YooKassa interface.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const origin = 'https://api.yookassa.ru';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const attemptId = new RegExp('^' + uuid + '$', 'i');
const invoicePath = new RegExp('^/v3/invoices/in-' + uuid + '$', 'i');
const paymentPath = new RegExp('^/v3/payments/' + uuid + '$', 'i');
const maxRequestBytes = 16_384;
const maxResponseBytes = 65_536;

function hasKeys(value, ...keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function matchesAmount(candidate, amount) {
  return hasKeys(candidate, 'value', 'currency') && candidate.currency === 'RUB' && candidate.value === amount.value;
}

function matchesMetadata(candidate, marker) {
  return hasKeys(candidate, 'royalty_attempt_id', 'royalty_month') &&
    candidate.royalty_attempt_id === marker.royalty_attempt_id && candidate.royalty_month === marker.royalty_month;
}

function validInvoice(body, key) {
  if (typeof key !== 'string' || !attemptId.test(key) ||
      !hasKeys(body, 'description', 'metadata', 'delivery_method_data', 'expires_at', 'cart', 'payment_data') ||
      typeof body.description !== 'string' || !body.description.trim() || body.description.length > 128 ||
      !hasKeys(body.metadata, 'royalty_attempt_id', 'royalty_month') || body.metadata.royalty_attempt_id !== key ||
      typeof body.metadata.royalty_month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.metadata.royalty_month) ||
      !hasKeys(body.delivery_method_data, 'type') || body.delivery_method_data.type !== 'self' ||
      typeof body.expires_at !== 'string' || !Array.isArray(body.cart) || body.cart.length !== 1) return false;

  const expiresAt = new Date(body.expires_at);
  const lifetime = expiresAt.getTime() - Date.now();
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 25 * 3_600_000 ||
      expiresAt.toISOString() !== body.expires_at) return false;

  const { payment_data: payment, cart: [goods], metadata } = body;
  if (!hasKeys(payment, 'amount', 'capture', 'description', 'metadata', 'receipt') ||
      payment.capture !== true || !matchesMetadata(payment.metadata, metadata) ||
      !hasKeys(payment.amount, 'value', 'currency') || payment.amount.currency !== 'RUB' ||
      typeof payment.amount.value !== 'string' || !/^[1-9]\d{0,15}\.\d{2}$/.test(payment.amount.value) ||
      typeof payment.description !== 'string' || !/^Оплата роялти за [а-яё]+ \d{4}$/u.test(payment.description) ||
      !hasKeys(goods, 'description', 'price', 'quantity') || goods.quantity !== 1 ||
      goods.description !== payment.description || !matchesAmount(goods.price, payment.amount)) return false;

  const { receipt } = payment;
  if (!hasKeys(receipt, 'tax_system_code', 'customer', 'items') || receipt.tax_system_code !== 2 ||
      !hasKeys(receipt.customer, 'email') || typeof receipt.customer.email !== 'string' ||
      receipt.customer.email.length > 254 || !/^[^\s@<>]+@[^.\s@<>]+(?:\.[^.\s@<>]+)+$/u.test(receipt.customer.email) ||
      !Array.isArray(receipt.items) || receipt.items.length !== 1) return false;

  const [item] = receipt.items;
  return hasKeys(item, 'description', 'amount', 'quantity', 'vat_code', 'payment_mode', 'payment_subject', 'measure') &&
    item.description === payment.description && matchesAmount(item.amount, payment.amount) && item.quantity === 1 &&
    item.vat_code === 7 && item.payment_mode === 'full_prepayment' && item.payment_subject === 'commodity' && item.measure === 'piece';
}

async function readBody(stream, limit) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const data = Buffer.from(chunk);
    bytes += data.length;
    if (bytes > limit) throw new Error('Body too large');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respond(res, status, body = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const amount = value => value == null ? undefined : { value: value.value, currency: value.currency };

function paymentView(payment) {
  return {
    id: payment.id, status: payment.status, paid: payment.paid, test: payment.test, captured_at: payment.captured_at,
    recipient: { account_id: payment.recipient?.account_id },
    invoice_details: { id: payment.invoice_details?.id },
    amount: amount(payment.amount), refunded_amount: amount(payment.refunded_amount),
  };
}

function invoiceView(invoice) {
  return {
    id: invoice.id, status: invoice.status,
    metadata: { royalty_attempt_id: invoice.metadata?.royalty_attempt_id, royalty_month: invoice.metadata?.royalty_month },
    delivery_method: { type: invoice.delivery_method?.type, url: invoice.delivery_method?.url },
    payment_details: invoice.payment_details == null
      ? undefined : { id: invoice.payment_details.id, status: invoice.payment_details.status },
    cart: Array.isArray(invoice.cart) ? invoice.cart.map(item => ({
      description: item?.description, quantity: item?.quantity, price: amount(item?.price), discount_price: item?.discount_price,
    })) : undefined,
  };
}

export function createRoyaltyInvoiceGateway({ shopId, secret }, fetchImpl = fetch) {
  if (!/^\d+$/.test(shopId ?? '') || !/^live_[!-~]+$/.test(secret ?? '') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Live gateway requires verified TLS and a working shop key');
  }
  const authorization = 'Basic ' + Buffer.from(shopId + ':' + secret).toString('base64');

  async function handle(req, res) {
    const path = req.url;
    const create = req.method === 'POST' && path === '/v3/invoices';
    const lookupPayment = req.method === 'GET' && paymentPath.test(path);
    if (req.headers['x-bron-royalty-shop-id'] !== shopId ||
        !(create || lookupPayment || (req.method === 'GET' && invoicePath.test(path)))) {
      respond(res, 403);
      return;
    }

    const headers = { Authorization: authorization, Accept: 'application/json' };
    let body;
    if (create) {
      const key = req.headers['idempotence-key'];
      try {
        const payload = JSON.parse(await readBody(req, maxRequestBytes));
        if (!validInvoice(payload, key)) throw new Error('Invalid invoice');
        headers['Idempotence-Key'] = key;
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(payload);
      } catch {
        respond(res, 400);
        return;
      }
    }

    const upstream = await fetchImpl(origin + path, {
      method: create ? 'POST' : 'GET', headers, body, redirect: 'error', signal: AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      respond(res, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
      return;
    }
    const result = JSON.parse(await readBody(upstream.body, maxResponseBytes));
    respond(res, 200, lookupPayment ? paymentView(result) : invoiceView(result));
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 2_000 }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) respond(res, 502);
      else res.destroy();
    });
  });
  server.maxConnections = 32;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '1' ||
        process.env.LISTEN_FDNAMES !== 'royalty-invoice') throw new Error('Missing systemd invoice socket');
    const server = createRoyaltyInvoiceGateway({
      shopId: process.env.YOOKASSA_LIVE_SHOP_ID, secret: process.env.YOOKASSA_LIVE_SECRET,
    });
    server.on('error', () => { console.error('Royalty invoice gateway socket is unavailable'); process.exitCode = 1; });
    server.listen({ fd: 3 });
  } catch {
    console.error('Royalty invoice gateway configuration is unavailable');
    process.exitCode = 1;
  }
}
