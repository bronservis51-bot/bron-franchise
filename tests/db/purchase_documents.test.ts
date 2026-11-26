import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTestDb, type TestDb } from './harness';
let t: TestDb;
const fm='fm@demo.example.com', owner='alpha.owner@demo.example.com', id='bbbb0000-0000-0000-0000-000000000001';
const month='2026-10-01';
const doc= { id, organization:id, kind:'demand', name:'Тест', day:month, counterparty:id, counterparty_name:'Тест', currency:'RUB', total_minor:100,
  lines:[{id, product_id:id, product:'Товар', quantity:1, price_minor:100,discount:0,vat:0,vat_included:false,amount_minor:100, cost_minor:60,cost_currency:'RUB'}] };
beforeAll(async()=>{t=await createTestDb();},180000);
afterAll(async()=>{await t.db.close();});
it('scopes purchases by effective date and strips private cost; replaces a rescinded snapshot',async()=>{
  const [alpha,beta]=await t.admin<{id:string}>("select id from partner where code in ('ALPHA','BETA') order by code");
  const store=(docs:unknown[],stamp:string)=>t.admin('select app_private.purchase_documents_store($1,$2,$3::jsonb)',[month,stamp,JSON.stringify(docs)]);
  const read=async()=> (await t.as<{j:{rows:object[]}}>(owner,'select public.purchase_documents_my($1,null) j',[month]))[0].j;
  await store([doc], '2026-11-01');
  expect((await read()).rows).toHaveLength(0);
  const map=(partner:string,day:string)=>t.as(fm,'select public.manager_purchase_mapping($1,$2,null,$3)',[id,partner,day]);
  await map(alpha.id,month);
  await map(beta.id,'2026-10-02');
  expect((await read()).rows).toHaveLength(1);
  expect((await read()).rows[0]).not.toHaveProperty('cost_minor');
  expect((await t.as<{j:{rows:object[]}}>(fm,'select public.manager_purchase_documents($1) j',[month]))[0].j.rows[0]).toHaveProperty('cost_minor','60');
  await t.expectError(owner,'select public.manager_purchase_documents($1)','forbidden',[month]);
  await expect(t.as(null,'select public.purchase_documents_my($1,null)',[month])).rejects.toThrow(/permission denied/);
  await store([], '2026-11-02');
  await store([doc], '2026-11-01');
  expect((await read()).rows).toHaveLength(0);
});

it('isolates supplier costs, shared partner purchases, point-specific data and revoked sessions (2.3, 6.3)',async()=>{
  const [alpha] = await t.admin<{id:string}>("select id from partner where code='ALPHA'");
  const points = await t.admin<{id:string}>('select id from location where partner_id=$1 order by id',[alpha.id]);
  const [foreign] = await t.admin<{id:string}>('select id from location where partner_id<>$1 limit 1',[alpha.id]);
  const cp='bbbb0000-0000-0000-0000-000000000002', day='2026-11-12', period='2026-11-01';
  const docs=[{...doc,day,counterparty:cp},{...doc,day,kind:'supply',currency:'TRY'},{...doc,day,id:cp}];
  const store=(rows:unknown[])=>t.admin('select app_private.purchase_documents_store($1,$2,$3::jsonb)',[period,'2026-11-25',JSON.stringify(rows)]);
  await store(docs);
  await t.as(fm,'select public.manager_purchase_mapping($1,$2,$3,$4)',[cp,alpha.id,points[0].id,period]);
  await t.as(fm,'select public.manager_purchase_mapping($1,$2,null,$3)',[id,alpha.id,period]);
  const read=async(location:string|null)=>(await t.as<{j:{rows:object[]}}>(owner,'select public.purchase_documents_my($1,$2) j',[period,location]))[0].j;
  expect((await read(null)).rows).toHaveLength(2);
  expect((await read(points[0].id)).rows).toHaveLength(1);
  await t.expectError(owner,'select public.purchase_documents_my($1,$2)','not-found',[period,foreign.id]);
  await expect(t.as(owner,'select * from app_private.procurement_document_position')).rejects.toThrow(/permission denied/);
  await expect(t.as(owner,'select public.manager_purchase_mapping($1,$2,null,$3)',[id,alpha.id,period])).rejects.toThrow('forbidden');
  const user=await t.userId(owner);
  await expect(t.db.transaction(async tx=>{
    await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role:'authenticated',session_id:id})]);
    await tx.exec('set local role authenticated');
    await tx.query('select public.purchase_documents_my($1,null)',[period]);
  })).rejects.toThrow();
  await expect(t.admin('select app_private.purchase_documents_store($1,$2,$3::jsonb)',[period,'2026-11-26',
    JSON.stringify([{...doc,day,total_minor:0}])])).rejects.toThrow('Document total mismatch');
  expect((await read(null)).rows).toHaveLength(2);
});

it('requires an unambiguous active franchisee assignment',async()=>{
  await t.admin("insert into public.role_assignment(user_id,role,scope_type,scope_id) select $1,'franchisee','partner',id from partner where code='BETA'",[await t.userId(owner)]);
  await t.expectError(owner,'select public.purchase_documents_my($1,null)','validation',[month]);
});
