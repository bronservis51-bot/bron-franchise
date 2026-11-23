// Восстановление из резервной копии: те же данные, долги по роялти и права в новой установке.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { createDb, demoUsers } from '../../scripts/db-lib.mjs';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { exportData, restoreData } from '../../scripts/backup-lib.mjs';

describe('резервная копия и восстановление', () => {
  it('экспорт → новая установка с другими id пользователей → те же данные, долги и права', async () => {
    const src = await createDb();
    const seedRecovery = async (db: typeof src) => {
      await db.exec(`insert into app_private.manager_recovery_account(user_id,email,enabled,reset_enabled,verified_at)
        select id,'manager-recovery@example.invalid',true,true,now() from auth.users where email='fm@demo.example.com';
        insert into app_private.manager_recovery_job(user_id,kind,state_hash,expires_at)
        select user_id,'reset',decode('00','hex'),now()+interval '15 minutes' from app_private.manager_recovery_account;`);
    };
    await seedRecovery(src);
    const product = '10000000-0000-0000-0000-000000000081';
    const store = '10000000-0000-0000-0000-000000000082';
    const operation = '10000000-0000-0000-0000-000000000083';
    const cart = JSON.stringify([{ product_id: product, quantity: 20 }]);
    await src.query('select app_private.procurement_catalog_store($1::jsonb,$2::uuid,now())', [JSON.stringify([{
      product_id: product, name: 'Плёнка для проверки восстановления', code: 'BACKUP-TEST', uom: 'Лист', category: 'Тест',
      image_url: null, stock: 10, reserve: 2, unallocated_reserve: 0, in_transit: 0,
      confirmed_incoming_qty: 0, confirmed_eta: null, purchase_order_id: null,
    }]), store]);
    const submit = async (db: typeof src, op: string) => {
      const user = (await db.query(`select id from public.app_user where email='alpha.owner@demo.example.com'`)).rows[0].id;
      return db.transaction(async (tx: typeof src) => {
        await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
        await tx.exec('set local role authenticated');
        return (await tx.query(`select public.procurement_submit($1::uuid,$2::jsonb,'together','Проверка копии') as request`, [op, cart])).rows[0].request;
      });
    };
    const request = await submit(src, operation);
    await src.query(`insert into app_private.procurement_incoming(product_id,purchase_order_id,quantity,eta,note,updated_by)
      select $1,$2,12,current_date+1,'Проверка восстановления подтверждённой поставки',id from public.app_user where email='fm@demo.example.com'`,
    [product, '10000000-0000-0000-0000-000000000085']);
    await src.query(`insert into app_private.learning_config(article_id,revision_id,questions)
      select id,published_revision_id,'[{"prompt":"Проверка копии?","choices":["Да","Нет"],"correct":0}]'::jsonb
      from article where status='published' limit 1`);
    await src.query(`insert into app_private.revenue_day_off(location_id,day,marked_by)
      select l.id, app_private.local_today(l.id)-1, u.id from public.location l, public.app_user u
      where l.code='ALPHA-1' and u.email='alpha.owner@demo.example.com'`);
    await src.query(`insert into app_private.partner_launch_task(partner_id,task,completed_by)
      select p.id,'island_brief',u.id from public.partner p, public.app_user u
      where p.code='ALPHA' and u.email='alpha.owner@demo.example.com'`);
    const leadId = '10000000-0000-0000-0000-000000000086';
    await src.query(`insert into public.franchise_lead(id,name,phone,phone_digits,contact_via,city,score,tier,status,deleted_at,note,partner_id)
      select $1,'Проверка связи','+70000000086','70000000086','call','Мурманск',0,'cold','won',now()-interval '1 day','История',id
      from public.partner where code='ALPHA'`, [leadId]);
    await src.query(`insert into app_private.lead_recontact(lead_id,received_at,name,phone,city,contact_via)
      values($1,now(),'Повторное обращение','+70000000086','Мурманск','telegram')`, [leadId]);
    await src.exec(`update public.location set closed_days='{[2026-03-02,2026-03-05)}' where code='ALPHA-1';
      insert into app_private.motivation_scheme(partner_id,policy)
      select id,app_private.motivation_default(currency) from public.partner where code='ALPHA';
      insert into app_private.team_pay_version(partner_id,effective_from,policy)
      select partner_id,effective_from,policy from app_private.motivation_scheme cross join (values ('-infinity'::date),(current_date+30)) dates(effective_from);
      insert into app_private.employee_pay_version(employee_id,effective_from,terms)
      select user_id,current_date+30,app_private.employee_pay_fields(s) from public.staff_member s limit 1;
      insert into app_private.employee_daily_exit(employee_id,day,location_id)
      select user_id,date '2020-01-01',location_ids[1] from public.staff_member limit 1;`);
    const payState = async (db: typeof src) => (await db.query(`select jsonb_build_object(
      'team',(select jsonb_agg(to_jsonb(v) order by partner_id,effective_from) from app_private.team_pay_version v),
      'employee',(select jsonb_agg(to_jsonb(v)-'employee_id'||jsonb_build_object('email',u.email) order by u.email,effective_from)
        from app_private.employee_pay_version v join public.app_user u on u.id=v.employee_id),
      'exits',(select jsonb_agg(to_jsonb(v)-'employee_id'||jsonb_build_object('email',u.email) order by u.email,day)
        from app_private.employee_daily_exit v join public.app_user u on u.id=v.employee_id)) as facts`)).rows[0].facts;
    const dump = await exportData(src);
    // Older private-table backups must receive defaults for columns added later.
    for (const key of ['for_trainees','for_franchisees','stage','position','pass_percent','quiz_size']) delete dump.private_tables.learning_config[0][key];
    expect(dump.tables.daily_revenue.length).toBeGreaterThan(0);
    expect(dump.private_tables.procurement_catalog).toHaveLength(1);
    expect(dump.private_tables.procurement_request).toHaveLength(1);
    expect(dump.private_tables.procurement_event).toHaveLength(1);
    expect(dump.private_tables.procurement_incoming).toHaveLength(1);
    expect(dump.private_tables.revenue_day_off).toHaveLength(1);
    expect(dump.private_tables.partner_launch_task).toHaveLength(1);
    expect(dump.private_tables.lead_recontact).toHaveLength(1);
    expect(dump.private_tables.team_pay_version).toHaveLength(2);
    expect(dump.private_tables.employee_pay_version.length).toBeGreaterThan(1);
    expect(dump.private_tables.employee_daily_exit.length).toBeGreaterThan(1);
    expect(dump.private_tables).not.toHaveProperty('manager_recovery_account');
    expect(dump.private_tables).not.toHaveProperty('manager_recovery_job');

    // Новая установка: только миграции, пользователи созданы заново (новые id)
    const dst = await createDb({ seed: false });
    for (const u of demoUsers) {
      await dst.query(`insert into auth.users(email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}')`, [u.email, JSON.stringify({ full_name: u.name })]);
    }
    await seedRecovery(dst);
    await expect(restoreData(dst, dump)).rejects.toThrow(/confirm-wipe/);
    await restoreData(dst, dump, { wipe: true });
    expect((await dst.query('select id from app_private.manager_recovery_job')).rows).toEqual([]);
    expect((await dst.query('select enabled,reset_enabled,verified_at from app_private.manager_recovery_account')).rows)
      .toEqual([{ enabled: false, reset_enabled: false, verified_at: null }]);

    const restoredLesson=(await dst.query('select questions,for_trainees,pass_percent from app_private.learning_config')).rows[0];
    expect(restoredLesson.questions).toHaveLength(1);expect(restoredLesson.for_trainees).toBe(false);expect(restoredLesson.pass_percent).toBe(80);
    const restored = (await dst.query(`select id, number, created_by, items from app_private.procurement_request`)).rows[0];
    const restoredOwner = (await dst.query(`select id from public.app_user where email='alpha.owner@demo.example.com'`)).rows[0].id;
    const restoredDayOff = (await dst.query(`select to_jsonb(d) as day_off from app_private.revenue_day_off d`)).rows[0].day_off;
    expect(restoredDayOff).toEqual({ ...dump.private_tables.revenue_day_off[0], marked_by: restoredOwner });
    const restoredLaunchTask = (await dst.query('select to_jsonb(t) as task from app_private.partner_launch_task t')).rows[0].task;
    expect(restoredLaunchTask).toEqual({ ...dump.private_tables.partner_launch_task[0], completed_by: restoredOwner });
    expect((await dst.query('select app_private.lead_json($1) as lead', [leadId])).rows[0].lead).toMatchObject({
      partner_id: dump.tables.franchise_lead[0].partner_id, note: 'История', pending_recontact: true,
      last_recontact: { name: 'Повторное обращение', contact_via: 'telegram' },
    });
    expect((await dst.query(`select closed_days::text days from public.location where code='ALPHA-1'`)).rows[0].days).toBe('{[2026-03-02,2026-03-05)}');
    expect(await payState(dst)).toEqual(await payState(src));
    expect(restored.id).toBe(request.id);
    expect(restored.items).toEqual(request.items);
    expect(restored.created_by).toBe(restoredOwner);
    expect(restored.created_by).not.toBe(dump.private_tables.procurement_request[0].created_by);
    expect((await dst.query(`select actor_id from app_private.procurement_event`)).rows[0].actor_id).toBe(restoredOwner);
    const restoredManager = (await dst.query(`select id from public.app_user where email='fm@demo.example.com'`)).rows[0].id;
    expect((await dst.query(`select updated_by from app_private.procurement_incoming`)).rows[0].updated_by).toBe(restoredManager);
    // A retry after recovery uses the remapped receipt and must not create another order.
    expect(await submit(dst, operation)).toEqual(request);
    expect(Number((await dst.query(`select count(*) as n from app_private.procurement_request`)).rows[0].n)).toBe(1);
    // Private identity sequences must advance past the restored rows as well.
    const nextRequest = await submit(dst, '10000000-0000-0000-0000-000000000084');
    expect(Number(nextRequest.number)).toBeGreaterThan(Number(request.number));
    expect((await dst.query(`select id from app_private.procurement_event order by id`)).rows).toHaveLength(2);

    const count = async (db: typeof src, t: string) => Number((await db.query(`select count(*) as n from public.${t}`)).rows[0].n);
    for (const t of ['partner', 'location', 'daily_revenue', 'revenue_plan', 'royalty_payment', 'royalty_manual',
      'article', 'article_revision', 'acknowledgement', 'role_assignment', 'audit_event']) {
      expect(await count(dst, t), t).toBe(await count(src, t));
    }
    const debt = async (db: typeof src) => (await db.query(
      `select p.code, sum(g.debt_minor) as d from public.partner p cross join lateral app_private.royalty_ledger(p.id) g group by 1 order by 1`)).rows;
    expect(await debt(dst)).toEqual(await debt(src));
    expect(Number((await dst.query(`select count(*) as n from public.article where published_revision_id is null and status = 'published'`)).rows[0].n)).toBe(0);
    // права: франчайзи в новой установке видит только своё
    const owner = (await dst.query(`select id from public.app_user where email = 'alpha.owner@demo.example.com'`)).rows[0].id;
    await dst.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: owner })]);
    await dst.exec('set role authenticated');
    expect((await dst.query(`select distinct partner_id from public.daily_revenue`)).rows).toHaveLength(1);
    await dst.exec('reset role');

    const historical = structuredClone(dump);
    for (const name of ['team_pay_version','employee_pay_version','employee_daily_exit','lead_recontact']) delete historical.private_tables[name];
    for (const shift of historical.tables.work_shift) delete shift.counts_as_exit;
    await restoreData(dst, historical, { wipe: true });
    expect((await dst.query(`select effective_from::text,policy from app_private.team_pay_version`)).rows)
      .toEqual([{ effective_from: '-infinity', policy: historical.private_tables.motivation_scheme[0].policy }]);
    expect((await dst.query(`select count(*)::int n from public.staff_member s left join app_private.employee_pay_version v
      on v.employee_id=s.user_id and v.effective_from='-infinity' and v.terms=app_private.employee_pay_fields(s) where v.employee_id is null`)).rows[0].n).toBe(0);
    expect((await dst.query(`select employee_id,day::text,location_id from app_private.employee_daily_exit order by employee_id,day`)).rows)
      .toEqual((await dst.query(`select distinct on (employee_id,day) employee_id,day::text,location_id from public.work_shift
        where status='closed' order by employee_id,day,closed_at,opened_at,id`)).rows);
    expect((await dst.query('select * from app_private.lead_recontact')).rows).toEqual([]);
    await src.close();
    await dst.close();
  }, 240_000);
});
