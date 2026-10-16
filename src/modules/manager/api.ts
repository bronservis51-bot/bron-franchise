import { command, from, rows } from '../../platform/backend';

export interface Partner { id: string; code: string; name: string; country: string; currency: string; status: string;
  contact_name: string | null; contact_phone: string | null; contact_email: string | null }
export interface Location { id: string; code: string; name: string; partner_id: string; city: string; address: string | null;
  timezone: string; currency: string; status: string; opened_on: string | null }
export interface Country { code: string; name: string; default_currency: string }

export const partners = () => rows<Partner>(from('partner').select('*').order('name'));
export const locationsOf = (partner: string) => rows<Location>(from('location').select('*').eq('partner_id', partner).order('name'));
export const countries = () => rows<Country>(from('country').select('code, name, default_currency').order('name'));

export const partnerSave = (p: { id: string | null; name: string; country: string; contact_name: string; contact_phone: string; contact_email: string; status: string }) =>
  command<string>('partner_save', p);
export const locationSave = (l: { id: string | null; partner: string; name: string; city: string; address: string; status: string; opened_on: string | null }) =>
  command<string>('location_save', l);

export interface Access { users: { assignment_id: string; user_id: string; full_name: string; email: string; since: string }[]; invites: { id: number; email: string; created_at: string }[] }
export const partnerAccess = (partner: string) => command<Access>('partner_access', { partner });
export const accessGrant = (partner: string, email: string) => command<{ status: 'pending' | 'granted' | 'exists' }>('access_grant', { partner, email });
export const accessRevoke = (assignment: string) => command('access_revoke', { assignment });
export const inviteCancel = (invite: number) => command('access_cancel_invite', { invite });

export interface RoyaltyRow {
  partner_id: string; partner_name: string; status: string; country: string; currency: string; rate_bp: number;
  revenue_minor: number; accrued_minor: number; manual_minor: number; paid_minor: number; debt_minor: number; is_open: boolean;
  current_revenue_minor: number; current_accrual_minor: number; debt_months: { month: string; debt_minor: number }[];
  last_payment_on: string | null; fx_rub: number | null;
}
export interface RoyaltySummary { month: string | null; current_month: string; rows: RoyaltyRow[];
  totals: { currency: string; accrued_minor: number; paid_minor: number; debt_minor: number }[]; debt_rub_minor: number | null }
export interface LedgerMonth { month: string; revenue_minor: number; rate_bp: number; accrued_minor: number; manual_minor: number; paid_minor: number; debt_minor: number; is_open: boolean }
export interface RoyaltyPartner { partner_id: string; partner_name: string; currency: string; rate_bp: number; months: LedgerMonth[];
  payments: { id: string; month: string; amount_minor: number; paid_on: string; note: string | null }[];
  manual: { id: string; month: string; amount_minor: number; note: string | null }[];
  rates: { effective_from: string; rate_bp: number }[] }

export const royaltySummary = (month: string | null) => command<RoyaltySummary>('royalty_summary', { month });
export const royaltyPartner = (partner: string) => command<RoyaltyPartner>('royalty_partner', { partner });
export const paymentAdd = (partner: string, month: string, amount: string, paid_on: string, note: string | null) =>
  command('royalty_payment_add', { partner, month, amount, paid_on, note });
export const paymentDelete = (id: string) => command('royalty_payment_delete', { id });
export const manualAdd = (partner: string, month: string, amount: string, note: string | null) => command('royalty_manual_add', { partner, month, amount, note });
export const manualDelete = (id: string) => command('royalty_manual_delete', { id });
export const rateSet = (partner: string, rate_bp: number, from: string) => command('royalty_rate_set', { partner, rate_bp, from });

export const pct = (bp: number) => `${(bp / 100).toLocaleString('ru-RU')} %`;
