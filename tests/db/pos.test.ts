// CRM продаж на точке: запись продажи с клиентом, повтор по ключу, клиент по телефону, гарантия, видимость базы клиентов.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
let alpha1: string, gamma: string;
const DINA = 'alpha.staff@demo.example.com';
const sale = `select public.pos_sale_create($1, $2, $3, $4::jsonb, $5, $6, null, $7) as r`;
beforeAll(async () => {
  t = await createTestDb();
  alpha1 = (await t.admin<{ id: string }>(`select id from public.location where code = 'ALPHA-1'`))[0].id;
  gamma = (await t.admin<{ id: string }>(`select id from public.location where code = 'GAMMA-1'`))[0].id;
}, 180_000);

describe('продажи на точке', () => {
  it('продажа с телефоном создаёт клиента, считает сумму и гарантию; повтор не задваивает', async () => {
    const lines = JSON.stringify([{ service: 'back', device: 'iPhone 15', price_minor: 99000 }, { service: 'camera', price_minor: 39000 }]);
    const [a] = await t.as<{ r: { sale: { id: string; total_minor: number; card_minor: number; warranty_until: string }; client: { visits: number } } }>(
      DINA, sale, [alpha1, '+7 999 000-11-22', 'Олег', lines, 'card', null, 'k1']);
    expect(Number(a.r.sale.total_minor)).toBe(138000);
    expect(Number(a.r.sale.card_minor)).toBe(138000);
    expect(a.r.sale.warranty_until).toBeTruthy();
    expect(a.r.client.visits).toBe(1);
    const [b] = await t.as<{ r: { replayed: boolean } }>(DINA, sale, [alpha1, '+7 999 000-11-22', 'Олег', lines, 'card', null, 'k1']);
    expect(b.r.replayed).toBe(true);
    const [c] = await t.as<{ r: { client: { visits: number; id: string } } }>(DINA, sale, [alpha1, '8 (999) 000 11 22', null, JSON.stringify([{ service: 'screen', price_minor: 79000 }]), 'mixed', 30000, 'k2']);
    expect(c.r.client.visits).toBe(2);
    const [card] = await t.as<{ v: { sales: unknown[]; name: string } }>(DINA, `select public.pos_client_card($1) as v`, [c.r.client.id]);
    expect(card.v.sales.length).toBe(2);
    expect(card.v.name).toBe('Олег');
    await t.expectError(DINA, sale, 'validation', [alpha1, null, null, '[]', 'cash', null, 'k3']);
    await t.expectError(DINA, sale, 'validation', [alpha1, null, null, JSON.stringify([{ service: 'back', price_minor: 1000 }]), 'mixed', 5000, 'k4']);
  });

  it('база клиентов — только своей сети; компания видит продажи без телефонов', async () => {
    const found = await t.as<{ v: { phone: string }[] }>(DINA, `select public.pos_client_search($1, '000 11') as v`, [alpha1]);
    expect(found[0].v.length).toBe(1);
    await t.expectError('gamma.owner@demo.example.com', `select public.pos_client_search($1, '')`, 'forbidden', [alpha1]);
    await t.expectError('founder@demo.example.com', `select public.pos_client_search($1, '')`, 'forbidden', [alpha1]);
    const [d] = await t.as<{ v: { sales: { client_phone: string | null }[] } }>('founder@demo.example.com', `select public.pos_day($1, null::date) as v`, [alpha1]);
    expect(d.v.sales.length).toBeGreaterThan(0);
    expect(d.v.sales.every((s) => s.client_phone === null)).toBe(true);
    expect((await t.as('founder@demo.example.com', `select 1 from public.pos_client`)).length).toBe(0);
    await t.expectError(DINA, sale, 'not-found', [gamma, null, null, JSON.stringify([{ service: 'back', price_minor: 1000 }]), 'cash', null, 'k5']);
  });

  it('возврат: в тот же день — сам сотрудник; клиенты «вернуть» — давно не были', async () => {
    const [d] = await t.as<{ v: { sales: { id: string }[] } }>(DINA, `select public.pos_day($1, null::date) as v`, [alpha1]);
    await t.expectError(DINA, `select * from public.pos_sale_return($1, '')`, 'validation', [d.v.sales[0].id]);
    const [r] = await t.as<{ status: string }>(DINA, `select * from public.pos_sale_return($1, 'Пузыри, переклеили бесплатно')`, [d.v.sales[0].id]);
    expect(r.status).toBe('returned');
    const [c] = await t.as<{ v: { long_ago: unknown[] } }>(DINA, `select public.pos_comeback($1) as v`, [alpha1]);
    expect(c.v.long_ago.length).toBeGreaterThan(0);
  });
});
