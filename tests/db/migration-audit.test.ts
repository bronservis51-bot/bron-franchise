import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { compareSnapshots, fingerprintRows, snapshotDatabase } from '../../scripts/migration-audit.mjs';

describe('полнота сверки переноса', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`create schema auth; create schema app_private; create schema storage;
      create table storage.buckets(id text primary key,public boolean);
      create table storage.objects(id int primary key,bucket_id text,name text);
      alter table storage.objects enable row level security;
      create policy document_read on storage.objects for select using (false);
      insert into storage.buckets values('private-files',false);
      create table auth.users(id int primary key,email text,encrypted_password text);
      create table auth.identities(id int primary key,user_id int,identity_data jsonb);
      create table public.partner(id int primary key,name text);
      create table public.location(id int primary key,name text);
      create table public.role_assignment(id int primary key,role text);
      create table public.daily_revenue(id int primary key,amount bigint,currency text);
      create table public.franchise_lead(id int primary key,name text);
      create table public.article_revision(id int primary key,body text);
      create table app_private.future_table(id int primary key,data jsonb);
      create sequence public.document_number;
      create function public.audit_probe() returns int language sql as 'select 1';
      alter table public.partner enable row level security;
      create policy partner_read on public.partner for select using (true);
      insert into auth.users values(1,'qa@example.invalid','synthetic-password-hash');
      insert into auth.identities values(1,1,'{"provider":"email"}');
      insert into public.partner values(1,'До переноса');
      insert into public.article_revision values(1,'Исходная редакция');
      insert into public.daily_revenue values(1,123456,'RUB');
      insert into app_private.future_table values(1,'{"preserve":true}');`);
  });
  afterEach(async () => { await db.close(); });

  it('даёт одинаковый снимок без записи в базу', async () => {
    expect(compareSnapshots(await snapshotDatabase(db), await snapshotDatabase(db))).toEqual([]);
    expect(fingerprintRows(['ab', 'c'])).not.toBe(fingerprintRows(['a', 'bc']));
  });
  it('видит изменённые значения при прежнем числе строк, Auth и новые приватные таблицы', async () => {
    const before = await snapshotDatabase(db);
    await db.exec(`update public.partner set name='Изменено';
      update public.article_revision set body='Потеряна история';
      update auth.users set encrypted_password='other-synthetic-hash';
      update auth.identities set identity_data='{}';
      update app_private.future_table set data='{}';`);
    const diff = compareSnapshots(before, await snapshotDatabase(db));
    expect(diff).toEqual(['data:app_private.future_table','data:auth.identities','data:auth.users','data:public.article_revision','data:public.partner']);
  });
  it('проверяет RLS, функции и состояние последовательностей', async () => {
    const before = await snapshotDatabase(db);
    await db.exec(`alter policy partner_read on public.partner using (false);
      create or replace function public.audit_probe() returns int language sql as 'select 2';
      select setval('public.document_number',42,true);`);
    expect(compareSnapshots(before, await snapshotDatabase(db))).toEqual(['schema:policies','schema:routines','sequence:public.document_number']);
  });
  it('нормализует search_path, сохраняет путь вызывающего и видит реальные изменения FK/RLS', async () => {
    await db.exec(`create function auth.uid() returns int language sql as 'select null::int';
      alter table public.partner add column auth_user_id int,
        add constraint partner_auth_user_fk foreign key (auth_user_id) references auth.users(id);
      alter policy partner_read on public.partner using (auth.uid() is not null);
      set search_path = public, auth, pg_catalog;`);
    const path = async () => (await db.query<{ search_path: string }>('show search_path')).rows[0].search_path;
    const withAuth = await path();
    const first = await snapshotDatabase(db);
    expect(await path()).toBe(withAuth);

    await db.exec('set search_path = public, pg_catalog');
    const withoutAuth = await path();
    expect(withoutAuth).not.toBe(withAuth);
    expect(compareSnapshots(first, await snapshotDatabase(db))).toEqual([]);
    expect(await path()).toBe(withoutAuth);

    await db.exec(`alter table public.partner drop constraint partner_auth_user_fk,
        add constraint partner_auth_user_fk foreign key (auth_user_id) references public.location(id);
      alter policy partner_read on public.partner using (auth.uid() is null);`);
    expect(compareSnapshots(first, await snapshotDatabase(db))).toEqual(['schema:constraints','schema:policies']);
    expect(await path()).toBe(withoutAuth);
  });
  it('сравнивает права владельца по смыслу, но видит лишний доступ роли', async () => {
    const before = await snapshotDatabase(db);
    await db.exec(`grant all privileges on table public.partner to postgres with grant option;
      grant all privileges on table storage.buckets to postgres with grant option;`);
    expect(compareSnapshots(before, await snapshotDatabase(db))).toEqual([]);

    await db.exec('create role anon; grant select on table public.partner to anon');
    expect(compareSnapshots(before, await snapshotDatabase(db))).toContain('schema:relations');
  });
  it('отличает default PUBLIC EXECUTE от пустого ACL функции в обоих направлениях', async () => {
    await db.exec(`create role anon; create role acl_owner;
      alter function public.audit_probe() owner to acl_owner;`);
    expect((await db.query(`select proacl::text as acl,
      has_function_privilege('anon','public.audit_probe()','EXECUTE') as allowed
      from pg_proc where oid='public.audit_probe()'::regprocedure`)).rows).toEqual([{ acl: null, allowed: true }]);
    const defaultAcl = await snapshotDatabase(db);

    await db.exec(`revoke all privileges on function public.audit_probe() from public;
      revoke all privileges on function public.audit_probe() from acl_owner;`);
    expect((await db.query(`select proacl::text as acl,
      has_function_privilege('anon','public.audit_probe()','EXECUTE') as allowed
      from pg_proc where oid='public.audit_probe()'::regprocedure`)).rows).toEqual([{ acl: '{}', allowed: false }]);
    const emptyAcl = await snapshotDatabase(db);
    expect(compareSnapshots(defaultAcl, emptyAcl)).toEqual(['schema:routines']);
    expect(compareSnapshots(emptyAcl, defaultAcl)).toEqual(['schema:routines']);
  });
  it('отличает default права обычного владельца таблицы от явного revoke', async () => {
    await db.exec(`create role acl_owner; alter table public.partner owner to acl_owner;`);
    expect((await db.query(`select relacl::text as acl,
      has_table_privilege('acl_owner','public.partner','SELECT') as allowed
      from pg_class where oid='public.partner'::regclass`)).rows).toEqual([{ acl: null, allowed: true }]);
    const defaultAcl = await snapshotDatabase(db);

    await db.exec('revoke all privileges on table public.partner from acl_owner');
    expect((await db.query(`select relacl::text as acl,
      has_table_privilege('acl_owner','public.partner','SELECT') as allowed
      from pg_class where oid='public.partner'::regclass`)).rows).toEqual([{ acl: '{}', allowed: false }]);
    const emptyAcl = await snapshotDatabase(db);
    expect(compareSnapshots(defaultAcl, emptyAcl)).toEqual(['schema:relations']);
    expect(compareSnapshots(emptyAcl, defaultAcl)).toEqual(['schema:relations']);
  });
  it('останавливается на неполной схеме и видит лишние/пропущенные объекты', async () => {
    expect(compareSnapshots({one:1},{one:1,extra:2})).toEqual(['extra']);
    await db.exec('drop table public.article_revision');
    await expect(snapshotDatabase(db)).rejects.toThrow('Missing required table: public.article_revision');
    expect((await db.query('select count(*) as n from public.partner')).rows).toEqual([{n:1}]);
  });
  it('обнаруживает публичный бакет и изменение политики закрытых файлов', async () => {
    const before = await snapshotDatabase(db);
    await db.exec(`update storage.buckets set public=true;
      alter policy document_read on storage.objects using (true);`);
    expect(compareSnapshots(before, await snapshotDatabase(db))).toEqual([
      'data:storage.buckets','schema:storage_policies',
    ]);
  });
  it('обнаруживает пропущенный файл, триггер и колонковые права', async () => {
    const before = await snapshotDatabase(db);
    await db.exec(`insert into storage.objects values(1,'private-files','synthetic.pdf');
      create function public.trigger_probe() returns trigger language plpgsql as 'begin return new; end';
      create trigger preserve_revision before update on public.article_revision
        for each row execute function public.trigger_probe();
      grant select(name) on public.partner to public;`);
    expect(compareSnapshots(before, await snapshotDatabase(db))).toEqual([
      'data:storage.objects','schema:columns','schema:routines','schema:triggers',
    ]);
  });
  it('не принимает отсутствующее хранилище за пустое', async () => {
    await db.exec('drop table storage.objects');
    await expect(snapshotDatabase(db)).rejects.toThrow('Missing required table: storage.objects');
  });
});
