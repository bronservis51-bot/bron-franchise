import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const manager = 'fm@demo.example.com';
const owner = 'alpha.owner@demo.example.com';
const other = 'beta.owner@demo.example.com';
let t: TestDb;
let partner: string;
let location: string;
let date: string;
let current: string;
let previous: string;

beforeAll(async () => {
  t = await createTestDb();
  const [fixture] = await t.admin<{ partner: string; location: string; date: string; current: string; previous: string }>(`
    select partner_id as partner, id as location, current_date::text as date,
      app_private.current_month()::text as current, (app_private.current_month()-interval '1 month')::date::text as previous
    from public.location where code='ALPHA-1'
  `);
  ({ partner, location, date, current, previous } = fixture);
}, 180_000);
afterAll(() => t?.db.close());

async function rpc<T>(user: string, sql: string, args: unknown[] = []) {
  return (await t.as<{ result: T }>(user, `select ${sql} result`, args))[0].result;
}
function write<T>(user: string, operation: string, payload: object, receipt = crypto.randomUUID()) {
  return rpc<T>(user, 'public.financial_operation($1,$2::jsonb,$3)', [operation, JSON.stringify(payload), receipt]);
}

it('исправляет только начисление, сохраняет старый долг и итоги старых исправлений', async () => {
  const [{ month, legacy }] = await t.admin<{ month: string; legacy: string }>(`
    select (app_private.current_month()-interval '6 months')::date::text as "month",
      (app_private.current_month()-interval '5 months')::date::text as legacy
  `);
  await rpc(manager, 'public.royalty_rate_set($1,1000,$2)', [partner, month]);
  for (const period of [month, legacy]) {
    await rpc(manager, 'public.revenue_save($1,$2,20000000,0,null,null)', [location, period]);
    await rpc(manager, "public.royalty_manual_add($1,$2,5000000,'Исторический долг')", [partner, period]);
  }
  const historic = await rpc<{ id: string; delta_minor: number }>(manager,
    "public.royalty_set_accrual($1,$2,1800000,'По архивному акту')", [partner, legacy]);
  expect(historic.delta_minor).toBe(-5200000);
  const receipt = crypto.randomUUID();
  const inputs = { p_partner: partner, p_month: month, p_target: 1800000, p_note: 'Новое начисление' };
  const correction = await write<{ id: string; delta_minor: number }>(manager, 'royalty_set_accrual_only', inputs, receipt);
  expect(correction.delta_minor).toBe(-200000);
  expect(await write(manager, 'royalty_set_accrual_only', inputs, receipt)).toEqual(correction);
  const result = await rpc<{ months: { month: string; past_debt_minor: number; correction_minor: number; debt_minor: number }[] }>(
    manager, 'public.royalty_partner($1)', [partner]);
  expect(result.months.find(row => row.month === month)).toMatchObject({ past_debt_minor: 5000000, correction_minor: -200000, debt_minor: 6800000 });
  expect(result.months.find(row => row.month === legacy)).toMatchObject({ past_debt_minor: 5000000, correction_minor: -5200000, debt_minor: 1800000 });
  const own = await rpc<typeof result>(owner, 'public.royalty_my()');
  expect(own.months.find(row => row.month === month)).toMatchObject({ past_debt_minor: 5000000, correction_minor: -200000, debt_minor: 6800000 });
});

it('проверяет совпадающий платёж, принимает осознанный второй и безопасно отвечает на повторы', async () => {
  const command = 'royalty_payment_reviewed';
  const args = { p_partner: partner, p_month: previous, p_amount: 765432, p_paid_on: date, p_note: 'Оплата', p_reviewed: [] };
  const replay = crypto.randomUUID();
  const first = await write<{ id: string }>(manager, command, args, replay);
  expect(first.id).toBeTruthy();
  expect(await write(manager, command, args, replay)).toEqual(first);
  const proposal = { ...args, p_month: current, p_note: 'Вторая оплата' };
  const warning = await write<{ matches: { id: string; month: string }[] }>(manager, command, proposal);
  expect(warning.matches).toEqual([expect.objectContaining({ id: first.id, month: previous })]);
  const second = await write<{ id: string }>(manager, command, { ...proposal, p_reviewed: [first.id] });
  expect(second.id).toBeTruthy();
  expect(second.id).not.toBe(first.id);
  const third = await write<{ matches: { id: string }[] }>(manager, command, { ...proposal, p_reviewed: [first.id] });
  expect(third.matches.map(match => match.id).sort()).toEqual([first.id, second.id].sort());
  await expect(write(owner, command, args)).rejects.toThrow('forbidden');
});

it('предлагает только регулярный расход, переносит проверенную сумму один раз и защищает чужую область', async () => {
  const save = (category: string, recurring: boolean) => write<string>(owner, 'expense_save_with_recurring', {
    p_id: null, p_month: previous, p_location: location, p_category: category, p_amount: 34500, p_note: 'Тест', p_recurring: recurring,
  });
  const recurring = await save('Регулярная аренда', true);
  await save('Разовая покупка', false);
  const preview = () => rpc<{ id: string; updated_at: string }[]>(owner, 'public.expense_repeat_preview($1)', [current]);
  const candidates = await preview();
  expect(candidates).toEqual([expect.objectContaining({ id: recurring })]);
  const receipt = crypto.randomUUID();
  const args = { p_month: current, p_rows: [{ id: recurring, amount: '45600', updated_at: candidates[0].updated_at }] };
  await expect(write(other, 'expense_repeat_checked', args)).rejects.toThrow('version-conflict');
  expect(await write(owner, 'expense_repeat_checked', args, receipt)).toBe(1);
  expect(await write(owner, 'expense_repeat_checked', args, receipt)).toBe(1);
  await expect(write(owner, 'expense_repeat_checked', {
    ...args, p_rows: [{ ...args.p_rows[0], amount: '46000' }],
  }, receipt)).rejects.toThrow('idempotency-conflict');
  await expect(write(owner, 'expense_repeat_checked', args)).rejects.toThrow('version-conflict');
  expect(await preview()).toEqual([]);
  const result = await rpc<{ expenses: { category: string; amount_minor: number; recurring: boolean }[] }>(owner, 'public.finance_my($1,null)', [current]);
  expect(result.expenses).toEqual(expect.arrayContaining([{ category: 'Регулярная аренда', amount_minor: 45600, recurring: true,
    id: expect.any(String), location_id: location, location_name: expect.any(String), month: current, note: 'Тест' }]));
  expect(result.expenses.some(expense => expense.category === 'Разовая покупка')).toBe(false);
});
