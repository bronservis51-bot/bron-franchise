// Target-only import building block. This module has no CLI, credentials or photo data.
// The operator supplies reviewed input privately on the VPS and a dedicated authenticated
// pg client. Existing RPC permissions, day versions, audit and operation receipts remain authoritative.
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^(empty|[0-9a-f]{32})$/;
const MAX = 100000000000n;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v);
export const planSha256 = (plan) => createHash('sha256').update(`${canonical(plan)}\n`).digest('hex');
const minor = (v) => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) > MAX) fail('IMPORT_INVALID_AMOUNT');
  return BigInt(v);
};
const date = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('IMPORT_INVALID_DATE');
  const parsed = new Date(`${v}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) fail('IMPORT_INVALID_DATE');
  return v;
};

function validatedInput(input) {
  if (!input || input.format !== 1 || !UUID.test(input.batchId) || !UUID.test(input.locationId)
    || !/^[A-Z]{3}$/.test(input.currency) || !Number.isInteger(input.year) || input.year < 2000 || input.year > 2100
    || !Number.isInteger(input.month) || input.month < 1 || input.month > 12
    || !Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 31) fail('IMPORT_INVALID_INPUT');
  const month = `${input.year}-${String(input.month).padStart(2, '0')}-`;
  const entries = input.entries.map(row => ({ day: date(row.day), totalMinor: minor(row.totalMinor).toString() }))
    .sort((a, b) => a.day.localeCompare(b.day));
  if (entries.some(r => !r.day.startsWith(month)) || new Set(entries.map(r => r.day)).size !== entries.length) fail('IMPORT_INVALID_DAYS');
  return { format: 1, batchId: input.batchId.toLowerCase(), locationId: input.locationId.toLowerCase(),
    currency: input.currency, year: input.year, month: input.month, entries };
}

function operationId(input, day) {
  const hex = createHash('sha256').update(`BRON_MISSING_DAY_TOTAL_V1:${input.batchId}:${input.locationId}:${day}`).digest('hex').slice(0, 32).split('');
  hex[12] = '8'; hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Never infer absent dates, payment methods, staff attribution or past payroll. */
export function buildRevenueImportPlan(rawInput, snapshot) {
  const input = validatedInput(rawInput);
  if (!snapshot || snapshot.locationId?.toLowerCase() !== input.locationId || snapshot.currency !== input.currency
    || snapshot.status !== 'active' || !UUID.test(snapshot.partnerId) || !Array.isArray(snapshot.days)) fail('IMPORT_LOCATION_MISMATCH');
  const today = date(snapshot.today);
  const current = new Map();
  for (const row of snapshot.days) {
    if (current.has(row.day) || !VERSION.test(row.version) || !Number.isInteger(row.rowCount) || row.rowCount < 0) fail('IMPORT_INVALID_SNAPSHOT');
    date(row.day); minor(row.totalMinor);
    if ((row.rowCount === 0) !== (row.version === 'empty') || (row.rowCount === 0 && row.totalMinor !== '0')) fail('IMPORT_INVALID_SNAPSHOT');
    current.set(row.day, row);
  }
  const rows = input.entries.map(entry => {
    if (entry.day > today) fail('IMPORT_FUTURE_DAY');
    const row = current.get(entry.day);
    if (!row) fail('IMPORT_INCOMPLETE_SNAPSHOT');
    const disposition = row.rowCount === 0 ? 'INSERT_TOTAL'
      : row.totalMinor === entry.totalMinor ? 'KEEP_MATCHING' : 'CONFLICT';
    return { ...entry, expectedVersion: row.version, existingRowCount: row.rowCount,
      existingTotalMinor: row.totalMinor, operationId: operationId(input, entry.day), disposition };
  });
  const conflicts = rows.filter(r => r.disposition === 'CONFLICT').length;
  return { format: 1, protocol: 'BRON_MISSING_DAY_TOTAL_IMPORT_V1', input,
    partnerId: snapshot.partnerId.toLowerCase(), permittedMutation: 'INSERT_MISSING_DAY_TOTALS_ONLY',
    status: conflicts ? 'BLOCKED_CONFLICT' : 'READY', rows,
    summary: { suppliedDays: rows.length, insertDays: rows.filter(r => r.disposition === 'INSERT_TOTAL').length,
      matchingDays: rows.filter(r => r.disposition === 'KEEP_MATCHING').length, conflictingDays: conflicts } };
}

/** q(sql, params) returns rows. Keep the returned snapshot/plan in a private VPS file. */
export async function inspectRevenueImport(q, rawInput) {
  const input = validatedInput(rawInput);
  const [location] = await q(`select id::text as "locationId", partner_id::text as "partnerId", currency, status::text,
      app_private.local_today(id)::text as today from public.location where id=$1`, [input.locationId]);
  if (!location) fail('IMPORT_LOCATION_MISMATCH');
  const days = await q(`select d.day::text, app_private.revenue_day_version($1,d.day) as version,
      count(r.id)::int as "rowCount", coalesce(sum(r.total_minor),0)::text as "totalMinor"
    from unnest($2::date[]) d(day) left join public.daily_revenue r on r.location_id=$1 and r.day=d.day
    group by d.day order by d.day`, [input.locationId, input.entries.map(r => r.day)]);
  const plan = buildRevenueImportPlan(input, { ...location, days });
  return { plan, sha256: planSha256(plan) };
}

/**
 * Requires a fresh dedicated client with a legitimate application actor/session already
 * configured by the reviewed operator. Does not impersonate users or bypass RPC checks.
 * expectedPlanSha256 binds the private preview; any day change rolls back the whole batch.
 * A COMMIT_UNKNOWN must be reconciled from existing operation receipts, never blindly retried.
 */
export async function applyMissingRevenueTotals(q, input, expectedPlanSha256) {
  if (!SHA.test(expectedPlanSha256)) fail('IMPORT_PLAN_PIN_REQUIRED');
  const checked = validatedInput(input);
  let transactionStarted = false; let commitAttempted = false;
  try {
    await q('begin isolation level repeatable read'); transactionStarted = true;
    await q('select app_private.require_user()');
    for (const row of checked.entries) await q('select app_private.revenue_day_lock($1,$2)', [checked.locationId, row.day]);
    const { plan, sha256 } = await inspectRevenueImport(q, checked);
    if (sha256 !== expectedPlanSha256 || plan.status !== 'READY') fail('IMPORT_PLAN_CHANGED_OR_CONFLICT');
    for (const row of plan.rows) {
      if (row.disposition !== 'INSERT_TOTAL') continue;
      await q(`select public.revenue_total_set($1,$2,$3,$4,$5,$6)`,
        [checked.locationId, row.day, row.totalMinor, row.expectedVersion, row.operationId,
          'Импорт подтверждённого итога дня; способ оплаты не указан']);
    }
    const verified = await inspectRevenueImport(q, checked);
    if (verified.plan.rows.some(r => r.disposition !== 'KEEP_MATCHING')) fail('IMPORT_POSTCHECK_FAILED');
    commitAttempted = true; await q('commit'); transactionStarted = false;
    return { status: 'PASS', insertedDays: plan.summary.insertDays, unchangedDays: plan.summary.matchingDays,
      suppliedDays: plan.summary.suppliedDays, staffShiftsWritten: 0, payrollRecalculated: false,
      planSha256: expectedPlanSha256, targetWriteOutcome: plan.summary.insertDays ? 'COMMITTED' : 'UNCHANGED' };
  } catch (error) {
    if (transactionStarted) { try { await q('rollback'); } catch { /* report uncertainty below */ } }
    if (commitAttempted) fail('IMPORT_COMMIT_UNKNOWN');
    throw error;
  }
}
