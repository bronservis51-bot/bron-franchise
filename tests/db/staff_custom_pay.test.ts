import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'beta.owner@demo.example.com';
const STAFF = 'custom.pay@access.bron.local';
const CUSTOM = {
  name: 'Лестница сотрудника',
  floor_minor: 35_000,
  tiers: [
    { from_minor: 0, rate_bp: 1200, bonus_minor: 800 },
    { from_minor: 210_000, rate_bp: 2000, bonus_minor: 1500 },
  ],
};
const CHANGED = { ...CUSTOM, floor_minor: 90_000 };

let database: TestDb;
let partner: string;
let location: string;
let employee: string;

beforeAll(async () => {
  database = await createTestDb();
  const [point] = await database.admin<{ id: string; partner_id: string }>("select id, partner_id from location where code='BETA-1'");
  partner = point.partner_id;
  location = point.id;
  const [member] = await database.as<{ id: string }>(OWNER,
    "select staff_account_create($1, 'Индивидуальная оплата', 'custom.pay', 'test-only-password', array[$2::uuid], false) id",
    [partner, location]);
  employee = member.id;
}, 180_000);

afterAll(async () => database?.db.close());

async function setCustom(policy: typeof CUSTOM | null, usePartner = false) {
  await database.admin('update public.staff_member set custom_pay=$2, use_partner_motivation=$3 where user_id=$1',
    [employee, policy === null ? null : JSON.stringify(policy), usePartner]);
}

async function policyToday() {
  const [row] = await database.admin<{ policy: unknown }>(
    'select app_private.staff_pay_policy($1, app_private.local_today($2)) as policy', [employee, location]);
  return row.policy;
}

it('validates named, bounded tiers before the payroll engine reads them', async () => {
  const validate = (policy: unknown) => database.admin('select app_private.staff_custom_pay_validate($1::jsonb)', [policy]);
  await expect(validate(null)).resolves.toHaveLength(1);
  await expect(validate(JSON.stringify(CUSTOM))).resolves.toHaveLength(1);
  await expect(validate(JSON.stringify({ ...CUSTOM, floor_minor: '35000' }))).resolves.toHaveLength(1);
  for (const invalid of [
    null, { ...CUSTOM, name: '  ' }, { ...CUSTOM, mode: 'legacy' }, { ...CUSTOM, floor_minor: -1 },
    { ...CUSTOM, floor_minor: 100_000_000_000 }, { ...CUSTOM, floor_minor: 10.5 },
    { ...CUSTOM, tiers: [] }, { ...CUSTOM, tiers: CUSTOM.tiers.slice(1) },
    { ...CUSTOM, tiers: [CUSTOM.tiers[0], CUSTOM.tiers[0]] },
    { ...CUSTOM, tiers: [{ ...CUSTOM.tiers[0], rate_bp: 10001 }] },
    { ...CUSTOM, tiers: [{ ...CUSTOM.tiers[0], bonus_minor: 100_000_000_000 }] },
    { ...CUSTOM, tiers: [{ ...CUSTOM.tiers[0], currency: 'RUB' }] },
  ]) {
    await expect(validate(JSON.stringify(invalid))).rejects.toThrow('validation');
  }
  await expect(database.as(OWNER, 'select app_private.staff_custom_pay_validate($1::jsonb)', [JSON.stringify(CUSTOM)]))
    .rejects.toThrow(/permission denied/);
});

it('snapshots the selected ladder in the shift and calculates in the point currency', async () => {
  await setCustom(CUSTOM);
  const [opened] = await database.as<{ id: string; pay_policy: unknown }>(STAFF,
    'select w.id, w.pay_policy from public.shift_open($1) w', [location]);
  expect(opened.pay_policy).toEqual(CUSTOM);

  await setCustom(CHANGED);
  expect(await policyToday()).toEqual(CHANGED);
  const [closed] = await database.as<{ result: { shift: { earned_minor: number; pay_policy: unknown }; currency: string } }>(STAFF,
    'select public.shift_close($1,200000,10000,null) as result', [opened.id]);
  expect(closed.result.currency).toBe('KZT');
  expect(closed.result.shift.earned_minor).toBe(43_500);
  expect(closed.result.shift.pay_policy).toEqual(CUSTOM);
});

it('retains the active trainee, partner and additive legacy payment rules', async () => {
  await setCustom(CUSTOM);
  await database.as(OWNER, `select public.staff_onboarding_set($1, jsonb_build_object(
    'employee_kind','trainee','learning_enabled',false,'internship_floor_minor',60000))`, [employee]);
  const [row] = await database.admin<{ expected: unknown }>(
    "select jsonb_set(app_private.motivation_default('KZT'),'{floor_minor}','60000') as expected");
  expect(await policyToday()).toEqual(row.expected);

  await database.as(OWNER, "select public.staff_onboarding_set($1, '{\"employee_kind\":\"employee\",\"learning_enabled\":false}')", [employee]);
  expect(await policyToday()).toEqual(CUSTOM);
  await setCustom(CUSTOM, true);
  const [defaultPolicy] = await database.admin<{ expected: unknown }>("select app_private.motivation_default('KZT') as expected");
  expect(await policyToday()).toEqual(defaultPolicy.expected);
  await setCustom(null);
  await database.admin('update public.staff_member set rate_bp=725,shift_fee_minor=12345 where user_id=$1', [employee]);
  expect(await policyToday()).toEqual({ mode: 'legacy', rate_bp: 725, fee_minor: 12345 });
});
