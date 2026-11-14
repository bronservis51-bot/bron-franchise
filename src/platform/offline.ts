// Черновики и очередь операций в IndexedDB, раздельно по пользователю (PWA-03, PWA-05).
// Схема версионируется: обновление приложения мигрирует, а не стирает данные (PWA-06).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface QueuedOperation {
  userId: string;
  clientOpId: string;
  kind: 'shift_close_versioned' | 'revenue_total_set' | 'revenue_save' | 'shift_close' | 'revenue_save_checked' | 'shift_close_checked';
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError?: string;
  /** Missing on old records: an unknown old error must never be retried automatically. */
  lastErrorCode?: string;
}

export interface DraftRow {
  userId: string;
  key: string;
  value: unknown;
  savedAt: string;
}

interface BronDB extends DBSchema {
  drafts: { key: [string, string]; value: DraftRow; indexes: { byUser: string } };
  queue: { key: [string, string]; value: QueuedOperation; indexes: { byUser: string } };
}

let dbPromise: Promise<IDBPDatabase<BronDB>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<BronDB>('bron-local', 2, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          const drafts = database.createObjectStore('drafts', { keyPath: ['userId', 'key'] });
          drafts.createIndex('byUser', 'userId');
        }
        if (oldVersion < 2) {
          const queue = database.createObjectStore('queue', { keyPath: ['userId', 'clientOpId'] });
          queue.createIndex('byUser', 'userId');
        }
      },
    });
  }
  return dbPromise;
}

async function guarded<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback; // приватный режим или запрет хранилища: приложение работает без черновиков
  }
}

export const drafts = {
  save: (userId: string, key: string, value: unknown) =>
    guarded(async () => void (await (await db()).put('drafts', { userId, key, value, savedAt: new Date().toISOString() })), undefined),
  load: <T>(userId: string, key: string) =>
    guarded(async () => ((await (await db()).get('drafts', [userId, key])) as DraftRow | undefined) as (DraftRow & { value: T }) | undefined, undefined),
  remove: (userId: string, key: string) => guarded(async () => void (await (await db()).delete('drafts', [userId, key])), undefined),
};

export const opQueue = {
  add: async (op: QueuedOperation) => { await (await db()).put('queue', op); },
  // A storage failure is not an empty queue or a successful removal.
  list: async (userId: string) => (await db()).getAllFromIndex('queue', 'byUser', userId),
  remove: async (userId: string, clientOpId: string) => { await (await db()).delete('queue', [userId, clientOpId]); },
};

/** A consistent copy of one account only. Other accounts on a shared device are never read. */
export async function readLocalWork(userId: string) {
  const tx = (await db()).transaction(['drafts', 'queue'], 'readonly');
  const [operations, savedDrafts] = await Promise.all([
    tx.objectStore('queue').index('byUser').getAll(userId),
    tx.objectStore('drafts').index('byUser').getAll(userId),
    tx.done,
  ]);
  if (operations.some(row => row.userId !== userId) || savedDrafts.some(row => row.userId !== userId)) {
    throw new Error('Локальные записи принадлежат другой учётной записи.');
  }
  return { operations, drafts: savedDrafts };
}

/** All-or-nothing merge: never overwrite an existing operation or draft with different data. */
export async function mergeLocalWork(userId: string, work: { operations: QueuedOperation[]; drafts: DraftRow[] }) {
  const tx = (await db()).transaction(['drafts', 'queue'], 'readwrite');
  let added = 0;
  try {
    for (const row of work.operations) {
      if (row.userId !== userId) throw new Error('Копия принадлежит другой учётной записи.');
      const store = tx.objectStore('queue');
      const old = await store.get([userId, row.clientOpId]);
      // Attempts/errors may have advanced locally. Preserve the local state, and never clear a conflict.
      if (old && (old.kind !== row.kind || !sameJson(old.payload, row.payload))) {
        throw new Error('На устройстве уже есть операция с этим UUID и другими данными. Импорт отменён.');
      }
      if (!old) { await store.add(row); added++; }
    }
    for (const row of work.drafts) {
      if (row.userId !== userId) throw new Error('Копия принадлежит другой учётной записи.');
      const store = tx.objectStore('drafts');
      const old = await store.get([userId, row.key]);
      if (old && !sameJson(old.value, row.value)) {
        throw new Error('На устройстве уже есть другой черновик. Импорт отменён; обе копии сохранены.');
      }
      if (!old) { await store.add(row); added++; }
    }
    await tx.done;
    return added;
  } catch (error) {
    try { tx.abort(); } catch { /* already aborted */ }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

/** JSON data only; object-key order is not a change to a financial operation. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort(); const right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, i) => key === right[i] && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/** Sign-out checks the queue and clears drafts atomically; it never deletes queued operations. */
export async function clearUserData(userId: string) {
  const tx = (await db()).transaction(['drafts', 'queue'], 'readwrite');
  try {
    if (await tx.objectStore('queue').index('byUser').count(userId)) {
      throw new Error('Есть неотправленные записи. Сначала отправьте их или сохраните копию из списка очереди.');
    }
    let cursor = await tx.objectStore('drafts').index('byUser').openCursor(userId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch { /* The failed transaction may already have aborted. */ }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

/** Update guards inspect every user's durable work and fail closed if storage cannot be read. */
export async function hasPendingLocalWork(): Promise<boolean> {
  try { const d = await db(); return (await d.count('queue')) > 0 || (await d.count('drafts')) > 0; }
  catch { return true; }
}
