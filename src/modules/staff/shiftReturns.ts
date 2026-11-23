import { captureSession, command } from '../../platform/backend';
import { operationKey } from '../../platform/operation';
import { sendOrQueue } from '../../platform/outbox';
import type { CloseResult } from './api';

type ShiftTarget = { locationId: string; day: string } | { shiftId: string; revision: number };
type Sale = { cash: string; card: string; returned: string; comment?: string | null };
type Correction = { ok: true; revision: number };

export function recordShiftReturn(userId: string, target: ShiftTarget, sale: Sale): Promise<CloseResult | { queued: true }>;
export function recordShiftReturn(userId: string, target: { shiftId: string; revision: number }, sale: Sale & { reason: string }): Promise<Correction>;
export async function recordShiftReturn(userId: string, target: ShiftTarget, sale: Sale & { reason?: string }) {
  const args = {
    cash: sale.cash, card: sale.card, return: sale.returned, comment: sale.comment ?? null, reason: sale.reason ?? null,
    location: 'locationId' in target ? target.locationId : null,
    day: 'day' in target ? target.day : null,
    shift: 'shiftId' in target ? target.shiftId : null,
    expected_revision: 'revision' in target ? target.revision : null,
  };
  const name = 'shift_record_with_return';
  const actor = sale.reason !== undefined ? await captureSession(userId) : null;
  const receipt = await operationKey(userId, name, args);
  const payload = { ...args, operation: receipt.id };
  const result = actor
    ? await command<Correction>(name, payload, { accessToken: actor.access_token })
    : await sendOrQueue<CloseResult>(userId, name, payload);
  receipt.complete();
  return result;
}
