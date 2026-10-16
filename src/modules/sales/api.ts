import { command, storage } from '../../platform/backend';
import { compressImage, sha256 } from '../../ui/files';

export interface SaleEntry {
  id: string; day: string; employee_id: string; revenue_minor: number; returns_minor: number; card_minor: number | null; services_count: number;
  source: 'self' | 'manager'; revision: number; comment: string | null; reduced_by_manager?: boolean; rate_bp?: number; files?: number;
}
export interface MyDay extends SaleEntry { location_id: string; location_name: string; currency: string; rate_bp: number; earnings_minor: number; locked: boolean }
export interface SellLocation { id: string; name: string; currency: string; timezone: string; today: string; rate_bp: number; can_manage: boolean; today_done: boolean }
export interface OpenShift { id: string; location_id: string; location_name: string; day: string; opened_at: string; currency: string; rate_bp: number; timezone: string }
export interface MyEarnings {
  month: string; locations: SellLocation[]; days: MyDay[]; open_shift: OpenShift | null;
  totals: { currency: string; revenue_minor: number; net_minor: number; earnings_minor: number; shifts: number }[];
}
export interface SalesEmployee { id: string; name: string; rate_bp: number; personal_rate: boolean; can_sell: boolean; on_shift_since: string | null }
export interface SalesMonth {
  location: { id: string; name: string; currency: string; timezone: string }; month: string; today: string; can_manage: boolean; locked: boolean; rate_bp: number;
  employees: SalesEmployee[]; entries: SaleEntry[]; missing_days: string[]; days_off?: { day: string; reason: string }[];
  policies: { id: string; employee_id: string | null; rate_bp: number; effective_from: string; note: string | null }[];
  totals: { revenue_minor: number; returns_minor: number; card_minor: number; services: number; days_with_data: number; earnings_minor: number }; days_in_period: number;
}
export interface SalesForReport {
  period: string; days_in_period: number;
  locations: { location_id: string; location_name: string; gross_minor: number; returns_minor: number; days_with_data: number; missing_days: string[] }[];
}
export interface ControlRow {
  location_id: string; location_name: string; partner_name: string; kind: string; currency: string; revenue_minor: number; services: number;
  days_with_data: number; missing_days: number; avg_check_minor: number | null; card_share: number | null; film_phones_60d: number; services_60d: number; services_est_60d: number;
  reductions: number; manager_entries: number; report_diff_minor: number; report_period: string | null; risk: number;
}

export const myEarnings = (month: string) => command<MyEarnings>('my_earnings', { month });
export const salesMonth = (location: string, month: string) => command<SalesMonth>('sales_month', { location, month });
export const salesForReport = (contract: string, period: string) => command<SalesForReport>('sales_for_report', { contract, period });
export const salesControl = (month: string) => command<{ month: string; days_in_period: number; locations: ControlRow[] }>('sales_control', { month });

/** Фото кассового отчёта / чека терминала к смене: подготовка на сервере → загрузка в приватное хранилище → подтверждение. */
async function attachPhoto(sale: string, file: File) {
  const blob = await compressImage(file);
  const mime = blob === file ? file.type : 'image/jpeg';
  const name = blob === file ? file.name : file.name.replace(/\.\w+$/, '.jpg');
  const prep = await command<{ file_id: string; path: string }>('sale_attach_prepare', { sale, name, mime, size: blob.size, checksum: await sha256(blob) });
  await storage.upload(prep.path, new File([blob], name, { type: mime }));
  await command('file_confirm', { file: prep.file_id });
}

export const salesCommands = {
  save: (a: { location: string; day: string; employee: string | null; revenue: string; returns: string; services: number; comment: string | null; expected_revision: number | null; card?: string | null }) =>
    command<SaleEntry>('sale_save', { ...a, card: a.card ?? null }),
  remove: (sale: string, reason: string) => command('sale_delete', { sale, reason }),
  dayOff: (location: string, day: string, off: boolean, reason: string | null) => command('sales_day_off_set', { location, day, off, reason }),
  openShift: (location: string) => command<{ id: string }>('shift_open', { location }),
  cancelShift: (shift: string) => command('shift_cancel', { shift }),
  async closeShift(a: { shift: string; revenue: string; card: string | null; returns: string; services: number; comment: string | null; photo: File | null }) {
    const s = await command<SaleEntry>('shift_close', { shift: a.shift, revenue: a.revenue, card: a.card, returns: a.returns, services: a.services, comment: a.comment });
    if (a.photo) await attachPhoto(s.id, a.photo);
    return s;
  },
  attachPhoto,
  setCommission: (location: string, employee: string | null, rate_bp: number, effective_from: string | null, note: string | null) =>
    command('commission_set', { location, employee, rate_bp, effective_from, note }),
};

/** Заработок по ставке в базисных пунктах (2000 = 20%) — как на сервере: round(нетто × ставка / 10000). */
export function earnings(netMinor: bigint, rateBp: number): bigint {
  const x = netMinor * BigInt(rateBp);
  return (x + 5000n) / 10000n;
}
export const pct = (bp: number) => `${(bp / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`;
