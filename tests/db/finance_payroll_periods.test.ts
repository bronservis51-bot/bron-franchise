import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const OTHER = 'beta.owner@demo.example.com';
const STAFF = '79000000011@staff.bron.local';
const MANAGER = 'fm@demo.example.com';
const MONTH = '2024-02-01';
const OWNER_SQL = 'select public.finance_my($1,$2) result';
const MANAGER_SQL = 'select public.manager_economy($1) result';
let db: TestDb;
let first: { id: string; partner_id: string };
let second: { id: string };

beforeAll(async () => {
  db = await createTestDb();
  [first, second] = await db.admin<{ id: string; partner_id: string }>(
    "select id, partner_id from public.location where code in ('ALPHA-1','ALPHA-2') order by code");
  // Imported historical payroll already has finalized amounts independent of current rates.
  await db.admin('alter table public.work_shift disable trigger shift_motivation');
  try {
    await db.admin(`
      insert into public.work_shift(partner_id, location_id, employee_id, day, status, closed_at, earned_minor, counts_as_exit)
      values ($1,$2,$4,'2024-02-15','closed',now(),15000,true),
        ($1,$3,$4,'2024-02-16','closed',now(),16000,true),
        ($1,$2,$4,'2024-02-29','closed',now(),29000,true),
        ($1,$3,$4,'2024-02-29','closed',now(),2000,false),
        ($1,$3,$4,'2024-03-01','closed',now(),1000,true)
    `, [first.partner_id, first.id, second.id, await db.userId(STAFF)]);
  } finally {
    await db.admin('alter table public.work_shift enable trigger shift_motivation');
  }
  await db.admin("update public.work_shift set day='2024-02-14', earned_minor=99000 where employee_id=$1 and status='open'",
    [await db.userId(STAFF)]);
}, 180_000);
afterAll(() => db?.db.close());

type Payroll = { payroll_minor: number; payroll_halves: [number, number] };
type Finance = { current: Payroll; months: Payroll[]; by_location: (Payroll & { location_id: string })[] | null;
  by_staff: { earned_minor: number; payroll_halves: [number, number] }[] };

async function ownerFinance(point: string | null) {
  const [{ result }] = await db.as<{ result: Finance }>(OWNER, OWNER_SQL, [MONTH, point]);
  return result;
}

it('делит начисления 15 и 16 числа, включая второй выход без фиксированной части и без открытой смены', async () => {
  const all = await ownerFinance(null);
  expect(all.current).toMatchObject({ payroll_minor: 62000, payroll_halves: [15000, 47000] });
  expect(all.months.at(-1)).toMatchObject({ payroll_minor: 62000, payroll_halves: [15000, 47000] });
  expect(all.by_location?.find(point => point.location_id === first.id))
    .toMatchObject({ payroll_minor: 44000, payroll_halves: [15000, 29000] });
  expect(all.by_location?.find(point => point.location_id === second.id))
    .toMatchObject({ payroll_minor: 18000, payroll_halves: [0, 18000] });
  expect(all.by_staff).toEqual([expect.objectContaining({ earned_minor: 62000, payroll_halves: [15000, 47000] })]);
  expect((await ownerFinance(second.id)).by_staff).toEqual([expect.objectContaining({ earned_minor: 18000, payroll_halves: [0, 18000] })]);
});

it('оставляет менеджеру сети только суммы франчайзи и сохраняет ограничения аккаунтов', async () => {
  const [{ result }] = await db.as<{ result: { partners: (Payroll & { partner_id: string })[] } }>(MANAGER, MANAGER_SQL, [MONTH]);
  const own = result.partners.find(partner => partner.partner_id === first.partner_id);
  expect(own).toMatchObject({ payroll_minor: 62000, payroll_halves: [15000, 47000] });
  expect(Object.keys(own!).sort()).toEqual(['closed_shifts', 'currency', 'expense_categories', 'expenses_minor',
    'partner_id', 'partner_name', 'payroll_halves', 'payroll_minor']);
  expect(result.partners.filter(partner => partner.partner_id !== first.partner_id)).toEqual(
    expect.arrayContaining([expect.objectContaining({ payroll_minor: 0, payroll_halves: [0, 0] })]));
  await db.expectError(OWNER, MANAGER_SQL, 'forbidden', [MONTH]);
  await db.expectError(STAFF, MANAGER_SQL, 'forbidden', [MONTH]);
  await db.expectError(MANAGER, OWNER_SQL, 'forbidden', [MONTH, null]);
  await db.expectError(OTHER, OWNER_SQL, 'not-found', [MONTH, first.id]);
});
