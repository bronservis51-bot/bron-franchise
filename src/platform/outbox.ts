// Сохранение без сети: выручка дня и закрытие смены ставятся в очередь на устройстве и отправляются, когда связь вернётся.
// Повторы используют серверные ключи операций; устаревшее исправление останавливается как конфликт.
import { AppError, command, toAppError } from './backend';
import { opQueue, type QueuedOperation } from './offline';
import { requireClient } from './supabase';

type Kind = QueuedOperation['kind'];
const listeners = new Set<() => void>();
export const onOutboxChange = (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); };
export const notifyOutboxChange = () => listeners.forEach((l) => l());
const changed = notifyOutboxChange;

const temporaryErrors = new Set(['offline', 'external-unavailable', 'unauthenticated', 'maintenance']);
const isTemporary = (e: unknown) => temporaryErrors.has(toAppError(e).code);

export function queuedOperationState(op: QueuedOperation): 'pending' | 'retryable' | 'blocked' {
  if (!op.lastError) return 'pending';
  // A tab running an older release can see the same IndexedDB before it knows the command.
  if ((op.kind === 'shift_submit' || op.kind === 'shift_record_with_return') &&
    op.lastErrorCode === 'unknown' && op.lastError === 'Не удалось выполнить действие') return 'retryable';
  return op.lastErrorCode && temporaryErrors.has(op.lastErrorCode) ? 'retryable' : 'blocked';
}

async function requireQueueOwner(userId: string) {
  const { data, error } = await requireClient().auth.getSession();
  if (!data.session || data.session.user.id !== userId || !data.session.access_token) {
    throw new AppError('unauthenticated', 'Для отправки сохранённых записей войдите в исходную учётную запись.', '', '');
  }
  if (error) throw toAppError(error);
  return data.session.access_token;
}

/** Выполнить команду; без сети — сохранить на устройстве. Возвращает результат или { queued: true }. */
export async function sendOrQueue<T>(userId: string, kind: Kind, args: Record<string, unknown>): Promise<T | { queued: true }> {
  try {
    const accessToken = await requireQueueOwner(userId);
    return await command<T>(kind, args, { accessToken });
  } catch (e) {
    if (!isTemporary(e)) throw e;
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
    for (const op of await queuedOps(userId)) {
      if (op.userId !== userId) throw new AppError('forbidden', 'Сохранённая запись принадлежит другой учётной записи.', '', '');
      if (queuedOperationState(op) === 'blocked') { failed++; continue; }
      try {
        if (op.kind === 'revenue_save' || op.kind === 'shift_close') throw new AppError('version-conflict', 'Запись создана старой версией приложения. Сверьте суммы с актуальным днём перед повторным вводом.', '', '');
        const accessToken = await requireQueueOwner(userId);
        await command(op.kind, op.payload, { accessToken });
      } catch (e) {
        const error = toAppError(e);
        const detail = op.kind === 'shift_submit' && error.code === 'unknown'
          ? error.hint || 'Не удалось отправить смену' : error.detail || error.code;
        await opQueue.recordFailure(op, detail, error.code);
        failed++;
        if (isTemporary(error)) break;
        continue;
      }
      // A storage failure after server success keeps the original operation retryable.
      // Its unchanged operation UUID makes a later retry safe on the server.
      await opQueue.remove(userId, op.clientOpId);
      sent++;
    }
  } finally {
    flushing = false;
    changed();
  }
  return { sent, failed };
}

export async function queuedOps(userId: string) {
  const operations = await opQueue.list(userId);
  // The IndexedDB user index orders matching rows by their primary key, not by creation time.
  return operations.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
export const dropOp = async (userId: string, id: string) => { await opQueue.remove(userId, id); changed(); };
