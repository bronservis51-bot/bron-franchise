import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const NETWORK = 'fm@demo.example.com';
const OWNER = 'alpha.owner@demo.example.com';
const GRANT = 'select public.access_grant($1,$2) result';
const CANCEL = 'select public.access_cancel_invite($1)';
let db: TestDb;
let partner: string;
let otherPartner: string;

beforeAll(async () => {
  db = await createTestDb();
  [{ id: partner }] = await db.admin<{ id: string }>("select id from public.partner where code='ALPHA'");
  [{ id: otherPartner }] = await db.admin<{ id: string }>("select id from public.partner where code='BETA'");
}, 180_000);
afterAll(async () => db?.db.close());

async function existingAccount(email: string) {
  const [row] = await db.admin<{ id: string }>(
    "select app_private.create_login($1,'synthetic-original-password','Учётная запись проверки') id", [email]);
  return row.id;
}

async function grant(login: string) {
  return (await db.as<{ result: { status: string } }>(NETWORK, GRANT, [partner, login]))[0].result;
}

async function access() {
  return (await db.as<{ result: { users: { user_id: string; can_manage: boolean }[]; invites: { id: number; email: string }[] } }>(
    NETWORK, 'select public.partner_access($1) result', [partner]))[0].result;
}

it('2.1 grants an existing account once without changing its credentials or previous session', async () => {
  const email = 'Existing.Owner@Example.Invalid';
  const user = await existingAccount(email);
  const original = await db.admin('select email, encrypted_password from auth.users where id=$1', [user]);
  const session = crypto.randomUUID();
  await db.admin('insert into auth.sessions(id,user_id) values($1,$2)', [session,user]);

  expect(await grant('  ' + email + '  ')).toMatchObject({ status: 'granted' });
  expect(await grant(email.toLowerCase())).toEqual({ status: 'exists' });
  expect(await db.admin('select role,scope_id from public.role_assignment where user_id=$1 and revoked_at is null', [user]))
    .toEqual([{ role: 'franchisee', scope_id: partner }]);
  expect(await db.admin('select email, encrypted_password from auth.users where id=$1', [user])).toEqual(original);
  expect(await db.admin('select id from auth.sessions where id=$1', [session])).toEqual([{ id: session }]);
  expect((await access()).users.find(row => row.user_id === user)?.can_manage).toBe(true);
});

it('2.1 cancels a normalized pending email before Auth provisioning without granting that role', async () => {
  const email = 'Cancel.Owner@Example.Invalid';
  expect(await grant(email)).toEqual({ status: 'pending' });
  expect(await grant(' ' + email.toLowerCase() + ' ')).toEqual({ status: 'pending' });
  expect(await db.admin('select id from auth.users where lower(email)=$1', [email.toLowerCase()])).toEqual([]);
  const matches = (await access()).invites.filter(row => row.email === email.toLowerCase());
  expect(matches).toHaveLength(1);
  await db.expectError(OWNER, CANCEL, 'forbidden', [matches[0].id]);
  await db.as(NETWORK, CANCEL, [matches[0].id]);

  const [provisioned] = await db.admin<{ id: string }>('insert into auth.users(email) values($1) returning id', [email.toLowerCase()]);
  expect(await db.admin('select role from public.role_assignment where user_id=$1', [provisioned.id])).toEqual([]);
  expect((await access()).invites.some(row => row.id === matches[0].id)).toBe(false);
  expect(await grant(email)).toMatchObject({ status: 'granted' });
});

it('only displays credential controls where the existing subordinate reset and login rules allow them', async () => {
  const email = 'former.company.owner@example.invalid';
  const user = await existingAccount(email);
  await db.admin("insert into public.role_assignment(user_id,role,scope_type,revoked_at) values($1,'franchise_manager','company',now())", [user]);
  expect(await grant(email)).toMatchObject({ status: 'granted' });
  await db.expectError(NETWORK, 'select public.user_set_password($1,$2)', 'forbidden', [user,'synthetic-reset-password']);
  await db.expectError(NETWORK, 'select public.user_set_phone_login($1,$2)', 'forbidden', [user,'79990001234']);
  expect((await access()).users.find(row => row.user_id === user)?.can_manage).toBe(false);
});

it('keeps many franchisee logins on a card and declines a new cross-card grant or invite', async () => {
  const email = 'pending.card@example.invalid';
  expect(await grant(email)).toEqual({ status: 'pending' });
  await db.expectError(NETWORK, GRANT, 'validation', [otherPartner, email.toUpperCase()]);
  const create = "select public.account_create($1,'Франчайзи',$2,'synthetic-card-password') id";
  await db.expectError(NETWORK, create, 'validation', [otherPartner, email]);
  await db.expectError(NETWORK, create, 'validation', [partner, email]);
  const [{ id: user }] = await db.admin<{ id: string }>('insert into auth.users(email) values($1) returning id', [email]);
  expect(await db.admin('select scope_id from public.role_assignment where user_id=$1', [user])).toEqual([{scope_id:partner}]);
  await db.expectError(NETWORK, GRANT, 'validation', [otherPartner, email]);
  expect(await grant(email)).toEqual({ status: 'exists' });
  expect((await access()).users.map(row => row.user_id)).toEqual(expect.arrayContaining([user, await db.userId(OWNER)]));
});

it('keeps existing legacy grants and access to explicit reports without selecting an arbitrary card for aggregate data', async () => {
  const email = 'legacy.multicard@example.invalid';
  const user = await existingAccount(email);
  await db.admin("insert into public.role_assignment(user_id,role,scope_type,scope_id) values($1,'franchisee','partner',$2),($1,'franchisee','partner',$3)", [user, partner, otherPartner]);
  expect(await grant(email)).toEqual({ status: 'exists' });
  expect(await db.admin('select id from public.role_assignment where user_id=$1 and revoked_at is null', [user])).toHaveLength(2);
  expect(await db.as(email,'select id from public.partner order by id')).toHaveLength(2);
  await db.expectError(email,'select public.finance_my(current_date,null)','validation');
  await db.expectError(email,'select public.royalty_my()','validation');
  await db.expectError(email,"select public.expense_save(null,current_date,null,'Тест',1000,null)",'validation');
});
