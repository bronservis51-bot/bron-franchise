import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { phoneLoginDigits, phoneLoginInitial } from '../../platform/login';
import { ConfirmDialog, Field, Input } from '../../ui';
import { useToast } from '../../ui/toast';
import { formatPhone } from './api';

/** An explicit login change, separate from password reset or staff pay/profile editing. */
export function PhoneLoginDialog({ user, name, currentPhone, onClose }: {
  user: string; name: string; currentPhone?: string | null; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [phone, setPhone] = useState(() => phoneLoginInitial(currentPhone));
  const digits = phoneLoginDigits(phone);
  const m = useMutation({
    mutationFn: () => command<{ phone: string; login: string; changed: boolean }>('user_set_phone_login', { user, phone }),
    onSuccess: async (result) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['access'] }),
        qc.invalidateQueries({ queryKey: ['staff-list'] }),
        qc.invalidateQueries({ queryKey: ['team'] }),
        qc.invalidateQueries({ queryKey: ['staff-access-history'] }),
      ]);
      toast(result.changed ? 'Телефон для входа изменён. Пароль сохранён.' : 'Этот телефон уже используется для входа.');
      onClose();
    },
  });
  return <ConfirmDialog open title={`Телефон / логин — ${name}`} confirmLabel="Сохранить телефон" busy={m.isPending}
    error={m.error} disabled={!digits} onClose={onClose} onConfirm={() => m.mutate()}>
    <Field label="Телефон для входа" required hint="Полный номер с кодом страны">{id =>
      <Input id={id} type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+7 900 123-45-67" />}</Field>
    {digits && <p className="faint">Новый логин: <strong>{formatPhone(digits)}</strong></p>}
    <p>Пароль останется прежним. После изменения пользователю нужно войти заново с новым номером. Смены, начисления и история сохранятся.</p>
  </ConfirmDialog>;
}
