import { command, from, rows, single } from '../../platform/backend';

export interface Opening {
  id: string; number: string; partner_id: string; location_id: string; contract_id: string | null; format: string | null; city: string;
  address: string | null; planned_open_on: string; actual_open_on: string | null; manager_id: string | null; status: string;
  status_reason: string | null; instance_id: string; template_version_id: string; crm_deal_ref: string | null; created_at: string; revision: number;
}
export interface Progress { project_id: string; total_tasks: number; done_tasks: number; critical_open: number; blocked_tasks: number; overdue_tasks: number; next_due_at: string | null; date_at_risk: boolean }
export interface StepTask { id: string; number: string; title: string; status: string; status_reason: string | null; due_at: string | null; queue_role: string; side: string; stage_key: string; stage_title: string; stage_order: number; step_order: number; is_critical: boolean; is_gate: boolean; assignee_id: string | null; requires_evidence: boolean }
export interface Blocker { task_id: string; number: string; title: string; stage_title: string; status: string; queue_role: string; due_at: string | null }

export const listOpenings = () => rows<Opening>(from('opening_project').select('*').order('planned_open_on'));
export const progressAll = () => rows<Progress>(from('v_opening_progress').select('*'));
export const getOpening = (id: string) => single<Opening>(from('opening_project').select('*').eq('id', id));
export const getProgress = (id: string) => single<Progress>(from('v_opening_progress').select('*').eq('project_id', id));
export const steps = (instanceId: string) =>
  rows<StepTask>(from('task').select('id, number, title, status, status_reason, due_at, queue_role, side, stage_key, stage_title, stage_order, step_order, is_critical, is_gate, assignee_id, requires_evidence')
    .eq('instance_id', instanceId).order('stage_order').order('step_order'));
export const blockers = (id: string) => command<Blocker[]>('opening_blockers', { project: id });
export const notes = (id: string) => rows<{ id: string; body: string; author_id: string; created_at: string }>(from('opening_note').select('*').eq('project_id', id).order('created_at', { ascending: false }));
export const events = (id: string) => rows<{ id: number; actor_id: string | null; action: string; detail: Record<string, unknown> | null; comment: string | null; at: string }>(
  from('opening_event').select('*').eq('project_id', id).order('at'));
export const templateVersion = (id: string) => single<{ version: number; change_note: string | null }>(from('workflow_template_version').select('version, change_note').eq('id', id));

export const openingCommands = {
  create: (a: { partner: string; location: string | null; location_name: string | null; city: string | null; address: string | null; format: string | null; planned_open: string; contract: string | null }) =>
    command<string>('opening_create', { ...a, template_code: null }),
  changeDate: (id: string, newDate: string, reason: string) => command<{ changed: { number: string; title: string; old_due: string | null; new_due: string }[] }>('opening_change_date', { project: id, new_date: newDate, reason }),
  approve: (id: string, comment: string | null) => command('opening_approve', { project: id, comment }),
  markOpened: (id: string, actual: string, comment: string | null) => command('opening_mark_opened', { project: id, actual, comment }),
  complete: (id: string) => command('opening_complete', { project: id }),
  cancel: (id: string, reason: string) => command('opening_cancel', { project: id, reason }),
  addNote: (id: string, body: string) => command('opening_add_note', { project: id, body }),
  demoCrm: (partner: string, dealRef: string, locationName: string, city: string, plannedOpen: string) =>
    command<{ inbox: string; project_id: string | null; error: string | null }>('demo_crm_deal_won', { partner, deal_ref: dealRef, location_name: locationName, city, planned_open: plannedOpen }),
};

export const EVENT_LABEL: Record<string, string> = {
  created: 'Проект создан', date_changed: 'Плановая дата перенесена', approved: 'Разрешение на открытие выдано', opened: 'Точка открыта',
  completed: 'Проект завершён', cancelled: 'Проект отменён',
};
