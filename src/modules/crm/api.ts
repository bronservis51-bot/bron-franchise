import { command, from, rows } from '../../platform/backend';

export type Stage = 'new' | 'contacted' | 'meeting' | 'negotiation' | 'contract' | 'won' | 'lost';
export interface Lead {
  id: string; number: string; name: string; company: string | null; phone: string | null; email: string | null; country: string | null; city: string | null;
  source: string; stage: Stage; investment_minor: number | null; points_planned: number | null; owner_id: string | null; next_action: string | null;
  next_action_at: string | null; lost_reason: string | null; partner_id: string | null; opening_id: string | null; stage_changed_at: string;
  last_touch_at: string | null; created_at: string; revision: number;
}
export interface Activity { id: string; lead_id: string; kind: 'call' | 'meeting' | 'message' | 'note' | 'stage' | 'created'; body: string | null; actor_id: string | null; at: string }

export const STAGES: { id: Stage; label: string }[] = [
  { id: 'new', label: 'Новый' }, { id: 'contacted', label: 'Связались' }, { id: 'meeting', label: 'Встреча' },
  { id: 'negotiation', label: 'Переговоры' }, { id: 'contract', label: 'Договор' }, { id: 'won', label: 'Партнёр' }, { id: 'lost', label: 'Отказ' },
];
export const ACTIVE: Stage[] = ['new', 'contacted', 'meeting', 'negotiation', 'contract'];
export const SOURCES: Record<string, string> = { site: 'Сайт', call: 'Звонок', referral: 'Рекомендация', social: 'Соцсети', exhibition: 'Выставка', ads: 'Реклама', other: 'Другое' };
export const stageLabel = (s: Stage) => STAGES.find((x) => x.id === s)?.label ?? s;

export const leads = () => rows<Lead>(from('crm_lead').select('*').order('next_action_at', { ascending: true, nullsFirst: true }).limit(500));
export const lead = (id: string) => rows<Lead>(from('crm_lead').select('*').eq('id', id)).then((r) => r[0] ?? null);
export const activities = (id: string) => rows<Activity>(from('crm_activity').select('*').eq('lead_id', id).order('at', { ascending: false }));
export const myWeekTouches = (userId: string) => {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  return rows<{ id: string }>(from('crm_activity').select('id').eq('actor_id', userId).in('kind', ['call', 'meeting', 'message']).gte('at', since));
};

export const crm = {
  create: (a: { name: string; phone: string; city: string | null; country: string | null; source: string; comment: string | null }) =>
    command<Lead>('crm_lead_create', { ...a, next_action: null, next_action_at: null }),
  update: (lead: string, patch: Record<string, unknown>, expected_revision: number | null) => command<Lead>('crm_lead_update', { lead, patch, expected_revision }),
  touch: (lead: string, kind: string, body: string | null, next_action: string | null, next_action_at: string | null) =>
    command<Lead>('crm_touch', { lead, kind, body, next_action, next_action_at }),
  stage: (lead: string, stage: Stage, reason: string | null, planned_open: string | null) =>
    command<{ lead: Lead; partner_id: string | null; opening_id: string | null }>('crm_set_stage', { lead, stage, reason, planned_open }),
};

/** Срок шага: просрочен / сегодня / позже — для цвета и подписи. */
export function dueState(at: string | null): 'none' | 'late' | 'today' | 'later' {
  if (!at) return 'none';
  const d = new Date(at);
  const now = new Date();
  const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (d < now && d.toDateString() !== now.toDateString()) return 'late';
  if (d < endToday) return d < now ? 'late' : 'today';
  return 'later';
}
export const digits = (phone: string | null) => (phone ?? '').replace(/\D/g, '');
