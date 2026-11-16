import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM = 'fm@demo.example.com';
const OWNER = 'alpha.owner@demo.example.com';
const FOREIGN = 'beta.owner@demo.example.com';
const STAFF = '79000000011@staff.bron.local';
const TEAM = 'rating-manager@access.bron.local';
const TECH = 'rating-tech@example.test';
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  const point = (await t.admin<{id:string; partner_id:string}>("select id,partner_id from public.location where code='ALPHA-1'"))[0];
  await t.as(OWNER, "select public.staff_account_create($1,'Rating manager','rating-manager','test-only-password',array[$2::uuid],true)", [point.partner_id, point.id]);
  const tech = (await t.admin<{id:string}>("insert into auth.users(email,raw_user_meta_data,raw_app_meta_data) values($1,'{\"full_name\":\"Rating tech\"}','{\"demo_seed\":true}') returning id", [TECH]))[0].id;
  await t.admin("insert into public.role_assignment(user_id,role,scope_type) values($1,'technical_specialist','company')", [tech]);
}, 180_000);
afterAll(async () => t?.db.close());

describe('manager-only ranking contract', () => {
  it('preserves the network manager ranking, metrics and effective permission', async () => {
    const rating = (await t.as<{j:{rows:Record<string,unknown>[]}}>(FM, 'select public.rating() j'))[0].j;
    expect(rating.rows.length).toBeGreaterThan(0);
    expect(rating.rows[0]).toHaveProperty('fill_pct');
    const me = (await t.as<{j:{assignments:{permissions:string[]}[]}}>(FM, 'select public.me() j'))[0].j;
    expect(me.assignments.flatMap(a => a.permissions)).toContain('rating.read');
  });

  it.each([OWNER, FOREIGN, STAFF, TEAM, TECH])('denies direct RPC and omits effective ranking permission for %s', async email => {
    await t.expectError(email, 'select public.rating()', 'forbidden');
    const me = (await t.as<{j:{assignments:{permissions:string[] | null}[]}}>(email, 'select public.me() j'))[0].j;
    expect(me.assignments.flatMap(a => a.permissions ?? [])).not.toContain('rating.read');
  });

  it('does not treat another company role or a mistakenly granted permission as franchise_manager', async () => {
    // Isolated fixture only: even a policy mistake cannot replace the exact role check.
    await t.admin("insert into public.role_permission(role,permission) values('technical_specialist','rating.read')");
    await t.expectError(TECH, 'select public.rating()', 'forbidden');
    await t.admin("delete from public.role_permission where role='technical_specialist' and permission='rating.read'");
  });

  it('rejects anonymous calls and a revoked manager session', async () => {
    await expect(t.as(null, 'select public.rating()')).rejects.toThrow(/permission denied/);
    const user = await t.userId(FM);
    const session = crypto.randomUUID();
    await t.admin('insert into auth.sessions(id,user_id) values($1,$2)', [session,user]);
    const run = () => t.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub:user,role:'authenticated',session_id:session})]);
      await tx.exec('set local role authenticated');
      return tx.query('select public.rating()');
    });
    await run();
    await t.admin('delete from auth.sessions where id=$1', [session]);
    await expect(run()).rejects.toThrow('unauthenticated');
  });

  it('rejects a removed network-manager assignment without trusting a cached client role', async () => {
    const user = await t.userId(FM);
    await t.admin("update public.role_assignment set revoked_at=now() where user_id=$1 and role='franchise_manager' and revoked_at is null", [user]);
    try {
      await t.expectError(FM, 'select public.rating()', 'forbidden');
    } finally {
      await t.admin("update public.role_assignment set revoked_at=null where user_id=$1 and role='franchise_manager'", [user]);
    }
  });

  it('preserves own revenue access without revealing another franchise through direct tables', async () => {
    const own = (await t.admin<{id:string}>("select id from public.partner where code='ALPHA'"))[0].id;
    const other = (await t.admin<{id:string}>("select id from public.partner where code='BETA'"))[0].id;
    expect(await t.as(OWNER, 'select id from public.partner where id=$1', [own])).toHaveLength(1);
    expect(await t.as(OWNER, 'select id from public.partner where id=$1', [other])).toHaveLength(0);
    expect(await t.as(OWNER, 'select id from public.daily_revenue where partner_id=$1', [other])).toHaveLength(0);
  });
});
