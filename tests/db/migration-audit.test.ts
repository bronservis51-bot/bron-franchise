import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { compareSnapshots, fingerprintRows, snapshotDatabase } from '../../scripts/migration-audit.mjs';

describe('полнота сверки переноса', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`create schema auth; create schema app_private;
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
  it('останавливается на неполной схеме и видит лишние/пропущенные объекты', async () => {
    expect(compareSnapshots({one:1},{one:1,extra:2})).toEqual(['extra']);
    await db.exec('drop table public.article_revision');
    await expect(snapshotDatabase(db)).rejects.toThrow('Missing required table: public.article_revision');
    expect((await db.query('select count(*) as n from public.partner')).rows).toEqual([{n:1}]);
  });
});
