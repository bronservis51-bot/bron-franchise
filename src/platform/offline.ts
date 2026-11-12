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

interface DraftRow {
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
