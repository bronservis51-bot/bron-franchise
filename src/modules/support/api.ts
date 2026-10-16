import { command, from, rows, single } from '../../platform/backend';

export interface Ticket {
  id: string; number: string; partner_id: string | null; location_id: string; category: string; queue_role: string; backup_role: string | null;
  urgency: string; urgency_reason: string | null; subject: string; description: string; equipment_model: string | null; status: string;
  assignee_id: string | null; created_by: string; first_response_due: string; resolve_due: string; first_response_at: string | null;
  resolved_at: string | null; closed_at: string | null; sla_paused_at: string | null; sla_paused_minutes: number; resolution_reason: string | null;
  kb_article_id: string | null; reopen_until: string | null; reopen_count: number; created_at: string; revision: number;
}
export interface Message { id: string; ticket_id: string; author_id: string; body: string; internal: boolean; lang: string | null; created_at: string }
export interface Routing { category: string; title: string; queue_role: string; required_fields: string[]; kb_section_hint: string | null }

export type TicketFilter = 'mine' | 'queue' | 'open' | 'sla' | 'closed';

export async function listTickets(filter: TicketFilter, userId: string, partnerId?: string | null, locationId?: string | null) {
  let q = from('ticket').select('id, number, subject, status, urgency, location_id, category, resolve_due, first_response_due, first_response_at, assignee_id, created_by, created_at').limit(200);
  if (filter === 'mine') q = q.or(`assignee_id.eq.${userId},created_by.eq.${userId}`).neq('status', 'closed');
  if (filter === 'queue') q = q.is('assignee_id', null).eq('status', 'new');
  if (filter === 'open') q = q.not('status', 'in', '(resolved,closed)');
  if (filter === 'sla') q = q.not('status', 'in', '(resolved,closed,waiting_partner)').lt('resolve_due', new Date().toISOString());
  if (filter === 'closed') q = q.in('status', ['resolved', 'closed']);
  if (partnerId) q = q.eq('partner_id', partnerId);
  if (locationId) q = q.eq('location_id', locationId);
  return rows<Ticket>(q.order('created_at', { ascending: false }));
}

export const getTicket = (id: string) => single<Ticket>(from('ticket').select('*').eq('id', id));
export const messages = (id: string) => rows<Message>(from('ticket_message').select('*').eq('ticket_id', id).order('created_at'));
export const ticketEvents = (id: string) => rows<{ id: number; actor_id: string | null; action: string; from_status: string | null; to_status: string | null; comment: string | null; at: string }>(
  from('ticket_event').select('*').eq('ticket_id', id).order('at'));
export const routing = () => rows<Routing>(from('support_routing').select('*').order('title'));
export const kbForCategory = (category: string) => command<{ article_id: string; title: string; summary: string | null }[]>('kb_for_context', { target_type: 'ticket_category', target_key: category });

export interface NewTicket { location: string; category: string; urgency: string; urgency_reason: string | null; subject: string; description: string; equipment_model: string | null; details: Record<string, string> }

export const ticketCommands = {
  create: (t: NewTicket, clientKey: string) => command<Ticket>('ticket_create', { ...t, client_key: clientKey }),
  take: (id: string) => command<Ticket>('ticket_take', { ticket: id }),
  reply: (id: string, body: string, internal: boolean, lang: string) => command<Message>('ticket_reply', { ticket: id, body, internal, lang }),
  setStatus: (id: string, status: string, comment: string, rev: number) => command<Ticket>('ticket_set_status', { ticket: id, status, comment, expected_revision: rev }),
  resolve: (id: string, reason: string, kbArticle: string | null) => command<Ticket>('ticket_resolve', { ticket: id, reason, kb_article: kbArticle }),
  confirm: (id: string) => command<Ticket>('ticket_confirm', { ticket: id }),
  reopen: (id: string, reason: string) => command<Ticket>('ticket_reopen', { ticket: id, reason }),
  translate: (messageId: string, target: string) => command<{ original: string; translated: string | null; kind: string; available: boolean }>('ticket_message_translate', { message: messageId, target }),
  attachPrepare: (id: string, internal: boolean, f: { name: string; mime: string; size: number; checksum: string }) =>
    command<{ file_id: string; path: string }>('ticket_attach_prepare', { ticket: id, name: f.name, mime: f.mime, size: f.size, checksum: f.checksum, internal }),
};

export const TICKET_EVENT: Record<string, string> = {
  created: 'Обращение создано', taken: 'Взято в работу', assigned: 'Передано', message: 'Сообщение', internal_note: 'Внутренняя заметка',
  status: 'Смена статуса', resolved: 'Решено', confirmed: 'Решение подтверждено', reopened: 'Переоткрыто', auto_closed: 'Закрыто автоматически',
  sla_resumed: 'Таймер решения возобновлён', routed_to_backup: 'Передано резервной роли',
};
