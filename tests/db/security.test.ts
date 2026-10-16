// Изоляция данных и права (AUTH-01/02, SEC-02, COST-17, AT-01, AT-16).
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); }, 180_000);

const ALPHA = 'alpha.owner@demo.example.com';
const BETA = 'beta.owner@demo.example.com';

async function id(sql: string, params: unknown[] = []) {
  const [r] = await t.admin<{ id: string }>(sql, params);
  return r.id;
}

describe('настройка прав в схеме public', () => {
  it('RLS включён на всех таблицах public', async () => {
    const rows = await t.admin<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('у authenticated нет INSERT/UPDATE/DELETE ни на одной таблице', async () => {
    const rows = await t.admin<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('authenticated', 'anon') and privilege_type <> 'SELECT'`);
    expect(rows).toEqual([]);
  });

  it('anon не имеет доступа ни к таблицам, ни к функциям', async () => {
    const tables = await t.admin(`select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'`);
    expect(tables).toEqual([]);
    const fns = await t.admin<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app_private') and has_function_privilege('anon', p.oid, 'execute')`);
    expect(fns).toEqual([]);
  });

  it('все SECURITY DEFINER функции фиксируют search_path', async () => {
    const rows = await t.admin<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app_private') and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('внутренние функции app_private не вызываются клиентом напрямую', async () => {
    await expect(t.as(ALPHA, `select app_private.audit('x', 'y', null)`)).rejects.toThrow(/permission denied/);
    await expect(t.as(ALPHA, `select app_private.run_jobs('manual')`)).rejects.toThrow(/permission denied/);
  });
});

describe('AT-01: партнёр A не получает данные партнёра B', () => {
  it('отчёты, начисления, оплаты и заказы чужого партнёра не видны', async () => {
    for (const table of ['revenue_report', 'accrual', 'payment', 'sales_order', 'ticket', 'contract', 'opening_project']) {
      const rows = await t.as<{ partner_id: string }>(ALPHA, `select partner_id from public.${table}`);
      const alpha = await id(`select id from public.partner where code = 'ALPHA'`);
      expect(rows.every((r) => r.partner_id === alpha), table).toBe(true);
    }
  });

  it('прямой вызов команды с ID чужого объекта возвращает «не найдено»', async () => {
    const betaReport = await id(`select r.id from public.revenue_report r join public.partner p on p.id = r.partner_id where p.code = 'BETA' limit 1`);
    await t.expectError(ALPHA, `select public.report_submit($1, 'attack-key-0001')`, 'not-found', [betaReport]);
    const betaOrder = await id(`select o.id from public.sales_order o join public.partner p on p.id = o.partner_id where p.code = 'BETA' limit 1`);
    await t.expectError(ALPHA, `select public.order_cancel($1, 'x')`, 'not-found', [betaOrder]);
  });

  it('нельзя привязать отчёт своего договора к точке другого партнёра (MODEL-01)', async () => {
    const contract = await id(`select k.id from public.contract k join public.partner p on p.id = k.partner_id where p.code = 'ALPHA'`);
    const betaLoc = await id(`select id from public.location where code = 'BETA-1'`);
    await t.expectError(ALPHA, `select public.report_save_draft($1, date '2024-02-01', $2::jsonb)`, 'validation',
      [contract, JSON.stringify([{ location_id: betaLoc, gross_minor: 100 }])]);
  });

  it('файлы чужого партнёра не выдаются политикой Storage', async () => {
    const beta = await id(`select id from public.partner where code = 'BETA'`);
    const betaUser = await t.userId(BETA);
    await t.admin(`insert into public.file_asset(path, name, mime, size_bytes, visibility, partner_id, status, uploaded_by)
                   values ($1, 'secret.pdf', 'application/pdf', 10, 'scope', $2, 'ready', $3)`, [`${beta}/x/secret.pdf`, beta, betaUser]);
    await t.admin(`insert into storage.objects(bucket_id, name) values ('private-files', $1)`, [`${beta}/x/secret.pdf`]);
    const asAlpha = await t.as(ALPHA, `select name from storage.objects where name like $1`, [`${beta}/%`]);
    expect(asAlpha).toEqual([]);
    const asBeta = await t.as(BETA, `select name from storage.objects where name like $1`, [`${beta}/%`]);
    expect(asBeta).toHaveLength(1);
  });

  it('загрузить файл можно только по пути, подготовленному сервером для автора', async () => {
    await expect(t.as(ALPHA, `insert into storage.objects(bucket_id, name) values ('private-files', 'company/evil.pdf')`))
      .rejects.toThrow(/row-level security/);
  });

  it('поиск по базе знаний не раскрывает внутренние статьи партнёру', async () => {
    const asPartner = await t.as<{ slug: string }>(ALPHA, `select slug from public.kb_search('мотивация')`);
    expect(asPartner.map((r) => r.slug)).not.toContain('motivatsiya-vnutrennyaya');
    const asStaff = await t.as<{ slug: string }>('fm@demo.example.com', `select slug from public.kb_search('мотивация')`);
    expect(asStaff.map((r) => r.slug)).toContain('motivatsiya-vnutrennyaya');
    const direct = await t.as(ALPHA, `select * from public.article where slug = 'motivatsiya-vnutrennyaya'`);
    expect(direct).toEqual([]);
  });

  it('сотрудник партнёра не видит финансы (AUTH-02)', async () => {
    expect(await t.as('alpha.staff@demo.example.com', `select * from public.revenue_report`)).toEqual([]);
    expect(await t.as('alpha.staff@demo.example.com', `select * from public.v_accrual_balance`)).toEqual([]);
  });

  it('системный администратор не видит финансы без финансовой роли', async () => {
    expect(await t.as('sysadmin@demo.example.com', `select * from public.payment`)).toEqual([]);
  });

  it('внутренние заметки открытия и обращения не видны партнёру (OPEN-05)', async () => {
    expect(await t.as(ALPHA, `select * from public.opening_note`)).toEqual([]);
    const notes = await t.as('fm@demo.example.com', `select * from public.opening_note`);
    expect(notes.length).toBeGreaterThan(0);
    const internal = await t.as<{ internal: boolean }>('alpha.staff@demo.example.com', `select internal from public.ticket_message`);
    expect(internal.every((m) => !m.internal)).toBe(true);
  });
});

describe('AT-16: одинаковые номера у разных партнёров', () => {
  it('номер отчёта партнёра уникален только в его области', async () => {
    const [r] = await t.admin<{ partner_ref: string }>(`select partner_ref from public.revenue_report r join public.partner p on p.id = r.partner_id where p.code = 'ALPHA' limit 1`);
    const betaContract = await id(`select k.id from public.contract k join public.partner p on p.id = k.partner_id where p.code = 'BETA'`);
    const betaLoc = await id(`select id from public.location where code = 'BETA-1'`);
    const rows = await t.as<{ partner_ref: string }>(BETA, `select partner_ref from public.report_save_draft($1, date '2024-03-01', $2::jsonb, null, $3)`,
      [betaContract, JSON.stringify([{ location_id: betaLoc, gross_minor: 1000 }]), r.partner_ref]);
    expect(rows[0].partner_ref).toBe(r.partner_ref);
  });
});
