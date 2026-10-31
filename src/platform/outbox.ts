// Сохранение без сети: выручка дня и закрытие смены ставятся в очередь на устройстве и отправляются, когда связь вернётся.
// Повторы используют серверные ключи операций; устаревшее исправление останавливается как конфликт.
import { AppError, command, toAppError } from './backend';
import { opQueue, type QueuedOperation } from './offline';

type Kind = QueuedOperation['kind'];
const listeners = new Set<() => void>();
export const onOutboxChange = (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
const changed = () => listeners.forEach((l) => l());

const isNetwork = (e: unknown) => ['offline', 'external-unavailable'].includes(toAppError(e).code);

/** Выполнить команду; без сети — сохранить на устройстве. Возвращает результат или { queued: true }. */
export async function sendOrQueue<T>(userId: string, kind: Kind, args: Record<string, unknown>): Promise<T | { queued: true }> {
  try {
    return await command<T>(kind, args);
  } catch (e) {
    if (!isNetwork(e)) throw e;
    await opQueue.add({ userId, clientOpId: String(args.operation ?? crypto.randomUUID()),
      kind, payload: args, createdAt: new Date().toISOString(), attempts: 0 });
    changed();
    return { queued: true };
  }
}

export const pendingCount = async (userId: string) => (await opQueue.list(userId)).length;

let flushing = false;
/** Отправить очередь: при появлении сети и при открытии приложения. Ошибку сервера сохраняем, чтобы показать пользователю. */
export async function flushOutbox(userId: string): Promise<{ sent: number; failed: number }> {
  if (flushing) return { sent: 0, failed: 0 };
  flushing = true;
  let sent = 0;
  let failed = 0;
  try {
    for (const op of await opQueue.list(userId)) {
      if (op.lastError) { failed++; continue; }
      try {
        if (op.kind === 'revenue_save' || op.kind === 'shift_close') throw new AppError('version-conflict', 'Запись создана старой версией приложения. Сверьте суммы с актуальным днём перед повторным вводом.', '', '');
        await command(op.kind, op.payload);
        await opQueue.remove(userId, op.clientOpId);
        sent++;
      } catch (e) {
        if (isNetwork(e)) break;
        await opQueue.add({ ...op, attempts: op.attempts + 1, lastError: toAppError(e).detail || toAppError(e).code });
        failed++;
      }
    }
  } finally {
    flushing = false;
    changed();
  }
  return { sent, failed };
}

export const queuedOps = (userId: string) => opQueue.list(userId);
export const dropOp = async (userId: string, id: string) => { await opQueue.remove(userId, id); changed(); };
