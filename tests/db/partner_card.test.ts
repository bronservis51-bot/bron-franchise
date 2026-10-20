// Карточка франчайзи у менеджера: данные, договор, документы; франчайзи их не видит.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM = 'fm@demo.example.com';
const VIKTOR = 'alpha.owner@demo.example.com';

let t: TestDb;
let alpha: string;
const one = async <T>(email: string, sql: string, params: unknown[] = []) => (await t.as<{ j: T }>(email, sql, params))[0].j;

beforeAll(async () => {
  t = await createTestDb();
  alpha = (await t.admin<{ id: string }>(`select id from public.partner where code = 'ALPHA'`))[0].id;
}, 180_000);

describe('карточка франчайзи', () => {
  it('менеджер заполняет карточку; пустое поле очищает значение; неизвестное поле и плохая дата — ошибка', async () => {
    await t.as(FM, `select public.partner_profile_save($1, $2::jsonb)`, [alpha, JSON.stringify({
      owner_name: 'Виктор Иванов', telegram: '@viktor', legal_form: 'ИП', inn: '344400000000',
      contract_number: 'Ф-12', contract_date: '2025-03-01', contract_until: '2030-03-01', franchise_fee_minor: '45000000', notes: 'Хочет вторую точку',
    })]);
    let c = await one<{ profile: Record<string, unknown>; locations: unknown[]; stats: { opened_on: string; rate_bp: number } }>(FM, `select public.partner_card($1) j`, [alpha]);
    expect(c.profile.contract_number).toBe('Ф-12');
    expect(Number(c.profile.franchise_fee_minor)).toBe(45000000);
    expect(c.locations.length).toBeGreaterThan(0);
    expect(c.stats.opened_on).toBeTruthy();
    await t.as(FM, `select public.partner_profile_save($1, $2::jsonb)`, [alpha, JSON.stringify({ telegram: '' })]);
    c = await one(FM, `select public.partner_card($1) j`, [alpha]);
    expect(c.profile.telegram).toBeNull();
    expect(c.profile.inn).toBe('344400000000');
    await t.expectError(FM, `select public.partner_profile_save($1, '{"salary": "1"}'::jsonb)`, 'validation', [alpha]);
    await t.expectError(FM, `select public.partner_profile_save($1, '{"contract_date": "вчера"}'::jsonb)`, 'validation', [alpha]);
    await t.expectError(FM, `select public.partner_profile_save($1, '{"contract_date": "2026-01-01", "contract_until": "2025-01-01"}'::jsonb)`, 'validation', [alpha]);
  });

  it('документы: только в папке франчайзи; франчайзи карточку и документы не видит', async () => {
    const path = `partner/${alpha}/dogovor.pdf`;
    const docId = await one<string>(FM, `select public.partner_document_add($1, 'contract', 'Договор франшизы', $2, 1000, 'application/pdf', '2025-03-01') j`, [alpha, path]);
    await t.expectError(FM, `select public.partner_document_add($1, 'contract', 'Чужой', 'partner/other/x.pdf', 1, 'application/pdf')`, 'validation', [alpha]);
    const c = await one<{ documents: { title: string }[] }>(FM, `select public.partner_card($1) j`, [alpha]);
    expect(c.documents.map((d) => d.title)).toEqual(['Договор франшизы']);
    await t.expectError(VIKTOR, `select public.partner_card($1)`, 'forbidden', [alpha]);
    await t.expectError(VIKTOR, `select public.partner_profile_save($1, '{}'::jsonb)`, 'forbidden', [alpha]);
    await t.expectError(VIKTOR, `select public.partner_document_delete($1)`, 'forbidden', [docId]);
    // таблицы карточки клиенту напрямую не читаются
    await expect(t.as(VIKTOR, `select * from public.partner_profile`)).rejects.toThrow();
    expect(await one<string>(FM, `select public.partner_document_delete($1) j`, [docId])).toBe(path);
  });

  it('файлы договоров в хранилище: менеджер загружает, франчайзи — нет', async () => {
    await t.as(FM, `insert into storage.objects(bucket_id, name, owner) values ('private-files', $1, auth.uid())`, [`partner/${alpha}/a.pdf`]);
    await expect(t.as(VIKTOR, `insert into storage.objects(bucket_id, name, owner) values ('private-files', $1, auth.uid())`, [`partner/${alpha}/b.pdf`])).rejects.toThrow();
    expect(await t.as(VIKTOR, `select name from storage.objects where name like 'partner/%'`)).toHaveLength(0);
    expect(await t.as(FM, `select name from storage.objects where name like 'partner/%'`)).toHaveLength(1);
  });
});
