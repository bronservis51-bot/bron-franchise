import { command } from '../../platform/backend';

export interface DayRow { day: string; cash_minor: number; card_minor: number; total_minor: number; comment: string | null; updated_at: string }

export interface LocationMonth {
  location_id: string; location_name: string; city: string; currency: string; status: string;
  partner_id: string; partner_name: string;
  month: string; today: string;
  plan_minor: number | null; fact_minor: number; cash_minor: number; card_minor: number; pct: number | null;
  days_in_month: number; days_left: number; need_per_day_minor: number | null;
  missing_days: string[]; last_day: string | null; fx_rub: number | null;
}

export interface MonthDetail extends LocationMonth { editable_from: string | null; days: DayRow[] }

export interface Overview { month: string; rows: LocationMonth[]; fact_rub_minor: number | null; plan_rub_minor: number | null; missing_fx: string[] }

export const revenueOverview = (month: string) => command<Overview>('revenue_overview', { month });
export const revenueMonth = (location: string, month: string) => command<MonthDetail>('revenue_month', { location, month });
export const revenueSave = (location: string, day: string, cash: string, card: string, comment: string | null) =>
  command('revenue_save', { location, day, cash, card, comment });
export const revenueDelete = (location: string, day: string) => command('revenue_delete', { location, day });
export const planSet = (location: string, month: string, amount: string) => command('revenue_plan_set', { location, month, amount });
