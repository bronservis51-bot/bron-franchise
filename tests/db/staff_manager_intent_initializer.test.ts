import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); }, 180_000);
afterAll(async () => t?.db.close());

it('initializes manager intent only from the staff member’s own partner, retaining suspended roles without restoring demotions', async () => {
  const partners = await t.admin<{ id: string; code: string }>("select id,code from partner where code in ('ALPHA','BETA')");
  const own = partners.find(p => p.code === 'ALPHA')!.id;
  const foreign = partners.find(p => p.code === 'BETA')!.id;
  const location = (await t.admin<{ id: string }>('select id from location where partner_id=$1 order by id limit 1', [own]))[0].id;
  const cases = [
    { key: 'foreign', scope: foreign, active: true, revoked: false, expected: false },
    { key: 'current', scope: own, active: true, revoked: false, expected: true },
    { key: 'suspended', scope: own, active: false, revoked: true, expected: true },
    { key: 'demoted', scope: own, active: true, revoked: true, expected: false },
  ];
  const ids: string[] = [];
  for (const item of cases) {
    const user = (await t.admin<{ id: string }>(
      'select app_private.create_login($1,$2,$3) id',
      [`initializer.${item.key}@access.bron.local`, 'isolated-test-password', `Initializer ${item.key}`],
    ))[0].id;
    ids.push(user);
    await t.admin('insert into staff_member(user_id,partner_id,phone,location_ids,active,manager_enabled) values($1,$2,$3,array[$4::uuid],$5,false)',
      [user, own, `initializer.${item.key}`, location, item.active]);
    await t.admin("insert into role_assignment(user_id,role,scope_type,scope_id,revoked_at) values($1,'franchisee_manager','partner',$2,case when $3 then now() else null end)",
      [user, item.scope, item.revoked]);
  }

  // The migration drops its one-use initializer. Recreate its exact definition,
  // rather than duplicating the predicate in a test-only SQL implementation.
  const migration = readFileSync(new URL('../../supabase/migrations/20261116020000_staff_scopes.sql', import.meta.url), 'utf8');
  const definition = migration.match(/create function app_private\.staff_initialize_manager_intent\(\) returns void[\s\S]*?\n\$\$;/)?.[0];
  expect(definition).toBeTruthy();
  await t.admin(definition!);
  await t.admin('select app_private.staff_initialize_manager_intent()');
  const rows = await t.admin<{ user_id: string; manager_enabled: boolean }>(
    'select user_id,manager_enabled from staff_member where user_id=any($1::uuid[])', [ids]);
  for (const [index, item] of cases.entries()) {
    expect(rows.find(row => row.user_id === ids[index])!.manager_enabled, item.key).toBe(item.expected);
  }
});
