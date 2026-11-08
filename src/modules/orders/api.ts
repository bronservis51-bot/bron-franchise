import { command } from '../../platform/backend';
import { operationKey } from '../../platform/operation';
import { setCurrencyMinorUnits } from '../../platform/money';
import type { ProcurementAction, ProcurementCatalog, ProcurementList, ProcurementRequest, ShipmentMode } from './types';

export async function procurementCatalog() {
  const result = await command<ProcurementCatalog>('procurement_catalog');
  if (result.shop?.currency && Number.isInteger(result.shop.currency_minor_unit) && result.shop.currency_minor_unit! >= 0 && result.shop.currency_minor_unit! <= 4) {
    setCurrencyMinorUnits([{ code: result.shop.currency, minor_unit: result.shop.currency_minor_unit! }]);
  }
  return result;
}
export const procurementList = () => command<ProcurementList>('procurement_list');
export const procurementSubmit = (operation: string, items: { product_id: string; quantity: number }[], shipment_mode: ShipmentMode, note: string) =>
  command<ProcurementRequest>('procurement_submit', { operation, items, shipment_mode, note });
export const procurementCheckout = (operation: string, items: { product_id: string; quantity: number; price_minor: number }[], price_version: string, shipment_mode: ShipmentMode, note: string) =>
  command<ProcurementRequest>('procurement_checkout', { operation, items, price_version, shipment_mode, note });

export async function procurementIncomingSet(user: string, data: { product_id: string; purchase_order_id: string; quantity: number; eta: string; note: string; expected_version: number }) {
  const receipt = await operationKey(user, 'procurement_incoming_set', data);
  const result = await command('procurement_incoming_set', { data, operation: receipt.id });
  receipt.complete(); return result;
}

/** The receipt survives a lost response and retry; the server also checks the payload and version. */
export async function procurementAction(user: string, id: string, expected_version: number, action: ProcurementAction, data: unknown) {
  const args = { id, expected_version, action, data };
  const receipt = await operationKey(user, 'procurement_action', args);
  const result = await command<ProcurementRequest>('procurement_action', { ...args, operation: receipt.id });
  receipt.complete();
  return result;
}
