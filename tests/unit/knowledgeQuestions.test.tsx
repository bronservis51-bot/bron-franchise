import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { QuestionsPage } from '../../src/modules/knowledge/KnowledgePages';
import type { Question } from '../../src/modules/knowledge/api';

const permissions = vi.hoisted(() => ({ editor: false }));
vi.mock('../../src/platform/session', () => ({
  useSession: () => ({ can: () => permissions.editor, isManager: false }),
}));

const pending: Question = {
  id: 'pending', question: 'Открытый вопрос', answer: null, answered_at: null,
  created_at: '2026-11-17T10:00:00Z', article_id: null, user_name: 'Стажёр', partner_name: null,
  mine: true, unseen: false, category: 'equipment', route: 'technical',
};
const answered: Question = {
  ...pending, id: 'answered', question: 'Ранее заданный вопрос', answer: 'Порядок действий есть в памятке.',
  created_at: '2026-11-13T10:00:00Z', answered_at: '2026-11-18T10:00:00Z', article_id: 'published', unseen: true,
};

function renderQuestions(editor: boolean, questions: Question[]) {
  permissions.editor = editor;
  const client = new QueryClient();
  client.setQueryData(['kb', 'questions'], questions);
  client.setQueryData(['kb', 'manage'], [
    { id: 'published', title: 'Памятка по плоттеру', status: 'published' },
    { id: 'draft', title: 'Черновик инструкции', status: 'draft' },
    { id: 'archived', title: 'Архивная инструкция', status: 'archived' },
  ]);
  return renderToStaticMarkup(
    <MemoryRouter><QueryClientProvider client={client}><QuestionsPage /></QueryClientProvider></MemoryRouter>,
  );
}

describe('reusing knowledge in support answers', () => {
  it('offers the responder only published materials and preserves an already linked source', () => {
    const html = renderQuestions(true, [pending, { ...pending, id: 'source', article_id: 'origin' }]);
    expect(html.match(/<select\b[^>]*>[\s\S]*?<\/select>/g)).toHaveLength(1);
    expect(html).toContain('Памятка по плоттеру');
    expect(html).not.toContain('Черновик инструкции');
    expect(html).not.toContain('Архивная инструкция');
    expect(html).toContain('href="/kb/articles/origin"');
  });

  it('puts a new answer first for its author and links to the material inside the answer', () => {
    const html = renderQuestions(false, [pending, answered]);
    expect(html.indexOf(answered.question)).toBeLessThan(html.indexOf(pending.question));
    expect(html).toMatch(/class="answer"[\s\S]*href="\/kb\/articles\/published"[^>]*>Открыть материал<\/a>/);
    expect(html).not.toContain('<select');
  });

  it('preserves the support queue order', () => {
    const html = renderQuestions(true, [pending, answered]);
    expect(html.indexOf(pending.question)).toBeLessThan(html.indexOf(answered.question));
  });
});
