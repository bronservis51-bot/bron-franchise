import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const owner = 'alpha.owner@demo.example.com';
const other = 'beta.owner@demo.example.com';
const manager = 'fm@demo.example.com';
let t: TestDb;
let location: string;
let partner: string;

beforeAll(async () => {
  t = await createTestDb();
  const [fixture] = await t.admin<{ location: string; partner: string }>(
    "select id as location, partner_id as partner from public.location where code = 'ALPHA-1'",
  );
  ({ location, partner } = fixture);
}, 180_000);
afterAll(() => t?.db.close());

const november = '2026-11-01';
const december = '2026-12-01';
const january = '2027-01-01';
const february = '2027-02-01';

async function setReportMonth(month: string) {
  await t.admin(`create or replace function app_private.current_month() returns date language sql stable as $$ select date '${month}' $$`);
}

interface ExpenseRow { id: string; category: string; amount_minor: number; repeat_series_id: string | null }

async function report(user: string, month: string) {
  const [{ report }] = await t.as<{ report: { current: { expenses_minor: number }; expenses: ExpenseRow[] } }>(
    user, 'select public.finance_my($1, null) report', [month],
  );
  return report;
}

async function save(user: string, month: string, category: string, amount: number, recurring: boolean, id: string | null = null) {
  const [{ id: saved }] = await t.as<{ id: string }>(user,
    "select public.financial_operation('expense_save_repeating', $1::jsonb, gen_random_uuid()) id",
    [JSON.stringify({ p_id: id, p_month: month, p_location: location, p_category: category, p_amount: amount, p_recurring: recurring })],
  );
  return saved;
}

it('calculates one monthly occurrence in the owner, network and export reports, preserving old rows on edit and delete', async () => {
  await setReportMonth(november);
  const source = await save(owner, november, 'Аренда', 1000, true);
  await save(owner, november, 'Ремонт', 500, false);
  expect((await report(owner, november)).expenses.find(row => row.id === source)?.repeat_series_id).toBeTruthy();
  await setReportMonth(december);

  const ownerReport = await report(owner, december);
  expect(ownerReport.current.expenses_minor).toBe(1000);
  const [occurrence] = ownerReport.expenses;
  expect(occurrence.category).toBe('Аренда');
  expect((await report(owner, december)).expenses).toEqual([occurrence]);
  expect(await t.admin('select id from public.expense where id=$1', [occurrence.id])).toEqual([]);
  const [{ result }] = await t.as<{ result: { partners: { partner_id: string; expenses_minor: number }[] } }>(
    manager, 'select public.manager_economy($1) result', [december],
  );
  expect(result.partners.find(row => row.partner_id === partner)?.expenses_minor).toBe(1000);
  await t.admin('update public.partner set is_demo=false where id=$1', [partner]);
  const excel = await t.admin<{ key: string; amount: string }>(
    "select key, amount from app_private.google_finance_rows($1,$1) where kind='expense' and partner_id=$2", [december, partner],
  );
  expect(excel).toEqual([{ key: `expense:${occurrence.id}`, amount: '1000' }]);
  expect((await report(other, december)).expenses).toEqual([]);
  await t.expectError(other, 'select public.expense_delete($1)', 'not-found', [occurrence.id]);

  const oneOff = await save(owner, december, 'Аренда', 800, false);
  expect((await report(owner, december)).current.expenses_minor).toBe(1800);
  await t.as(owner, 'select public.expense_delete($1)', [oneOff]);
  expect(await save(owner, december, 'Аренда', 1400, true, occurrence.id)).toBe(occurrence.id);
  expect((await report(owner, december)).expenses).toEqual([expect.objectContaining({ id: occurrence.id, amount_minor: 1400 })]);
  await setReportMonth(january);
  const [januaryOccurrence] = (await report(owner, january)).expenses;
  expect(januaryOccurrence.amount_minor).toBe(1400);
  await t.admin("update public.partner set status='suspended' where id=$1", [partner]);
  try {
    await t.expectError(owner, 'select public.expense_delete($1)', 'forbidden', [januaryOccurrence.id]);
    expect((await report(owner, january)).expenses).toEqual([januaryOccurrence]);
  } finally {
    await t.admin("update public.partner set status='active' where id=$1", [partner]);
  }
  await t.as(owner, 'select public.expense_delete($1)', [januaryOccurrence.id]);
  expect((await report(owner, january)).expenses).toEqual([]);
  await setReportMonth(february);
  expect((await report(owner, february)).expenses).toEqual([]);
  expect((await report(owner, november)).expenses.find(row => row.id === source)?.amount_minor).toBe(1000);
  expect((await report(owner, december)).expenses.find(row => row.id === occurrence.id)?.amount_minor).toBe(1400);
});

it('keeps old recurring flags manual and stops new automatic repeats without deleting the booked expense', async () => {
  await setReportMonth(february);
  const [{ id }] = await t.as<{ id: string }>(owner,
    "select public.financial_operation('expense_save_with_recurring', $1::jsonb, gen_random_uuid()) id",
    [JSON.stringify({ p_id: null, p_month: february, p_location: location, p_category: 'Связь', p_amount: 500, p_recurring: true })],
  );
  const march = '2027-03-01';
  const april = '2027-04-01';
  const may = '2027-05-01';
  await setReportMonth(march);
  expect((await report(owner, march)).expenses).toEqual([]);
  const [{ candidates }] = await t.as<{ candidates: ExpenseRow[] }>(owner, 'select public.expense_repeat_preview($1) candidates', [march]);
  expect(candidates).toEqual([expect.objectContaining({ id })]);
  await t.as(owner, "select public.financial_operation('expense_save_with_recurring', $1::jsonb, gen_random_uuid())",
    [JSON.stringify({ p_id: id, p_month: february, p_location: location, p_category: 'Связь', p_amount: 500, p_recurring: false })],
  );
  const [{ candidates: afterDisabling }] = await t.as<{ candidates: ExpenseRow[] }>(owner,
    'select public.expense_repeat_preview($1) candidates', [march]);
  expect(afterDisabling).toEqual([]);

  expect(await save(owner, february, 'Связь', 600, true, id)).toBe(id);
  expect((await report(owner, march)).expenses).toEqual([]);
  await setReportMonth(april);
  const [aprilOccurrence] = (await report(owner, april)).expenses;
  expect(aprilOccurrence.amount_minor).toBe(600);
  const [{ updated }] = await t.as<{ updated: string }>(owner,
    "select public.financial_operation('expense_save_with_recurring', $1::jsonb, gen_random_uuid()) updated",
    [JSON.stringify({ p_id: aprilOccurrence.id, p_month: april, p_location: location, p_category: 'Связь', p_amount: 700, p_recurring: false })],
  );
  expect(updated).toBe(aprilOccurrence.id);
  await setReportMonth(may);
  expect((await report(owner, may)).expenses).toEqual([]);
  expect((await report(owner, april)).expenses).toEqual([expect.objectContaining({ id: aprilOccurrence.id, amount_minor: 700 })]);
});
