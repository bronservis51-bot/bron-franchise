import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const manager = 'fm@demo.example.com';
const owner = 'alpha.owner@demo.example.com';
let db: TestDb;
let partner: string;
let period: string;

beforeAll(async () => {
  db = await createTestDb();
  [{ id: partner }] = await db.admin<{ id: string }>("select id from public.partner where code = 'ALPHA'");
  [{ period }] = await db.admin<{ period: string }>("select (app_private.current_month() - interval '1 month')::date::text as period");
}, 180_000);
afterAll(async () => db?.db.close());

it('makes the private workbook link available only to network managers', async () => {
  await db.admin("insert into app_private.manager_google_report_settings(spreadsheet_id) values ('test_spreadsheet_1234567890')");
  expect(await db.as(manager, 'select public.manager_google_report_link() as value'))
    .toEqual([{ value: 'https://docs.google.com/spreadsheets/d/test_spreadsheet_1234567890/edit' }]);
  await db.expectError(owner, 'select public.manager_google_report_link()', 'forbidden');
  await expect(db.as(null, 'select public.manager_google_report_link()')).rejects.toThrow('permission denied');
});

it('credits confirmations without guessing a bank date and keeps unperiodized debt outside monthly balances', async () => {
  const baseline = async () => (await db.admin<{ accrued_minor: number; debt_minor: number; paid_minor: number }>(
    'select accrued_minor::int, debt_minor::int, paid_minor::int from app_private.royalty_ledger($1) where month = $2',
    [partner, period],
  ))[0];
  const before = await baseline();
  expect(before.debt_minor).toBeGreaterThan(0);
  await db.admin('insert into public.royalty_payment(partner_id,month,amount_minor,note) values ($1,$2,$3,$4)',
    [partner, period, before.debt_minor, 'Owner confirmed payment without a bank date']);
  await db.as(manager, 'select public.royalty_manual_add($1,null,1163400,$2)', [partner, 'The period is unknown']);
  expect(await baseline()).toEqual({ ...before, debt_minor: 0, paid_minor: before.paid_minor + before.debt_minor });
  const [known] = await db.as<{ data: { months: { month: string }[]; undated: { debt_minor: number } } }>(
    manager, 'select public.royalty_partner($1) as data', [partner]);
  expect(known.data.undated.debt_minor).toBe(1163400);
  expect(known.data.months.every(row => row.month !== null)).toBe(true);
  const [summary] = await db.as<{ data: { rows: { partner_id: string; undated_debt_minor: number }[] } }>(
    manager, 'select public.royalty_summary(null) as data');
  expect(summary.data.rows.find(row => row.partner_id === partner)?.undated_debt_minor).toBe(1163400);
  const [legacy] = await db.as<{ data: { month: string }[] }>(manager, 'select public.royalty_ops($1,30) as data', [partner]);
  expect(legacy.data.every(op => op.month !== null)).toBe(true);
  const [ops] = await db.as<{ data: { paid_on?: string | null; month: string | null; op: string }[] }>(
    manager, 'select public.royalty_ops_v2($1,30) as data', [partner]);
  expect(ops.data).toContainEqual(expect.objectContaining({ op: 'past_debt', month: null }));
  expect(ops.data).toContainEqual(expect.objectContaining({ op: 'payment', month: period, paid_on: null }));
  await db.as(manager, "select public.financial_operation('royalty_payment_reviewed',$1::jsonb,$2::uuid)", [{
    p_partner: partner, p_month: null, p_amount: 500, p_paid_on: new Date().toISOString().slice(0, 10),
    p_note: 'Payment towards the undated debt', p_reviewed: [],
  }, crypto.randomUUID()]);
  const [balance] = await db.admin<{ amount: number }>('select debt_minor::int as amount from app_private.royalty_ledger($1) where month is null', [partner]);
  expect(balance.amount).toBe(1162900);
});
