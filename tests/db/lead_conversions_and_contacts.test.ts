import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const manager = 'fm@demo.example.com';
const owner = 'alpha.owner@demo.example.com';
const submit = 'select public.lead_submit($1::jsonb) answer';
const link = 'select public.lead_link_partner($1,$2,$3,$4,$5) id';
const count = 'select public.lead_pending_recontacts() n';
const form = (phone: string, extra: Record<string, unknown> = {}) => ({
  name: 'Исходный контакт', city: 'Мурманск', phone, contact_via: 'telegram',
  budget: 'partial', timing: 'quarter', manage: 'self', experience: 'some', place: 'help',
  source: 'Synthetic QA', ...extra,
});
type Lead = {
  id: string; name: string; phone: string; city: string; status: string; note: string | null; updated_at: string;
  contact_via: string; partner_id: string | null; deleted_at: string | null; last_recontact_at: string | null; pending_recontact: boolean;
};
let t: TestDb;
beforeAll(async () => { t = await createTestDb(); }, 180_000);
afterAll(async () => t?.db.close());

const send = (phone: string, extra?: Record<string, unknown>) => t.as(null, submit, [JSON.stringify(form(phone, extra))]);
const leads = async (trash = false) => (await t.as<{ rows: Lead[] }>(manager, `select public.lead_${trash ? 'trash_' : ''}list() rows`))[0].rows;
const find = async (phone: string, trash = false) => (await leads(trash)).find(x => x.phone === phone)!;
const move = async (l: Lead, stage: string) => (await t.as<{ row: Lead }>(manager,
  'select public.lead_move($1,$2,$3) row', [l.id, stage, l.updated_at]))[0].row;
const remove = async (l: Lead, deleted: boolean) => (await t.as<{ row: Lead }>(manager,
  'select public.lead_set_deleted($1,$2,$3) row', [l.id, deleted, l.updated_at]))[0].row;

describe('lead phone and repeat contact', () => {
  it('recognizes Russian and Kazakh 8 prefixes and preserves explicitly international foreign numbers', async () => {
    for (const [international, trunk] of [['+7 912 444-72-01', '8 (912) 444-72-01'], ['+7 777 444-72-02', '8 777 444 7202']]) {
      expect(await send(international)).toEqual([{ answer: { ok: true } }]);
      expect(await send(trunk, { name: 'Повтор' })).toEqual([{ answer: { ok: true } }]);
      expect(await find(international)).toMatchObject({ name: 'Исходный контакт' });
      expect(await find(trunk)).toBeUndefined();
    }
    await send('+7 840 444-72-03');
    await send('+8 840 444-72-03');
    await send('+90 532 444-72-04');
    expect(await find('+8 840 444-72-03')).toBeDefined();
    expect(await find('+90 532 444-72-04')).toBeDefined();
    const padding = ' '.repeat(30);
    await send('+90 532' + padding + '4447205', { name: 'Первый длинный формат' });
    await send('+90 532' + padding + '4447206', { name: 'Второй длинный формат' });
    await send('+90 532 444-72-05', { name: 'Третий длинный формат' });
    expect((await leads()).filter(row => row.name.includes('длинный формат'))).toHaveLength(2);
  });

  it('keeps the archived original and its note, deduplicates repeat requests, then restores in place', async () => {
    const phone = '+7 912 444-72-10';
    await send(phone);
    const {id} = await find(phone);
    await t.as(manager, 'select public.lead_update($1,$2,$3)', [id, 'won', 'Исходная заметка']);
    const archived = await remove(await find(phone), true);
    await send('8 912 444 7210', { website: 'bot' });
    expect(await t.as(manager, count)).toEqual([{ n: 0 }]);
    await send('8 912 444 7210', { name: 'Имя в повторе', city: 'Другой город', contact_via: 'call' });
    await send(phone);
    const received = await find(phone, true);
    expect(received).toMatchObject({ id, status: 'won', note: 'Исходная заметка', name: archived.name, city: archived.city,
      contact_via: 'telegram', deleted_at: archived.deleted_at, updated_at: archived.updated_at, pending_recontact: true });
    expect(received.last_recontact_at).toBeTruthy();
    expect(await find(phone)).toBeUndefined();
    expect(await t.as(manager, count)).toEqual([{ n: 1 }]);
    expect(await t.admin('select count(*)::int n from app_private.lead_recontact where lead_id=$1', [id])).toEqual([{ n: 1 }]);
    expect(await remove(archived, false)).toMatchObject({ id, status: 'won', note: 'Исходная заметка', deleted_at: null,
      pending_recontact: false, last_recontact_at: received.last_recontact_at });
    expect(await t.as(manager, count)).toEqual([{ n: 0 }]);
    await t.expectError(owner, count, 'forbidden');
    await expect(t.as(null, count)).rejects.toThrow(/permission denied/);
  });
});

describe('explicit conversion of a won lead', () => {
  const data = { name: 'Франчайзи из заявки', country: 'RU', contact_name: 'Исходный контакт', contact_phone: '+7 912 444-72-20',
    contact_city: 'Мурманск', contact_instagram: 'synthetic.lead', preparation_stage: 'contract_signed' };
  it('creates one franchisee on repeat, retains applicant data, and rejects stale or unauthorized conversion', async () => {
    await send(data.contact_phone);
    const initial = await find(data.contact_phone);
    const params = [initial.id, null, JSON.stringify(data), initial.updated_at, randomUUID()];
    await t.expectError(manager, link, 'transition-not-allowed', params);
    const won = await move(initial, 'won');
    await t.expectError(manager, link, 'version-conflict', params);
    params[3] = won.updated_at;
    await t.expectError(owner, link, 'forbidden', params);
    await expect(t.as(null, link, params)).rejects.toThrow(/permission denied/);
    const [{ id }] = await t.as<{ id: string }>(manager, link, params);
    expect(await t.as(manager, link, params)).toEqual([{ id }]);
    await t.expectError(manager, link, 'idempotency-conflict', [initial.id, null, JSON.stringify({...data, contact_city:'Другой город'}), won.updated_at, params[4]]);
    await t.expectError(manager, link, 'transition-not-allowed', [...params.slice(0,4), randomUUID()]);
    expect(await find(data.contact_phone)).toMatchObject({ id: initial.id, partner_id: id, name: initial.name, city: initial.city,
      phone: initial.phone, contact_via: initial.contact_via, status: 'won' });
    expect(await t.admin('select id,name,contact_name,contact_phone,contact_city,contact_instagram,preparation_stage from public.partner where id=$1', [id]))
      .toEqual([{ id, name: data.name, contact_name: data.contact_name, contact_phone: data.contact_phone, contact_city: data.contact_city,
        contact_instagram: data.contact_instagram, preparation_stage: 'contract_signed' }]);
    expect(await t.admin('select id from public.location where partner_id=$1', [id])).toEqual([]);
  });

  it('explicitly links an existing franchisee without rewriting their fields or reclassifying an archived lead', async () => {
    const phone = '+7 912 444-72-21';
    await send(phone);
    const won = await move(await find(phone), 'won');
    const [{ id, name, contact_phone, preparation_stage }] = await t.admin<{id:string;name:string;contact_phone:string;preparation_stage:string}>(
      "select id,name,contact_phone,preparation_stage from public.partner where code='ALPHA'");
    const params = [won.id, id, null, won.updated_at, randomUUID()];
    const archived = await remove(won, true);
    await t.expectError(manager, link, 'transition-not-allowed', [won.id, id, null, archived.updated_at, randomUUID()]);
    const restored = await remove(archived, false);
    params[3] = restored.updated_at;
    expect(await t.as(manager, link, params)).toEqual([{ id }]);
    expect(await find(phone)).toMatchObject({ partner_id:id, phone });
    expect(await t.admin('select name,contact_phone,preparation_stage from public.partner where id=$1', [id])).toEqual([{name,contact_phone,preparation_stage}]);
  });
});
