import { command } from '../../platform/backend';
import { operationKey } from '../../platform/operation';
import { sendOrQueue } from '../../platform/outbox';

export interface DayEntry { revision: number; employee_id: string | null; employee_name: string | null; cash_minor: number; card_minor: number; total_minor: number; comment: string | null }
export interface DayRow { day: string; cash_minor: number; card_minor: number; total_minor: number; comment: string | null; updated_at: string; entries: DayEntry[] }

export interface LocationMonth {
  location_id: string; location_name: string; city: string; currency: string; status: string;
  partner_id: string; partner_name: string;
  month: string; today: string;
  plan_minor: number | null; fact_minor: number; cash_minor: number; card_minor: number; pct: number | null;
  days_in_month: number; days_left: number; need_per_day_minor: number | null;
  missing_days: string[]; last_day: string | null; fx_rub: number | null;
}

export interface MonthDetail extends LocationMonth {
  editable_from: string | null; days: DayRow[];
  prev_month_total_minor: number; prev_same_period_minor: number; same_period_minor: number;
  weekday_avg: { dow: number; avg_minor: number }[];
  staff: { user_id: string; full_name: string }[];
}

export interface Overview { month: string; rows: LocationMonth[]; fact_rub_minor: number | null; plan_rub_minor: number | null; missing_fx: string[] }

export const revenueOverview = (month: string) => command<Overview>('revenue_overview', { month });
export const revenueMonth = (location: string, month: string) => command<MonthDetail>('revenue_month', { location, month });
/** Сохранить выручку дня (без сети — в очередь на устройстве). employee = null — запись самого франчайзи. */
export const revenueSave = async (userId: string, location: string, day: string, cash: string, card: string, comment: string | null, employee: string | null, expected_revision: number) => {
  const args = { location, day, cash, card, comment, employee, expected_revision };
  const receipt = await operationKey(userId, 'revenue_save_checked', args);
  const result = await sendOrQueue(userId, 'revenue_save_checked', { ...args, operation: receipt.id });
  receipt.complete();
  return result;
};
export const revenueDelete = (location: string, day: string, employee: string | null) => command('revenue_delete', { location, day, employee });
export const planSet = (location: string, month: string, amount: string) => command('revenue_plan_set', { location, month, amount });

export const WEEKDAY = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const WEEKDAY_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
