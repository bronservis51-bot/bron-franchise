import { beforeEach, describe, expect, it, vi } from 'vitest';

const openDB = vi.hoisted(() => vi.fn());
vi.mock('idb', () => ({ openDB }));

function device() {
  const queueCount = vi.fn().mockResolvedValue(0);
  const queueStore = { index: vi.fn(() => ({ count: queueCount })) };
  const draftDelete = vi.fn().mockResolvedValue(undefined);
  const draftContinue = vi.fn().mockResolvedValue(null);
  const draftCursor = vi.fn().mockResolvedValue({ delete: draftDelete, continue: draftContinue });
  const draftStore = { index: vi.fn(() => ({ openCursor: draftCursor })) };
  const tx = {
    objectStore: vi.fn((name: string) => name === 'queue' ? queueStore : draftStore),
    done: Promise.resolve(), abort: vi.fn(),
  };
  const db = {
    getAllFromIndex: vi.fn().mockResolvedValue([]), delete: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(() => tx),
  };
  openDB.mockResolvedValue(db);
  return { db, tx, queueCount, queueStore, draftStore, draftCursor, draftDelete };
}

beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });

describe('durable queue storage fails closed', () => {
  it('reports an IndexedDB open failure instead of an empty queue', async () => {
    openDB.mockRejectedValue(new Error('IndexedDB unavailable'));
    const { opQueue } = await import('../../src/platform/offline');
    await expect(opQueue.list('user')).rejects.toThrow('IndexedDB unavailable');
  });
  it('reports a failed queue read and a failed removal', async () => {
    const { db } = device(); db.getAllFromIndex.mockRejectedValue(new Error('read failed'));
    db.delete.mockRejectedValue(new Error('delete failed'));
    const { opQueue } = await import('../../src/platform/offline');
    await expect(opQueue.list('user')).rejects.toThrow('read failed');
    await expect(opQueue.remove('user', 'operation')).rejects.toThrow('delete failed');
  });
});

describe('local sign-out cleanup', () => {
  it('checks the queue and clears only that user’s drafts in the same transaction', async () => {
    const { db, tx, queueCount, queueStore, draftStore, draftCursor, draftDelete } = device();
    const { clearUserData } = await import('../../src/platform/offline');
    await clearUserData('user');
    expect(db.transaction).toHaveBeenCalledExactlyOnceWith(['drafts', 'queue'], 'readwrite');
    expect(queueStore.index).toHaveBeenCalledWith('byUser'); expect(queueCount).toHaveBeenCalledWith('user');
    expect(draftStore.index).toHaveBeenCalledWith('byUser'); expect(draftCursor).toHaveBeenCalledWith('user');
    expect(draftDelete).toHaveBeenCalledTimes(1);
    expect(tx.objectStore.mock.calls.map(([name]) => name)).toEqual(['queue', 'drafts']);
    expect(db.delete).not.toHaveBeenCalled(); expect(tx.abort).not.toHaveBeenCalled();
  });
  it('keeps drafts and queue untouched when queued work exists', async () => {
    const { db, tx, queueCount, draftCursor, draftDelete } = device(); queueCount.mockResolvedValue(1);
    const { clearUserData } = await import('../../src/platform/offline');
    await expect(clearUserData('user')).rejects.toThrow('Есть неотправленные записи');
    expect(tx.abort).toHaveBeenCalledTimes(1); expect(draftCursor).not.toHaveBeenCalled();
    expect(draftDelete).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
    expect(tx.objectStore.mock.calls.map(([name]) => name)).toEqual(['queue']);
  });
  it('aborts without clearing local work if the atomic queue check fails', async () => {
    const { db, tx, queueCount, draftDelete } = device(); queueCount.mockRejectedValue(new Error('queue read failed'));
    const { clearUserData } = await import('../../src/platform/offline');
    await expect(clearUserData('user')).rejects.toThrow('queue read failed');
    expect(tx.abort).toHaveBeenCalledTimes(1); expect(draftDelete).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
  });
  it('refuses sign-out cleanup if storage cannot be opened', async () => {
    openDB.mockRejectedValue(new Error('storage denied'));
    const { clearUserData } = await import('../../src/platform/offline');
    await expect(clearUserData('user')).rejects.toThrow('storage denied');
  });
});

describe('account-scoped recovery transactions', () => {
  const operation = { userId: 'user', clientOpId: 'operation', kind: 'revenue_total_set' as const,
    payload: { operation: 'operation', total: '12300', expected_version: 'empty' }, createdAt: '2026-11-12T10:00:00Z', attempts: 0 };
  const draft = { userId: 'user', key: 'day', value: { total: '12300' }, savedAt: '2026-11-12T10:00:00Z' };
  function recoveryDevice(existingOperation?: typeof operation, existingDraft?: typeof draft) {
    const queue = { get: vi.fn().mockResolvedValue(existingOperation), add: vi.fn().mockResolvedValue(undefined),
      index: vi.fn(() => ({ getAll: vi.fn().mockResolvedValue(existingOperation ? [existingOperation] : []) })) };
    const drafts = { get: vi.fn().mockResolvedValue(existingDraft), add: vi.fn().mockResolvedValue(undefined),
      index: vi.fn(() => ({ getAll: vi.fn().mockResolvedValue(existingDraft ? [existingDraft] : []) })) };
    const tx = { objectStore: vi.fn((name: string) => name === 'queue' ? queue : drafts), done: Promise.resolve(), abort: vi.fn() };
    const database = { transaction: vi.fn(() => tx) }; openDB.mockResolvedValue(database);
    return { queue, drafts, tx, database };
  }
  it('copies only the active user’s queue and drafts in one read-only transaction', async () => {
    const { tx, database, queue, drafts } = recoveryDevice(operation, draft);
    const { readLocalWork } = await import('../../src/platform/offline');
    await expect(readLocalWork('user')).resolves.toEqual({ operations: [operation], drafts: [draft] });
    expect(database.transaction).toHaveBeenCalledExactlyOnceWith(['drafts', 'queue'], 'readonly');
    expect(queue.index).toHaveBeenCalledWith('byUser'); expect(drafts.index).toHaveBeenCalledWith('byUser');
    expect(tx.objectStore.mock.calls.map(([name]) => name)).toEqual(['queue', 'drafts']);
  });
  it('does not overwrite local errors when importing the same operation again', async () => {
    const local = { ...operation, attempts: 4, lastError: 'Сверьте суммы', lastErrorCode: 'version-conflict' };
    const { queue, drafts, tx } = recoveryDevice(local, draft);
    const { mergeLocalWork } = await import('../../src/platform/offline');
    await expect(mergeLocalWork('user', { operations: [operation], drafts: [draft] })).resolves.toBe(0);
    expect(queue.add).not.toHaveBeenCalled(); expect(drafts.add).not.toHaveBeenCalled(); expect(tx.abort).not.toHaveBeenCalled();
  });
  it('aborts the entire merge if an operation UUID has a different payload', async () => {
    const { queue, drafts, tx } = recoveryDevice({ ...operation, payload: { ...operation.payload, total: '99999' } });
    const { mergeLocalWork } = await import('../../src/platform/offline');
    await expect(mergeLocalWork('user', { operations: [operation], drafts: [draft] })).rejects.toThrow('другими данными');
    expect(tx.abort).toHaveBeenCalledTimes(1); expect(queue.add).not.toHaveBeenCalled(); expect(drafts.add).not.toHaveBeenCalled();
  });
  it('aborts earlier operation additions too when a later draft conflicts', async () => {
    const { queue, tx } = recoveryDevice(undefined, { ...draft, value: { total: '99999' } });
    const { mergeLocalWork } = await import('../../src/platform/offline');
    await expect(mergeLocalWork('user', { operations: [operation], drafts: [draft] })).rejects.toThrow('другой черновик');
    expect(queue.add).toHaveBeenCalledExactlyOnceWith(operation); expect(tx.abort).toHaveBeenCalledTimes(1);
  });
  it('rejects a foreign account and an IndexedDB write failure without claiming success', async () => {
    const { queue, tx } = recoveryDevice();
    const { mergeLocalWork } = await import('../../src/platform/offline');
    await expect(mergeLocalWork('other-user', { operations: [operation], drafts: [] })).rejects.toThrow('другой');
    expect(queue.add).not.toHaveBeenCalled();
    queue.add.mockRejectedValue(new Error('QuotaExceededError'));
    await expect(mergeLocalWork('user', { operations: [operation], drafts: [draft] })).rejects.toThrow('QuotaExceededError');
    expect(tx.abort).toHaveBeenCalledTimes(2);
  });
});
