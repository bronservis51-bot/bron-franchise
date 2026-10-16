// Модуль Workflows and Tasks: единственное место обращения к backend для задач.
import { command, from, rows, single } from '../../platform/backend';

export interface Task {
  id: string; number: string; kind: string; title: string; description: string | null; status: string; status_reason: string | null;
  priority: string; due_at: string | null; due_mode: string; queue_role: string; backup_role: string | null; assignee_id: string | null;
  partner_id: string | null; location_id: string | null; subject_type: string | null; subject_id: string | null; stage_title: string | null;
  is_critical: boolean; is_gate: boolean; requires_evidence: boolean; requires_review: boolean; partner_visible: boolean; side: string;
  result: string | null; completed_at: string | null; completed_by: string | null; kb_article_slug: string | null; revision: number; created_at: string;
  instance_id: string | null;
}
export interface TaskEvent { id: number; actor_id: string | null; action: string; from_status: string | null; to_status: string | null; comment: string | null; at: string }

export type TaskFilter = 'mine' | 'queue' | 'review' | 'done' | 'all';

export async function listTasks(filter: TaskFilter, userId: string, partnerId?: string | null, locationId?: string | null) {
  let q = from('task').select('id, number, title, status, status_reason, due_at, priority, queue_role, assignee_id, partner_id, location_id, is_critical, kind, subject_type, subject_id, completed_at').limit(200);
  if (filter === 'mine') q = q.eq('assignee_id', userId).not('status', 'in', '(done,cancelled)');
  if (filter === 'queue') q = q.is('assignee_id', null).in('status', ['ready']);
  if (filter === 'review') q = q.eq('status', 'in_review');
  if (filter === 'done') q = q.in('status', ['done', 'cancelled']).order('completed_at', { ascending: false });
  if (filter === 'all') q = q.not('status', 'in', '(done,cancelled)');
  if (partnerId) q = q.eq('partner_id', partnerId);
  if (locationId) q = q.eq('location_id', locationId);
  if (filter !== 'done') q = q.order('due_at', { ascending: true, nullsFirst: false });
  return rows<Task>(q);
}

export const getTask = (id: string) => single<Task>(from('task').select('*').eq('id', id));
export const taskEvents = (id: string) => rows<TaskEvent>(from('task_event').select('*').eq('task_id', id).order('at'));
export const taskDeps = async (id: string) => {
  const deps = await rows<{ depends_on: string }>(from('task_dependency').select('depends_on').eq('task_id', id));
  if (!deps.length) return [];
  return rows<Pick<Task, 'id' | 'number' | 'title' | 'status'>>(from('task').select('id, number, title, status').in('id', deps.map((d) => d.depends_on)));
};
export const articleBySlug = (slug: string) => single<{ id: string }>(from('article').select('id').eq('slug', slug));

export const taskCommands = {
  take: (id: string, rev: number) => command<Task>('task_take', { task: id, expected_revision: rev }),
  transition: (id: string, to: string, comment: string | null, rev: number) => command<Task>('task_transition', { task: id, to, comment, expected_revision: rev }),
  complete: (id: string, result: string, rev: number) => command<Task>('task_complete', { task: id, result, expected_revision: rev }),
  cancel: (id: string, reason: string) => command<Task>('task_cancel', { task: id, reason }),
  reopen: (id: string, reason: string) => command<Task>('task_reopen', { task: id, reason }),
  comment: (id: string, text: string) => command<void>('task_comment', { task: id, text }),
  returnToQueue: (id: string, rev: number) => command<Task>('task_assign', { task: id, user: null, expected_revision: rev }),
  attachPrepare: (id: string, f: { name: string; mime: string; size: number; checksum: string }) =>
    command<{ file_id: string; path: string }>('task_attach_prepare', { task: id, name: f.name, mime: f.mime, size: f.size, checksum: f.checksum }),
};

export const ACTION_LABEL: Record<string, string> = {
  created: 'Создана', taken: 'Взята в работу', assigned: 'Назначена', returned_to_queue: 'Возвращена в очередь', transition: 'Смена статуса',
  completed: 'Завершена', submitted_for_review: 'Отправлена на проверку', cancelled: 'Отменена', reopened: 'Переоткрыта', comment: 'Комментарий',
  unblocked: 'Стала доступна', rescheduled: 'Срок изменён',
};
