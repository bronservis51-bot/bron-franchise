import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const MANAGER = 'fm@demo.example.com';
const OWNER = 'alpha.owner@demo.example.com';
let t: TestDb;
let partner: string;

beforeAll(async () => {
  t = await createTestDb();
  partner = (await t.admin<{ id: string }>("select id from public.partner where code='ALPHA'"))[0].id;
}, 180_000);
afterAll(async () => { await t?.db.close(); });

async function save(stage: string | null, name = 'Франчайзи для проверки подготовки', who = MANAGER) {
  return t.as(who, `select public.partner_save_preparation($1,$2,'RU',null,null,null,'active',$3)`, [partner, name, stage]);
}
async function state() {
  return (await t.admin<{ name: string; status: string; preparation_stage: string | null }>(
    'select name,status,preparation_stage from public.partner where id=$1', [partner]))[0];
}

describe('подготовка франчайзи без изменения операционного статуса', () => {
  it('существующие карточки остаются без придуманного этапа; этап можно менять в любом порядке', async () => {
    expect((await state()).preparation_stage).toBeNull();
    for (const stage of ['opening_preparation', 'contract_signed', 'location_search', null]) {
      await save(stage);
      expect(await state()).toMatchObject({ status: 'active', preparation_stage: stage });
    }
    const changes = await t.admin<{ diff: { before: string | null; after: string | null } }>(
      "select diff from public.audit_event where action='partner.preparation_change' and entity_id=$1 order by at,id", [partner]);
    expect(changes).toHaveLength(4);
    expect(changes.map(row => row.diff.after)).toEqual(['opening_preparation', 'contract_signed', 'location_search', null]);
  });

  it('недопустимый этап не меняет даже основные данные; обычный франчайзи не назначает этап', async () => {
    const before = await state();
    await expect(save('invented_stage', 'Неверная новая запись')).rejects.toThrow('validation');
    expect(await state()).toEqual(before);
    await expect(save('contract_signed', 'Чужая правка', OWNER)).rejects.toThrow('forbidden');
    expect(await state()).toEqual(before);
    await expect(t.as(null, `select public.partner_save_preparation($1,'Аноним','RU',null,null,null,'active','contract_signed')`, [partner])).rejects.toThrow();
  });

  it('старый клиент сохраняет свой контракт и не стирает этап; приостановка остаётся отдельным статусом', async () => {
    await save('contract_signed');
    await t.as(MANAGER, `select public.partner_save($1,'Имя из старого клиента','RU',null,null,null,'suspended')`, [partner]);
    expect(await state()).toEqual({ name: 'Имя из старого клиента', status: 'suspended', preparation_stage: 'contract_signed' });
  });

  it('создание партнёра и этапа атомарно, без обязательной точки или линейного маршрута', async () => {
    const id = (await t.as<{ id: string }>(MANAGER,
      `select public.partner_save_preparation(null,'Подготовка нового партнёра','RU',null,null,null,'active','opening_preparation') id`))[0].id;
    const row = (await t.admin<{ preparation_stage: string; status: string }>(
      'select preparation_stage,status from public.partner where id=$1', [id]))[0];
    expect(row).toEqual({ preparation_stage: 'opening_preparation', status: 'active' });
    expect(await t.admin('select id from public.location where partner_id=$1', [id])).toHaveLength(0);
  });
});
