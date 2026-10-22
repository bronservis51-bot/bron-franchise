// Заказ материалов: менеджер задаёт ссылку МойСклад каждому франчайзи; франчайзи видит только свою.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM = 'fm@demo.example.com';
const VIKTOR = 'alpha.owner@demo.example.com';
const MARSEL = 'beta.owner@demo.example.com';
const DINA = '79000000011@staff.bron.local';

let t: TestDb;
const pid = async (code: string) => (await t.admin<{ id: string }>(`select id from public.partner where code = $1`, [code]))[0].id;
const one = async <T>(email: string, sql: string, params: unknown[] = []) => (await t.as<{ j: T }>(email, sql, params))[0].j;

beforeAll(async () => { t = await createTestDb(); }, 180_000);

describe('ссылка для заказа материалов', () => {
  it('менеджер задаёт ссылку; франчайзи видит свою, у другого — своя или пусто', async () => {
    const url = 'https://online.moysklad.ru/public/abc123/catalog';
    await t.as(FM, `select public.partner_order_url_set($1, $2)`, [await pid('ALPHA'), `  ${url} `]);
    expect((await one<{ url: string | null }>(VIKTOR, `select public.order_link() j`)).url).toBe(url);
    expect((await one<{ url: string | null }>(MARSEL, `select public.order_link() j`)).url).toBeNull();
    // очистить
    await t.as(FM, `select public.partner_order_url_set($1, '')`, [await pid('ALPHA')]);
    expect((await one<{ url: string | null }>(VIKTOR, `select public.order_link() j`)).url).toBeNull();
  });

  it('только https-ссылка; франчайзи и сотрудник ссылку не меняют', async () => {
    const a = await pid('ALPHA');
    await t.expectError(FM, `select public.partner_order_url_set($1, 'moysklad.ru/x')`, 'validation', [a]);
    await t.expectError(FM, `select public.partner_order_url_set($1, 'javascript:alert(1)')`, 'validation', [a]);
    await t.expectError(FM, `select public.partner_order_url_set($1, 'https://a b')`, 'validation', [a]);
    await t.expectError(VIKTOR, `select public.partner_order_url_set($1, 'https://example.com')`, 'forbidden', [a]);
    await t.expectError(DINA, `select public.order_link()`, 'forbidden');
  });
});
