import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cleanup, clearQueries, clearSnapshot, signOut, remember, setState } = vi.hoisted(() => ({
  cleanup: vi.fn(), clearQueries: vi.fn(), clearSnapshot: vi.fn(), signOut: vi.fn(), remember: vi.fn(), setState: vi.fn(),
}));
// Supply a signed-in provider state without a DOM or a live Auth connection.
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => [initial === null ? { user: { id: 'original-user' }, assignments: [] } : initial, setState],
  useEffect: vi.fn(), useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear: clearQueries }) }));
vi.mock('../../src/platform/offline', () => ({ clearUserData: cleanup }));
vi.mock('../../src/platform/supabase', () => ({
  snapshot: { clear: clearSnapshot }, setRememberDevice: remember, supabase: { auth: { signOut } },
}));
vi.mock('../../src/platform/backend', () => ({ command: vi.fn(), from: vi.fn(), rows: vi.fn(), toAppError: (e: unknown) => e }));
import { SessionProvider } from '../../src/platform/session';

beforeEach(() => { vi.resetAllMocks(); cleanup.mockResolvedValue(undefined); signOut.mockResolvedValue({ error: null }); });

describe('sign-out preserves work if local cleanup is blocked', () => {
  it.each(['queue read failed', 'Есть неотправленные записи'])('keeps the session and cached work after %s', async message => {
    cleanup.mockRejectedValue(new Error(message));
    const provider = SessionProvider({ children: null });
    await expect(provider.props.value.signOut()).rejects.toThrow(message);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('original-user');
    expect(signOut).not.toHaveBeenCalled(); expect(clearQueries).not.toHaveBeenCalled();
    expect(clearSnapshot).not.toHaveBeenCalled(); expect(remember).not.toHaveBeenCalled(); expect(setState).not.toHaveBeenCalled();
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
});
