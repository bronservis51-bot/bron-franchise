import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import type { QueuedOperation } from '../../src/platform/offline';

const { list, add, remove } = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/platform/offline', () => ({ opQueue: { list, add, remove } }));
vi.mock('../../src/platform/config', () => ({
  isConfigured: true,
  config: { supabaseUrl: 'https://queue-test.invalid', supabaseKey: 'public-fixture-key-for-offline-tests' },
}));
import { supabase } from '../../src/platform/supabase';
import { command, toAppError } from '../../src/platform/backend';
import { flushOutbox } from '../../src/platform/outbox';

// Deliberately fake opaque tokens: requests only reach the fetch stub below.
const session = (id: string, access_token: string) => ({ data: { session: { user: { id }, access_token } as Session }, error: null });
const payload = { operation: 'operation-A', location: 'location', day: '2026-11-10', total: '12345', expected_version: 'version-A', comment: null };
const op: QueuedOperation = { userId: 'user-A', clientOpId: payload.operation, kind: 'revenue_total_set', payload, attempts: 0, createdAt: '2026-11-10T12:00:00Z' };
const requestFetch = vi.fn<typeof fetch>();
const success = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', requestFetch);
  vi.stubGlobal('navigator', { onLine: true });
  list.mockResolvedValue([structuredClone(op)]); add.mockResolvedValue(undefined); remove.mockResolvedValue(undefined);
  requestFetch.mockResolvedValue(success());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('real Supabase RPC authorization for queued work', () => {
  it('binds only this request to captured A when the shared session switches to B before fetch', async () => {
    const getSession = vi.spyOn(supabase!.auth, 'getSession')
      .mockResolvedValueOnce(session('user-A', 'fixture-token-A'))
      .mockResolvedValue(session('user-B', 'fixture-token-B'));
    await expect(flushOutbox('user-A')).resolves.toEqual({ sent: 1, failed: 0 });
    // The installed Supabase fetch wrapper really re-reads the newer shared session.
    expect(getSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [input, init] = requestFetch.mock.calls[0];
    expect(String(input)).toBe('https://queue-test.invalid/rest/v1/rpc/revenue_total_set');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token-A');
    expect(JSON.parse(String(init?.body))).toEqual(Object.fromEntries(Object.entries(payload).map(([key, value]) => [`p_${key}`, value])));
    expect(remove).toHaveBeenCalledExactlyOnceWith('user-A', 'operation-A');

    // A normal later RPC uses B: no client-wide auth/header mutation was made.
    requestFetch.mockResolvedValue(success());
    await command('me');
    expect(new Headers(requestFetch.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer fixture-token-B');
  });

  it('retains a revoked captured A operation and retries after fresh A sign-in with the same UUID and version', async () => {
    vi.spyOn(supabase!.auth, 'getSession')
      .mockResolvedValueOnce(session('user-A', 'fixture-revoked-A'))
      .mockResolvedValue(session('user-B', 'fixture-token-B'));
    requestFetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PGRST301', message: 'JWT expired' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    }));
    await expect(flushOutbox('user-A')).resolves.toEqual({ sent: 0, failed: 1 });
    expect(remove).not.toHaveBeenCalled();
    const retained = add.mock.calls[0][0] as QueuedOperation;
    expect(retained).toMatchObject({ userId: 'user-A', clientOpId: 'operation-A', payload, lastErrorCode: 'unauthenticated' });
    expect(new Headers(requestFetch.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer fixture-revoked-A');

    list.mockResolvedValue([retained]);
    vi.mocked(supabase!.auth.getSession).mockResolvedValue(session('user-A', 'fixture-fresh-A'));
    requestFetch.mockResolvedValue(success());
    await expect(flushOutbox('user-A')).resolves.toEqual({ sent: 1, failed: 0 });
    expect(new Headers(requestFetch.mock.calls[1][1]?.headers).get('Authorization')).toBe('Bearer fixture-fresh-A');
    expect(requestFetch.mock.calls[1][1]?.body).toBe(requestFetch.mock.calls[0][1]?.body);
    expect(remove).toHaveBeenCalledExactlyOnceWith('user-A', 'operation-A');
  });

  it('preserves an explicit server maintenance code for retry classification', () => {
    expect(toAppError({ message: 'maintenance', details: 'Переключение базы' })).toMatchObject({ code: 'maintenance', detail: 'Переключение базы' });
  });

  it.each([
    [{ message: 'version-conflict' }, 'version-conflict'],
    [{ message: 'idempotency-conflict' }, 'idempotency-conflict'],
    [{ message: 'forbidden' }, 'forbidden'],
    [{ message: 'permission denied', code: '42501' }, 'forbidden'],
    [{ message: 'JWT expired', code: 'PGRST301' }, 'unauthenticated'],
    [{ message: 'unrecognized-server-error', code: 'P0001' }, 'unknown'],
    [{ message: 'invalid network configuration', code: 'P0001' }, 'unknown'],
  ])('does not replace a received server error with offline: %j', (error, code) => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(toAppError(error).code).toBe(code);
  });

  it('still classifies an actual fetch failure while disconnected as offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    expect(toAppError(new TypeError('Failed to fetch')).code).toBe('offline');
  });
});
