import { beforeEach, expect, it, vi } from 'vitest';

const { change, getClaims, signIn, signOut, dispose } = vi.hoisted(() => ({
  change: vi.fn(), getClaims: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), dispose: vi.fn(),
}));
vi.mock('../../src/platform/backend', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/platform/backend')>(), command: change,
}));
vi.mock('../../src/platform/supabase', () => ({
  requireClient: () => ({ auth: { getClaims } }),
  createPasswordConfirmationClient: () => ({ auth: { signInWithPassword: signIn, signOut, dispose } }),
}));
import { changeManagerPhoneLogin } from '../../src/platform/managerLogin';

const user = { id: 'manager-id', email: 'manager@example.invalid' };
const phone = '99900013210';
const password = crypto.randomUUID();

beforeEach(() => {
  vi.clearAllMocks();
  getClaims.mockResolvedValue({ data: { claims: { session_id: 'origin-session', sub: user.id } } });
  signIn.mockResolvedValue({ data: { session: { user, access_token: 'synthetic-auth-proof' } } });
  change.mockResolvedValue(true);
  signOut.mockResolvedValue({ error: null });
  dispose.mockResolvedValue(undefined);
});

it('only sends the password to Auth and pins the change command to the temporary session', async () => {
  await expect(changeManagerPhoneLogin(user, phone, password)).resolves.toBe(true);
  expect(signIn).toHaveBeenCalledExactlyOnceWith({ email: user.email, password });
  expect(change).toHaveBeenCalledExactlyOnceWith('manager_set_my_phone_login', { phone, previous_session: 'origin-session' },
    { accessToken: 'synthetic-auth-proof' });
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  expect(dispose).toHaveBeenCalledOnce();
});

it('keeps the current session and drops the temporary client on a command failure', async () => {
  const failure = new Error('synthetic RPC failure');
  change.mockRejectedValue(failure);
  await expect(changeManagerPhoneLogin(user, phone, password)).rejects.toBe(failure);
  expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  expect(dispose).toHaveBeenCalledOnce();
});

it('never sends the change command if the password or account was not verified', async () => {
  signIn.mockResolvedValueOnce({ error: { code: 'invalid_credentials' } });
  await expect(changeManagerPhoneLogin(user, phone, password)).rejects.toMatchObject({ code: 'validation', field: 'password' });
  signIn.mockResolvedValueOnce({ data: { session: { user: { id: 'another-id' }, access_token: 'synthetic-auth-proof' } } });
  await expect(changeManagerPhoneLogin(user, phone, password)).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(change).not.toHaveBeenCalled();
});
