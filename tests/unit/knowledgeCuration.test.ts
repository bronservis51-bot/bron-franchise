import { expect, it } from 'vitest';
// @ts-expect-error — reviewed SQL builder, no runtime database dependency
import { knowledgeCurationSql } from '../../scripts/knowledge-curation.mjs';

const article = { id: '00000000-0000-4000-8000-000000000001', slug: 'checked', title: 'Проверенный материал', section: 'start', status: 'published', body: 'Подтверждённый текст', sources: ['https://example.invalid/source'], reason: 'Сверено' };
const plan = { id: 'review-2026-11-04', sections: [], articles: [article] };
it('отклоняет публикацию без источника и пустую публикацию', () => {
  for (const change of [{sources:[]},{body:''}]) expect(()=>knowledgeCurationSql({...plan,articles:[{...article,...change}]})).toThrow();
});
it('оставляет будущие блоки пустыми черновиками', () => {
  expect(()=>knowledgeCurationSql({...plan,articles:[{...article,status:'draft'}]})).toThrow();
  expect(knowledgeCurationSql({...plan,articles:[{...article,status:'draft',body:'',sources:[]}]})).toContain('begin;');
});
it('отклоняет повтор статьи в одном плане', () => {
  expect(()=>knowledgeCurationSql({...plan,articles:[article,article]})).toThrow('Повтор статьи');
});
it('экранирует литерал и отделяет тело SQL от текста источника', () => {
  const sql=knowledgeCurationSql({...plan,articles:[{...article,body:"Источник: 'цитата' $knowledge_curation$"}]});
  expect(sql).toContain("''цитата''");
  expect(sql).toContain('do $knowledge_curation_$');
});
it('разрешает замену пустой заготовки только с точной версией статьи и черновика', () => {
  const checked = { ...article, expected_revision: 2, expected_draft: { id: article.id, revision: 1 } };
  expect(knowledgeCurationSql({ ...plan, articles: [checked] })).toContain("x ? 'expected_draft'");
  for (const change of [
    { expected_revision: null }, { expected_revision: 0 }, { expected_draft: null },
    { expected_draft: { id: 'anything', revision: 1 } }, { expected_draft: { id: article.id } },
    { expected_draft: { id: article.id, revision: 0 } }, { status: 'archived' },
  ]) expect(() => knowledgeCurationSql({ ...plan, articles: [{ ...checked, ...change }] })).toThrow('точная версия');
});
