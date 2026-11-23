import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cleanup, clearQueries, removeQueries, invalidateQueries, clearSnapshot, signOut, remember, setState, getSession, readProfile, saveSnapshot, getSnapshot, from } = vi.hoisted(() => ({
  cleanup: vi.fn(), clearQueries: vi.fn(), clearSnapshot: vi.fn(), signOut: vi.fn(), remember: vi.fn(), setState: vi.fn(),
  getSession: vi.fn(), readProfile: vi.fn(), saveSnapshot: vi.fn(), getSnapshot: vi.fn(), from: vi.fn(), removeQueries: vi.fn(), invalidateQueries: vi.fn(),
}));
// Supply a signed-in provider state without a DOM or a live Auth connection.
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => [initial === null ? { user: { id: 'original-user' }, assignments: [] } : initial, setState],
  useEffect: vi.fn(), useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (value: unknown) => ({ current: value }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear: clearQueries, removeQueries, invalidateQueries }) }));
vi.mock('../../src/platform/offline', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/platform/offline')>(),
  clearUserData: cleanup,
}));
vi.mock('../../src/platform/supabase', () => ({
  snapshot: { clear: clearSnapshot, set: saveSnapshot, get: getSnapshot }, setRememberDevice: remember, supabase: { auth: { signOut, getSession } },
}));
vi.mock('../../src/platform/backend', () => ({ command: readProfile, from, rows: async () => [], toAppError: (e: unknown) => e }));
import { PendingLocalWorkError } from '../../src/platform/offline';
import { SessionProvider } from '../../src/platform/session';

const profile = (id: string, permissions: string[] = []) => ({ user: { id }, assignments: [{ role: 'franchisee_staff', scope_type: 'partner', scope_id: 'partner', permissions }] });
const session = (id: string, access_token: string) => ({ data: { session: { user: { id }, access_token } }, error: null });

beforeEach(() => {
  vi.resetAllMocks();
  cleanup.mockResolvedValue(undefined);
  signOut.mockResolvedValue({ error: null });
  getSession.mockResolvedValue(session('original-user', 'original-token'));
  from.mockReturnValue({ select: vi.fn() });
});

describe('sign-out preserves work if local cleanup is blocked', () => {
  function expectSessionKept() {
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('original-user');
    expect(signOut).not.toHaveBeenCalled(); expect(clearQueries).not.toHaveBeenCalled();
    expect(clearSnapshot).not.toHaveBeenCalled(); expect(remember).not.toHaveBeenCalled(); expect(setState).not.toHaveBeenCalled();
  }

  it('shows a local storage failure and keeps its cause and the current session', async () => {
    const cause = new Error('queue read failed');
    cleanup.mockRejectedValue(cause);
    const failure = SessionProvider({ children: null }).props.value.signOut();
    await expect(failure).rejects.toThrow('Не удалось проверить неотправленные записи на устройстве. Повторите выход позже.');
    await expect(failure.catch((error: Error) => error.cause)).resolves.toBe(cause);
    expectSessionKept();
  });

  it('keeps the pending-work message and current session while records are queued', async () => {
    const queued = new PendingLocalWorkError();
    cleanup.mockRejectedValue(queued);
    const failure = SessionProvider({ children: null }).props.value.signOut();
    await expect(failure).rejects.toThrow('Есть неотправленные записи');
    await expect(failure).rejects.toBe(queued);
    expectSessionKept();
  });
  it('finishes local sign-out only after the atomic work check succeeds', async () => {
    let release!: () => void;
    cleanup.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    const provider = SessionProvider({ children: null });
    const pending = provider.props.value.signOut();
    expect(signOut).not.toHaveBeenCalled(); expect(clearQueries).not.toHaveBeenCalled();
    release(); await pending;
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('original-user');
    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(remember).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('keeps the login screen closed while Auth is removing the old session', async () => {
    let release!: () => void;
    signOut.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    const pending = SessionProvider({ children: null }).props.value.signOut();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    const shownTooSoon = setState.mock.calls.some(([value]) => value === 'signed-out');
    release();
    await pending;
    expect(shownTooSoon).toBe(false);
    expect(setState).toHaveBeenLastCalledWith('signed-out');
  });
});

describe('profile refresh follows the active session', () => {
  it('does not restore a profile returned after sign-out', async () => {
    let finish!: (value: ReturnType<typeof profile>) => void;
    readProfile.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const provider = SessionProvider({ children: null }).props.value;
    const pending = provider.reload();
    await vi.waitFor(() => expect(readProfile).toHaveBeenCalledOnce());
    await provider.signOut();
    setState.mockClear();
    finish(profile('original-user'));
    await pending;
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it('keeps a late response from the previous account out of the next session', async () => {
    let finish!: (value: ReturnType<typeof profile>) => void;
    readProfile.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const provider = SessionProvider({ children: null }).props.value;
    const previous = provider.reload();
    await vi.waitFor(() => expect(readProfile).toHaveBeenCalledOnce());
    getSession.mockResolvedValue(session('next-user', 'next-token'));
    readProfile.mockResolvedValueOnce(profile('next-user'));
    await provider.reload();
    finish(profile('original-user'));
    await previous;
    expect(readProfile.mock.calls).toEqual([
      ['me', {}, { accessToken: 'original-token' }],
      ['me', {}, { accessToken: 'next-token' }],
    ]);
    expect(saveSnapshot.mock.calls.filter(([key]) => key === 'me')).toEqual([['me', profile('next-user')]]);
  });

  it('discards scoped screen data and retains the local work queue when permissions change', async () => {
    getSnapshot.mockImplementation(key => key === 'me' ? profile('original-user', ['procurement.order']) : null);
    readProfile.mockResolvedValue(profile('original-user'));
    await SessionProvider({ children: null }).props.value.reload();
    expect(removeQueries).toHaveBeenCalledOnce();
    const { predicate, type } = removeQueries.mock.calls[0][0];
    expect(type).toBe('inactive');
    expect(predicate({ queryKey: ['staff', 'home', 'original-user'] })).toBe(true);
    expect(predicate({ queryKey: ['local-queue', 'original-user'] })).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ type: 'active', predicate });
    expect(clearQueries).not.toHaveBeenCalled();
  });

  it('returns to login when the current Auth session no longer has an active profile', async () => {
    const cached = profile('original-user');
    getSnapshot.mockImplementation(key => key === 'me' ? cached : null);
    readProfile.mockResolvedValue({ user: null, assignments: [] });
    await SessionProvider({ children: null }).props.value.reload();
    expect(setState).toHaveBeenLastCalledWith('signed-out');
    expect(clearQueries).toHaveBeenCalledOnce();
    expect(clearSnapshot).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('restores a matching stored profile before a first refresh that fails offline', async () => {
    const cached = profile('original-user');
    getSnapshot.mockImplementation(key => key === 'me' ? cached : null);
    readProfile.mockRejectedValue({ code: 'offline' });
    await expect(SessionProvider({ children: null }).props.value.reload()).rejects.toMatchObject({ code: 'offline' });
    expect(setState).toHaveBeenCalledWith(cached);
    expect(setState).toHaveBeenCalledWith('signed-in');
    expect(clearSnapshot).not.toHaveBeenCalled();
  });
});
