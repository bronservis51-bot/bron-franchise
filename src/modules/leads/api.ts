import { command } from '../../platform/backend';

export type LeadStatus = 'new' | 'in_work' | 'call_back' | 'meeting' | 'won' | 'lost';
export type LeadTier = 'hot' | 'warm' | 'cold';

export interface Lead {
  id: string; created_at: string; name: string; phone: string; contact_via: 'whatsapp' | 'telegram' | 'call' | 'instagram' | 'other'; city: string;
  budget: 'full' | 'partial' | 'none' | null; timing: 'month' | 'quarter' | 'half' | 'research' | null; manage: 'self' | 'manager' | 'undecided' | null;
  experience: 'business' | 'some' | 'none' | null; place: 'has' | 'options' | 'help' | null;
  instagram?: string | null; pipeline_column?: string | null;
  comment: string | null; source: string | null; score: number; tier: LeadTier; status: LeadStatus; note: string | null;
  updated_at: string; updated_by_name: string | null; deleted_at?: string | null;
}

export const leadList = () => command<Lead[]>('lead_list');
export const leadTrashList = () => command<Lead[]>('lead_trash_list');
export const leadSetDeleted = (lead: Lead, deleted: boolean) => command<Lead>('lead_set_deleted', { id: lead.id, deleted, expected_updated_at: lead.updated_at });
export const leadMove = (lead: Lead, column: string) => command<Lead>('lead_move', { id: lead.id, column, expected_updated_at: lead.updated_at });
export interface LeadInput { id?: string; name: string; instagram: string | null; phone: string; city: string; column: string; note: string; }
export const leadSave = (lead: LeadInput, expected: string | null, operation: string) => command<Lead>('lead_save', { lead, expected_updated_at: expected, operation });
export const leadUpdate = (id: string, status: LeadStatus, note: string) => command('lead_update', { id, status, note });

// Подписи ответов — те же формулировки, что в анкете на сайте
export const STATUS: Record<LeadStatus, string> = {
  new: 'Новая', in_work: 'В работе', call_back: 'Перезвонить', meeting: 'Встреча', won: 'Договор', lost: 'Отказ',
};
export const TIER: Record<LeadTier, string> = { hot: 'Горячая', warm: 'Тёплая', cold: 'Холодная' };
export const ANSWERS = {
  budget: { full: 'Есть вся сумма ≈ 1 млн ₽', partial: 'Часть своя, часть — кредит или партнёр', none: 'Пока нет такой суммы' },
  timing: { month: 'В ближайший месяц', quarter: 'Через 1–3 месяца', half: 'Через 3–6 месяцев', research: 'Пока изучаю' },
  manage: { self: 'Сам(а), буду на точке', manager: 'Найму управляющего', undecided: 'Пока не решил(а)' },
  experience: { business: 'Есть свой бизнес', some: 'Был опыт в продажах или управлении', none: 'Это первый бизнес' },
  place: { has: 'Есть место с потоком людей', options: 'Есть варианты, нужно выбрать', help: 'Нужна помощь с поиском' },
  contact_via: { whatsapp: 'WhatsApp', telegram: 'Telegram', call: 'Звонок', instagram: 'Instagram', other: 'Не указан' },
} as const;
