import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'beta.owner@demo.example.com';
const MANAGER = 'fm@demo.example.com';

interface MonthFinance {
  month: string;
  revenue_minor: number;
  payroll_minor: number;
  royalty_minor: number;
  expenses_minor: number;
  net_minor: number;
}

interface Finance {
  current: MonthFinance;
  months: MonthFinance[];
  by_location: (MonthFinance & { location_id: string })[] | null;
  expenses: { id: string; amount_minor: number }[];
  royalty: { months: { month: string; accrued_minor: number }[] } | null;
}

let t: TestDb;
let partner: string;
let location: string;
let month: string;

beforeAll(async () => {
  t = await createTestDb();
  const [fixture] = await t.admin<{ partner: string; location: string; month: string }>(`
    select partner_id as partner, id as location, app_private.current_month()::text as month
    from public.location where code = 'BETA-1'
  `);
  ({ partner, location, month } = fixture);
}, 180_000);

afterAll(async () => { await t?.db.close(); });

async function finance(m: string, locationId: string | null = null): Promise<Finance> {
  const [{ result }] = await t.as<{ result: Finance }>(OWNER, 'select public.finance_my($1, $2) as result', [m, locationId]);
  return result;
}

async function saveExpense(id: string | null, locationId: string | null, category: string, amount: number): Promise<string> {
  const [{ result }] = await t.as<{ result: string }>(OWNER,
    'select public.expense_save($1, $2, $3, $4, $5) as result', [id, month, locationId, category, amount]);
  return result;
}

describe('финансы по всем точкам и по отдельной точке', () => {
  it('учитывает общий расход только в общей сводке, даже если у франчайзи одна точка', async () => {
    const locationExpense = await saveExpense(null, location, 'Аренда', 1);
    const commonExpense = await saveExpense(null, null, 'Связь', 1);
    try {
      const minor = fc.integer({ min: 1, max: 10_000_000 });
      await fc.assert(fc.asyncProperty(minor, minor, async (local, common) => {
        await saveExpense(locationExpense, location, 'Аренда', local);
        await saveExpense(commonExpense, null, 'Связь', common);

        const all = await finance(month);
        const selected = await finance(month, location);

        expect(all.current.expenses_minor).toBe(local + common);
        expect(all.expenses).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: locationExpense, amount_minor: local }),
          expect.objectContaining({ id: commonExpense, amount_minor: common }),
        ]));
        expect(selected.current.expenses_minor).toBe(local);
        expect(selected.months.at(-1)?.expenses_minor).toBe(local);
        expect(selected.expenses).toEqual([expect.objectContaining({ id: locationExpense, amount_minor: local })]);
        expect(all.by_location).toEqual([expect.objectContaining({ location_id: location, expenses_minor: local })]);
        expect(all.current.net_minor).toBe(selected.current.net_minor - common);
      }), { seed: 20261119, numRuns: 32 });
    } finally {
      await t.as(OWNER, 'select public.expense_delete($1)', [locationExpense]);
      await t.as(OWNER, 'select public.expense_delete($1)', [commonExpense]);
    }
  });

  it('сохраняет выручку и исключает автоматическое роялти до начала учёта во всех срезах', async () => {
    const [{ earlier, start }] = await t.admin<{ earlier: string; start: string }>(`
      select (app_private.current_month() - interval '2 months')::date::text as earlier,
        (app_private.current_month() - interval '1 month')::date::text as start
    `);
    const before = await finance(earlier);
    const atStart = await finance(start);
    expect(before.current.royalty_minor).toBeGreaterThan(0);
    expect(atStart.current.royalty_minor).toBeGreaterThan(0);
    await t.admin('update public.partner set royalty_from = $1 where id = $2', [start, partner]);
    try {
      const historical = await finance(earlier);
      const selected = await finance(earlier, location);
      const current = await finance(start);
      const unchangedRevenue = { revenue_minor: before.current.revenue_minor, royalty_minor: 0 };
      expect(historical.current).toMatchObject(unchangedRevenue);
      expect(selected.current).toMatchObject(unchangedRevenue);
      expect(historical.by_location?.[0]).toMatchObject(unchangedRevenue);
      expect(current.months.find((m) => m.month === earlier)).toMatchObject(unchangedRevenue);
      expect(historical.current.net_minor).toBe(before.current.net_minor + before.current.royalty_minor);
      expect(current.current).toEqual(atStart.current);
      expect(current.royalty?.months.find((m) => m.month === start)?.accrued_minor).toBe(current.current.royalty_minor);
    } finally {
      await t.admin('update public.partner set royalty_from = null where id = $1', [partner]);
    }
  });

  it('показывает общие расходы партнёра без точек и отклоняет выбор неизвестной точки', async () => {
    const [{ id }] = await t.as<{ id: string }>(MANAGER,
      "select public.partner_save(null, 'Партнёр без точек', 'KZ', null, null, null) as id");
    const ownerId = await t.userId(OWNER);
    await t.admin("update public.role_assignment set scope_id = $1 where user_id = $2 and role = 'franchisee'", [id, ownerId]);
    try {
      const commonExpense = await saveExpense(null, null, 'Связь', 500);
      const all = await finance(month);
      expect(all.by_location).toEqual([]);
      expect(all.current).toMatchObject({ revenue_minor: 0, expenses_minor: 500, net_minor: -500 });
      expect(all.expenses).toEqual([expect.objectContaining({ id: commonExpense })]);
      await t.expectError(OWNER, 'select public.finance_my($1, $2)', 'not-found', [month, crypto.randomUUID()]);
    } finally {
      await t.admin("update public.role_assignment set scope_id = $1 where user_id = $2 and role = 'franchisee'", [partner, ownerId]);
    }
  });
});
