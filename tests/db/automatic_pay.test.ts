import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const OTHER_OWNER = 'beta.owner@demo.example.com';
const MANAGER = 'fm@demo.example.com';
const employees = ['auto-pay-first', 'auto-pay-second', 'auto-pay-third'];
const confirm = 'select public.automatic_pay_confirm($1,$2,$3,$4,$5) result';
let db: TestDb;
let point: string;
let partner: string;
let day: string;
let month: string;
let ids: string[];

beforeAll(async () => {
  db = await createTestDb();
  [{ id: point, partner_id: partner, day, month }] = await db.admin(
    `select id, partner_id, app_private.local_today(id)::text as day,
      date_trunc('month', app_private.local_today(id))::date::text as month
      from public.location where code='ALPHA-1'`);
  ids = [];
  for (const login of employees) {
    const [{ id }] = await db.as<{id: string}>(OWNER,
      "select public.staff_account_create($1,'Тестовый сотрудник',$2,'test-only-password',array[$3::uuid],false) id",
      [partner, login, point]);
    ids.push(id);
  }
}, 180_000);
afterAll(() => db?.db.close());

async function expectPendingPayroll(expected: number) {
  const [{report}] = await db.as<{report:{current:{payroll_pending:number}}}>(
    OWNER, 'select public.finance_my($1,$2) report', [month,point]);
  expect(report.current.payroll_pending).toBe(expected);
  const [{overall}] = await db.as<{overall:{by_location:{location_id:string; payroll_pending:number}[]}}>(
    OWNER, 'select public.finance_my($1,null) as overall', [month]);
  expect(overall.by_location.find(row=>row.location_id===point)?.payroll_pending).toBe(expected);
  const [{economy}] = await db.as<{economy:{partners:{partner_id:string; payroll_pending:number}[]}}>(
    MANAGER, 'select public.manager_economy($1) economy', [month]);
  expect(economy.partners.find(row=>row.partner_id===partner)?.payroll_pending).toBe(expected);
}

it('offers explicit starter tiers when history is sparse and calibrates tiers when more history arrives', async () => {
  const previewSql = 'select public.automatic_pay_preview($1) result';
  await db.expectError(OTHER_OWNER, previewSql, 'forbidden', [point]);
  await db.admin("delete from public.daily_revenue where location_id=$1 and day<date_trunc('month',$2::date)::date",[point,day]);
  const [{ result: starter }] = await db.as<{result: { sample_days:number; policy: unknown }}>(OWNER, previewSql, [point]);
  expect(starter.sample_days).toBe(0);
  expect(starter.policy).toMatchObject({automatic:{source:'starter'}});
  const [boundary]=await db.admin(
    "select app_private.motivation_pay(1699999,$1)::int as low,app_private.motivation_pay(1700000,$1)::int as high",
    [starter.policy]);
  expect(boundary).toEqual({low:326000,high:343000});
  await db.admin(`insert into public.daily_revenue(location_id,partner_id,day,currency,cash_minor,card_minor)
    select $1,$2,d::date,'RUB',600000+(extract(day from d)::bigint)*50000,0 from generate_series(
      date_trunc('month',$3::date)-interval '3 months',date_trunc('month',$3::date)-interval '1 day',interval '1 day') d
    on conflict (location_id,day,employee_id) do update set cash_minor=excluded.cash_minor`, [point,partner,day]);
  const [{ result: proposal }] = await db.as<{result: { sample_days: number; policy: { tiers: unknown[]; automatic: Record<string, unknown> } }}>(
    OWNER, previewSql, [point]);
  expect(proposal.sample_days).toBeGreaterThanOrEqual(60);
  expect(proposal.policy.tiers).toHaveLength(7);
  expect(proposal.policy.automatic).toMatchObject({ location_id: point, currency: 'RUB', source: 'history' });
  const [{top,below_top,first,before_first}] = await db.admin(
    `select app_private.motivation_pay(9000000,p)::int as top,
      app_private.motivation_pay(8999999,p)::int as below_top,
      app_private.motivation_pay(5000000,p)::int as first,
      app_private.motivation_pay(4999999,p)::int as before_first
      from app_private.automatic_pay_for_staff($1,3) p`,
    [proposal.policy]);
  expect({top,below_top,first,before_first}).toEqual({top:735000,below_top:680000,first:275000,before_first:250000});
});

it('confirms the same gross point-day cash and actual staffing for each automatic shift', async () => {
  const [{ result: {policy} }] = await db.as<{result: {policy: unknown}}>(OWNER,
    'select public.automatic_pay_preview($1) result',[point]);
  const save = 'select public.staff_pay_save($1,$2,0,0,false,$3,$4,0,null)';
  for (const id of ids) await db.as(OWNER,save,[partner,id,policy,day]);
  for (const [index,login] of employees.entries()) {
    await db.as(login+'@access.bron.local',
      'select public.shift_submit($1,$2,$3,0,$4,null)', [point,day,index===0?5_000_000:0,crypto.randomUUID()]);
  }
  const stats = () => db.admin<{employee_id:string; earned_minor:number|null; rate_bp:number|null}>(
    'select employee_id,earned_minor::int,rate_bp from public.work_shift where location_id=$1 and day=$2 and employee_id=any($3) order by employee_id',
    [point,day,ids]);
  expect((await stats()).map(s=>s.earned_minor)).toEqual([null,null,null]);
  await expectPendingPayroll(3);
  const [{ version }] = await db.admin<{version:string}>('select app_private.revenue_day_version($1,$2) version',[point,day]);
  const args = [point,day,version,ids,'Касса и состав сверены'];
  await db.expectError(employees[0]+'@access.bron.local',confirm,'forbidden',args);
  await db.expectError(OWNER,confirm,'version-conflict',args.with(3,ids.slice(0,2)));
  await db.as(OWNER,confirm,args);
  expect((await stats()).map(s=>[s.rate_bp,s.earned_minor])).toEqual([[550,275000],[550,275000],[550,275000]]);
  await expectPendingPayroll(0);
  await db.as(OWNER,confirm,args);
  expect((await stats()).map(s=>s.earned_minor)).toEqual([275000,275000,275000]);
  const [{total}] = await db.admin<{total:number}>('select sum(total_minor)::int total from public.daily_revenue where location_id=$1 and day=$2',[point,day]);
  expect(total).toBe(5_000_000);
  const [{ days }] = await db.as<{days: unknown[]}>(OWNER,'select public.automatic_pay_days($1,$2) days',[partner,month]);
  expect(days).toEqual([]);
});

it('requires a new confirmation after the point cash changes and preserves the original dated ladder', async () => {
  const [{version: beforeVersion}]=await db.admin<{version:string}>('select app_private.revenue_day_version($1,$2) version',[point,day]);
  const stale = [point,day,beforeVersion,ids,'Суммы сверены'];
  await db.as(OWNER, 'select public.revenue_total_set($1,$2,6000000,$3,$4,null)', [point,day,beforeVersion,crypto.randomUUID()]);
  await db.expectError(OWNER,confirm,'version-conflict',stale);
  const previously = () => db.admin<{earned_minor:number; rate_bp:number}>(
    'select earned_minor::int,rate_bp from public.work_shift where location_id=$1 and day=$2 and employee_id=any($3)',[point,day,ids]);
  expect((await previously()).map(p=>p.earned_minor)).toEqual([275000,275000,275000]);
  const [{days}]=await db.as<{days:{version:string}[]}>(OWNER,
    'select public.automatic_pay_days($1,$2) days',[partner,month]);
  expect(days).toHaveLength(1);
  expect(days[0]).toMatchObject({previously_confirmed:true,total_minor:6_000_000});
  await db.as(OWNER,confirm,stale.with(2,days[0].version));
  expect((await previously()).map(p=>[p.rate_bp,p.earned_minor])).toEqual([[650,390000],[650,390000],[650,390000]]);
});

it('uses a single reconciled report when today has exactly one worker assigned to the point', async () => {
  const [{id: soloPoint}]=await db.admin<{id:string}>(`
    insert into public.location(partner_id,name,code,status,currency,timezone,city)
    select partner_id,'Тестовая точка','ALPHA-AUTO-SOLO','active',currency,timezone,city from public.location where id=$1 returning id`,
    [point]);
  const [{id: worker}]=await db.as<{id:string}>(OWNER,
    "select public.staff_account_create($1,'Тестовый сотрудник','auto-pay-solo','test-only-password',array[$2::uuid],false) id",
    [partner,soloPoint]);
  const policy={
    name:'Автоматический расчёт',floor_minor:100_000,tiers:[{from_minor:0,rate_bp:2000,bonus_minor:0}],
    automatic:{location_id:soloPoint,currency:'RUB',staffing:{}},
  };
  await db.as(OWNER,'select public.staff_pay_save($1,$2,0,0,false,$3,$4,0,null)',[partner,worker,policy,day]);
  const [{result}]=await db.as<{result:{shift:{earned_minor:number; rate_bp:number}}}>('auto-pay-solo@access.bron.local',
    'select public.shift_submit($1,$2,0,1000000,$3,null) result',[soloPoint,day,crypto.randomUUID()]);
  expect(result.shift).toMatchObject({earned_minor:200_000,rate_bp:2000});
  await expect(db.as('auto-pay-solo@access.bron.local',
    'select total_minor from app_private.automatic_pay_basis where location_id=$1',[soloPoint])).rejects.toThrow(/permission denied/);
  await db.admin('delete from public.work_shift where location_id=$1 and day=$2 and employee_id=$3',[soloPoint,day,worker]);
  const [basis]=await db.admin('select count(*)::int as count from app_private.automatic_pay_basis where location_id=$1',[soloPoint]);
  expect(basis.count).toBe(0);
  const [{result: replaced}]=await db.as<{result:{shift:{earned_minor:number}}}>('auto-pay-solo@access.bron.local',
    'select public.shift_submit($1,$2,0,2000000,$3,null) result',[soloPoint,day,crypto.randomUUID()]);
  expect(replaced.shift.earned_minor).toBe(400_000);
});
