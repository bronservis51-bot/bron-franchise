// Восстановление из резервной копии: те же данные, долги по роялти и права в новой установке.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { createDb, demoUsers } from '../../scripts/db-lib.mjs';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { exportData, restoreData } from '../../scripts/backup-lib.mjs';

describe('резервная копия и восстановление', () => {
  it('экспорт → новая установка с другими id пользователей → те же данные, долги и права', async () => {
    const src = await createDb();
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
    const dump = await exportData(src);
    expect(dump.tables.daily_revenue.length).toBeGreaterThan(0);
    expect(dump.private_tables.procurement_catalog).toHaveLength(1);
    expect(dump.private_tables.procurement_request).toHaveLength(1);
    expect(dump.private_tables.procurement_event).toHaveLength(1);
    expect(dump.private_tables.procurement_incoming).toHaveLength(1);

    // Новая установка: только миграции, пользователи созданы заново (новые id)
    const dst = await createDb({ seed: false });
    for (const u of demoUsers) {
      await dst.query(`insert into auth.users(email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}')`, [u.email, JSON.stringify({ full_name: u.name })]);
    }
    await expect(restoreData(dst, dump)).rejects.toThrow(/confirm-wipe/);
    await restoreData(dst, dump, { wipe: true });

    const restored = (await dst.query(`select id, number, created_by, items from app_private.procurement_request`)).rows[0];
    const restoredOwner = (await dst.query(`select id from public.app_user where email='alpha.owner@demo.example.com'`)).rows[0].id;
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
  }, 240_000);
});
