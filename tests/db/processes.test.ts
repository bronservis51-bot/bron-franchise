// Процессы: открытие, задачи, поддержка, заказы, знания, обмен (AT-02…06, AT-11…14).
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
const FM = 'fm@demo.example.com';
// Руководителя направления нет (решение владельца 13.10.2026): разрешения, шаблоны и публикацию статей ведёт руководитель компании
const HEAD = 'founder@demo.example.com'; // руководитель: только настройка шаблона, без согласований
const ALPHA = 'alpha.owner@demo.example.com';
const SUPPLY = 'supply@demo.example.com';
let seq = 0;
const key = (p: string) => `${p}-proc-key-${++seq}`;

beforeAll(async () => { t = await createTestDb(); }, 180_000);

async function one<T = { id: string }>(sql: string, params: unknown[] = []) {
  const [r] = await t.admin<T>(sql, params);
  return r;
}

describe('открытие точки', () => {
  let project: string;
  it('проект создаётся по шаблону со снимком версии', async () => {
    const alpha = (await one(`select id from public.partner where code = 'ALPHA'`)).id;
    const [r] = await t.as<{ id: string }>(FM, `select public.opening_create($1, null, 'Альфа Тест', 'Казань', null, 'Островок', current_date + 40) as id`, [alpha]);
    project = r.id;
    const tasks = await t.admin<{ status: string }>(`select status from public.task where subject_id = $1`, [project]);
    expect(tasks.length).toBe(18);
    expect(tasks.filter((x) => x.status === 'ready').length).toBe(2); // без зависимостей: реквизиты и фото места
  });

  it('AT-03: без критических задач разрешение на открытие не выдаётся', async () => {
    const detail = await t.expectError(FM, `select public.opening_approve($1)`, 'transition-not-allowed', [project]);
    expect(detail).toMatch(/Прикрепить подписанный договор/);
    const blockers = await t.as(ALPHA, `select * from public.opening_blockers($1)`, [project]);
    expect(blockers.length).toBeGreaterThan(5);
  });

  it('AT-04: новая версия шаблона не меняет начатый проект', async () => {
    const [{ definition }] = await t.admin<{ definition: { steps: unknown[]; stages: unknown[] } }>(
      `select definition from public.workflow_template_version where status = 'published'`);
    const def = { ...definition, steps: definition.steps.slice(0, 3) };
    await t.as(HEAD, `select public.workflow_template_publish('opening-standard', $1::jsonb, 'Сокращённый шаблон')`, [JSON.stringify(def)]);
    const n = await t.admin(`select 1 from public.task where subject_id = $1`, [project]);
    expect(n.length).toBe(18);
    const [v] = await t.admin<{ version: number }>(`select v.version from public.opening_project p join public.workflow_template_version v on v.id = p.template_version_id where p.id = $1`, [project]);
    expect(v.version).toBe(1);
    // вернуть полный шаблон версией 3 для следующих проверок
    await t.as(HEAD, `select public.workflow_template_publish('opening-standard', $1::jsonb, 'Возврат полного шаблона')`, [JSON.stringify(definition)]);
  });

  it('шаблон с циклом зависимостей отклоняется', async () => {
    const def = { stages: [{ key: 's', title: 'S' }], steps: [
      { key: 'a', stage: 's', title: 'A', queue_role: 'franchise_manager', depends_on: ['b'] },
      { key: 'b', stage: 's', title: 'B', queue_role: 'franchise_manager', depends_on: ['a'] }] };
    await t.expectError(HEAD, `select public.workflow_template_publish('opening-standard', $1::jsonb, 'цикл')`, 'validation', [JSON.stringify(def)]);
  });

  it('OPEN-04: перенос даты меняет только незавершённые относительные сроки', async () => {
    const before = await t.admin<{ step_key: string; due_at: string }>(`select step_key, due_at::text from public.task where subject_id = $1 order by step_key`, [project]);
    const [r] = await t.as<{ r: { changed: unknown[] } }>(FM, `select public.opening_change_date($1, current_date + 50, 'Арендодатель перенёс сдачу') as r`, [project]);
    const after = await t.admin<{ step_key: string; due_at: string }>(`select step_key, due_at::text from public.task where subject_id = $1 order by step_key`, [project]);
    const changed = after.filter((a, i) => a.due_at !== before[i].due_at).map((a) => a.step_key);
    expect(changed).toContain('kit_order');
    expect(changed).not.toContain('partner_details'); // срок от старта проекта не меняется
    expect(r.r.changed.length).toBe(changed.length);
  });

  it('партнёр видит дорожную карту, но не внутренние заметки', async () => {
    await t.as(FM, `select public.opening_add_note($1, 'Внутренняя заметка')`, [project]);
    expect((await t.as(ALPHA, `select * from public.opening_project where id = $1`, [project])).length).toBe(1);
    expect(await t.as(ALPHA, `select * from public.opening_note where project_id = $1`, [project])).toEqual([]);
    await t.expectError(ALPHA, `select public.opening_add_note($1, 'x')`, 'forbidden', [project]);
  });

  it('повтор события CRM вернул тот же проект (OPEN-01)', async () => {
    const rows = await t.admin(`select 1 from public.opening_project where crm_deal_ref = 'DEMO-DEAL-1042'`);
    expect(rows).toHaveLength(1);
    const [inbox] = await t.admin<{ n: string }>(`select count(*) as n from public.inbox where source = 'crm'`);
    expect(Number(inbox.n)).toBe(1);
  });

  it('полный проход: задачи → разрешение → открытие', async () => {
    const steps = await t.admin<{ id: string; step_key: string; queue_role: string; requires_evidence: boolean }>(
      `select id, step_key, queue_role, requires_evidence from public.task where subject_id = $1 order by stage_order, step_order`, [project]);
    const who: Record<string, string> = { partner_owner: ALPHA, franchise_manager: FM, finance: 'finance1@demo.example.com',
      procurement: SUPPLY, warehouse: SUPPLY, founder: FM, hr_admin: 'hr@demo.example.com',
      designer: 'designer@demo.example.com', direction_head: FM };
    for (const s of steps) {
      if (['opening_permit', 'opening_fact', 'stab_7', 'stab_14', 'stab_30'].includes(s.step_key)) continue;
      if (s.requires_evidence) {
        // доказательство: файл, подготовленный сервером, загружен и подтверждён
        const [prep] = await t.as<{ r: { file_id: string; path: string } }>(who[s.queue_role],
          `select public.task_attach_prepare($1, 'photo.jpg', 'image/jpeg', 1000, null) as r`, [s.id]);
        await t.as(who[s.queue_role], `insert into storage.objects(bucket_id, name) values ('private-files', $1)`, [prep.r.path]);
        await t.as(who[s.queue_role], `select public.file_confirm($1)`, [prep.r.file_id]);
      }
      await t.as(who[s.queue_role], `select public.task_complete($1, 'Выполнено')`, [s.id]);
    }
    await t.as(FM, `select public.opening_approve($1, 'Готово')`, [project]);
    await t.as(FM, `select public.opening_mark_opened($1, current_date)`, [project]);
    const [loc] = await t.admin<{ status: string }>(`select l.status from public.location l join public.opening_project p on p.location_id = l.id where p.id = $1`, [project]);
    expect(loc.status).toBe('active');
    const stab = await t.admin<{ due_at: string | null }>(`select due_at from public.task where subject_id = $1 and step_key = 'stab_7'`, [project]);
    expect(stab[0].due_at).not.toBeNull();
  });

  it('задача с обязательным доказательством не завершается без файла', async () => {
    const alpha = (await one(`select id from public.partner where code = 'ALPHA'`)).id;
    const [r] = await t.as<{ id: string }>(FM, `select public.opening_create($1, null, 'Альфа Тест 2', 'Казань', null, null, current_date + 40) as id`, [alpha]);
    const task = await one(`select id from public.task where subject_id = $1 and step_key = 'location_photos'`, [r.id]);
    await t.expectError(ALPHA, `select public.task_complete($1, 'Готово')`, 'validation', [task.id]);
  });
});

describe('задачи и передача дел', () => {
  it('комментарий не завершает задачу; завершение требует результата', async () => {
    const task = await one(`select id from public.task where status = 'ready' and queue_role = 'partner_owner' limit 1`);
    await t.as(ALPHA, `select public.task_comment($1, 'Посмотрю завтра')`, [task.id]);
    const [s] = await t.admin<{ status: string }>(`select status from public.task where id = $1`, [task.id]);
    expect(s.status).toBe('ready');
    await t.expectError(ALPHA, `select public.task_complete($1, '')`, 'validation', [task.id]);
  });

  it('конфликт версий при одновременном изменении', async () => {
    const task = await one<{ id: string; revision: number }>(`select id, revision from public.task where status = 'ready' and queue_role = 'partner_owner' limit 1`);
    await t.as(ALPHA, `select public.task_take($1, $2)`, [task.id, task.revision]);
    await t.expectError(ALPHA, `select public.task_transition($1, 'blocked', 'нет доступа', $2)`, 'version-conflict', [task.id, task.revision]);
  });

  it('AT-02: увольнение отзывает доступ, работа возвращается в очередь, история сохраняется', async () => {
    const fmId = await t.userId(FM);
    const mine = await t.admin<{ id: string }>(`select id from public.task where assignee_id = $1 and status not in ('done','cancelled')`, [fmId]);
    expect(mine.length).toBeGreaterThan(0);
    await t.as('founder@demo.example.com', `select public.offboard_user($1, 'Увольнение')`, [fmId]);
    const left = await t.admin(`select id from public.task where assignee_id = $1 and status not in ('done','cancelled')`, [fmId]);
    expect(left).toEqual([]);
    const events = await t.admin(`select 1 from public.task_event where task_id = $1 and action = 'returned_to_queue'`, [mine[0].id]);
    expect(events.length).toBe(1);
    await expect(t.as(FM, `select public.me()`)).resolves.toBeTruthy();
    await t.expectError(FM, `select public.task_comment($1, 'x')`, 'forbidden', [mine[0].id]);
    // авторство сохранено
    const authored = await t.admin(`select 1 from public.task_event where actor_id = $1`, [fmId]);
    expect(authored.length).toBeGreaterThan(0);
    // Вернуть менеджера франшизы для следующих проверок (он теперь выдаёт разрешения и публикует статьи)
    await t.admin(`update public.app_user set status = 'active' where id = $1`, [fmId]);
    await t.admin(`update public.role_assignment set revoked_at = null, revoke_reason = null where user_id = $1`, [fmId]);
  });
});

describe('поддержка', () => {
  it('обращение маршрутизируется в очередь компетенции, срочность требует пояснения', async () => {
    const loc = (await one(`select id from public.location where code = 'ALPHA-1'`)).id;
    await t.expectError(ALPHA, `select public.ticket_create($1, 'equipment', 'stopped', '', 'Нет питания', 'Не включается', 'X1')`, 'validation', [loc]);
    await t.expectError(ALPHA, `select public.ticket_create($1, 'equipment', 'normal', null, 'Нет питания', 'Не включается', null)`, 'validation', [loc]);
    const [tk] = await t.as<{ id: string; queue_role: string; first_response_due: string; resolve_due: string }>(ALPHA,
      `select * from public.ticket_create($1, 'equipment', 'stopped', 'Точка стоит', 'Нет питания', 'Не включается', 'X1', '{}'::jsonb, 'k-1')`, [loc]);
    expect(tk.queue_role).toBe('support_specialist');
    expect(new Date(tk.resolve_due) > new Date(tk.first_response_due)).toBe(true);
    // повтор отправки офлайн-черновика с тем же ключом возвращает то же обращение (PWA-03)
    const [again] = await t.as<{ id: string }>(ALPHA, `select * from public.ticket_create($1, 'equipment', 'stopped', 'Точка стоит', 'Нет питания', 'Не включается', 'X1', '{}'::jsonb, 'k-1')`, [loc]);
    expect(again.id).toBe(tk.id);
    const head = await t.admin(`select 1 from public.notification n join auth.users u on u.id = n.user_id where u.email = $1 and n.kind = 'ticket.stopped'`, [FM]);
    expect(head.length).toBeGreaterThan(0);
  });

  it('решение без причины отклоняется; партнёр подтверждает или переоткрывает', async () => {
    const tk = await one(`select id from public.ticket where subject = 'Нет питания'`);
    await t.as('tech@demo.example.com', `select public.ticket_take($1)`, [tk.id]);
    await t.expectError('tech@demo.example.com', `select public.ticket_resolve($1, '')`, 'validation', [tk.id]);
    await t.as('tech@demo.example.com', `select public.ticket_resolve($1, 'Заменён блок питания')`, [tk.id]);
    await t.as(ALPHA, `select public.ticket_reopen($1, 'Снова не включается')`, [tk.id]);
    await t.as('tech@demo.example.com', `select public.ticket_resolve($1, 'Заменена розетка')`, [tk.id]);
    await t.as(ALPHA, `select public.ticket_confirm($1)`, [tk.id]);
    const [s] = await t.admin<{ status: string; reopen_count: number }>(`select status, reopen_count from public.ticket where id = $1`, [tk.id]);
    expect(s).toEqual({ status: 'closed', reopen_count: 1 });
  });

  it('ожидание партнёра приостанавливает таймер решения', async () => {
    const tk = await one<{ id: string; resolve_due: string }>(`select id, resolve_due::text from public.ticket where status = 'waiting_partner' limit 1`);
    await t.admin(`update public.ticket set sla_paused_at = now() - interval '2 hours' where id = $1`, [tk.id]);
    await t.as('alpha.staff@demo.example.com', `select public.ticket_reply($1, 'Видео приложили')`, [tk.id]);
    const [after] = await t.admin<{ resolve_due: string; status: string; sla_paused_minutes: number }>(`select resolve_due::text, status, sla_paused_minutes from public.ticket where id = $1`, [tk.id]);
    expect(after.status).toBe('in_progress');
    expect(after.sla_paused_minutes).toBeGreaterThanOrEqual(120);
    expect(new Date(after.resolve_due) > new Date(tk.resolve_due)).toBe(true);
  });

  it('рабочий календарь: срок переносится на рабочее время', async () => {
    const [r] = await t.admin<{ due: string }>(`select to_char(app_private.add_business_minutes('2026-10-09 17:00+03', 120,
      (select id from public.business_calendar where code = 'support-msk')) at time zone 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') as due`);
    expect(r.due).toBe('2026-10-12 10:00'); // пятница 17:00 + 2 рабочих часа → понедельник 10:00
  });

  it('демо-перевод помечен и сохраняет оригинал', async () => {
    const m = await one(`select m.id from public.ticket_message m join public.ticket t on t.id = m.ticket_id where t.subject = 'Plotter kesmiyor' limit 1`).catch(() => null);
    if (!m) {
      const tk = await one(`select id from public.ticket where subject = 'Plotter kesmiyor'`);
      await t.as('designer@demo.example.com', `select public.ticket_reply($1, 'Здравствуйте! Пришлите, пожалуйста, видео работы плоттера и фото ножа.')`, [tk.id]);
    }
    const msg = await one(`select m.id from public.ticket_message m join public.ticket t on t.id = m.ticket_id where t.subject = 'Plotter kesmiyor' limit 1`);
    const [r] = await t.as<{ r: { kind: string; original: string; available: boolean } }>('gamma.owner@demo.example.com', `select public.ticket_message_translate($1, 'tr') as r`, [msg.id]);
    expect(r.r.kind).toBe('demo');
    expect(r.r.available).toBe(true);
  });
});

describe('заказы', () => {
  it('BUY-03: сервер пересчитывает цену и проверяет кратность', async () => {
    const loc = (await one(`select id from public.location where code = 'ALPHA-1'`)).id;
    const [cart] = await t.as<{ id: string }>(ALPHA, `select * from public.cart_open($1)`, [loc]);
    const sheet = (await one(`select id from public.catalog_item where sku = 'PU-WT-SH'`)).id;
    await t.as(ALPHA, `select public.cart_set_line($1, $2, 15)`, [cart.id, sheet]);
    const detail = await t.expectError(ALPHA, `select public.order_submit($1, $2)`, 'validation', [cart.id, key('submit')]);
    expect(detail).toMatch(/кратно 10/);
    await t.as(ALPHA, `select public.cart_set_line($1, $2, 20)`, [cart.id, sheet]);
    await t.admin(`update public.order_line set price_minor = 1 where order_id = $1`, [cart.id]); // подмена цены в черновике
    const [r] = await t.as<{ r: { total_minor: number } }>(ALPHA, `select public.order_submit($1, $2) as r`, [cart.id, key('submit')]);
    expect(Number(r.r.total_minor)).toBe(20 * 18000);
  });

  it('AT-05: двойное нажатие и потерянный ответ склада — один внешний документ', async () => {
    const loc = (await one(`select id from public.location where code = 'ALPHA-2'`)).id;
    const [cart] = await t.as<{ id: string }>(ALPHA, `select * from public.cart_open($1)`, [loc]);
    await t.as(ALPHA, `select public.cart_set_line($1, (select id from public.catalog_item where sku = 'SQG-PRO'), 2)`, [cart.id]);
    const k = key('submit');
    const [a] = await t.as<{ r: { number: string } }>(ALPHA, `select public.order_submit($1, $2) as r`, [cart.id, k]);
    const [b] = await t.as<{ r: { number: string; replayed: boolean } }>(ALPHA, `select public.order_submit($1, $2) as r`, [cart.id, k]);
    expect(b.r.number).toBe(a.r.number);
    expect(b.r.replayed).toBe(true);
    // Оплату заказа подтверждает снабжение, а не финансы (решение владельца 13.10.2026)
    await t.expectError('finance1@demo.example.com', `select public.order_payment_confirm($1, 'BANK-X')`, 'forbidden', [cart.id]);
    await t.as(SUPPLY, `select public.order_payment_confirm($1, 'BANK-X')`, [cart.id]);
    await t.as(SUPPLY, `select public.integration_set_demo_behavior('moysklad', 'lost_response')`);
    await t.as(SUPPLY, `select public.run_integration_jobs()`);
    const [mid] = await t.admin<{ transfer_status: string }>(`select transfer_status from public.sales_order where id = $1`, [cart.id]);
    expect(mid.transfer_status).toBe('needs_reconciliation');
    await t.admin(`update public.outbox set next_attempt_at = now() where aggregate_id = $1`, [cart.id]);
    await t.as(SUPPLY, `select public.run_integration_jobs()`);
    const [end] = await t.admin<{ transfer_status: string }>(`select transfer_status from public.sales_order where id = $1`, [cart.id]);
    expect(end.transfer_status).toBe('sent');
    const docs = await t.admin(`select 1 from public.demo_external_doc where external_code = $1`, [cart.id]);
    expect(docs).toHaveLength(1);
    await t.as(SUPPLY, `select public.integration_set_demo_behavior('moysklad', 'success')`);
  });

  it('AT-06: частичная отгрузка оставляет остаток открытым; повтор webhook игнорируется', async () => {
    const o = await one<{ id: string; status: string }>(`select id, status from public.sales_order where status = 'partially_shipped' limit 1`);
    const lines = await t.admin<{ qty_ordered: string; qty_shipped: string }>(`select qty_ordered, qty_shipped from public.order_line where order_id = $1`, [o.id]);
    expect(lines.some((l) => Number(l.qty_shipped) < Number(l.qty_ordered))).toBe(true);
    const shipments = await t.admin(`select 1 from public.shipment where order_id = $1`, [o.id]);
    expect(shipments).toHaveLength(1); // второй webhook с тем же event_id не создал отгрузку
    const [dup] = await t.admin<{ n: string }>(`select count(*) as n from public.inbox where event_id = 'seed-ms-ship-a2'`);
    expect(Number(dup.n)).toBe(1);
    // приёмка части отгруженного: заказ не становится доставленным
    const line = await one(`select id, qty_shipped from public.order_line where order_id = $1 and qty_shipped > 0 limit 1`, [o.id]);
    await t.as(ALPHA, `select public.order_receive($1, $2::jsonb)`, [o.id, JSON.stringify([{ line_id: line.id, qty_received: 1 }])]);
    const [after] = await t.admin<{ status: string }>(`select status from public.sales_order where id = $1`, [o.id]);
    expect(after.status).toBe('partially_shipped');
    await t.expectError(ALPHA, `select public.order_receive($1, $2::jsonb)`, 'validation', [o.id, JSON.stringify([{ line_id: line.id, qty_received: 99 }])]);
  });

  it('согласование заявки: автор не согласует сам, снабжение согласует', async () => {
    const o = await one(`select id from public.sales_order where approval_status = 'pending' limit 1`);
    await t.expectError('manager.north@demo.example.com', `select public.order_approve($1)`, 'forbidden', [o.id]);
    await t.as(SUPPLY, `select public.order_approve($1, 'Ок')`, [o.id]);
    const [r] = await t.admin<{ transfer_status: string }>(`select transfer_status from public.sales_order where id = $1`, [o.id]);
    expect(r.transfer_status).toBe('pending');
  });

  it('повтор заказа создаёт новую корзину и не меняет исходный', async () => {
    const o = await one<{ id: string; total_minor: string }>(`select id, total_minor::text from public.sales_order where status = 'partially_shipped' limit 1`);
    const [cart] = await t.as<{ id: string; status: string; repeated_from: string }>(ALPHA, `select * from public.order_repeat($1)`, [o.id]);
    expect(cart.status).toBe('draft');
    expect(cart.repeated_from).toBe(o.id);
    const [same] = await t.admin<{ total_minor: string }>(`select total_minor::text from public.sales_order where id = $1`, [o.id]);
    expect(same.total_minor).toBe(o.total_minor);
  });

  it('AT-12: при сбое склада нет ложного успеха, после исчерпания попыток — задача', async () => {
    const o = await one(`select id from public.sales_order where transfer_status = 'failed' limit 1`);
    await t.as(SUPPLY, `select public.integration_set_demo_behavior('moysklad', 'fail')`);
    for (let i = 0; i < 6; i++) {
      await t.admin(`update public.outbox set next_attempt_at = now() where aggregate_id = $1`, [o.id]);
      await t.as(SUPPLY, `select public.run_integration_jobs()`);
    }
    const [ob] = await t.admin<{ status: string }>(`select status from public.outbox where aggregate_id = $1 and topic = 'warehouse.create_order'`, [o.id]);
    expect(ob.status).toBe('dead');
    const [s] = await t.admin<{ transfer_status: string }>(`select transfer_status from public.sales_order where id = $1`, [o.id]);
    expect(s.transfer_status).toBe('failed');
    const tasks = await t.admin(`select 1 from public.task where kind = 'integration_dead' and subject_id = $1`, [o.id]);
    expect(tasks).toHaveLength(1);
    await t.as(SUPPLY, `select public.integration_set_demo_behavior('moysklad', 'success')`);
    const [{ id: ob2 }] = await t.admin<{ id: string }>(`select id from public.outbox where aggregate_id = $1`, [o.id]);
    await t.as(SUPPLY, `select public.outbox_retry($1)`, [ob2]);
    await t.as(SUPPLY, `select public.run_integration_jobs()`);
    const [fixed] = await t.admin<{ transfer_status: string }>(`select transfer_status from public.sales_order where id = $1`, [o.id]);
    expect(fixed.transfer_status).toBe('sent');
  });
});

describe('база знаний', () => {
  it('сотрудник находит инструкцию по оклейке, в том числе с опечаткой', async () => {
    const exact = await t.as<{ slug: string }>('staff.north@demo.example.com', `select slug from public.kb_search('оклейка смартфона')`);
    expect(exact[0].slug).toBe('standart-okleyki');
    const typo = await t.as<{ slug: string }>('staff.north@demo.example.com', `select slug from public.kb_search('аклейка смартфна')`);
    expect(typo.map((r) => r.slug)).toContain('standart-okleyki');
  });

  it('опубликованная редакция неизменна', async () => {
    await expect(t.admin(`update public.article_revision set body = 'x' where status = 'published'`)).rejects.toThrow('transition-not-allowed');
  });

  it('публикация требует владельца и согласующего ≠ автора', async () => {
    const [a] = await t.as<{ r: { article_id: string } }>('editor@demo.example.com',
      `select public.article_create((select id from public.kb_section where slug = 'prodazhi'), 'article', 'Тест', 'all') as r`);
    await t.as('editor@demo.example.com', `select public.article_save_draft($1, 'Тест', null, 'Достаточно длинный текст статьи для публикации.')`, [a.r.article_id]);
    await t.as('editor@demo.example.com', `select public.article_submit($1)`, [a.r.article_id]);
    const rev = await one(`select id from public.article_revision where article_id = $1 and status = 'in_review'`, [a.r.article_id]);
    await t.expectError('editor@demo.example.com', `select public.article_publish($1, false)`, 'forbidden', [rev.id]);
    await t.as(FM, `select public.article_publish($1, false)`, [rev.id]);
  });

  it('новая обязательная версия создаёт ознакомления аудитории; косметическая — нет', async () => {
    const art = await one(`select id from public.article where slug = 'standart-okleyki'`);
    const [{ n: before }] = await t.admin<{ n: string }>(`select count(*) as n from public.ack_assignment where article_id = $1`, [art.id]);
    await t.as('editor@demo.example.com', `select public.article_save_draft($1, 'Стандарт оклейки смартфона', 'Исправлена опечатка', (select body from public.article_revision where id = (select published_revision_id from public.article where id = $1)) || ' ')`, [art.id]);
    await t.as('editor@demo.example.com', `select public.article_submit($1)`, [art.id]);
    let rev = await one(`select id from public.article_revision where article_id = $1 and status = 'in_review'`, [art.id]);
    await t.as(FM, `select public.article_publish($1, false)`, [rev.id]);
    const [{ n: cosmetic }] = await t.admin<{ n: string }>(`select count(*) as n from public.ack_assignment where article_id = $1`, [art.id]);
    expect(cosmetic).toBe(before);
    await t.as('editor@demo.example.com', `select public.article_save_draft($1, 'Стандарт оклейки смартфона', 'Новый шаг', (select body from public.article_revision where id = (select published_revision_id from public.article where id = $1)) || E'\n\nНовый обязательный шаг.')`, [art.id]);
    await t.as('editor@demo.example.com', `select public.article_submit($1)`, [art.id]);
    rev = await one(`select id from public.article_revision where article_id = $1 and status = 'in_review'`, [art.id]);
    const [res] = await t.as<{ r: { ack_assigned: number } }>(FM, `select public.article_publish($1, true) as r`, [rev.id]);
    expect(res.r.ack_assigned).toBeGreaterThan(5);
    await t.as(ALPHA, `select public.article_acknowledge($1)`, [rev.id]);
    const [mine] = await t.as<{ completed_at: string | null }>(ALPHA, `select completed_at from public.ack_assignment where revision_id = $1 and user_id = auth.uid()`, [rev.id]);
    expect(mine.completed_at).not.toBeNull();
  });

  it('AT-11: изменение исходника Drive не меняет опубликованный регламент; отзыв доступа скрывает статью', async () => {
    const art = await one<{ id: string; published_revision_id: string }>(`select id, published_revision_id from public.article where slug = 'plotter-lekala'`);
    await t.as(SUPPLY, `select public.demo_drive_change($1, 'Изменённый текст в Drive: новая процедура калибровки.', 'v2')`, [art.id]);
    const [same] = await t.admin<{ published_revision_id: string }>(`select published_revision_id from public.article where id = $1`, [art.id]);
    expect(same.published_revision_id).toBe(art.published_revision_id);
    const candidate = await t.admin(`select 1 from public.article_revision where article_id = $1 and status = 'in_review' and source = 'drive'`, [art.id]);
    expect(candidate).toHaveLength(1);
    await t.as(SUPPLY, `select public.demo_drive_access($1, false)`, [art.id]);
    expect(await t.as(ALPHA, `select slug from public.kb_search('плоттер')`)).not.toContainEqual({ slug: 'plotter-lekala' });
    expect(await t.as(ALPHA, `select 1 from public.article where id = $1`, [art.id])).toEqual([]);
    await t.as(SUPPLY, `select public.demo_drive_access($1, true)`, [art.id]);
  });

  it('сбой экспорта корпоративной копии виден и устраняется повтором', async () => {
    await t.as(SUPPLY, `select public.integration_set_demo_behavior('google_drive', 'fail')`);
    const art = await one(`select id from public.article where slug = 'garantiya-45'`);
    await t.as('editor@demo.example.com', `select public.article_save_draft($1, 'Гарантия на оклейку гаджета: как оформить обращение', null, 'Обновлённый текст регламента гарантии для проверки экспорта.')`, [art.id]);
    await t.as('editor@demo.example.com', `select public.article_submit($1)`, [art.id]);
    const rev = await one(`select id from public.article_revision where article_id = $1 and status = 'in_review'`, [art.id]);
    await t.as(FM, `select public.article_publish($1, false)`, [rev.id]);
    await t.as(SUPPLY, `select public.run_integration_jobs()`);
    const [failed] = await t.admin<{ export_status: string }>(`select export_status from public.article where id = $1`, [art.id]);
    expect(failed.export_status).toBe('failed');
    await t.as(SUPPLY, `select public.integration_set_demo_behavior('google_drive', 'success')`);
    await t.admin(`update public.outbox set next_attempt_at = now() where aggregate_id = $1`, [art.id]);
    await t.as(SUPPLY, `select public.run_integration_jobs()`);
    const [ok] = await t.admin<{ export_status: string }>(`select export_status from public.article where id = $1`, [art.id]);
    expect(ok.export_status).toBe('done');
  });

  it('KB-19: экспорт восстанавливается в новой установке', async () => {
    const [exp] = await t.as<{ e: { articles: unknown[] } }>('editor@demo.example.com', `select public.kb_export() as e`);
    expect(exp.e.articles.length).toBeGreaterThan(5);
    const fresh = await createTestDb({ seed: true, users: false });
    await fresh.admin(`insert into auth.users(email, raw_user_meta_data, raw_app_meta_data) values ('restore@demo.example.com', '{"full_name":"Восстановление"}', '{}')`);
    await fresh.admin(`insert into public.role_assignment(user_id, role, scope_type) select id, 'kb_editor', 'company' from public.app_user`);
    const [res] = await fresh.as<{ r: { imported: number } }>('restore@demo.example.com', `select public.kb_import($1::jsonb) as r`, [JSON.stringify(exp.e)]);
    expect(res.r.imported).toBe(exp.e.articles.length);
    const found = await fresh.as<{ slug: string }>('restore@demo.example.com', `select slug from public.kb_search('оклейка')`);
    expect(found.map((r) => r.slug)).toContain('standart-okleyki');
  }, 120_000);
});

describe('экран «Сегодня» и показатели', () => {
  it('у партнёра, финансиста и сотрудника точки разные блоки', async () => {
    const [p] = await t.as<{ v: Record<string, unknown[]> }>(ALPHA, `select public.today() as v`);
    const [f] = await t.as<{ v: Record<string, unknown[]> }>('finance1@demo.example.com', `select public.today() as v`);
    const [s] = await t.as<{ v: Record<string, unknown[]> }>('staff.north@demo.example.com', `select public.today() as v`);
    expect(f.v.approvals.length).toBeGreaterThan(0);
    expect(p.v.approvals).toEqual([]);
    expect(s.v.balances).toEqual([]);
    expect(s.v.acks.length).toBeGreaterThan(0);
  });

  it('обзор исключений доступен руководителю и закрыт партнёру', async () => {
    const [m] = await t.as<{ m: { items: { key: string }[] } }>('founder@demo.example.com', `select public.metrics_overview() as m`);
    expect(m.m.items.map((i) => i.key)).toContain('overdue_debt');
    await t.expectError(ALPHA, `select public.metrics_overview()`, 'forbidden');
  });
});
