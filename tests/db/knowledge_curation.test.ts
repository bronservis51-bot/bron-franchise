import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
// @ts-expect-error — same reviewed SQL builder used for operational curation
import { knowledgeCurationSql } from '../../scripts/knowledge-curation.mjs';

let t: TestDb;
let section: string;
let user: string;
let serial = 0;
beforeAll(async () => {
  t = await createTestDb();
  section = (await t.admin<{ id: string }>(`insert into public.kb_section(slug,title) values ('curation-check','Проверка') returning id`))[0].id;
  user = await t.userId('fm@demo.example.com');
}, 180_000);
afterAll(async () => { await t?.db.close(); });

async function fixture(body = '') {
  const slug = `curation-article-${++serial}`;
  const a = (await t.admin<{ id: string; revision: number }>(`insert into public.article(slug,section_id) values ($1,$2) returning id,revision`, [slug, section]))[0];
  const d = (await t.admin<{ id: string; revision: number }>(`insert into public.article_revision(article_id,rev_no,title,body) values ($1,1,'Пустая заготовка',$2) returning id,revision`, [a.id, body]))[0];
  return {
    id: `curation-test-${serial}`, sections: [], articles: [{
      id: a.id, slug, title: 'Проверенный материал', summary: 'Есть источник', section: 'curation-check',
      status: 'published', body: 'Содержимое проверено', sources: ['https://example.invalid/verified'], reason: 'Проверка источника',
      expected_revision: a.revision, expected_draft: d,
    }],
  };
}

async function apply(plan: unknown) {
  try { await t.db.exec(knowledgeCurationSql(plan)); }
  catch (e) { await t.db.exec('rollback;'); throw e; }
}

describe('публикация проверенной пустой заготовки', () => {
  it('сохраняет UUID, историю, ознакомления и вопросы; повтор не создаёт редакции', async () => {
    const plan = await fixture('\n\t ');
    const a = plan.articles[0];
    await t.admin(`insert into public.acknowledgement(article_id,user_id,rev_no) values ($1,$2,1)`, [a.id, user]);
    await t.admin(`insert into public.kb_question(user_id,article_id,question) values ($1,$2,'Проверяем сохранение вопроса')`, [user, a.id]);
    await apply(plan);
    const rows = await t.admin<{ id: string; status: string; body: string; rev_no: number }>(`select id,status,body,rev_no from public.article_revision where article_id=$1 order by rev_no`, [a.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: a.expected_draft.id, status: 'superseded', body: '\n\t ', rev_no: 1 });
    expect(rows[1]).toMatchObject({ status: 'published', body: a.body, rev_no: 2 });
    expect((await t.admin<{ id: string; published_revision_id: string; revision: number }>(`select id,published_revision_id,revision from public.article where id=$1`, [a.id]))[0])
      .toEqual({ id: a.id, published_revision_id: rows[1].id, revision: a.expected_revision + 1 });
    await apply(plan);
    expect(await t.admin(`select id,status,body,rev_no from public.article_revision where article_id=$1 order by rev_no`, [a.id])).toEqual(rows);
    expect((await t.admin(`select 1 from public.acknowledgement where article_id=$1`, [a.id]))).toHaveLength(1);
    expect((await t.admin(`select 1 from public.kb_question where article_id=$1`, [a.id]))).toHaveLength(1);
  });

  it('отказывает при непустом, изменённом, исчезнувшем или неоднозначном черновике', async () => {
    for (const scenario of ['body', 'version', 'identity', 'missing', 'multiple', 'article'] as const) {
      const plan = await fixture();
      const a = plan.articles[0];
      if (scenario === 'body') await t.admin(`update public.article_revision set body='Автор начал работу' where id=$1`, [a.expected_draft.id]);
      if (scenario === 'version') await t.admin(`update public.article_revision set revision=revision+1 where id=$1`, [a.expected_draft.id]);
      if (scenario === 'identity') a.expected_draft.id = '00000000-0000-4000-8000-000000000001';
      if (scenario === 'missing') await t.admin(`update public.article_revision set status='superseded' where id=$1`, [a.expected_draft.id]);
      if (scenario === 'multiple') await t.admin(`insert into public.article_revision(article_id,rev_no,title,body) values ($1,2,'Ещё черновик','')`, [a.id]);
      if (scenario === 'article') await t.admin(`update public.article set revision=revision+1 where id=$1`, [a.id]);
      const before = await t.admin(`select * from public.article_revision where article_id=$1 order by rev_no`, [a.id]);
      await expect(apply(plan)).rejects.toThrow();
      expect(await t.admin(`select * from public.article_revision where article_id=$1 order by rev_no`, [a.id])).toEqual(before);
    }
  });

  it('без явного ожидаемого черновика сохраняет прежний запрет на перезапись', async () => {
    const plan = await fixture();
    const { expected_draft: _, ...article } = plan.articles[0];
    await expect(apply({ ...plan, articles: [article] })).rejects.toThrow('Есть авторский черновик');
  });

  it('конфликт второй статьи откатывает публикацию первой в том же плане', async () => {
    const first = await fixture();
    const second = await fixture('Непустой черновик');
    await expect(apply({ ...first, articles: [...first.articles, ...second.articles] })).rejects.toThrow();
    expect((await t.admin<{ status: string }>(`select status from public.article_revision where id=$1`, [first.articles[0].expected_draft.id]))[0].status).toBe('draft');
    expect(await t.admin(`select id from public.article_revision where article_id=$1`, [first.articles[0].id])).toHaveLength(1);
  });
});
