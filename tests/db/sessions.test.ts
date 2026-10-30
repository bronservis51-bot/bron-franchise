import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); }, 120_000);

describe('live session authorization', () => {
  it('rejects data access from a revoked session even with a valid user id', async () => {
    const user = await t.userId('alpha.owner@demo.example.com');
    const session = 'a0000000-0000-0000-0000-000000000001';
    await t.admin('insert into auth.sessions(id,user_id) values ($1,$2)', [session,user]);
    const read = () => t.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({sub:user,role:'authenticated',session_id:session})]);
      await tx.exec('set local role authenticated');
      return (await tx.query('select id from public.partner')).rows;
    });
    expect((await read()).length).toBe(1);
    await t.admin('delete from auth.sessions where id=$1', [session]);
    expect(await read()).toHaveLength(0);
    const me = await t.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({sub:user,role:'authenticated',session_id:session})]);
      await tx.exec('set local role authenticated');
      return (await tx.query<{j:{user:unknown}}>('select public.me() j')).rows[0].j;
    });
    expect(me.user).toBeNull();
    await expect(t.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({sub:user,role:'authenticated',session_id:session})]);
      await tx.exec('set local role authenticated');
      await tx.query('select public.revenue_overview(current_date)');
    })).rejects.toThrow('unauthenticated');
  });
  it('rejects a session belonging to another user', async () => {
    const owner = await t.userId('alpha.owner@demo.example.com');
    const other = await t.userId('beta.owner@demo.example.com');
    const session = 'a0000000-0000-0000-0000-000000000002';
    await t.admin('insert into auth.sessions(id,user_id) values ($1,$2)', [session,other]);
    const rows = await t.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({sub:owner,role:'authenticated',session_id:session})]);
      await tx.exec('set local role authenticated');
      return (await tx.query('select id from public.partner')).rows;
    });
    expect(rows).toHaveLength(0);
  });
  it('keeps anonymous lead submission available while lead data stays private', async () => {
    const grants = await t.admin<{submit:boolean; read:boolean}>("select has_function_privilege('anon','public.lead_submit(jsonb)','execute') as submit, has_table_privilege('anon','public.franchise_lead','select') as read");
    expect(grants[0]).toEqual({submit:true,read:false});
    const result = await t.as<{j:{ok:boolean}}>(null, "select public.lead_submit($1::jsonb) j", [JSON.stringify({name:'Тест формы',phone:'+79991234567',city:'Тест',budget:'full',timing:'month',manage:'self',experience:'none',place:'has',contact_via:'call',consent:true,website:''})]);
    expect(result[0].j.ok).toBe(true);
    await expect(t.as(null, 'select id from public.partner')).rejects.toThrow(/permission denied/);
  });
});
