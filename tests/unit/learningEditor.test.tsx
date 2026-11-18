import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LearningEditor } from '../../src/modules/learning/Learning';

function editorHtml(publishedRevision: string | null, bankRevision?: string) {
  const client = new QueryClient();
  client.setQueryData(['learning-config', 'lesson', null], {
    version: 3,
    revision_id: bankRevision,
    questions: [{ prompt: 'К кому обратиться за помощью?', choices: ['К наставнику', 'К покупателю'], correct: 0 }],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LearningEditor article="lesson" revision={publishedRevision} />
    </QueryClientProvider>,
  );
}

describe('confirming unchanged quiz questions', () => {
  it('offers an enabled confirmation when the bank belongs to a previous revision', () => {
    const html = editorHtml('new-revision', 'old-revision');
    expect(html).toContain('Проверьте вопросы по новой редакции.');
    const button = html.match(/<button[^>]*>Подтвердить вопросы<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('disabled');
  });

  it.each([
    ['current revision', 'current-revision', 'current-revision'],
    ['unpublished lesson', null, 'old-revision'],
    ['unconfigured lesson', 'published-revision', undefined],
  ])('keeps save disabled for an unchanged %s', (_label, publishedRevision, bankRevision) => {
    const html = editorHtml(publishedRevision, bankRevision);
    expect(html).not.toContain('Подтвердить вопросы');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Сохранить обучение<\/button>/);
  });
});
