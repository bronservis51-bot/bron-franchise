import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedOperation } from '../../src/platform/offline';

const { rpc, add, list, remove, getSession, records } = vi.hoisted(() => ({
  rpc: vi.fn(), add: vi.fn(), list: vi.fn(), remove: vi.fn(), getSession: vi.fn(),
  records: new Map<string, QueuedOperation>(),
}));
vi.mock('../../src/platform/backend', () => ({
  command: rpc, toAppError: (e: unknown) => e,
  AppError: class extends Error { constructor(public code: string, public detail: string) { super(detail); } },
}));
vi.mock('../../src/platform/offline', () => ({ opQueue: { add, list, remove } }));
vi.mock('../../src/platform/supabase', () => ({ requireClient: () => ({ auth: { getSession } }) }));
import { flushOutbox, sendOrQueue } from '../../src/platform/outbox';

const payload = { operation: 'original-operation', location: 'location', day: '2026-11-10', total: '12345', expected_version: 'original-version', comment: null };
const operation = (changes: Partial<QueuedOperation> = {}): QueuedOperation => ({
  userId: 'user', clientOpId: payload.operation, kind: 'revenue_total_set', payload: { ...payload },
  createdAt: '2026-11-10T12:00:00Z', attempts: 0, ...changes,
});
const put = (op = operation()) => records.set(op.clientOpId, structuredClone(op));

beforeEach(() => {
  vi.resetAllMocks(); records.clear();
  getSession.mockResolvedValue({ data: { session: { user: { id: 'user' }, access_token: 'fixture-user-token' } }, error: null });
  rpc.mockResolvedValue({ ok: true });
  add.mockImplementation(async (op: QueuedOperation) => { records.set(op.clientOpId, structuredClone(op)); });
  list.mockImplementation(async (userId: string) => [...records.values()].filter(op => op.userId === userId));
  remove.mockImplementation(async (_userId: string, id: string) => { records.delete(id); });
});

describe('offline storage truthfulness', () => {
  it('never returns queued success after the device rejects the write', async () => {
    rpc.mockRejectedValue({ code: 'offline' }); add.mockRejectedValue(new Error('QuotaExceededError'));
    await expect(sendOrQueue('user', 'revenue_total_set', payload)).rejects.toThrow('QuotaExceededError');
  });
  it('preserves the operation UUID and financial version in the durable queue', async () => {
    rpc.mockRejectedValue({ code: 'offline' });
    await expect(sendOrQueue('user', 'revenue_total_set', payload)).resolves.toEqual({ queued: true });
    expect(records.get(payload.operation)).toMatchObject({ userId: 'user', clientOpId: payload.operation, payload });
  });
  it('fails closed on queue read errors', async () => {
    put(); list.mockRejectedValue(new Error('IndexedDB unavailable'));
    await expect(flushOutbox('user')).rejects.toThrow('IndexedDB unavailable');
    expect(rpc).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(records.size).toBe(1);
  });
  it('keeps a server-successful operation retryable if durable removal fails', async () => {
    put(); remove.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    await expect(flushOutbox('user')).rejects.toThrow('IndexedDB unavailable');
    expect(records.get(payload.operation)).toEqual(operation());
    await expect(flushOutbox('user')).resolves.toEqual({ sent: 1, failed: 0 });
    expect(rpc.mock.calls).toEqual([['revenue_total_set', payload, { accessToken: 'fixture-user-token' }], ['revenue_total_set', payload, { accessToken: 'fixture-user-token' }]]);
  });
});

describe('outbox recovery preserves the original actor and operation', () => {
  it('retries after re-authentication as the same UUID with the exact original payload', async () => {
    put(); getSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    await expect(flushOutbox('user')).resolves.toEqual({ sent: 0, failed: 1 });
    expect(rpc).not.toHaveBeenCalled();
    expect(records.get(payload.operation)).toMatchObject({ clientOpId: payload.operation, payload, lastErrorCode: 'unauthenticated' });
    await expect(flushOutbox('user')).resolves.toEqual({ sent: 1, failed: 0 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('revenue_total_set', payload, { accessToken: 'fixture-user-token' });
    expect(records.size).toBe(0);
  });
  it('durably saves the attempted operation when the editing session has expired', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(sendOrQueue('user', 'revenue_total_set', payload)).resolves.toEqual({ queued: true });
    expect(rpc).not.toHaveBeenCalled(); expect(records.get(payload.operation)).toMatchObject({ userId: 'user', payload });
  });
  it('retries a declared maintenance failure without changing its operation or expected version', async () => {
    put(); rpc.mockRejectedValueOnce({ code: 'maintenance', detail: 'Переключение базы' });
    await expect(flushOutbox('user')).resolves.toEqual({ sent: 0, failed: 1 });
    expect(records.get(payload.operation)).toMatchObject({ lastErrorCode: 'maintenance', payload });
    await expect(flushOutbox('user')).resolves.toEqual({ sent: 1, failed: 0 });
    expect(rpc.mock.calls).toEqual([['revenue_total_set', payload, { accessToken: 'fixture-user-token' }], ['revenue_total_set', payload, { accessToken: 'fixture-user-token' }]]);
  });
  it.each(['version-conflict', 'idempotency-conflict', 'forbidden'])('never automatically retries %s', async code => {
    put(); rpc.mockRejectedValueOnce({ code, detail: code });
    await flushOutbox('user'); await flushOutbox('user');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(records.get(payload.operation)).toMatchObject({ payload, lastErrorCode: code });
  });
  it('does not reinterpret an old unclassified error as retryable', async () => {
    put(operation({ lastError: 'Сессия истекла' }));
    await expect(flushOutbox('user')).resolves.toEqual({ sent: 0, failed: 1 });
    expect(rpc).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
  });
  it.each(['revenue_save', 'shift_close'] as const)('keeps legacy %s for manual reconciliation', async kind => {
    put(operation({ kind })); await flushOutbox('user'); await flushOutbox('user');
    expect(rpc).not.toHaveBeenCalled();
    expect(records.get(payload.operation)).toMatchObject({ kind, lastErrorCode: 'version-conflict', payload });
  });
  it('never sends the previous user’s operation under a different current session', async () => {
    put(); getSession.mockResolvedValue({ data: { session: { user: { id: 'other-user' } } }, error: null });
    await flushOutbox('user');
    expect(rpc).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(records.get(payload.operation)).toMatchObject({ userId: 'user', payload, lastErrorCode: 'unauthenticated' });
    await flushOutbox('other-user');
    expect(rpc).not.toHaveBeenCalled(); expect(records.size).toBe(1);
  });
  it('rejects a foreign row even if the storage index returns it', async () => {
    const foreign = operation({ userId: 'other-user' }); put(foreign); list.mockResolvedValue([foreign]);
    await expect(flushOutbox('user')).rejects.toMatchObject({ code: 'forbidden' });
    expect(rpc).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
});
