import { command } from '../../platform/backend';
import { operationKey } from '../../platform/operation';
import type { ProcurementAction, ProcurementCatalog, ProcurementList, ProcurementRequest, ShipmentMode } from './types';

export const procurementCatalog = () => command<ProcurementCatalog>('procurement_catalog');
export const procurementList = () => command<ProcurementList>('procurement_list');
export const procurementSubmit = (operation: string, items: { product_id: string; quantity: number }[], shipment_mode: ShipmentMode, note: string) =>
  command<ProcurementRequest>('procurement_submit', { operation, items, shipment_mode, note });

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
