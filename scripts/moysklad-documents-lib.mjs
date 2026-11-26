// Document/position collections only. Never follow a URL supplied in a response.
import { createMoyskladReader, readEntityPages } from './procurement-sync-lib.mjs';

const kinds = ['demand', 'salesreturn', 'supply', 'purchasereturn'];
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export function documentReader(token) {
  return createMoyskladReader(token, { allowPath(path) {
    if (path === 'entity/currency') return true;
    const parts = path.split('/');
    return parts[0] === 'entity' && kinds.includes(parts[1]) && (parts.length === 2 ||
      (parts.length === 4 && uuid.test(parts[2]) && parts[3] === 'positions'));
  } }).get;
}
function check(condition, message) { if (!condition) throw new Error(message); }
function minor(value) { return Number.isSafeInteger(value) && value >= 0; }
function currency(code) {
  check(typeof code === 'string' && /^[A-Z]{3}$/.test(code), 'Unknown source currency');
  return code;
}
export async function sourceCostCurrency(get) {
  const rows = await readEntityPages({get}, 'entity/currency', {filter:'default=true'});
  check(rows.length === 1 && rows[0].default === true, 'Unknown accounting currency');
  return currency(rows[0].isoCode);
}
function name(value) {
  check(typeof value === 'string' && value.trim() && value.length <= 2000, 'Missing source name');
  return value;
}
// Convert a JSON decimal, including scientific notation, to an exact fraction.
function decimal(value) {
  const [digits, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = digits.split('.');
  const scale = fraction.length - Number(exponent);
  const factor = 10n ** BigInt(Math.abs(scale));
  const coefficient = BigInt(whole + fraction);
  return scale < 0 ? [coefficient * factor, 1n] : [coefficient, factor];
}
function grossAmount(quantity, price, discount, extraVat) {
  const [q, qScale] = decimal(quantity);
  const [p, pScale] = decimal(price);
  const [d, dScale] = decimal(discount);
  const [v, vScale] = decimal(extraVat);
  const numerator = q * p * (100n * dScale - d) * (100n * vScale + v);
  const denominator = qScale * pScale * dScale * vScale * 10000n;
  return Number((2n * numerator + denominator) / (2n * denominator));
}
function position(row, doc, costCurrency, outbound) {
  const { quantity, price, discount, vat } = row;
  check(quantity > 0 && Number.isFinite(quantity) && Number.isFinite(price) && price >= 0
    && Number.isFinite(discount) && discount <= 100 && Number.isFinite(vat) && vat >= 0, 'Invalid position');
  check(uuid.test(row.assortment?.id), 'Missing assortment UUID');
  const amount = grossAmount(quantity, price, discount, doc.vatEnabled && !doc.vatIncluded ? vat : 0);
  check(minor(amount), 'Invalid calculated amount');
  const cost = outbound ? row.stock?.cost ?? null : null;
  check(cost === null || minor(cost), 'Invalid source cost');
  return { id:row.id, product_id:row.assortment.id, product:name(row.assortment.name), quantity, price_minor:price, discount, vat, vat_included:doc.vatIncluded ?? false, amount_minor:amount,
    cost_minor:cost, cost_currency:cost === null ? null : costCurrency };
}

// Verify the same set of posted document revisions after reading every position.
// readEntityPages checks pagination counts, offsets and repeated UUIDs.
export async function readDocuments(get, start, end, costCurrency, organizationId) {
  currency(costCurrency);
  check(uuid.test(organizationId), 'Invalid organization UUID');
  const organization = organizationId.toLowerCase();
  const documents = [];
  const filter = 'organization=https://api.moysklad.ru/api/remap/1.2/entity/organization/' + organization +
    ';applicable=true;moment>=' + start + ' 00:00:00;moment<' + end + ' 00:00:00';
  for (const kind of kinds) {
    const path = 'entity/' + kind;
    const query = { filter, expand:'agent,rate.currency,organization', order:'moment,asc' };
    const headers = await readEntityPages({get}, path, query);
    for (const doc of headers) {
      check(doc.organization?.id?.toLowerCase() === organization, 'Unverified source organization');
      check(doc.applicable === true && typeof doc.updated === 'string' && doc.updated.length >= 10 &&
        /^\d{4}-\d{2}-\d{2} /.test(doc.moment) && doc.moment.slice(0,10) >= start && doc.moment.slice(0,10) < end,
        'Invalid posted document or month');
      check(typeof doc.vatEnabled === 'boolean' && (!doc.vatEnabled || typeof doc.vatIncluded === 'boolean') &&
        uuid.test(doc.agent?.id) && minor(doc.sum), 'Invalid document');
      const outbound = kind === 'demand' || kind === 'salesreturn';
      const rows = await readEntityPages({get}, path + '/' + doc.id + '/positions',
        {expand:'assortment', ...(outbound && {fields:'stock'})});
      check(doc.positions?.meta?.size === rows.length, 'Incomplete document position page');
      const lines = rows.map(row => position(row, doc, costCurrency, outbound));
      check(lines.reduce((sum,l) => sum + BigInt(l.amount_minor), 0n) === BigInt(doc.sum), 'Document total mismatch');
      documents.push({kind, organization, id:doc.id, name:name(doc.name), day:doc.moment.slice(0,10), counterparty:doc.agent.id,
        counterparty_name:name(doc.agent.name), currency:currency(doc.rate?.currency?.isoCode), total_minor:doc.sum, lines});
    }
    const verified = await readEntityPages({get}, path, {filter, order:query.order});
    const revisions = new Map(verified.map(doc => [doc.id,doc.updated]));
    check(verified.length === headers.length && headers.every(doc => revisions.get(doc.id) === doc.updated),
      'Source document changed during import');
  }
  return documents;
}
