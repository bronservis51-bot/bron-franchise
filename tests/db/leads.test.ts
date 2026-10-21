// Заявки на франшизу с сайта: анкета без входа, оценка, CRM менеджера; франчайзи и сотрудник заявки не видят.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM = 'fm@demo.example.com';
const VIKTOR = 'alpha.owner@demo.example.com';

let t: TestDb;
const lead = (over: Record<string, string> = {}) => JSON.stringify({
  name: 'Анна', phone: '+7 912 345-67-89', contact_via: 'whatsapp', city: 'Краснодар',
  budget: 'full', timing: 'month', manage: 'self', experience: 'business', place: 'has', comment: 'Есть место в ТЦ', ...over,
});
type Lead = { id: string; name: string; city: string; tier: string; score: number; status: string; note: string | null; phone_digits?: string };
const list = async () => (await t.as<{ j: Lead[] }>(FM, `select public.lead_list() j`))[0].j;

beforeAll(async () => { t = await createTestDb(); }, 180_000);

describe('заявки с сайта', () => {
  it('сайт без входа отправляет анкету; менеджер видит её горячей и без служебных полей', async () => {
    await t.as(null, `select public.lead_submit($1::jsonb)`, [lead()]);
    const [l] = await list();
    expect(l).toMatchObject({ name: 'Анна', city: 'Краснодар', tier: 'hot', status: 'new' });
    expect(l.phone_digits).toBeUndefined();
    expect((await t.as<{ n: number }>(FM, `select public.lead_inbox() n`))[0].n).toBe(1);
  });

  it('без бюджета заявка холодная; повтор того же телефона за 10 минут не дублируется', async () => {
    await t.as(null, `select public.lead_submit($1::jsonb)`, [lead({ name: 'Олег', phone: '89001112233', budget: 'none', timing: 'research' })]);
    await t.as(null, `select public.lead_submit($1::jsonb)`, [lead({ name: 'Олег', phone: '8 900 111-22-33', budget: 'none', timing: 'research' })]);
    const oleg = (await list()).filter((l) => l.name === 'Олег');
    expect(oleg).toHaveLength(1);
    expect(oleg[0].tier).toBe('cold');
  });

  it('ловушка для ботов молча отбрасывает заявку; неполная анкета — ошибка', async () => {
    const before = (await list()).length;
    await t.as(null, `select public.lead_submit($1::jsonb)`, [lead({ name: 'Бот', phone: '+70000000001', website: 'http://spam' })]);
    expect((await list()).length).toBe(before);
    await t.as(null, `select public.lead_submit($1::jsonb)`, [lead({ phone: '123' })]).then(() => { throw new Error('ожидалась ошибка'); }, (e: Error) => expect(e.message).toBe('validation'));
    await t.as(null, `select public.lead_submit($1::jsonb)`, [lead({ phone: '+79990001122', budget: 'много' })]).then(() => { throw new Error('ожидалась ошибка'); }, (e: Error) => expect(e.message).toBe('validation'));
  });

  it('менеджер меняет статус и заметку; франчайзи и гость заявки не читают и не меняют', async () => {
    const [l] = await list();
    await t.as(FM, `select public.lead_update($1, 'call_back', 'Перезвонить в пятницу')`, [l.id]);
    expect((await list()).find((x) => x.id === l.id)).toMatchObject({ status: 'call_back', note: 'Перезвонить в пятницу' });
    await t.expectError(FM, `select public.lead_update($1, 'потом', null)`, 'validation', [l.id]);
    await t.expectError(VIKTOR, `select public.lead_list()`, 'forbidden');
    await t.expectError(VIKTOR, `select public.lead_update($1, 'won', null)`, 'forbidden', [l.id]);
    expect((await t.as<{ n: number }>(VIKTOR, `select public.lead_inbox() n`))[0].n).toBe(0);
    await t.as(null, `select public.lead_list()`).then(() => { throw new Error('гость прочитал заявки'); }, (e: Error) => expect(e.message).toMatch(/permission denied/));
    await t.as(null, `select * from public.franchise_lead`).then(() => { throw new Error('гость прочитал таблицу'); }, (e: Error) => expect(e.message).toMatch(/permission denied/));
  });
});
