import { command } from '../../platform/backend';
import { operationKey } from '../../platform/operation';
import { sendOrQueue } from '../../platform/outbox';

export interface Shift { id: string; location_id: string; location_name?: string; day: string; status: 'open' | 'closed'; opened_at: string; closed_at: string | null;
  cash_minor: number; card_minor: number; total_minor: number; comment: string | null; rate_bp: number | null; shift_fee_minor: number | null; earned_minor: number | null }
export interface StaffHomeData {
  month: string; rate_bp: number; shift_fee_minor: number; partner_name: string; currency: string;
  open_shift: (Shift & { location_name: string; currency: string }) | null;
  locations: { location_id: string; location_name: string; currency: string; today: string; my_today: Shift | null }[];
  month_earned_minor: number; month_revenue_minor: number; month_shifts: number;
  shifts: Shift[];
}
export interface StaffRow {
  user_id: string; full_name: string; phone: string; active: boolean; location_ids: string[]; location_names: string[];
  rate_bp: number; shift_fee_minor: number; open_shift: { id: string; location_name: string; opened_at: string } | null;
  month_shifts: number; month_revenue_minor: number; month_earned_minor: number;
  shifts: { id: string; day: string; location_name: string; total_minor: number; earned_minor: number; opened_at: string; closed_at: string }[];
}
export interface CloseResult { shift: Shift; month_earned_minor: number; month_shifts: number; currency: string }

export const staffHome = (month: string | null) => command<StaffHomeData>('staff_home', { month });
export const shiftOpen = (location: string) => command<Shift>('shift_open', { location });
export const shiftClose = async (userId: string, shift: string, cash: string, card: string, comment: string | null, expected_closed_at: string | null) => {
  const args = { shift, cash, card, comment, expected_closed_at };
  const receipt = await operationKey(userId, 'shift_close_checked', args);
  const result = await sendOrQueue<CloseResult>(userId, 'shift_close_checked', { ...args, operation: receipt.id });
  receipt.complete();
  return result;
};
export const shiftCancel = (shift: string) => command('shift_cancel', { shift });

export const staffList = (partner: string, month: string) => command<StaffRow[]>('staff_list', { partner, month });
export const staffCreate = (a: { partner: string; full_name: string; phone: string; password: string; locations: string[]; rate_bp: number; shift_fee: string }) =>
  command<string>('staff_create', a);
export const staffUpdate = (a: { user: string; full_name: string; locations: string[]; rate_bp: number; shift_fee: string }) => command('staff_update', a);
export const staffSetActive = (user: string, active: boolean) => command('staff_set_active', { user, active });
export const userSetPassword = (user: string, password: string) => command('user_set_password', { user, password });

/** Телефон «+7 900 000-00-11» → цифры логина (так же, как app_private.phone_digits в базе). */
export function phoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (/^8\d{10}$/.test(d)) return `7${d.slice(1)}`;
  if (/^9\d{9}$/.test(d)) return `7${d}`;
  return d;
}
export const staffEmail = (phone: string) => `${phoneDigits(phone)}@staff.bron.local`;
export const formatPhone = (digits: string) => (/^7\d{10}$/.test(digits) ? `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}` : `+${digits}`);
export const pctBp = (bp: number) => `${(bp / 100).toLocaleString('ru-RU')} %`;

/** Пароль для выдачи человеку: 8 символов без похожих (0/O, 1/l). */
export function randomPassword() {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => a[b % a.length]).join('');
}
