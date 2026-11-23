import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const manager = 'fm@demo.example.com';
const owner = 'alpha.owner@demo.example.com';
let t: TestDb;
beforeAll(async () => { t = await createTestDb(); }, 180_000);
afterAll(async () => t?.db.close());
const partnerSave = 'select public.partner_save_preparation_checked($1,$2,$3,$4,$5,$6,$7,$8,$9) id';
const locationSave = 'select public.location_save_checked($1,$2,$3,$4,$5,$6,$7,$8) id';
const make = async (name: string) => (await t.as<{id:string}>(manager,partnerSave,[null,name,'RU',null,null,null,'active','opening_preparation',null]))[0].id;
const stamp = async (table: 'partner' | 'location', id: string) => (await t.admin<{version:string}>(`select updated_at::text version from public.${table} where id=$1`,[id]))[0].version;

it('rejects a stale partner form before it can undo the stage or commercial status saved in another tab', async () => {
  const p = await make('Исходное имя');
  const initial = await stamp('partner',p);
  await t.as(manager,partnerSave,[p,'Исходное имя','RU',null,null,null,'terminated','location_search',initial]);
  await t.expectError(manager,partnerSave,'version-conflict',[p,'Новое имя','RU',null,null,null,'active','opening_preparation',initial]);
  expect(await t.admin('select name,status,preparation_stage from partner where id=$1',[p])).toEqual([
    {name:'Исходное имя',status:'terminated',preparation_stage:'location_search'},
  ]);
  await t.as(manager,partnerSave,[p,'Новое имя','RU',null,null,null,'terminated','location_search',await stamp('partner',p)]);
  await t.expectError(owner,partnerSave,'forbidden',[p,'Чужая попытка','RU',null,null,null,'active',null,await stamp('partner',p)]);
  await expect(t.as(null,partnerSave,[null,'Гость','RU',null,null,null,'active',null,null])).rejects.toThrow(/permission denied/);
});

it('rejects a stale or wrong-partner point form before it can undo the opening date or status', async () => {
  const p = await make('Проект с точкой');
  const other = await make('Другой проект');
  const [{id}] = await t.as<{id:string}>(manager,locationSave,[null,p,'Точка','Город',null,'active','2099-01-02',null]);
  const initial = await stamp('location',id);
  await t.as(manager,locationSave,[id,p,'Точка','Город',null,'closed','2099-01-03',initial]);
  await t.expectError(manager,locationSave,'version-conflict',[id,p,'Новое имя','Город',null,'active','2099-01-02',initial]);
  const latest = await stamp('location',id);
  await t.expectError(manager,locationSave,'not-found',[id,other,'Чужая точка','Город',null,'active','2099-01-02',latest]);
  expect(await t.admin('select name,status,opened_on::text from location where id=$1',[id])).toEqual([
    {name:'Точка',status:'closed',opened_on:'2099-01-03'},
  ]);
  await t.expectError(owner,locationSave,'forbidden',[id,p,'Чужая попытка','Город',null,'active',null,latest]);
});
