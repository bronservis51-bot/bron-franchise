import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const owner = 'alpha.owner@demo.example.com';
const other = 'beta.owner@demo.example.com';
const url = 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=fixture';
let db: TestDb;
let actor: string, partner: string, point: string, month: string, lastDay: string;
type Status = { state: string; overdue: boolean; month: string; due_on: string; amount_minor: string | null; checkout_url: string | null; missing: unknown[] };
type Job = { id: string; lease: string; month: Date; amount_minor: number; provider_id: string | null };
const status = async (user = owner) =>
  (await db.as<{ value: Status }>(user, 'select public.royalty_home_status() as value'))[0].value;
const requestSql = 'select public.royalty_checkout_request($1,$2) as value';
const request = async (amount: string | null = '12500', period: string | null = month) =>
  (await db.as<{ value: Status }>(owner,requestSql,[period,amount]))[0].value;
const returnSql = 'select public.royalty_checkout_return_status($1) as value';
const work = () => db.admin<Job>('select * from app_private.royalty_checkout_work(1)');
const ready = () => db.admin("update app_private.royalty_checkout_attempt set next_check_at=now()-interval '1 minute'");
const observe = async (j: Job, state: string, link: string | null = null, id = 'provider-fixture') =>
  (await db.admin<{ok: boolean}>('select app_private.royalty_checkout_observe($1,$2,$3,$4,$5,$6) ok',
    [j.id, j.lease, id, state, link, state === 'succeeded' ? lastDay : null]))[0].ok;

beforeAll(async () => {
  db = await createTestDb();
  actor = await db.userId(owner);
  [{ id: partner }] = await db.admin<{ id: string }>(`insert into public.partner(code,name,country,currency)
    values ('CHECKOUT','Тестовый партнёр','RU','RUB') returning id`);
  await db.admin("update public.app_user set is_demo=false where id=$1", [actor]);
  await db.admin("update public.role_assignment set scope_id=$1 where user_id=$2 and role='franchisee'", [partner, actor]);
  [{month, lastDay}] = await db.admin<{month: string;lastDay:string}>(`select
    (app_private.current_month()-interval '1 month')::date::text as month, (app_private.current_month()-1)::text "lastDay"`);
  [{ id: point }] = await db.admin<{ id: string }>(`insert into public.location(code,name,partner_id,city,timezone,currency,opened_on)
    values ('CHECKOUT','Точка проверки',$1,'Москва','Europe/Moscow','RUB',$2) returning id`, [partner,lastDay]);
}, 180000);
afterAll(async () => db?.db.close());
beforeEach(async () => {
  await db.admin('delete from app_private.royalty_checkout_attempt');
  await db.admin('delete from public.royalty_payment where partner_id=$1',[partner]);
  await db.admin('delete from public.daily_revenue where partner_id=$1',[partner]);
  await db.admin('delete from app_private.revenue_day_off where location_id=$1',[point]);
  await db.admin('delete from public.royalty_manual where partner_id=$1',[partner]);
  await db.admin('insert into public.royalty_manual(partner_id,month,amount_minor) values ($1,$2,12500)',[partner,month]);
  await db.admin("update public.partner set status='active',currency='RUB',is_demo=false where id=$1",[partner]);
  await db.admin('insert into app_private.royalty_checkout_pilot(partner_id) values ($1) on conflict do nothing',[partner]);
});
const report = () => db.admin(`insert into public.daily_revenue(location_id,partner_id,day,currency,cash_minor,card_minor)
  values ($1,$2,$3,'RUB',0,0)`,[point,partner,lastDay]);

it('prioritizes missing dates, accepts a confirmed zero or a day off, and checks the 1st, 5th and 6th Moscow deadlines', async () => {
  expect(await status()).toMatchObject({state:'missing_revenue',month,amount_minor:null,missing:[{location_id:point,location_name:'Точка проверки',days:[lastDay]}]});
  await report();
  for (const [offset,state] of [[0,'payable'],[4,'payable'],[5,'overdue']] as const) {
    const [{value}] = await db.admin<{value: Status}>(`select app_private.royalty_checkout_balance($1,$2,
      ((app_private.current_month()+$3::int)::timestamp at time zone 'Europe/Moscow')) value`,[partner,actor,offset]);
    expect(value).toMatchObject({state,overdue:offset>4,amount_minor:'12500',checkout_url:null});
  }
  await db.admin('delete from public.daily_revenue where partner_id=$1',[partner]);
  await db.admin('insert into app_private.revenue_day_off(location_id,day,marked_by) values ($1,$2,$3)',[point,lastDay,actor]);
  expect((await status()).state).toMatch(/payable|overdue/);
});

it('reminds outside the pilot but never creates a payment without eligibility and session scope', async () => {
  await db.admin('delete from app_private.royalty_checkout_pilot where partner_id=$1',[partner]);
  expect((await status()).state).toBe('missing_revenue');
  await expect(request()).rejects.toThrow('version-conflict');
  await report();
  expect((await status()).state).toBe('none');
  await expect(request()).rejects.toThrow('version-conflict');
  await db.admin('insert into app_private.royalty_checkout_pilot values ($1)',[partner]);
  for (const setting of ["status='suspended'","status='active',currency='KZT'","currency='RUB',is_demo=true"]) {
    await db.admin(`update public.partner set ${setting} where id=$1`,[partner]);
    expect((await status()).state).toBe('none');
    await expect(request()).rejects.toThrow('version-conflict');
  }
  expect((await status(other)).missing).not.toContainEqual(expect.objectContaining({location_id:point}));
  await db.expectError('fm@demo.example.com',requestSql,'forbidden',[month,'12500']);
  await expect(db.as(null,requestSql,[month,'12500'])).rejects.toThrow('permission denied');
  await expect(db.as(owner,'select * from app_private.royalty_checkout_work(1)')).rejects.toThrow('permission denied');
  expect(await work()).toEqual([]);
});

it('reuses a verified link, hides it after a change, and credits the original amount exactly once', async () => {
  await report();
  const before = await status();
  expect(await request()).toMatchObject({state:'checking',overdue:before.state==='overdue'});
  expect((await request()).state).toBe('checking');
  const [first] = await work();
  expect(await work()).toEqual([]);
  expect(await observe(first,'pending',url)).toBe(true);
  expect((await request()).checkout_url).toBe(url);
  await db.admin('insert into public.royalty_payment(partner_id,month,amount_minor,paid_on) values ($1,$2,1000,$3)',[partner,month,lastDay]);
  expect(await request('11500')).toMatchObject({state:'checking',checkout_url:null});
  await ready();
  const [recheck] = await work();
  expect(recheck).toMatchObject({id:first.id,provider_id:'provider-fixture'});
  expect(await observe(recheck,'succeeded')).toBe(true);
  expect(await observe(recheck,'succeeded')).toBe(false);
  expect(await status()).toMatchObject({state:'none',checkout_url:null});
  expect(await db.admin('select debt_minor::int balance from app_private.royalty_ledger($1) where month=$2',[partner,month])).toEqual([{balance:-1000}]);
});

it('drops never-dispatched stale work, blocks unresolved creates beyond the retry window', async () => {
  await report();
  await request();
  await db.admin('update public.royalty_manual set amount_minor=9500 where partner_id=$1',[partner]);
  expect(await work()).toEqual([]);
  await request('9500');
  const [first] = await work();
  expect(Number(first.amount_minor)).toBe(9500);
  await db.admin("update app_private.royalty_checkout_attempt set lease_until=now()-interval '1 minute',first_dispatch_at=now()-interval '24 hours'");
  expect(await work()).toEqual([]);
  expect((await request('9500')).state).toBe('checking');
});

it('waits until the month ends locally and respects historical shutdown intervals', async () => {
  await db.admin("update public.location set timezone='America/New_York',opened_on=$2::date-2,closed_days=datemultirange(daterange($2::date-2,$2::date,'[)')) where id=$1",[point,lastDay]);
  try {
    const [{value}] = await db.admin<{value: Status}>(`select app_private.royalty_checkout_balance($1,$2,
      app_private.current_month()::timestamp at time zone 'Europe/Moscow') value`,[partner,actor]);
    expect(value).toMatchObject({state:'unavailable',checkout_url:null,missing:[]});
    await db.admin("update public.location set timezone='Europe/Moscow' where id=$1",[point]);
    expect(await status()).toMatchObject({state:'missing_revenue',missing:[{location_id:point,days:[lastDay]}]});
  } finally {
    await db.admin("update public.location set timezone='Europe/Moscow',opened_on=$2,closed_days='{}' where id=$1",[point,lastDay]);
  }
});

it('rechecks the originating live session before dispatch and rejects a revoked caller', async () => {
  await report();
  const sid = crypto.randomUUID();
  const withSession = (sql = requestSql, params: unknown[] = [month, '12500']) => db.db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'authenticated',sub:actor,session_id:sid})]);
    await tx.exec('set local role authenticated');
    return (await tx.query<{value: Status}>(sql, params)).rows[0].value;
  });
  await db.admin('insert into auth.sessions(id,user_id) values ($1,$2)',[sid,actor]);
  expect((await withSession()).state).toBe('checking');
  await db.admin('delete from auth.sessions where id=$1',[sid]);
  await expect(withSession()).rejects.toThrow('unauthenticated');
  await expect(withSession(returnSql,[crypto.randomUUID()])).rejects.toThrow('unauthenticated');
  expect(await work()).toEqual([]);
  expect((await status()).state).toMatch(/payable|overdue/);
});

it('retries with the same attempt, rejects old leases and credits only a validated provider identity', async () => {
  await report();
  await request();
  const [original] = await work();
  await db.admin("update app_private.royalty_checkout_attempt set lease_until=now()-interval '1 second'");
  const [retry] = await work();
  expect(retry.id).toBe(original.id);
  expect(retry.lease).not.toBe(original.lease);
  expect(await observe(original,'succeeded')).toBe(false);
  await expect(observe(retry,'pending','https://example.invalid')).rejects.toThrow('invalid-observation');
  expect(await observe(retry,'pending',url)).toBe(true);
  await ready();
  const [pending] = await work();
  expect(await observe(pending,'pending')).toBe(true);
  expect((await status()).checkout_url).toBe(url);
  await ready();
  const [cancel] = await work();
  await expect(observe(cancel,'canceled',null,'other-payment')).rejects.toThrow('invalid-observation');
  expect(await observe(cancel,'canceled')).toBe(true);
  expect((await status()).checkout_url).toBe(null);
  await request();
  const [newAttempt] = await work();
  expect(newAttempt.id).not.toBe(original.id);
  await expect(observe(newAttempt,'succeeded')).rejects.toThrow('duplicate key');
  expect(await db.admin('select id from public.royalty_payment where partner_id=$1',[partner])).toEqual([]);
});

it('preserves confirmed provider settlements while allowing a manager to reverse a manual payment', async () => {
  await report();
  await request();
  const [j] = await work();
  expect(await observe(j,'succeeded')).toBe(true);
  const manager = 'fm@demo.example.com';
  const remove = 'select public.royalty_payment_delete($1)';
  await db.expectError(manager,remove,'validation',[j.id]);
  const [{id}] = await db.admin<{id:string}>('insert into public.royalty_payment(partner_id,month,amount_minor,paid_on) values ($1,$2,100,$3) returning id',[partner,month,lastDay]);
  await db.as(manager,remove,[id]);
  expect(await db.admin('select id from public.royalty_payment where partner_id=$1',[partner])).toEqual([{id:j.id}]);
});

it('recovers an unknown expired creation only by verified lookup, including after the amount changes', async () => {
  await report();
  await request();
  const [unknown] = await work();
  const attach = 'select app_private.royalty_checkout_recover($1,$2) as accepted';
  const wrong = crypto.randomUUID();
  const correct = crypto.randomUUID();
  await expect(db.as('fm@demo.example.com',attach,[unknown.id,wrong])).rejects.toThrow('permission denied');
  expect(await db.admin(attach,[unknown.id,wrong])).toEqual([{accepted:false}]);
  await db.admin("update app_private.royalty_checkout_attempt set first_dispatch_at=now()-interval '24 hours' where id=$1",[unknown.id]);
  expect(await db.admin(attach,[unknown.id,wrong])).toEqual([{accepted:false}]);
  const expireLease = () => db.admin("update app_private.royalty_checkout_attempt set lease_until=now()-interval '1 minute' where id=$1",[unknown.id]);
  await expireLease();
  expect(await work()).toEqual([]);
  expect(await db.admin(attach,[unknown.id,wrong])).toEqual([{accepted:true}]);
  await db.admin('update public.royalty_manual set amount_minor=5000 where partner_id=$1',[partner]);
  const [lookup] = await work();
  expect(lookup).toMatchObject({id:unknown.id,provider_id:wrong});
  expect(await db.admin(attach,[unknown.id,correct])).toEqual([{accepted:false}]);
  await expect(observe(lookup,'succeeded',null,correct)).rejects.toThrow('invalid-observation');
  expect(await db.admin('select id from public.royalty_payment where partner_id=$1',[partner])).toEqual([]);
  await expireLease();
  expect(await db.admin(attach,[unknown.id,correct])).toEqual([{accepted:true}]);
  expect(await observe(lookup,'succeeded',null,wrong)).toBe(false);
  const [verified] = await work();
  expect(verified).toMatchObject({id:unknown.id,provider_id:correct});
  expect(await observe(verified,'succeeded',null,correct)).toBe(true);
  expect(await db.admin(attach,[unknown.id,wrong])).toEqual([{accepted:false}]);
  expect(await work()).toEqual([]);
  expect(await db.admin('select debt_minor::int as balance from app_private.royalty_ledger($1) where month=$2',[partner,month])).toEqual([{balance:-7500}]);
});

it('rejects a changed quote before enqueuing an attempt or returning an existing link', async () => {
  await report();
  const displayed = await status();
  await db.admin('update public.royalty_manual set amount_minor=15000 where partner_id=$1',[partner]);
  await expect(request(displayed.amount_minor,displayed.month)).rejects.toThrow('version-conflict');
  await expect(request('15000','2000-01-01')).rejects.toThrow('version-conflict');
  await expect(request('15000',null)).rejects.toThrow('version-conflict');
  await expect(request(null)).rejects.toThrow('version-conflict');
  expect(await work()).toEqual([]);
  await request('15000');
  const [j] = await work();
  expect(await observe(j,'pending',url)).toBe(true);
  await expect(request(displayed.amount_minor)).rejects.toThrow('version-conflict');
  expect((await request('15000')).checkout_url).toBe(url);
});

it('reads only the owner’s original return period and verified status across a month rollover', async () => {
  const historicalMonth = '2025-09-01';
  const providerId = crypto.randomUUID();
  const [{id}] = await db.admin<{id:string}>(`insert into app_private.royalty_checkout_attempt
    (partner_id,month,requested_by,amount_minor,provider_id,first_dispatch_at) values ($1,$2,$3,17000,$4,now()-interval '1 year') returning id`,
    [partner,historicalMonth,actor,providerId]);
  const read = async (key: string, user = owner) => (await db.as<{value:unknown}>(user,returnSql,[key]))[0].value;
  const unavailable = {state:'unavailable',month:null,amount_minor:null,currency:'RUB'};
  const period = {month:historicalMonth,amount_minor:'17000',currency:'RUB'};
  await db.admin('update public.app_user set is_demo=false where id=$1',[await db.userId(other)]);
  expect(await read(id,other)).toEqual(unavailable);
  expect(await read(id,'fm@demo.example.com')).toEqual(unavailable);
  expect(await read(crypto.randomUUID())).toEqual(unavailable);
  await expect(db.as(null,returnSql,[id])).rejects.toThrow('permission denied');
  expect(await read(id)).toEqual({state:'checking',...period});
  const [j] = await work();
  expect(await observe(j,'succeeded',null,providerId)).toBe(true);
  expect(await read(id)).toEqual({state:'paid',...period});
  expect(await read(id)).toEqual({state:'paid',...period});
  await report();
  await request();
  const [canceled] = await work();
  expect(await observe(canceled,'canceled',null,crypto.randomUUID())).toBe(true);
  expect(await read(canceled.id)).toEqual({state:'canceled',month,amount_minor:'12500',currency:'RUB'});
});
