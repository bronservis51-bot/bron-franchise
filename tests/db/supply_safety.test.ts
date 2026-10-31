import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
const FM = 'fm@demo.example.com', OWNER = 'alpha.owner@demo.example.com';
const cp = 'a1000000-0000-0000-0000-000000000001';
const sample = [{ counterparty_id: cp, name: 'Поставки тест', sales_minor: 10000, cost_minor: 4000, profit_minor: 6000 }];
beforeAll(async () => { t = await createTestDb(); }, 180000);
afterAll(async () => { await t.db.close(); });

describe('private supply snapshot', () => {
  it('stores a complete snapshot and refuses duplicate or malformed rows atomically', async () => {
    await t.admin('select app_private.supply_store($1,$2::jsonb,$3,$4)', ['2026-10-01', JSON.stringify(sample), '2026-10-31T10:00:00Z', '2026-10-31 23:59:59']);
    await expect(t.admin('select app_private.supply_store($1,$2::jsonb,$3,$4)', ['2026-10-01', JSON.stringify([...sample, ...sample]), '2026-10-31T11:00:00Z', '2026-10-31 23:59:59'])).rejects.toThrow('Invalid or duplicate');
    const r = await t.admin<{n: number}>('select jsonb_array_length(rows) n from app_private.supply_snapshot');
    expect(r[0].n).toBe(1);
  });
  it('does not expose cost data to a franchisee, employee or anonymous API', async () => {
    await t.expectError(OWNER, "select public.manager_supply_snapshot('2026-10-01')", 'forbidden');
    await t.expectError('79000000011@staff.bron.local', "select public.manager_supply_snapshot('2026-10-01')", 'forbidden');
    await expect(t.as(null, "select public.manager_supply_snapshot('2026-10-01')")).rejects.toThrow(/permission denied/);
    await expect(t.as(OWNER, 'select * from app_private.supply_snapshot')).rejects.toThrow(/permission denied/);
  });
  it('keeps unmatched counterparties separate until the manager explicitly links them', async () => {
    const p = (await t.admin<{id: string}>("select id from public.partner where code='ALPHA'"))[0].id;
    const before = (await t.as<{j: {unmapped: unknown[]}}>(FM, "select public.manager_supply_snapshot('2026-10-01') j"))[0].j;
    expect(before.unmapped).toHaveLength(1);
    await t.as(FM, 'select public.manager_supply_map($1,$2)', [cp,p]);
    const after = (await t.as<{j: {unmapped: unknown[]; rows: {partner_id: string; sales_minor: number}[]}}>(FM, "select public.manager_supply_snapshot('2026-10-01') j"))[0].j;
    expect(after.unmapped).toHaveLength(0);
    expect(after.rows.find(r => r.partner_id===p)?.sales_minor).toBe(10000);
  });
});

describe('durable write receipts', () => {
  it('a repeated royalty payment produces a single ledger entry, and rejects changed amounts', async () => {
    const p = (await t.admin<{id: string}>("select id from public.partner where code='ALPHA'"))[0].id;
    const args = {p_partner:p,p_month:'2026-10-01',p_amount:333,p_paid_on:'2026-10-31',p_note:'receipt test'};
    const op = 'a1000000-0000-0000-0000-000000000002';
    const write = () => t.as<{id:string}>(FM, "select public.financial_operation('royalty_payment_add',$1::jsonb,$2) id",[JSON.stringify(args),op]);
    expect(await write()).toEqual(await write());
    expect((await t.admin<{n:number}>("select count(*)::int n from public.royalty_payment where note='receipt test'"))[0].n).toBe(1);
    await t.expectError(FM, "select public.financial_operation('royalty_payment_add',$1::jsonb,$2)", 'idempotency-conflict',[JSON.stringify({...args,p_amount:444}),op]);
  });
  it('stale revenue cannot overwrite an edit, while replay of the same operation succeeds', async () => {
    const loc = (await t.admin<{id:string}>("select l.id from public.location l join public.partner p on p.id=l.partner_id where p.code='ALPHA' and l.status='active' limit 1"))[0].id;
    const row = (await t.as<{j:{entries:{employee_id:string|null;revision:number}[]}}>(OWNER, 'select public.revenue_month($1,current_date) j',[loc]))[0].j;
    expect(row).toBeTruthy();
    const current = (await t.admin<{revision:number}>('select revision from public.daily_revenue where location_id=$1 and day=current_date and employee_id is null',[loc]))[0];
    const op = 'a1000000-0000-0000-0000-000000000003';
    const args=[loc,current?.revision??-1,op];
    const sql="select public.revenue_save_checked($1,current_date,12345,0,$2,$3,'receipt revenue',null) j";
    const first=await t.as(OWNER,sql,args);
    expect(await t.as(OWNER,sql,args)).toEqual(first);
    await t.expectError(OWNER,sql,'version-conflict',[loc,current?.revision??-1,'a1000000-0000-0000-0000-000000000004']);
    expect((await t.admin<{cash_minor:number}>('select cash_minor from public.daily_revenue where location_id=$1 and day=current_date and employee_id is null',[loc]))[0].cash_minor).toBe(12345);
  });
});
