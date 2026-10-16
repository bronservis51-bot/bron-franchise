import { command, from, rows, single } from '../../platform/backend';

export interface Section { id: string; parent_id: string | null; slug: string; title: string; description: string | null; sort: number }
export interface ArticleRow {
  id: string; slug: string; section_id: string; type: string; owner_id: string | null; audience: string; audience_roles: string[] | null; status: string;
  published_revision_id: string | null; review_due: string | null; required_ack: boolean; source_mode: string; export_status: string; export_error: string | null;
  exported_at: string | null; tags: string[]; revision: number; updated_at: string;
  published: { title: string; summary: string | null; rev_no: number; published_at: string | null } | null;
}
export interface Revision { id: string; article_id: string; rev_no: number; title: string; summary: string | null; body: string; lang: string; status: string; source: string;
  author_id: string | null; approved_by: string | null; published_at: string | null; submitted_at: string | null; requires_reack: boolean; change_note: string | null;
  reject_reason: string | null; revision: number; updated_at: string; external_version: string | null }
export interface SearchHit { article_id: string; revision_id: string; slug: string; title: string; snippet: string; type: string; section_title: string; status: string; rev_no: number; published_at: string | null; review_due: string | null; rank: number }

const ARTICLE_COLS = 'id, slug, section_id, type, owner_id, audience, audience_roles, status, published_revision_id, review_due, required_ack, source_mode, export_status, export_error, exported_at, tags, revision, updated_at, published:article_revision!article_published_revision_id_fkey(title, summary, rev_no, published_at)';

export const sections = () => rows<Section>(from('kb_section').select('*').order('sort'));
export const articles = () => rows<ArticleRow>(from('article').select(ARTICLE_COLS).order('updated_at', { ascending: false }));
export const getArticle = (id: string) => single<ArticleRow>(from('article').select(ARTICLE_COLS).eq('id', id));
export const getRevision = (id: string) => single<Revision>(from('article_revision').select('*').eq('id', id));
export const revisionsOf = (articleId: string) => rows<Revision>(from('article_revision').select('*').eq('article_id', articleId).order('rev_no', { ascending: false }));
export const myAck = (revisionId: string, userId: string) => single<{ at: string }>(from('acknowledgement').select('at').eq('revision_id', revisionId).eq('user_id', userId));
export const bindings = (articleId: string) => rows<{ target_type: string; target_key: string }>(from('kb_binding').select('target_type, target_key').eq('article_id', articleId));
export const sourceLink = (articleId: string) => single<{ external_id: string; external_version: string | null; sync_status: string; last_synced_at: string | null; error: string | null }>(from('source_link').select('*').eq('article_id', articleId));
export const myAcks = (userId: string) => rows<{ id: string; article_id: string; revision_id: string; due_on: string; completed_at: string | null; created_at: string }>(
  from('ack_assignment').select('*').eq('user_id', userId).order('created_at', { ascending: false }));
export const allAcks = () => rows<{ article_id: string; revision_id: string; completed_at: string | null }>(from('ack_assignment').select('article_id, revision_id, completed_at'));
export const searchLog = () => rows<{ query: string; results: number; at: string }>(from('kb_search_log').select('query, results, at').eq('results', 0).order('at', { ascending: false }).limit(20));

export const search = (q: string, includeDrafts: boolean) => command<SearchHit[]>('kb_search', { query: q, include_drafts: includeDrafts, limit: 20 });

export const kbCommands = {
  create: (section: string, type: string, title: string, audience: string) => command<{ article_id: string }>('article_create', { section, type, title, audience, owner: null, slug: null, lang: 'ru' }),
  saveDraft: (article: string, title: string, summary: string, body: string, expectedRevision: number | null, changeNote: string | null) =>
    command<Revision>('article_save_draft', { article, title, summary, body, expected_revision: expectedRevision, change_note: changeNote }),
  updateMeta: (article: string, m: { section: string | null; type: string | null; audience: string | null; audience_roles: string[] | null; owner: string | null; tags: string[] | null; review_due: string | null; required_ack: boolean | null }) =>
    command('article_update_meta', { article, ...m }),
  submit: (article: string) => command<Revision>('article_submit', { article }),
  reject: (revision: string, reason: string) => command('article_reject', { revision, reason }),
  publish: (revision: string, requiresReack: boolean, reviewDue: string | null, note: string | null) =>
    command<{ ack_assigned: number; rev_no: number }>('article_publish', { revision, requires_reack: requiresReack, review_due: reviewDue, note }),
  archive: (article: string, reason: string) => command('article_archive', { article, reason }),
  acknowledge: (revision: string) => command('article_acknowledge', { revision }),
  feedback: (article: string, kind: string, comment: string | null) => command('kb_feedback_add', { article, kind, comment }),
  exportAll: () => command<Record<string, unknown>>('kb_export'),
  importAll: (data: unknown) => command<{ imported: number; skipped: number }>('kb_import', { export: data }),
  driveChange: (article: string, body: string, version: string) => command('demo_drive_change', { article, new_body: body, external_version: version }),
  driveAccess: (article: string, available: boolean) => command('demo_drive_access', { article, available }),
};

export const TYPE_LABEL: Record<string, string> = { article: 'Статья', instruction: 'Инструкция', faq: 'Вопросы и ответы', regulation: 'Регламент', template: 'Шаблон', checklist: 'Чек-лист' };
