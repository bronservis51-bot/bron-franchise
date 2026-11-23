import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { KbHomePage, KbManagePage } from '../../src/modules/knowledge/KbBrowse';
import type { Card, KbHome, SectionNode } from '../../src/modules/knowledge/api';

const permissions = vi.hoisted(() => ({ editor: false }));
vi.mock('../../src/platform/session', () => ({
  useSession: () => ({ can: (permission: string) => permission === 'kb.edit' && permissions.editor }),
}));

const section: SectionNode & { slug: string } = {
  id: 'safeguards', slug: 'garantii', title: 'Гарантии', description: 'Описание раздела',
  sort: 1, parent_id: null, icon: 'shield', count: 3,
};

const featured: Card = {
  id: 'latest', title: 'Недавно опубликованная памятка', section_id: section.id, type: 'instruction',
  has_video: false, summary: null, status: 'published', minutes: 3, views_30: 1, required_ack: false,
  has_draft: false, read: false, published_at: '2026-11-08T12:00:00Z', updated_at: '2026-11-08T12:00:00Z',
};
const home: KbHome = { sections: [section], recent: [featured], popular: [], continue: [], drafts: 2, total: 3 };

function render(entry = '/kb', editor = false) {
  permissions.editor = editor;
  const client = new QueryClient();
  client.setQueryData(['kb', 'home', editor], home);
  client.setQueryData(['kb', 'sections'], [section]);
  client.setQueryData(['kb', 'to-read'], [
    { article_id: 'required', title: 'Обязательный регламент', summary: null, due_on: '2099-01-01' },
  ]);
  client.setQueryData(['kb', 'inbox'], { unanswered: editor ? 2 : 0, new_answers: editor ? 0 : 1 });
  client.setQueryData(['kb', 'manage'], []);
  client.setQueryData(['kb', 'search', 'гарантия', false], []);
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}><QueryClientProvider client={client}>
      {entry.startsWith('/kb/manage') ? <KbManagePage /> : <KbHomePage />}
    </QueryClientProvider></MemoryRouter>,
  );
}

describe('knowledge entry by role and URL', () => {
  it('starts with search and catalog, and keeps unanswered reading and replies findable', () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*id="kb-q"[^>]*type="search"/);
    expect(html).toContain('href="/kb/s/safeguards"');
    expect(html).toContain('href="/kb/questions"');
    expect(html).toContain('Новых ответов');
    expect(html).toContain('Нужно прочитать');
    expect(html).toContain('href="/kb?view=reading"');
    expect(html).not.toContain('Открываю точку');
    expect(html).not.toContain(featured.title);
    expect(html).not.toContain('href="/kb/manage"');
  });

  it('keeps journey deep links and dedicated collections, including mandatory reading', () => {
    expect(render('/kb?path=help')).toContain('Клиент недоволен');
    const reading = render('/kb?view=reading');
    expect(reading).toContain('href="/kb/articles/required"');
    expect(reading).toContain(featured.title);
  });

  it('keeps editor actions in management and the unanswered count beside the question link', () => {
    const landing = render('/kb', true);
    expect(landing).toContain('href="/kb/manage"');
    expect(landing).toContain('Без ответа');
    expect(landing).not.toContain('Новая статья');
    expect(landing).not.toContain('Искали и не нашли');
    const manage = render('/kb/manage?status=draft', true);
    expect(manage).toContain('Новая статья');
    expect(manage).toContain('Поиск без результатов');
    expect(manage).toContain('href="/learning/manage"');
  });

  it('shows only search results in the main area when opened from a saved query', () => {
    const html = render('/kb?q=гарантия');
    expect(html).toContain('Пока не нашли ответ');
    expect(html).toContain('Задать вопрос');
    expect(html).not.toContain('href="/kb/s/safeguards"');
    expect(html).not.toContain('Открываю точку');
  });
});
