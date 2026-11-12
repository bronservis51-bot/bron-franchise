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
