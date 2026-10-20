import { command, from, rows, single } from '../../platform/backend';

export interface Section { id: string; slug: string; title: string; description: string | null; sort: number }
export interface ArticleRow {
  id: string; slug: string; section_id: string; type: string; status: string; published_revision_id: string | null;
  required_ack: boolean; ack_rev_no: number | null; tags: string[]; revision: number; updated_at: string;
  published: { title: string; summary: string | null; rev_no: number; published_at: string | null } | null;
}
export interface Revision { id: string; article_id: string; rev_no: number; title: string; summary: string | null; body: string; status: string;
  author_id: string | null; published_at: string | null; change_note: string | null; revision: number; updated_at: string }
export interface SearchHit { article_id: string; title: string; snippet: string; type: string; section_title: string; status: string; published_at: string | null; rank: number }
export interface ToRead { article_id: string; title: string; summary: string | null; due_on: string; published_at: string }

const ARTICLE_COLS = 'id, slug, section_id, type, status, published_revision_id, required_ack, ack_rev_no, tags, revision, updated_at, published:article_revision!article_published_revision_id_fkey(title, summary, rev_no, published_at)';

export const sections = () => rows<Section>(from('kb_section').select('*').order('sort'));
export const articles = () => rows<ArticleRow>(from('article').select(ARTICLE_COLS).order('updated_at', { ascending: false }));
export const getArticle = (id: string) => single<ArticleRow>(from('article').select(ARTICLE_COLS).eq('id', id));
export const getRevision = (id: string) => single<Revision>(from('article_revision').select('*').eq('id', id));
export const revisionsOf = (articleId: string) => rows<Revision>(from('article_revision').select('*').eq('article_id', articleId).order('rev_no', { ascending: false }));
export const myAcks = (articleId: string, userId: string) => rows<{ rev_no: number; at: string }>(
  from('acknowledgement').select('rev_no, at').eq('article_id', articleId).eq('user_id', userId).order('rev_no', { ascending: false }));

export const search = (q: string, includeDrafts: boolean) => command<SearchHit[]>('kb_search', { query: q, include_drafts: includeDrafts, limit: 20 });
export const toRead = () => command<ToRead[]>('kb_to_read');
export const ackStatus = (article: string) => command<{ user_id: string; full_name: string; partner: string | null; acknowledged_at: string | null }[]>('kb_ack_status', { article });

export const kbCommands = {
  sectionSave: (id: string | null, title: string, description: string | null, sort: number | null) => command<string>('kb_section_save', { id, title, description, sort }),
  create: (section: string, type: string, title: string) => command<{ article_id: string }>('article_create', { section, type, title }),
  saveDraft: (article: string, title: string, summary: string, body: string, expectedRevision: number | null) =>
    command<Revision>('article_save_draft', { article, title, summary, body, expected_revision: expectedRevision }),
  updateMeta: (article: string, m: { section: string | null; type: string | null; required_ack: boolean | null; tags: string[] | null }) =>
    command('article_update_meta', { article, ...m }),
  publish: (article: string, requiresReack: boolean, note: string | null) => command<{ rev_no: number }>('article_publish', { article, requires_reack: requiresReack, note }),
  archive: (article: string, archived: boolean) => command('article_archive', { article, archived }),
  acknowledge: (article: string) => command('article_acknowledge', { article }),
};

export const TYPE_LABEL: Record<string, string> = { article: 'Статья', instruction: 'Инструкция', faq: 'Вопросы и ответы', regulation: 'Регламент', checklist: 'Чек-лист' };

export interface Question { id: string; question: string; answer: string | null; answered_at: string | null; created_at: string; article_id: string | null;
  user_name: string; partner_name: string | null; mine: boolean; unseen: boolean }
export const kbAsk = (question: string, article: string | null) => command<string>('kb_ask', { question, article });
export const kbQuestions = () => command<Question[]>('kb_questions');
export const kbAnswer = (question: string, answer: string, article: string | null) => command('kb_answer', { question, answer, article });
export const kbMisses = () => command<{ query: string; times: number; last_at: string }[]>('kb_search_misses');
