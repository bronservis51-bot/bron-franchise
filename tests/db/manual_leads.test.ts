import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
let t: TestDb;
const FM = 'fm@demo.example.com', PARTNER = 'alpha.owner@demo.example.com';
type Row = { id: string; name: string; instagram: string; phone: string; city: string; status: string; note: string | null; pipeline_column: string | null; updated_at: string; budget: string | null; timing: string | null; place: string | null };
const create = async (data: Record<string,unknown>, operation = randomUUID()) => (await t.as<{j:Row}>(FM, 'select public.lead_save($1::jsonb,null,$2) j', [JSON.stringify(data),operation]))[0].j;
beforeAll(async () => { t = await createTestDb(); }, 180_000);
describe('minimal manual CRM', () => {
 it('creates a lead with only a handle; no fictional phone, city or qualification', async () => {
  const l = await create({ name:'@test.contact', instagram:'test.contact' });
  expect(l).toMatchObject({ name:'@test.contact',instagram:'test.contact',phone:'',city:'',status:'new',budget:null,timing:null,place:null,pipeline_column:'000' });
 });
 it('retries the same creation safely and rejects changed content or duplicate Instagram', async () => {
  const op=randomUUID(), data={name:'@repeat',instagram:'repeat'};
  expect((await create(data,op)).id).toBe((await create(data,op)).id);
  await t.expectError(FM,'select public.lead_save($1::jsonb,null,$2)','idempotency-conflict',[JSON.stringify({...data,name:'Different'}),op]);
  await t.expectError(FM,'select public.lead_save($1::jsonb,null,$2)','validation',[JSON.stringify(data),randomUUID()]);
 });
 it('moves to every qualification and work column, preserves notes, rejects stale versions', async () => {
  let l=await create({name:'Ручная заявка',note:'Сохранить заметку'});
  const old=l.updated_at;
  for(const column of ['111','100','010','001','011','110','101','000','in_work','call_back','meeting','won','lost','auto']) {
   l=(await t.as<{j:Row}>(FM,'select public.lead_move($1,$2,$3) j',[l.id,column,l.updated_at]))[0].j;
   expect(l.note).toBe('Сохранить заметку');
   expect(l.status).toBe(/^[01]{3}$/.test(column)||column==='auto'?'new':column);
   if(/^[01]{3}$/.test(column))expect(l.pipeline_column).toBe(column);
  }
  expect(l.pipeline_column).toBeNull();
  await t.expectError(FM,"select public.lead_move($1,'won',$2)",'version-conflict',[l.id,old]);
 });
 it('edits contact and note together with the stage and protects concurrent edits', async () => {
  const l=await create({name:'Анна'}), input={id:l.id,name:'Анна новая',note:'Созвон завтра',column:'in_work'};
  const changed=(await t.as<{j:Row}>(FM,'select public.lead_save($1::jsonb,$2,$3) j',[JSON.stringify(input),l.updated_at,randomUUID()]))[0].j;
  expect(changed).toMatchObject({name:'Анна новая',note:'Созвон завтра',status:'in_work'});
  await t.expectError(FM,'select public.lead_save($1::jsonb,$2,$3)','version-conflict',[JSON.stringify(input),l.updated_at,randomUUID()]);
 });
 it('denies partners, anonymous calls, revoked sessions and direct table reads', async () => {
  const l=await create({name:'Закрытая'});
  await t.expectError(PARTNER,"select public.lead_move($1,'won',$2)",'forbidden',[l.id,l.updated_at]);
  await t.expectError(PARTNER,'select public.lead_save($1::jsonb,null,$2)','forbidden',[JSON.stringify({name:'Чужая'}),randomUUID()]);
  await expect(t.as(null,'select public.lead_save($1::jsonb,null,$2)',[JSON.stringify({name:'Гость'}),randomUUID()])).rejects.toThrow(/permission denied/);
  await expect(t.as(PARTNER,'select * from public.franchise_lead')).rejects.toThrow(/permission denied/);
  const uid=await t.userId(FM);
  await expect(t.db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,role:'authenticated',session_id:randomUUID()})]);await tx.exec('set local role authenticated');await tx.query("select public.lead_move($1,'won',$2)",[l.id,l.updated_at]);})).rejects.toThrow('unauthenticated');
 });
});
