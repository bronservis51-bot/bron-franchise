import { toBigInt } from '../../platform/money';
import type { LocationMonth } from '../revenue/api';
import type { RoyaltyRow } from './api';

interface Franchisee { partner_id: string; partner_name: string }
type RetailPoint = Pick<LocationMonth, keyof Franchisee | 'currency' | 'fact_minor' | 'missing_days'>;
type RoyaltyBalance = Pick<RoyaltyRow, keyof Franchisee | 'currency' | 'accrued_minor' | 'manual_minor' | 'paid_minor' | 'debt_minor' | 'is_open'>;

export interface PartnerEconomy extends Franchisee {
  currency: string;
  payroll_minor: number;
  payroll_halves?: [number, number];
  closed_shifts: number;
  expenses_minor: number;
  expense_categories: { category: string; amount_minor: number }[];
}

export interface SupplyRow extends Franchisee {
  mapped_count: number;
  counterparties: string[];
  sales_minor: number;
  cost_minor: number;
  profit_minor: number;
}

interface ComparisonRow {
  id: string;
  name: string;
  retail: Map<string, bigint>;
  missingDays: number | null;
  salaries?: PartnerEconomy;
  royalty?: RoyaltyBalance;
  supply?: SupplyRow;
}

export function economyComparison({ points = [], salaries = [], royalties = [], supplies = [] }: {
  points?: RetailPoint[];
  salaries?: PartnerEconomy[];
  royalties?: RoyaltyBalance[];
  supplies?: SupplyRow[];
}) {
  const rows = new Map<string, ComparisonRow>();
  const forPartner = ({ partner_id: id, partner_name: name }: Franchisee) => {
    const present = rows.get(id);
    if (present) return present;
    const row: ComparisonRow = { id, name, retail: new Map(), missingDays: null };
    rows.set(id, row);
    return row;
  };

  for (const point of points) {
    const row = forPartner(point);
    row.retail.set(point.currency, (row.retail.get(point.currency) ?? 0n) + toBigInt(point.fact_minor));
    row.missingDays = (row.missingDays ?? 0) + point.missing_days.length;
  }
  for (const partner of salaries) forPartner(partner).salaries = partner;
  for (const partner of royalties) forPartner(partner).royalty = partner;
  for (const partner of supplies) forPartner(partner).supply = partner;
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

export function networkSpreadsheetLink(value: unknown) {
  return typeof value === 'string' && /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,100}\/edit$/.test(value)
    ? value : null;
}
