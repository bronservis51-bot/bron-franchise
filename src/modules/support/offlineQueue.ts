// Офлайн-очередь обращений (PWA-03/04): операция хранит client operation ID; повтор на сервере идемпотентен.
// Отправка — при открытии приложения, появлении сети и по кнопке; фоновой синхронизации не обещаем.
import { opQueue } from '../../platform/offline';
import { toAppError } from '../../platform/backend';
import { ticketCommands, type NewTicket } from './api';

export async function queueTicket(userId: string, ticket: NewTicket, clientOpId: string) {
  await opQueue.add({ userId, clientOpId, kind: 'ticket_create', payload: ticket as unknown as Record<string, unknown>, createdAt: new Date().toISOString(), attempts: 0 });
}

let flushing = false;

export async function flushQueue(userId: string): Promise<{ sent: number; failed: number }> {
  if (flushing) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0;
  let failed = 0;
  try {
    for (const op of await opQueue.list(userId)) {
      try {
        if (op.kind === 'ticket_create') await ticketCommands.create(op.payload as unknown as NewTicket, op.clientOpId);
        await opQueue.remove(userId, op.clientOpId);
        sent++;
      } catch (e) {
        const err = toAppError(e);
        // Сеть — оставляем в очереди; отказ сервера (права отозваны, данные неверны) — сохраняем с причиной для пользователя (AT-13)
        await opQueue.add({ ...op, attempts: op.attempts + 1, lastError: err.code === 'offline' || err.code === 'external-unavailable' ? undefined : err.detail || err.code });
        failed++;
        if (err.code === 'offline') break;
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, failed };
}
