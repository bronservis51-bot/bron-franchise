import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const managerEmail = 'fm@demo.example.com';
const ownerEmail = 'alpha.owner@demo.example.com';
const phone = '99900013210';
const nextEmail = `${phone}@staff.bron.local`;
let t: TestDb;
let manager: string;
let owner: string;

beforeAll(async () => {
  t = await createTestDb();
  manager = await t.userId(managerEmail);
  owner = await t.userId(ownerEmail);
  await t.admin(`update auth.users set encrypted_password=extensions.crypt($2, extensions.gen_salt('bf'))
    where id=$1`, [manager, crypto.randomUUID()]);
  await t.admin(`insert into auth.identities(provider_id, user_id, identity_data, provider)
    values ($1, $1::text::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email')`, [manager, managerEmail]);
}, 180000);
afterAll(async () => t?.db.close());

async function session(user: string, minutesAgo: number, method = 'password') {
  const [{ id }] = await t.admin<{ id: string }>(`insert into auth.sessions(user_id, created_at)
    values ($1, now() - make_interval(mins => $2)) returning id`, [user, minutesAgo]);
  await t.admin('insert into auth.mfa_amr_claims(session_id, authentication_method) values ($1, $2)', [id, method]);
  return id;
}

async function change(user: string, proof: string, previous: string, requestedPhone = phone) {
  return t.db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated', session_id: proof })]);
    await tx.exec('set local role authenticated');
    const result = await tx.query<{ changed: boolean }>('select public.manager_set_my_phone_login($1, $2) changed', [requestedPhone, previous]);
    return result.rows[0].changed;
  });
}

it('requires active manager access and a distinct recent password session for the same account', async () => {
  const previous = await session(manager, 25);
  const expired = await session(manager, 10);
  const otp = await session(manager, 0, 'otp');
  const proof = await session(manager, 0);
  const ownerPrevious = await session(owner, 25);
  const ownerProof = await session(owner, 0);
  await expect(change(owner, ownerProof, ownerPrevious)).rejects.toThrow('forbidden');
  await expect(change(manager, proof, proof)).rejects.toThrow('validation');
  await expect(change(manager, proof, ownerPrevious)).rejects.toThrow('validation');
  await expect(change(manager, expired, previous)).rejects.toThrow('validation');
  await expect(change(manager, otp, previous)).rejects.toThrow('validation');
  await expect(change(manager, crypto.randomUUID(), previous)).rejects.toThrow('unauthenticated');
  await expect(t.as(null, 'select public.manager_set_my_phone_login($1, $2)', [phone, previous])).rejects.toThrow(/permission denied/);
  expect(await t.admin('select email from auth.users where id=$1', [manager])).toEqual([{ email: managerEmail }]);
});

it('rejects a reserved number and an account with another identity before writing', async () => {
  const previous = await session(manager, 25);
  const proof = await session(manager, 0);
  const partner = (await t.admin<{ id: string }>("select id from partner where code='ALPHA'"))[0].id;
  await t.admin(`insert into pending_assignment(email, role, partner_id) values ($1, 'franchisee', $2)`, [nextEmail, partner]);
  await expect(change(manager, proof, previous)).rejects.toThrow('validation');
  await t.admin('delete from pending_assignment where email=$1', [nextEmail]);
  await t.admin("insert into auth.identities(provider_id,user_id,identity_data,provider) values($1,$2,'{}','google')", [manager, manager]);
  await expect(change(manager, proof, previous)).rejects.toThrow('validation');
  await t.admin("delete from auth.identities where user_id=$1 and provider='google'", [manager]);
  expect(await t.admin('select email from auth.users where id=$1', [manager])).toEqual([{ email: managerEmail }]);
});

it('declines a password-only change for an account with a verified MFA factor', async () => {
  const previous = await session(manager, 25);
  const proof = await session(manager, 0);
  const [{ id }] = await t.admin<{ id: string }>("insert into auth.mfa_factors(user_id, status) values ($1, 'verified') returning id", [manager]);
  try {
    await expect(change(manager, proof, previous)).rejects.toMatchObject({ message: 'forbidden', detail: expect.stringContaining('администратору') });
    expect(await t.admin('select email from auth.users where id=$1', [manager])).toEqual([{ email: managerEmail }]);
    expect(await t.admin('select id from auth.sessions where id=$1', [previous])).toEqual([{ id: previous }]);
  } finally {
    await t.admin('delete from auth.mfa_factors where id=$1', [id]);
  }
});

it('keeps the account and originating session, changes its login, and revokes the other sessions and tokens', async () => {
  const previous = await session(manager, 25);
  const proof = await session(manager, 0);
  await t.admin("insert into auth.mfa_factors(user_id, status) values ($1, 'unverified')", [manager]);
  await t.admin("insert into auth.one_time_tokens(user_id, token_type) values ($1, 'recovery_token'), ($2, 'recovery_token')", [manager, owner]);
  const [before] = await t.admin<{ password: string; roles: string }>(`select encrypted_password as password,
    (select string_agg(id::text, ',' order by id) from role_assignment where user_id=u.id) roles
    from auth.users u where id=$1`, [manager]);

  expect(await change(manager, proof, previous, '+999 (000) 13-210')).toBe(true);

  expect(await t.admin(`select u.email, a.phone, i.identity_data->>'email' as identity_email,
    u.encrypted_password=$2 as same_password,
    (select string_agg(id::text, ',' order by id) from role_assignment where user_id=u.id)=$3 as same_roles
    from auth.users u join app_user a on a.id=u.id join auth.identities i on i.user_id=u.id where u.id=$1`, [manager, before.password, before.roles]))
    .toEqual([{ email: nextEmail, phone, identity_email: nextEmail, same_password: true, same_roles: true }]);
  expect(await t.admin('select id from auth.sessions where user_id=$1', [manager])).toEqual([{ id: previous }]);
  expect(await t.admin('select user_id from auth.one_time_tokens')).toEqual([{ user_id: owner }]);
  expect(await t.admin("select partner_id, diff from audit_event where action='user.login' and entity_id=$1", [manager]))
    .toEqual([{ partner_id: null, diff: { login_type: 'phone', changed: true, phone_last4: '3210' } }]);
  await expect(change(manager, proof, previous)).rejects.toThrow('unauthenticated');

  const freshProof = await session(manager, 0);
  expect(await change(manager, freshProof, previous)).toBe(false);
  expect(await t.admin("select id from audit_event where action='user.login' and entity_id=$1", [manager])).toHaveLength(1);
});
