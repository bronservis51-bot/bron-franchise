import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../platform/session';
import { enrollManagerRecovery, managerRecoveryStatus } from '../platform/managerRecovery';
import { ConfirmDialog, DataState, Field, Input } from '../ui';

export function ManagerRecoverySettings({ onClose }: { onClose: () => void }) {
  const { me } = useSession();
  const status = useQuery({ queryKey: ['manager-recovery', me?.user.id], queryFn: managerRecoveryStatus, enabled: Boolean(me),
    staleTime: 0, retry: false, refetchOnWindowFocus: true });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canSend = Boolean(me && status.data && !status.data.verified && !sent);

  async function submit() {
    if (!me || !canSend || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await enrollManagerRecovery(me.user, password)) setSent(true);
      else await status.refetch();
    } catch (cause) {
      setError(cause);
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  return <ConfirmDialog open title="Почта для восстановления" cancelLabel="Закрыть" confirmLabel={canSend ? 'Отправить письмо' : undefined}
    busy={busy} error={error} disabled={!password} onClose={onClose} onConfirm={() => void submit()}>
    <DataState query={status} skeleton={2}>{(contact) => contact ? <>
      <p className="recovery-email"><strong>{contact.email}</strong></p>
      {contact.verified ? <p role="status">{contact.reset_enabled ? 'Адрес подтверждён. Сброс по почте доступен.'
        : 'Адрес подтверждён. Сброс по почте подключает администратор.'}</p> : <>
        {(sent || contact.pending) && <p role="status">Проверьте почту и откройте ссылку из письма.</p>}
        {canSend && <Field label="Текущий пароль" required>{id =>
          <Input id={id} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />}</Field>}
      </>}
    </> : <p>Почта для восстановления пока недоступна. Восстановить доступ поможет администратор системы.</p>}</DataState>
  </ConfirmDialog>;
}
