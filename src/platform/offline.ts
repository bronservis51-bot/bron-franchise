// Черновики и очередь операций в IndexedDB, раздельно по пользователю (PWA-03, PWA-05).
// Схема версионируется: обновление приложения мигрирует, а не стирает данные (PWA-06).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface QueuedOperation {
  userId: string;
  clientOpId: string;
  kind: 'ticket_create';
  payload: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  lastError?: string;
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
  add: (op: QueuedOperation) => guarded(async () => void (await (await db()).put('queue', op)), undefined),
  list: (userId: string) => guarded(async () => (await db()).getAllFromIndex('queue', 'byUser', userId), [] as QueuedOperation[]),
  remove: (userId: string, clientOpId: string) => guarded(async () => void (await (await db()).delete('queue', [userId, clientOpId])), undefined),
};

/** Выход или смена пользователя: черновики и очередь этого пользователя удаляются (PWA-05). */
export async function clearUserData(userId: string) {
  await guarded(async () => {
    const d = await db();
    const tx = d.transaction(['drafts', 'queue'], 'readwrite');
    for (const store of ['drafts', 'queue'] as const) {
      let cursor = await tx.objectStore(store).index('byUser').openCursor(userId);
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
    }
    await tx.done;
  }, undefined);
}
