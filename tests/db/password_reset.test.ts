import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
// @ts-expect-error shared SQL loader has no declaration file
import { migrationFiles } from '../../scripts/db-lib.mjs';
import { createTestDb, type TestDb } from './harness';

const NETWORK = 'fm@demo.example.com';
const OWNER = 'alpha.owner@demo.example.com';
const OTHER_OWNER = 'beta.owner@demo.example.com';
const EMPLOYEE = '79000000011@staff.bron.local';
const RESET = 'select public.user_set_password($1,$2)';
const PASSWORD = 'test-only-reset-password';

let t: TestDb;

beforeAll(async () => { t = await createTestDb(); }, 180_000);
afterAll(async () => t?.db.close());

it('rejects missing Auth targets and accounts outside the subordinate hierarchy', async () => {
  await t.expectError(NETWORK, RESET, 'not-found', [crypto.randomUUID(), PASSWORD]);
  await t.expectError(NETWORK, RESET, 'not-found', [null, PASSWORD]);
  const [{ id: orphan }] = await t.admin<{ id: string }>(
    "select app_private.create_login('reset.orphan@example.invalid','test-only-old-password','Тест') id",
  );
  await t.expectError(NETWORK, RESET, 'not-found', [orphan, PASSWORD]);
  await t.expectError(OTHER_OWNER, RESET, 'forbidden', [await t.userId(EMPLOYEE), PASSWORD]);
  await t.expectError(OWNER, RESET, 'forbidden', [await t.userId(OWNER), PASSWORD]);
  await expect(t.as(null, RESET, [await t.userId(EMPLOYEE), PASSWORD])).rejects.toThrow('permission denied');
});

it('protects active and historical company accounts even against a network manager', async () => {
  const owner = await t.userId(OWNER);
  const other = await t.userId(OTHER_OWNER);
  const [before] = await t.admin('select encrypted_password from auth.users where id=$1', [other]);
  const [{ id: assignment }] = await t.admin<{ id: string }>(
    `insert into public.role_assignment(user_id,role,scope_type)
      values($1,'franchise_manager','company') returning id`, [other],
  );
  await t.expectError(NETWORK, RESET, 'forbidden', [other, PASSWORD]);
  await t.admin('update public.role_assignment set revoked_at=now() where id=$1', [assignment]);
  await t.expectError(NETWORK, RESET, 'forbidden', [other, PASSWORD]);
  expect(await t.admin('select encrypted_password from auth.users where id=$1', [other])).toEqual([before]);
  await t.as(NETWORK, RESET, [owner, PASSWORD]);
});

it('retains a delegated manager’s reset access to staff assigned only to the managed point', async () => {
  const [{ id: point, partner_id: partner }] = await t.admin<{ id: string; partner_id: string }>(
    "select id,partner_id from public.location where code='ALPHA-3'",
  );
  await t.as(OWNER, `select public.staff_account_create($1,'Управляющий','reset.point.manager',
    'test-only-old-password',array[$2::uuid],true)`, [partner,point]);
  const [{ id: employee }] = await t.as<{ id: string }>(OWNER,
    `select public.staff_account_create($1,'Сотрудник','reset.point.employee',
      'test-only-old-password',array[$2::uuid],false) id`, [partner,point]);
  await t.as('reset.point.manager@access.bron.local', RESET, [employee,PASSWORD]);
  expect(await t.admin('select encrypted_password=extensions.crypt($2,encrypted_password) changed from auth.users where id=$1',
    [employee,PASSWORD])).toEqual([{ changed: true }]);
});

it('revokes the subordinate’s sessions and pending recovery and email changes while preserving login and MFA', async () => {
  const employee = await t.userId(EMPLOYEE);
  const owner = await t.userId(OWNER);
  const [{ id: session }] = await t.admin<{ id: string }>('insert into auth.sessions(user_id) values($1) returning id', [employee]);
  const [{ id: ownerSession }] = await t.admin<{ id: string }>('insert into auth.sessions(user_id) values($1) returning id', [owner]);
  const [{ id: factor }] = await t.admin<{ id: string }>(
    "insert into auth.mfa_factors(user_id,status) values($1,'verified') returning id", [employee],
  );
  const [identity] = await t.admin(`insert into auth.identities(provider_id,user_id,identity_data,provider)
    values($1,$1::text::uuid,jsonb_build_object('email',$2::text),'email') returning *`, [employee,EMPLOYEE]);
  await t.admin(`update auth.users set encrypted_password=extensions.crypt('test-only-old-password',extensions.gen_salt('bf')),
    recovery_token='prior-recovery',email_change='pending@example.invalid',email_change_token_new='prior-new',
    email_change_token_current='prior-current',email_change_confirm_status=1 where id=$1`, [employee]);
  await t.admin(`insert into auth.one_time_tokens(user_id,token_type) values
    ($1,'recovery_token'),($1,'email_change_token_new'),($1,'email_change_token_current'),
    ($1,'confirmation_token'),($2,'recovery_token')`, [employee,owner]);

  await t.as(OWNER, RESET, [employee,PASSWORD]);

  expect(await t.admin(`select email,encrypted_password=extensions.crypt($2,encrypted_password) new_password,
    encrypted_password=extensions.crypt('test-only-old-password',encrypted_password) old_password,
    recovery_token,email_change,email_change_token_new,email_change_token_current,email_change_confirm_status
    from auth.users where id=$1`, [employee,PASSWORD])).toEqual([{
    email: EMPLOYEE, new_password: true, old_password: false, recovery_token: '', email_change: '',
    email_change_token_new: '', email_change_token_current: '', email_change_confirm_status: 0,
  }]);
  expect(await t.admin('select * from auth.identities where user_id=$1', [employee])).toEqual([identity]);
  expect(await t.admin('select id,status from auth.mfa_factors where user_id=$1', [employee])).toEqual([{ id: factor, status: 'verified' }]);
  expect(await t.admin('select id from auth.sessions where id in ($1,$2)', [session,ownerSession])).toEqual([{ id: ownerSession }]);
  expect(await t.admin('select token_type from auth.one_time_tokens where user_id=$1', [employee])).toEqual([{ token_type: 'confirmation_token' }]);
  expect(await t.admin('select token_type from auth.one_time_tokens where user_id=$1', [owner])).toEqual([{ token_type: 'recovery_token' }]);
  expect(await t.admin(`select diff from public.audit_event where action='user.password' and entity_id=$1`, [employee])).toEqual([{ diff: null }]);
});

it('can revoke tokens when a legacy non-superuser owns the RPC and Auth owns its tables', async () => {
  const db = new PGlite({ username: 'supabase_admin', initDbStartParams: ['--username=supabase_admin'], extensions: { pg_trgm, pgcrypto } });
  try {
    await db.exec(readFileSync('supabase/tests-shim/00_supabase_shim.sql', 'utf8'));
    await db.exec(`create role postgres nologin nosuperuser createrole bypassrls;
      create role supabase_auth_admin nologin nosuperuser;
      grant create on database postgres to postgres;
      grant usage,create on schema public,auth,storage,extensions to postgres;
      grant usage,create on schema auth to supabase_auth_admin;
      alter table auth.users owner to supabase_auth_admin;
      alter table auth.sessions owner to supabase_auth_admin;
      alter table auth.one_time_tokens owner to supabase_auth_admin;
      grant all on all tables in schema auth,storage to postgres;
      grant execute on all functions in schema auth,storage,extensions to postgres;
      alter table storage.objects owner to postgres;
      alter table storage.buckets owner to postgres;
      set role postgres;`);
    const files: string[] = migrationFiles();
    for (const file of files.filter(f => !f.endsWith('_subordinate_password_reset.sql'))) {
      await db.exec(readFileSync(file, 'utf8'));
    }
    await db.exec(`reset role;
      revoke all on auth.one_time_tokens from postgres;
      revoke update on auth.users from postgres;
      grant update (encrypted_password, updated_at) on auth.users to postgres;`);
    await db.exec(readFileSync('supabase/seed/seed.sql', 'utf8'));
    for (const file of files.filter(f => f.endsWith('_subordinate_password_reset.sql'))) {
      await db.exec(readFileSync(file, 'utf8'));
    }
    const [{ actor, target }] = (await db.query<{ actor: string; target: string }>(`
      select app_private.create_login('reset-network@example.invalid','test-only-old-password','Менеджер') actor,
        app_private.create_login('reset-target@example.invalid','test-only-old-password','Франчайзи') target`)).rows;
    await db.query(`insert into public.role_assignment(user_id,role,scope_type) values($1,'franchise_manager','company')`, [actor]);
    await db.query(`insert into public.role_assignment(user_id,role,scope_type,scope_id)
      select $1,'franchisee','partner',id from public.partner where code='ALPHA'`, [target]);
    await db.query(`insert into auth.one_time_tokens(user_id,token_type) values($1,'recovery_token')`, [target]);
    const [{ id: session }] = (await db.query<{ id: string }>('insert into auth.sessions(user_id) values($1) returning id', [actor])).rows;

    await db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: 'authenticated', session_id: session })]);
      await tx.exec('set local role authenticated');
      await tx.query(RESET, [target,PASSWORD]);
    });

    expect((await db.query('select token_type from auth.one_time_tokens where user_id=$1', [target])).rows).toEqual([]);
    expect((await db.query(`select pg_get_userbyid(proowner) owner,
      has_function_privilege('anon',oid,'execute') anon_exec,
      has_column_privilege('authenticated','auth.one_time_tokens','token_type','select') auth_read,
      has_table_privilege('authenticated','auth.one_time_tokens','delete') auth_delete
      from pg_proc where oid='public.user_set_password(uuid,text)'::regprocedure`)).rows)
      .toEqual([{ owner: 'postgres', anon_exec: false, auth_read: false, auth_delete: false }]);
  } finally {
    await db.close();
  }
}, 180_000);
