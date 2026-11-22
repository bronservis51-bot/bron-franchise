import { AppError, command } from './backend';
import { createPasswordConfirmationClient, requireClient } from './supabase';

type ManagerAccount = { id: string; email: string };

export async function withManagerPasswordConfirmation<T>(user: ManagerAccount, password: string,
  action: (previousSession: string, accessToken: string) => Promise<T>) {
  const { data: current, error: currentError } = await requireClient().auth.getClaims();
  if (currentError) throw currentError;
  const previous = current?.claims.session_id;
  if (current?.claims.sub !== user.id || typeof previous !== 'string') {
    throw new AppError('unauthenticated', 'Сессия завершена. Войдите снова.', '', '');
  }

  const confirmation = createPasswordConfirmationClient();
  try {
    const { data, error } = await confirmation.auth.signInWithPassword({ email: user.email, password });
    if (error?.code === 'invalid_credentials') {
      throw new AppError('validation', 'Текущий пароль не подошёл.', 'password', '');
    }
    if (error?.status === 429) {
      throw new AppError('validation', 'Слишком много попыток. Повторите позже.', 'password', '');
    }
    if (error) throw error;
    if (data?.session?.user.id !== user.id) {
      throw new AppError('unauthenticated', 'Не удалось подтвердить вашу учётную запись.', '', '');
    }
    return await action(previous, data.session.access_token);
  } finally {
    await confirmation.auth.signOut({ scope: 'local' }).catch(() => undefined);
    await confirmation.auth.dispose().catch(() => undefined);
  }
}

export function changeManagerPhoneLogin(user: ManagerAccount, phone: string, password: string) {
  return withManagerPasswordConfirmation(user, password, (previous_session, accessToken) =>
    command<boolean>('manager_set_my_phone_login', { phone, previous_session }, { accessToken }));
}
