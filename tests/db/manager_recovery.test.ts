import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const MANAGER = 'fm@demo.example.com';
const OWNER = 'alpha.owner@demo.example.com';
const MAIL = 'recovery-fixture@example.invalid';
const PASSWORD = 'new-local-recovery-password';
type MailJob = { id: string; email: string; kind: 'confirm' | 'reset'; login: string | null };

let db: TestDb;
let manager: string;

beforeAll(async () => {
  db = await createTestDb();
  manager = await db.userId(MANAGER);
  await db.admin('create role bron_manager_recovery_mailer login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls');
  await db.admin('grant bron_recovery_mailer to bron_manager_recovery_mailer');
}, 180_000);
afterAll(async () => db?.db.close());

async function provision(verified = false, resetEnabled = false) {
  await db.admin(`insert into app_private.manager_recovery_account(user_id,email,enabled,verified_at)
    values($1,$2,true,case when $3 then clock_timestamp() end)
    on conflict(user_id) do update set email=excluded.email,enabled=excluded.enabled,verified_at=excluded.verified_at`, [manager,MAIL,verified]);
  if (resetEnabled) await db.admin('update app_private.manager_recovery_account set reset_enabled=true where user_id=$1', [manager]);
}

async function scalar<T>(actor: string | null, fn: string, args: unknown[] = []) {
  return (await db.as<{ result: T }>(actor, `select public.${fn} as result`, args))[0].result;
}

async function digest(token: string) {
  return (await db.admin<{ value: string }>("select encode(extensions.digest($1,'sha256'),'hex') as value", [token]))[0].value;
}

async function mailer<T>(sql: string, params: unknown[]) {
  return db.db.transaction(async tx => {
    await tx.exec('set local role bron_manager_recovery_mailer');
    return (await tx.query<T>(sql, params)).rows;
  });
}

async function take(token: string) {
  return mailer<MailJob>('select * from app_private.manager_recovery_job_take($1)', [await digest(token)]);
}

async function enroll(proof: string, previous: string, passwordProof = true) {
  if (passwordProof) await db.admin("insert into auth.mfa_amr_claims(session_id,authentication_method) values($1,'password') on conflict do nothing", [proof]);
  return db.db.transaction(async tx => {
    await tx.query('select set_config(\'request.jwt.claims\',$1,true)', [JSON.stringify({sub:manager,role:'authenticated',session_id:proof})]);
    await tx.exec('set local role authenticated');
    return (await tx.query<{ result: boolean }>('select public.manager_recovery_enroll($1) as result', [previous])).rows[0].result;
  });
}

beforeEach(async () => {
  await db.admin("update auth.users set encrypted_password=extensions.crypt('initial-test-only-password',extensions.gen_salt('bf')) where id=$1", [manager]);
  await db.admin('update app_private.manager_recovery_account set reset_enabled=false,last_reset_requested_at=null,last_confirm_requested_at=null');
});

it('enrolls only a preconfigured manager with distinct fresh password proof without touching Auth', async () => {
  expect(await scalar(OWNER,'manager_recovery_status()')).toBeNull();
  expect(await scalar(MANAGER,'manager_recovery_status()')).toBeNull();
  expect(await scalar(null,'manager_recovery_available()')).toBe(false);
  await provision();
  expect(await scalar(MANAGER,'manager_recovery_status()')).toMatchObject({ email:MAIL,verified:false,reset_enabled:false });
  await expect(scalar(null,'manager_recovery_status()')).rejects.toThrow(/permission denied/);
  const previous = crypto.randomUUID(); const proof = crypto.randomUUID();
  await db.admin('insert into auth.sessions(id,user_id,created_at) values($1,$3,now()-interval \'1 hour\'),($2,$3,now())', [previous,proof,manager]);
  const authBefore = await db.admin('select email,encrypted_password from auth.users where id=$1', [manager]);
  expect(await enroll(proof,previous,false)).toBe(false);
  expect(await enroll(proof,proof)).toBe(false);
  expect(await enroll(proof,previous)).toBe(true);
  await db.admin('update app_private.manager_recovery_account set reset_enabled=true where user_id=$1', [manager]);
  await db.admin('update app_private.manager_recovery_account set reset_enabled=false where user_id=$1', [manager]);
  expect(await scalar(MANAGER,'manager_recovery_status()')).toMatchObject({ email:MAIL,verified:false,pending:true });
  const token = '1'.repeat(64);
  expect(await take(token)).toEqual([{ id:expect.any(String),email:MAIL,kind:'confirm',login:null }]);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[token,PASSWORD])).toBe(false);
  expect(await scalar(null,'manager_recovery_confirm($1)',[token])).toBe(true);
  expect(await scalar(null,'manager_recovery_confirm($1)',[token])).toBe(false);
  expect(await scalar(MANAGER,'manager_recovery_status()')).toMatchObject({ email:MAIL,verified:true,reset_enabled:false });
  expect(await scalar(null,'manager_recovery_available()')).toBe(false);
  await scalar(null,'manager_recovery_request($1)',[MANAGER]);
  expect(await take('0'.repeat(64))).toEqual([]);
  await db.admin('update app_private.manager_recovery_account set reset_enabled=true where user_id=$1', [manager]);
  expect(await scalar(null,'manager_recovery_available()')).toBe(true);
  expect(await db.admin('select email,encrypted_password from auth.users where id=$1', [manager])).toEqual(authBefore);
  expect(await db.admin('select id from auth.sessions where id in ($1,$2)', [previous,proof])).toHaveLength(2);
});

it('keeps public requests neutral, limits mail, and resets only the verified Auth password', async () => {
  await provision(true,true);
  const request = async (login: string) => scalar(null,'manager_recovery_request($1)',[login]);
  expect(await request(OWNER)).toBe(await request('unconfigured-fixture@example.invalid'));
  expect(await request(MAIL)).toBe(await request(MANAGER));
  const token = '2'.repeat(64);
  expect(await take(token)).toEqual([{ id:expect.any(String),email:MAIL,kind:'reset',login:MANAGER }]);
  expect(await take('3'.repeat(64))).toEqual([]);
  await db.admin("update app_private.manager_recovery_account set last_reset_requested_at=now()-interval '6 minutes' where user_id=$1", [manager]);
  await request(MANAGER);
  expect(await take('3'.repeat(64))).toEqual([]);
  await expect(mailer('select * from app_private.manager_recovery_account', [])).rejects.toThrow(/permission denied/);
  await expect(db.as(OWNER,'select * from app_private.manager_recovery_job_take($1)',[await digest(token)])).rejects.toThrow(/permission denied/);
  const before = await db.admin('select id,email from auth.users where id=$1', [manager]);
  await db.admin("insert into auth.identities(provider_id,user_id,identity_data,provider) values($1::uuid::text,$1::uuid,jsonb_build_object('email',$2::text),'email') on conflict do nothing", [manager,MANAGER]);
  const identities = await db.admin('select id,provider,identity_data from auth.identities where user_id=$1', [manager]);
  await db.admin('insert into auth.sessions(user_id) values($1)', [manager]);
  await db.admin("insert into auth.one_time_tokens(user_id,token_type) values($1,'recovery_token')", [manager]);
  await db.admin("insert into auth.one_time_tokens(user_id,token_type) values($1,'email_change_token_new'),($1,'phone_change_token')", [manager]);
  await db.admin('update auth.users set updated_at=clock_timestamp() where id=$1', [manager]);
  expect(await scalar(null,'manager_recovery_confirm($1)',[token])).toBe(false);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[token,'short-password'.slice(0,11)])).toBe(false);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[token,PASSWORD])).toBe(true);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[token,PASSWORD])).toBe(false);
  expect(await db.admin('select id,email from auth.users where id=$1', [manager])).toEqual(before);
  expect(await db.admin('select id,provider,identity_data from auth.identities where user_id=$1', [manager])).toEqual(identities);
  expect(await db.admin('select id from auth.sessions where user_id=$1', [manager])).toEqual([]);
  expect(await db.admin('select token_type from auth.one_time_tokens where user_id=$1', [manager])).toEqual([{ token_type:'phone_change_token' }]);
  expect(await db.admin('select encrypted_password=extensions.crypt($2,encrypted_password) matches from auth.users where id=$1', [manager,PASSWORD])).toEqual([{ matches:true }]);
});

it('retains links after mailer failures and caps sends while a challenge has 15 minutes to live', async () => {
  await provision(true,true);
  await scalar(null,'manager_recovery_request($1)',[MANAGER]);
  const first = '4'.repeat(64), second = '5'.repeat(64), third = '6'.repeat(64);
  const [job] = await take(first);
  expect(await db.admin("select expires_at-requested_at=interval '15 minutes' valid from app_private.manager_recovery_job where id=$1", [job.id])).toEqual([{ valid:true }]);
  const retry = async (token: string) => mailer('select app_private.manager_recovery_job_finish($1,$2,false)', [job.id,await digest(token)]);
  const advance = async () => db.admin('update app_private.manager_recovery_job set next_attempt_at=now() where id=$1', [job.id]);
  await retry(second);
  expect(await take(second)).toEqual([]);
  await retry(first);
  await advance();
  expect((await take(second))[0]?.id).toBe(job.id);
  await retry(second);
  await advance();
  expect((await take(third))[0]?.id).toBe(job.id);
  await retry(third);
  await advance();
  expect(await take(first)).toEqual([]);
  await db.admin("update app_private.manager_recovery_account set last_reset_requested_at=now()-interval '6 minutes' where user_id=$1", [manager]);
  await scalar(null,'manager_recovery_request($1)',[MANAGER]);
  expect(await take('d'.repeat(64))).toEqual([]);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[first,PASSWORD])).toBe(true);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[third,PASSWORD])).toBe(false);
});

it('reclaims a crashed lease, accepts an earlier link, and stops retries after current delivery acknowledgement', async () => {
  await provision(true,true);
  await scalar(null,'manager_recovery_request($1)',[MANAGER]);
  expect(await mailer("select current_user::text as actor,pg_has_role(current_user,'bron_recovery_mailer','USAGE') as inherited", [])).toEqual([
    { actor:'bron_manager_recovery_mailer',inherited:true },
  ]);
  const first='e'.repeat(64), second='f'.repeat(64), third='0'.repeat(64);
  const [job] = await take(first);
  expect(await take(second)).toEqual([]);
  const expireLease = async () => db.admin("update app_private.manager_recovery_job set next_attempt_at=now()-interval '1 second' where id=$1", [job.id]);
  await expireLease();
  expect((await take(second))[0]?.id).toBe(job.id);
  const finish = async (token: string, ok: boolean) => mailer('select app_private.manager_recovery_job_finish($1,$2,$3)', [job.id,await digest(token),ok]);
  await finish(first,true);
  expect(await db.admin('select delivered_at is not null as delivered from app_private.manager_recovery_job where id=$1', [job.id])).toEqual([{ delivered:false }]);
  await finish(second,true);
  await finish(second,false);
  await expireLease();
  expect(await take(third)).toEqual([]);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[first,PASSWORD])).toBe(true);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[second,PASSWORD])).toBe(false);
});

it('rejects tokens after ordinary password changes, an expired window, role changes, or verified MFA', async () => {
  await provision(true,true);
  async function activeToken(token: string) {
    await db.admin('update app_private.manager_recovery_account set last_reset_requested_at=null where user_id=$1', [manager]);
    await scalar(null,'manager_recovery_request($1)',[MANAGER]);
    expect((await take(token))[0]?.kind).toBe('reset');
  }
  const passwordChange = '7'.repeat(64);
  await activeToken(passwordChange);
  await db.admin("update auth.users set encrypted_password=extensions.crypt('ordinary-test-password',extensions.gen_salt('bf')) where id=$1", [manager]);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[passwordChange,PASSWORD])).toBe(false);

  const expired = '8'.repeat(64);
  await activeToken(expired);
  await db.admin("update app_private.manager_recovery_job set expires_at=now()-interval '1 second' where user_id=$1", [manager]);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[expired,PASSWORD])).toBe(false);

  const revoked = '9'.repeat(64);
  await activeToken(revoked);
  await db.admin("update public.role_assignment set revoked_at=now() where user_id=$1 and role='franchise_manager'", [manager]);
  expect(await scalar(null,'manager_recovery_available()')).toBe(false);
  await db.admin("update public.role_assignment set revoked_at=null where user_id=$1 and role='franchise_manager'", [manager]);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[revoked,PASSWORD])).toBe(false);

  const withMfa = 'a'.repeat(64);
  await activeToken(withMfa);
  await db.admin("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [manager]);
  try {
    expect(await scalar(null,'manager_recovery_available()')).toBe(false);
    expect(await scalar(null,'manager_recovery_reset($1,$2)',[withMfa,PASSWORD])).toBe(false);
  } finally {
    await db.admin('delete from auth.mfa_factors where user_id=$1', [manager]);
  }
});

it('sends nothing when a native login and another verified recovery address ambiguously match', async () => {
  await provision(true,true);
  const [second] = await db.admin<{ id: string }>("insert into auth.users(email,encrypted_password) values($1,extensions.crypt('second-test-only-password',extensions.gen_salt('bf'))) returning id", [MAIL]);
  await db.admin("insert into public.role_assignment(user_id,role,scope_type) values($1,'franchise_manager','company')", [second.id]);
  await db.admin("insert into app_private.manager_recovery_account(user_id,email,enabled,reset_enabled,verified_at) values($1,'second-recovery@example.invalid',true,true,now())", [second.id]);
  await scalar(null,'manager_recovery_request($1)',[MAIL]);
  expect(await take('b'.repeat(64))).toEqual([]);
  await scalar(null,'manager_recovery_request($1)',[MANAGER]);
  expect(await take('c'.repeat(64))).toEqual([{ id:expect.any(String),email:MAIL,kind:'reset',login:MANAGER }]);
});

it('revokes reset links when disabling reset and preserves verification across toggles', async () => {
  await provision(true,true);
  await scalar(null,'manager_recovery_request($1)',[MANAGER]);
  const token = 'd'.repeat(64);
  expect((await take(token))[0]?.kind).toBe('reset');
  await db.admin('update app_private.manager_recovery_account set reset_enabled=false where user_id=$1', [manager]);
  expect(await scalar(null,'manager_recovery_available()')).toBe(false);
  expect(await scalar(MANAGER,'manager_recovery_status()')).toMatchObject({ email:MAIL,verified:true,reset_enabled:false });
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[token,PASSWORD])).toBe(false);
  await db.admin('update app_private.manager_recovery_account set reset_enabled=true where user_id=$1', [manager]);
  expect(await scalar(null,'manager_recovery_available()')).toBe(true);
  expect(await scalar(null,'manager_recovery_reset($1,$2)',[token,PASSWORD])).toBe(false);
});
