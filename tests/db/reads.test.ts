// Дымовая проверка чтения: каждая роль читает каждую клиентскую таблицу и вызывает команды чтения без ошибок.
// Ловит ошибки, которые проявляются только при реальном вызове (неоднозначные имена в PL/pgSQL, политики RLS).
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, DEMO_USERS, type TestDb } from './harness';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); }, 180_000);

const id = async (sql: string) => (await t.admin<{ id: string }>(sql))[0]?.id;

describe('чтение для всех ролей', () => {
  it('каждая роль читает каждую клиентскую таблицу без ошибок', async () => {
    const tables = await t.admin<{ tbl: string; columns: string[] | null }>(`select tbl::text as tbl, columns from app_private.client_table`);
    const failures: string[] = [];
    for (const u of DEMO_USERS) {
      for (const tb of tables) {
        const cols = tb.columns ? tb.columns.join(', ') : '*';
        try {
          await t.as(u.email, `select ${cols} from ${tb.tbl} limit 5`);
        } catch (e) {
          failures.push(`${u.email} → ${tb.tbl}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('«Сегодня» и профиль строятся для каждой роли', async () => {
    for (const u of DEMO_USERS) {
      const [r] = await t.as<{ v: Record<string, unknown> }>(u.email, `select public.today() as v`);
      expect(Object.keys(r.v)).toContain('my_tasks');
      const [m] = await t.as<{ m: { assignments: unknown[] } }>(u.email, `select public.me() as m`);
      expect(m.m.assignments.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('каталог для партнёра и собственной точки', async () => {
    const alpha1 = await id(`select id from public.location where code = 'ALPHA-1'`);
    const north = await id(`select id from public.location where code = 'OWN-NORTH'`);
    const gamma = await id(`select id from public.location where code = 'GAMMA-1'`);
    const a = await t.as<{ currency: string; sku: string; price_minor: string; subtitle: string; article_no: number; visual: { kind: string } }>(
      'alpha.owner@demo.example.com', `select * from public.catalog_for_location($1)`, [alpha1]);
    expect(a.length).toBe(22);
    expect(a[0].currency).toBe('RUB');
    const glossy = a.find((r) => r.sku === 'SH-GL-6')!;
    expect(Number(glossy.price_minor)).toBe(49000);
    expect(glossy.subtitle).toBe('Лист на 6 телефонов');
    expect(glossy.visual.kind).toBe('glossy');
    expect(a.every((r) => r.article_no > 0)).toBe(true);
    const n = await t.as<{ currency: string }>('manager.north@demo.example.com', `select * from public.catalog_for_location($1)`, [north]);
    expect(n.length).toBe(22);
    const g = await t.as<{ currency: string }>('gamma.owner@demo.example.com', `select * from public.catalog_for_location($1)`, [gamma]);
    expect(g[0].currency).toBe('TRY');
    await t.expectError('alpha.owner@demo.example.com', `select * from public.catalog_for_location($1)`, 'not-found', [gamma]);
  });

  it('административные и аналитические чтения', async () => {
    expect((await t.as('sysadmin@demo.example.com', `select * from public.admin_users()`)).length).toBe(DEMO_USERS.length);
    expect((await t.as('founder@demo.example.com', `select * from public.queue_health()`)).length).toBeGreaterThan(0);
    await t.expectError('alpha.owner@demo.example.com', `select * from public.admin_users()`, 'forbidden');
    const [m] = await t.as<{ m: { items: unknown[] } }>('fm@demo.example.com', `select public.metrics_overview() as m`);
    expect(m.m.items.length).toBeGreaterThan(8);
  });

  it('знания: контекст, поиск, экспорт для разных ролей', async () => {
    expect((await t.as('alpha.staff@demo.example.com', `select * from public.kb_for_context('ticket_category', 'equipment')`)).length).toBeGreaterThan(0);
    expect((await t.as('alpha.staff@demo.example.com', `select * from public.kb_search('плоттер')`)).length).toBeGreaterThan(0);
    const [e] = await t.as<{ e: { scope: string; articles: unknown[] } }>('alpha.owner@demo.example.com', `select public.kb_export() as e`);
    expect(e.e.scope).toBe('published-visible');
    expect(e.e.articles.length).toBeLessThan(7); // без внутреннего материала и черновиков
  });

  it('проект открытия: блокеры читает партнёр', async () => {
    const p = await id(`select id from public.opening_project where crm_deal_ref is null limit 1`);
    expect((await t.as('alpha.owner@demo.example.com', `select * from public.opening_blockers($1)`, [p])).length).toBeGreaterThan(0);
  });
});

describe('карта сети', () => {
  it('руководитель видит все точки с координатами и сводкой; франчайзи — нет', async () => {
    const [r] = await t.as<{ m: { locations: { code: string; lat: number | null; kind: string; revenue_minor: number; control: unknown }[] } }>(
      'founder@demo.example.com', `select public.network_map() as m`);
    const codes = r.m.locations.map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(['OWN-NORTH', 'ALPHA-1', 'BETA-1', 'GAMMA-1', 'ALPHA-3']));
    expect(r.m.locations.every((l) => l.lat !== null)).toBe(true);
    expect(r.m.locations.find((l) => l.code === 'ALPHA-1')!.revenue_minor).toBeGreaterThan(0);
    expect(r.m.locations.find((l) => l.code === 'BETA-1')!.control).toBeTruthy();
    await t.expectError('alpha.owner@demo.example.com', `select public.network_map()`, 'forbidden');
    await t.expectError('staff.north@demo.example.com', `select public.network_map()`, 'forbidden');
  });
});

describe('руководитель и заметки к точкам', () => {
  it('у руководителя нет согласований и проверок — только просмотр', async () => {
    const [r] = await t.as<{ v: { approvals: unknown[]; queue_tasks: unknown[] } }>('founder@demo.example.com', `select public.today() as v`);
    expect(r.v.approvals).toEqual([]);
    const perms = await t.admin<{ permission: string }>(`select permission from public.role_permission where role = 'founder'`);
    expect(perms.map((p) => p.permission)).not.toEqual(expect.arrayContaining(['order.approve']));
    expect(perms.map((p) => p.permission)).toEqual(expect.arrayContaining(['metrics.read', 'sales.read', 'royalty.read']));
  });

  it('менеджер франшизы пишет внутреннюю заметку с напоминанием; франчайзи её не видит, свою — видит', async () => {
    const [{ id: loc }] = await t.admin<{ id: string }>(`select id from public.location where code = 'BETA-1'`);
    const [n] = await t.as<{ id: string; internal: boolean }>('fm@demo.example.com',
      `select * from public.location_note_add($1, 'Позвонить после акции', current_date, true)`, [loc]);
    expect(n.internal).toBe(true);
    const [td] = await t.as<{ v: { reminders: { id: string }[] } }>('fm@demo.example.com', `select public.today() as v`);
    expect(td.v.reminders.map((x) => x.id)).toContain(n.id);
    const seen = await t.as<{ id: string }>('beta.owner@demo.example.com', `select id from public.location_note where location_id = $1`, [loc]);
    expect(seen.map((x) => x.id)).not.toContain(n.id);
    const [own] = await t.as<{ id: string; internal: boolean }>('beta.owner@demo.example.com',
      `select * from public.location_note_add($1, 'Привезли новый плоттер', null, true)`, [loc]);
    expect(own.internal).toBe(false);
    expect((await t.as('founder@demo.example.com', `select 1 from public.location_note where id = $1`, [own.id])).length).toBe(1);
    await t.expectError('alpha.owner@demo.example.com', `select * from public.location_note_add($1, 'x', null, false)`, 'not-found', [loc]);
    await t.expectError('beta.owner@demo.example.com', `select public.location_note_delete($1)`, 'not-found', [n.id]);
    await t.as('fm@demo.example.com', `select * from public.location_note_done($1, true)`, [n.id]);
    const [td2] = await t.as<{ v: { reminders: { id: string }[] } }>('fm@demo.example.com', `select public.today() as v`);
    expect(td2.v.reminders.map((x) => x.id)).not.toContain(n.id);
  });
});

describe('обязательные инструкции только тем, кого касаются', () => {
  it('стандарт оклейки — сотрудникам точек и франчайзи; регламент отчёта — франчайзи; офису — ничего', async () => {
    const acks = async (email: string) => (await t.as<{ v: { acks: { title: string }[] } }>(email, `select public.today() as v`))[0].v.acks.map((a) => a.title);
    for (const office of ['founder@demo.example.com', 'finance1@demo.example.com', 'supply@demo.example.com', 'fm@demo.example.com']) expect(await acks(office)).toEqual([]);
    // менеджерам продаж — ещё их должностная инструкция
    expect((await acks('staff.north@demo.example.com')).sort()).toEqual(['Менеджер продаж', 'Стандарт оклейки смартфона']);
    expect((await acks('alpha.staff@demo.example.com')).sort()).toEqual(['Менеджер продаж', 'Стандарт оклейки смартфона']);
    expect((await acks('beta.owner@demo.example.com')).sort()).toEqual(['Регламент сдачи отчёта о выручке', 'Стандарт оклейки смартфона']);
  });

  it('«Выручка сети»: все точки с городом, страной и днями; франчайзи — нет доступа', async () => {
    const [r] = await t.as<{ v: { locations: { code: string; city: string; country_name: string; kind: string; revenue_minor: number; daily: [string, number][] }[] } }>(
      'founder@demo.example.com', `select public.network_sales(current_date) as v`);
    const a1 = r.v.locations.find((l) => l.code === 'ALPHA-1')!;
    expect(a1.city).toBe('Волгоград');
    expect(a1.country_name).toBeTruthy();
    expect(a1.daily.length).toBeGreaterThan(0);
    expect(new Set(r.v.locations.map((l) => l.kind))).toEqual(new Set(['own', 'franchise']));
    await t.expectError('alpha.owner@demo.example.com', `select public.network_sales(current_date)`, 'forbidden');
  });
});

describe('должностные инструкции', () => {
  it('инструкция привязана к роли: менеджер продаж видит её в «Моей должности» и получает ознакомление; офис — нет', async () => {
    const [m] = await t.as<{ v: { code: string; docs: { title: string; acknowledged: boolean }[] }[] }>('alpha.staff@demo.example.com', `select public.my_role() as v`);
    expect(m.v.find((r) => r.code === 'partner_staff')!.docs.map((d) => d.title)).toEqual(['Менеджер продаж']);
    const [td] = await t.as<{ v: { acks: { title: string }[] } }>('alpha.staff@demo.example.com', `select public.today() as v`);
    expect(td.v.acks.map((a) => a.title)).toContain('Менеджер продаж');
    const [f] = await t.as<{ v: { acks: unknown[] } }>('finance1@demo.example.com', `select public.today() as v`);
    expect(f.v.acks).toEqual([]);
  });

  it('новому сотруднику с ролью ознакомление назначается сразу', async () => {
    const north = (await t.admin<{ id: string }>(`select id from public.location where code = 'OWN-NORTH'`))[0].id;
    const uid = await t.userId('tech@demo.example.com');
    await t.admin(`insert into public.role_assignment(user_id, role, scope_type, scope_id, granted_by) values ($1, 'location_staff', 'location', $2, $1)`, [uid, north]);
    const a = await t.admin(`select 1 from public.ack_assignment k join public.article a on a.id = k.article_id where k.user_id = $1 and a.slug = 'dolzhnost-menedzher-prodazh'`, [uid]);
    expect(a.length).toBe(1);
  });
});
