import { command } from '../../platform/backend';

export type Service = 'back' | 'screen' | 'full' | 'camera' | 'laptop' | 'watch' | 'tablet' | 'goods' | 'other';
export const SERVICES: { id: Service; label: string }[] = [
  { id: 'back', label: 'Задняя панель' }, { id: 'screen', label: 'Экран' }, { id: 'full', label: 'Полная' }, { id: 'camera', label: 'Камера' },
  { id: 'laptop', label: 'Ноутбук' }, { id: 'tablet', label: 'Планшет' }, { id: 'watch', label: 'Часы' }, { id: 'goods', label: 'Товар' }, { id: 'other', label: 'Другое' },
];
export const serviceLabel = (s: string) => SERVICES.find((x) => x.id === s)?.label ?? s;
export const PAYMENTS: Record<string, string> = { card: 'Карта', cash: 'Наличные', transfer: 'Перевод', mixed: 'Карта + наличные' };

export interface SaleLine { service: Service; device: string | null; qty: number; price_minor: number }
export interface PosSale {
  id: string; location_id: string; employee_id: string; employee_name: string; client_id: string | null; sold_at: string; day: string; currency: string;
  total_minor: number; payment: string; card_minor: number; warranty_until: string | null; comment: string | null; status: 'done' | 'returned'; return_reason: string | null;
  lines: SaleLine[]; client_name?: string | null; client_phone?: string | null; client_visits?: number | null; location_name?: string;
}
export interface PosDay {
  location: { id: string; name: string; currency: string }; day: string; today: string; can_sell: boolean; sales: PosSale[];
  price_hints: Record<string, number>; devices: string[];
}
export interface Client { id: string; name: string | null; phone: string; visits: number; total_minor: number; last_visit_at: string | null; warranty_until?: string | null; last_device?: string | null; note?: string | null }

export const posDay = (location: string, day: string | null) => command<PosDay>('pos_day', { location, day });
export const clientSearch = (location: string, q: string) => command<Client[]>('pos_client_search', { location, q });
export const clientCard = (client: string) => command<Client & { sales: PosSale[]; partner_id: string | null }>('pos_client_card', { client });
export const comeback = (location: string) => command<{ long_ago: Client[]; warranty_ending: (Client & { warranty_until: string })[] }>('pos_comeback', { location });
export const pos = {
  sell: (a: { location: string; phone: string | null; name: string | null; lines: SaleLine[]; payment: string; card: number | null; comment: string | null; key: string }) =>
    command<{ sale: PosSale; client: Client | null; replayed?: boolean }>('pos_sale_create', a),
  ret: (sale: string, reason: string) => command('pos_sale_return', { sale, reason }),
  note: (client: string, name: string | null, note: string | null) => command('pos_client_note', { client, name, note }),
};
export const phoneDigits = (p: string | null) => {
  const d = (p ?? '').replace(/\D/g, '');
  return /^8\d{10}$/.test(d) ? `7${d.slice(1)}` : d;
};
