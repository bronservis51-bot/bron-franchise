import type { Lead, LeadStatus } from './api';

export type Readiness = { money: boolean; place: boolean; now: boolean };
export type PipelineColumn = { id: string; title: string; hint: string; factors?: Readiness; status?: LeadStatus };

// Частичный бюджет, варианты помещения и более поздние сроки ещё не полная готовность.
export function readiness(lead: Pick<Lead, 'budget' | 'place' | 'timing'>): Readiness {
  return { money: lead.budget === 'full', place: lead.place === 'has', now: lead.timing === 'month' };
}
export function readinessKey(f: Readiness) { return `${Number(f.money)}${Number(f.place)}${Number(f.now)}`; }

// По числу выполненных условий; при равенстве — деньги, затем близость открытия.
export const PIPELINE: PipelineColumn[] = [
  { id: '000', title: 'Изучают', hint: 'Ни один фактор пока не подтверждён' },
  { id: '010', title: 'Есть помещение', hint: 'Нужны бюджет и готовность начать' },
  { id: '001', title: 'Хотят сейчас', hint: 'Нужны бюджет и помещение' },
  { id: '100', title: 'Есть деньги', hint: 'Нужны помещение и срок открытия' },
  { id: '011', title: 'Помещение + сейчас', hint: 'Осталось решить вопрос бюджета' },
  { id: '110', title: 'Деньги + помещение', hint: 'Осталось согласовать скорое открытие' },
  { id: '101', title: 'Деньги + сейчас', hint: 'Осталось подобрать помещение' },
  { id: '111', title: 'Готовы к открытию', hint: 'Все три условия выполнены' },
].map(c => ({ ...c, factors: { money: c.id[0] === '1', place: c.id[1] === '1', now: c.id[2] === '1' } }));
export const COLUMNS: PipelineColumn[] = [...PIPELINE,
  { id: 'in_work', title: 'В работе', hint: 'Контакт, перезвонить или встреча', status: 'in_work' },
  { id: 'won', title: 'Договор', hint: 'Договорённость с партнёром', status: 'won' },
  { id: 'lost', title: 'Отказ', hint: 'Закрытые обращения', status: 'lost' },
];
export function columnFor(lead: Pick<Lead, 'budget' | 'place' | 'timing' | 'status' | 'pipeline_column'>): string {
  if (lead.status === 'new') return PIPELINE.some(c => c.id === lead.pipeline_column) ? lead.pipeline_column! : readinessKey(readiness(lead));
  if (lead.status === 'won' || lead.status === 'lost') return lead.status;
  return 'in_work';
}
export function groupLeads(leads: Lead[], search: string, onlyNew: boolean) {
  const query = search.trim().toLocaleLowerCase('ru');
  const groups = new Map(COLUMNS.map(c => [c.id, [] as Lead[]]));
  for (const lead of leads) {
    if (onlyNew && lead.status !== 'new') continue;
    const text = `${lead.name} ${lead.instagram ?? ''} ${lead.city} ${lead.phone}`.toLocaleLowerCase('ru');
    const digits = query.replace(/\D/g, '');
    if (query && !text.includes(query) && !(digits.length >= 3 && /^[\d\s+()-]+$/.test(query) && lead.phone.replace(/\D/g, '').includes(digits))) continue;
    groups.get(columnFor(lead))!.push(lead);
  }
  for (const list of groups.values()) list.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  return groups;
}
