// CRM: воронка франчайзи — следующий шаг, касания, дубли, отказ с причиной, «Партнёр» создаёт франчайзи и проект открытия.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
const FM = 'fm@demo.example.com';
beforeAll(async () => { t = await createTestDb(); }, 180_000);

describe('CRM', () => {
  it('новый лид сразу получает следующий шаг; дубль по телефону не создаётся', async () => {
    const [c] = await t.as<{ id: string; next_action: string; next_action_at: string; stage: string; owner_id: string }>(FM,
      `select * from public.crm_lead_create('Пётр', '+7 (999) 111-22-33', 'Тула', 'RU', 'site', 'С сайта', null, null)`);
    expect(c.stage).toBe('new');
    expect(c.next_action).toBeTruthy();
    expect(c.owner_id).toBe(await t.userId(FM));
    await t.expectError(FM, `select * from public.crm_lead_create('Пётр 2', '8 999 111 22 33', null, null, null, null, null, null)`, 'validation');
    await t.expectError('founder@demo.example.com', `select * from public.crm_lead_create('X', '+7 900 000 00 01', null, null, null, null, null, null)`, 'forbidden');
    await t.expectError('alpha.owner@demo.example.com', `select * from public.crm_lead_create('X', '+7 900 000 00 01', null, null, null, null, null, null)`, 'forbidden');
  });

  it('касание пишет историю, двигает «Новый» в «Связались» и ставит следующий шаг', async () => {
    const [{ id }] = await t.admin<{ id: string }>(`select id from public.crm_lead where name = 'Пётр'`);
    await t.expectError(FM, `select * from public.crm_touch($1, 'call', 'Поговорили', 'Встреча', null)`, 'validation', [id]);
    const [c] = await t.as<{ stage: string; next_action: string }>(FM, `select * from public.crm_touch($1, 'call', 'Поговорили, интересно', 'Встреча в офисе', now() + interval '2 days')`, [id]);
    expect(c.stage).toBe('contacted');
    expect(c.next_action).toBe('Встреча в офисе');
    const acts = await t.as<{ kind: string }>(FM, `select kind from public.crm_activity where lead_id = $1 order by at`, [id]);
    expect(acts.map((a) => a.kind)).toEqual(['created', 'call']);
    const [r] = await t.as<{ v: { crm: { due: unknown[] } } }>(FM, `select public.today() as v`);
    expect(r.v.crm.due.length).toBeGreaterThan(0);
    expect((await t.as('founder@demo.example.com', `select 1 from public.crm_lead where id = $1`, [id])).length).toBe(1);
    expect((await t.as('alpha.owner@demo.example.com', `select 1 from public.crm_lead`)).length).toBe(0);
  });

  it('отказ — только с причиной; «Партнёр» создаёт франчайзи и проект открытия', async () => {
    const [{ id }] = await t.admin<{ id: string }>(`select id from public.crm_lead where name = 'Пётр'`);
    await t.expectError(FM, `select public.crm_set_stage($1, 'lost', '', null)`, 'validation', [id]);
    await t.expectError(FM, `select public.crm_set_stage($1, 'won', null, null)`, 'validation', [id]);
    const [w] = await t.as<{ r: { partner_id: string; opening_id: string } }>(FM, `select public.crm_set_stage($1, 'won', null, current_date + 60) as r`, [id]);
    expect(w.r.partner_id).toBeTruthy();
    expect(w.r.opening_id).toBeTruthy();
    const [p] = await t.admin<{ status: string; contact_phone: string }>(`select status, contact_phone from public.partner where id = $1`, [w.r.partner_id]);
    expect(p.status).toBe('prospect');
    await t.expectError(FM, `select public.crm_set_stage($1, 'lost', 'передумал', null)`, 'transition-not-allowed', [id]);
  });
});
