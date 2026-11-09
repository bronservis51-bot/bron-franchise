import {randomUUID} from 'node:crypto';
import {beforeAll,describe,expect,it} from 'vitest';
import {createTestDb,type TestDb} from './harness';
let t:TestDb;
const FM='fm@demo.example.com',PARTNER='alpha.owner@demo.example.com';
type Lead={id:string;name:string;status:string;note:string;updated_at:string;deleted_at:string|null};
const make=async()=> (await t.as<{j:Lead}>(FM,'select public.lead_save($1::jsonb,null,$2) j',[JSON.stringify({name:'Контакт для удаления',note:'Не терять историю',column:'lost'}),randomUUID()]))[0].j;
const set=async(l:Lead,deleted:boolean)=>(await t.as<{j:Lead}>(FM,'select public.lead_set_deleted($1,$2,$3) j',[l.id,deleted,l.updated_at]))[0].j;
const list=async(fn:string)=>(await t.as<{j:Lead[]}>(FM,`select public.${fn}() j`))[0].j;
beforeAll(async()=>{t=await createTestDb();},180_000);
describe('recoverable lead deletion',()=>{
 it('keeps rejected leads until explicit deletion, preserves original row and restores its stage',async()=>{
  const l=await make();expect((await list('lead_list')).some(x=>x.id===l.id)).toBe(true);
  const d=await set(l,true);expect(d.deleted_at).toBeTruthy();
  expect((await list('lead_list')).some(x=>x.id===l.id)).toBe(false);
  expect((await list('lead_trash_list')).find(x=>x.id===l.id)).toMatchObject({name:l.name,status:'lost',note:l.note});
  const restored=await set(d,false);expect(restored).toMatchObject({id:l.id,status:'lost',note:l.note,deleted_at:null});
  expect((await list('lead_list')).some(x=>x.id===l.id)).toBe(true);
 });
 it('retries safely but rejects stale deletion after edits and old restoration after a later deletion',async()=>{
  const l=await make(),d=await set(l,true);expect((await set(l,true)).updated_at).toBe(d.updated_at);
  const r=await set(d,false);
  await t.expectError(FM,'select public.lead_set_deleted($1,true,$2)','version-conflict',[r.id,l.updated_at]);
  const d2=await set(r,true);
  await t.expectError(FM,'select public.lead_set_deleted($1,false,$2)','version-conflict',[d2.id,d.updated_at]);
 });
 it('blocks old clients editing a removed row; removes new leads from the inbox only after explicit deletion',async()=>{
  const l=await make();await t.as(FM,"select public.lead_update($1,'new',null)",[l.id]);
  const current=(await list('lead_list')).find(x=>x.id===l.id)!;
  const before=(await t.as<{n:number}>(FM,'select public.lead_inbox() n'))[0].n;
  const d=await set(current,true);
  expect((await t.as<{n:number}>(FM,'select public.lead_inbox() n'))[0].n).toBe(before-1);
  await t.expectError(FM,"select public.lead_update($1,'won',null)",'transition-not-allowed',[l.id]);
  await t.expectError(FM,"select public.lead_move($1,'won',$2)",'transition-not-allowed',[d.id,d.updated_at]);
 });
 it('denies anonymous users, partner accounts and revoked sessions',async()=>{
  const l=await make();
  await t.expectError(PARTNER,'select public.lead_set_deleted($1,true,$2)','forbidden',[l.id,l.updated_at]);
  await t.expectError(PARTNER,'select public.lead_trash_list()','forbidden');
  await expect(t.as(null,'select public.lead_set_deleted($1,true,$2)',[l.id,l.updated_at])).rejects.toThrow(/permission denied/);
  await expect(t.as(null,'select public.lead_trash_list()')).rejects.toThrow(/permission denied/);
  const uid=await t.userId(FM);
  await expect(t.db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,role:'authenticated',session_id:randomUUID()})]);await tx.exec('set local role authenticated');await tx.query('select public.lead_set_deleted($1,true,$2)',[l.id,l.updated_at]);})).rejects.toThrow('unauthenticated');
  expect((await list('lead_list')).some(x=>x.id===l.id)).toBe(true);
 });
});
