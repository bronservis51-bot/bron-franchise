import { AuthApiError } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginErrorText } from '../../src/app/loginDiagnostics';

beforeEach(() => vi.stubGlobal('navigator', { onLine: true }));
afterEach(() => vi.unstubAllGlobals());

describe('login feedback', () => {
  it.each([
    new AuthApiError('User is banned', 400, 'user_banned'),
    { msg: 'User is banned', code: 400, error_code: 'user_banned' },
    { message: 'User is banned', status: 400 },
  ])('recognizes a blocked account without showing a raw provider message', (error) => {
    expect(loginErrorText(error)).toEqual({ text: 'Вход закрыт. Обратитесь к своему руководителю.', detail: '' });
    expect(loginErrorText(error, 'tr')).toEqual({ text: 'Giriş engellendi. Yöneticinizle iletişime geçin.', detail: '' });
  });

  it('uses one message for invalid credentials and does not infer a block from the HTTP status', () => {
    expect(loginErrorText(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'))).toEqual({
      text: 'Неверный логин или пароль.', detail: '',
    });
    expect(loginErrorText(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'), 'tr')).toEqual({
      text: 'Kullanıcı adı veya parola hatalı.', detail: '',
    });
    expect(loginErrorText(new AuthApiError('Forbidden', 403, 'unexpected_failure')).text).toBe('Не удалось войти.');
  });
});
