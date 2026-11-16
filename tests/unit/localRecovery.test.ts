import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readLocalWork, mergeLocalWork, getSession } = vi.hoisted(() => ({ readLocalWork: vi.fn(), mergeLocalWork: vi.fn(), getSession: vi.fn() }));
vi.mock('../../src/platform/offline', () => ({ readLocalWork, mergeLocalWork }));
vi.mock('../../src/platform/supabase', () => ({ requireClient: () => ({ auth: { getSession } }) }));
import { exportLocalRecovery, importLocalRecovery, MAX_RECOVERY_BYTES, parseLocalRecovery } from '../../src/platform/localRecovery';

const userId = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const time = '2026-11-12T10:00:00.000Z';
const operation = () => ({ userId, clientOpId: operationId, kind: 'revenue_total_set', createdAt: time, attempts: 3,
  payload: { operation: operationId, location: other, day: '2026-11-11', total: '12300', expected_version: 'empty', comment: null },
  lastError: 'Сверьте суммы', lastErrorCode: 'version-conflict' });
const backup = () => ({ format: 'bron-local-work', version: 1, userId, exported_at: time,
  operations: [operation()], drafts: [{ userId, key: 'revenue', value: { total: '12300' }, savedAt: time }] });
const session = (id = userId) => ({ data: { session: { user: { id }, access_token: 'fixture-token-never-export' } }, error: null });

beforeEach(() => {
  vi.resetAllMocks(); getSession.mockResolvedValue(session());
  readLocalWork.mockResolvedValue({ operations: backup().operations, drafts: backup().drafts });
  mergeLocalWork.mockResolvedValue(2);
});

describe('portable local work preserves actor, idempotency, conflicts and drafts', () => {
  it('round trips the original payload, UUID, financial version and blocked error without tokens', async () => {
    const text = await exportLocalRecovery(userId);
    const parsed = parseLocalRecovery(text, userId);
    expect(parsed.operations).toEqual(backup().operations); expect(parsed.drafts).toEqual(backup().drafts);
    expect(text).not.toContain('fixture-token'); expect(readLocalWork).toHaveBeenCalledExactlyOnceWith(userId);
    await expect(importLocalRecovery(userId, text)).resolves.toBe(2);
    expect(mergeLocalWork).toHaveBeenCalledExactlyOnceWith(userId, parsed);
  });
  it('imports the previous operations-only format without clearing unclassified errors', () => {
    const op = operation(); delete (op as Partial<typeof op>).lastErrorCode;
    const parsed = parseLocalRecovery(JSON.stringify({ format: 'bron-pending', exported_at: time, operations: [op] }), userId);
    expect(parsed.drafts).toEqual([]); expect(parsed.operations[0]).toEqual(op);
  });
  it('does not read or export any account before login', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(exportLocalRecovery(userId)).rejects.toThrow('войдите');
    expect(readLocalWork).not.toHaveBeenCalled();
    await expect(importLocalRecovery(userId, JSON.stringify(backup()))).rejects.toThrow('войдите');
    expect(mergeLocalWork).not.toHaveBeenCalled();
  });
  it('refuses an export if the account changes while reading IndexedDB', async () => {
    getSession.mockResolvedValueOnce(session()).mockResolvedValue(session(other));
    await expect(exportLocalRecovery(userId)).rejects.toThrow('войдите');
  });
  it.each(['header', 'operation', 'draft'])('rejects a foreign %s before any write', async scope => {
    const data = backup();
    if (scope === 'header') data.userId = other;
    if (scope === 'operation') data.operations[0].userId = other;
    if (scope === 'draft') data.drafts[0].userId = other;
    await expect(importLocalRecovery(userId, JSON.stringify(data))).rejects.toThrow(/другой/);
    expect(mergeLocalWork).not.toHaveBeenCalled();
  });
  it.each(['uuid', 'version', 'duplicate', 'command', 'secret'])('rejects corrupt %s without changing storage', async damage => {
    const data = backup(); const op = data.operations[0];
    if (damage === 'uuid') op.payload.operation = other;
    if (damage === 'version') delete (op.payload as Partial<typeof op.payload>).expected_version;
    if (damage === 'duplicate') data.operations.push(structuredClone(op));
    if (damage === 'command') op.kind = 'user_set_password';
    if (damage === 'secret') Object.assign(op.payload, { access_token: 'not-allowed' });
    await expect(importLocalRecovery(userId, JSON.stringify(data))).rejects.toThrow('повреждён');
    expect(mergeLocalWork).not.toHaveBeenCalled();
  });
  it('rejects files above the byte limit and excessive nesting', () => {
    expect(() => parseLocalRecovery(' '.repeat(MAX_RECOVERY_BYTES + 1), userId)).toThrow('5 МБ');
    const nested = JSON.stringify(backup()).replace('"total":"12300"', `"total":${'['.repeat(34)}0${']'.repeat(34)}`);
    expect(() => parseLocalRecovery(nested, userId)).toThrow('повреждён');
  });
  it('does not offer an exported backup that cannot be imported by the same version', async () => {
    const draft = { ...backup().drafts[0], value: 'x'.repeat(MAX_RECOVERY_BYTES) };
    readLocalWork.mockResolvedValue({ operations: backup().operations, drafts: [draft] });
    await expect(exportLocalRecovery(userId)).rejects.toThrow('5 МБ');
  });
  it('propagates a storage failure without claiming the import succeeded', async () => {
    mergeLocalWork.mockRejectedValue(new Error('QuotaExceededError'));
    await expect(importLocalRecovery(userId, JSON.stringify(backup()))).rejects.toThrow('QuotaExceededError');
  });
});
