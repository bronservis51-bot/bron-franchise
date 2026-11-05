import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
// @ts-expect-error — общий модуль JS
import { createDb } from '../../scripts/db-lib.mjs';
// @ts-expect-error — общий модуль JS
import { readSourceLeads, reconcileLateLeads } from '../../scripts/late-leads-lib.mjs';

let source: PGlite, target: PGlite;
const submit = async (db: PGlite, phone = '+79990000001') => {
  await db.query('select public.lead_submit($1::jsonb)', [JSON.stringify({
    name: 'Проверка переноса', phone, city: 'Тестовый город', contact_via: 'call', budget: 'full',
    timing: 'month', manage: 'self', experience: 'none', place: 'has', comment: 'Синтетические данные',
  })]);
};
const rows = async (db: PGlite) => (await db.query('select to_jsonb(l)::text as payload from public.franchise_lead l order by id')).rows;

beforeAll(async () => {
  source = await createDb({ seed: false });
  target = await createDb({ seed: false });
}, 240_000);
beforeEach(async () => {
  await source.exec('delete from public.franchise_lead');
  await target.exec('delete from public.franchise_lead');
});
afterAll(async () => { await source?.close(); await target?.close(); });

describe('заявки из старых открытых анкет после переноса', () => {
  it('по умолчанию ничего не записывает; перенос сохраняет UUID, ответы и микросекунды', async () => {
    await submit(source);
    await source.exec("update public.franchise_lead set created_at='2026-11-05 01:02:03.123456+00',updated_at='2026-11-05 01:02:03.123456+00'");
    const snapshot = await readSourceLeads(source);
    expect(await reconcileLateLeads(target, snapshot)).toMatchObject({ pending: 1, inserted: 0, mode: 'dry-run' });
    expect(await rows(target)).toEqual([]);
    expect(await reconcileLateLeads(target, snapshot, { apply: true })).toMatchObject({ inserted: 1 });
    expect(await rows(target)).toEqual(await rows(source));
    expect(await reconcileLateLeads(target, snapshot, { apply: true })).toMatchObject({ existing: 1, pending: 0, inserted: 0 });
  });

  it('не затирает статус, контакт и заметку менеджера на цели', async () => {
    await submit(source);
    await reconcileLateLeads(target, await readSourceLeads(source), { apply: true });
    await target.exec("update public.franchise_lead set status='in_work',note='Встреча согласована',name='Уточнённый контакт',pipeline_column='111',updated_at=clock_timestamp()");
    const edited = await rows(target);
    await reconcileLateLeads(target, await readSourceLeads(source), { apply: true });
    expect(await rows(target)).toEqual(edited);
  });

  it('не объединяет разные UUID по телефону и не мешает новым заявкам целевого сайта', async () => {
    await submit(source);
    await submit(target);
    expect(await reconcileLateLeads(target, await readSourceLeads(source), { apply: true })).toMatchObject({ inserted: 1 });
    expect(await rows(target)).toHaveLength(2);
  });

  it('отказывается от всей партии при незавершённой ручной работе на источнике', async () => {
    await submit(source);
    await submit(source, '+79990000002');
    await source.exec("update public.franchise_lead set status='call_back',note='Позвонить' where phone='+79990000002'");
    await expect(reconcileLateLeads(target, await readSourceLeads(source), { apply: true })).rejects.toThrow('source-lead-needs-review');
    expect(await rows(target)).toEqual([]);
  });

  it('откатывает всю партию при ошибке второй записи, затем допускает повтор', async () => {
    await submit(source);
    await submit(source, '+79990000002');
    await target.exec("alter table public.franchise_lead add constraint simulated_failure check(phone<>'+79990000002')");
    try {
      await expect(reconcileLateLeads(target, await readSourceLeads(source), { apply: true })).rejects.toThrow();
      expect(await rows(target)).toEqual([]);
    } finally { await target.exec('alter table public.franchise_lead drop constraint simulated_failure'); }
    expect(await reconcileLateLeads(target, await readSourceLeads(source), { apply: true })).toMatchObject({ inserted: 2 });
  });

  it('не пишет в неполную или отличающуюся схему', async () => {
    await submit(source);
    await target.exec('alter table public.franchise_lead add column unexpected text');
    try {
      await expect(reconcileLateLeads(target, await readSourceLeads(source), { apply: true })).rejects.toThrow('lead-schema-mismatch');
      expect(await rows(target)).toEqual([]);
    } finally { await target.exec('alter table public.franchise_lead drop column unexpected'); }
  });
});
