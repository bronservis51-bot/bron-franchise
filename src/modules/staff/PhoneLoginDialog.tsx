import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { useLocale } from '../../platform/locale';
import { phoneLoginDigits, phoneLoginInitial } from '../../platform/login';
import { ConfirmDialog, Field, Input } from '../../ui';
import { useToast } from '../../ui/toast';
import { formatPhone } from './api';

/** An explicit login change, separate from password reset or staff pay/profile editing. */
export function PhoneLoginDialog({ user, name, currentPhone, onClose }: {
  user: string; name: string; currentPhone?: string | null; onClose: () => void;
}) {
  const { t } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [phone, setPhone] = useState(() => phoneLoginInitial(currentPhone));
  const digits = phoneLoginDigits(phone);
  const m = useMutation({
    mutationFn: (submittedPhone: string) => command<{ phone: string; login: string; changed: boolean }>('user_set_phone_login', { user, phone: submittedPhone }),
    onSuccess: async (result) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['access'] }),
        qc.invalidateQueries({ queryKey: ['staff-list'] }),
        qc.invalidateQueries({ queryKey: ['team'] }),
        qc.invalidateQueries({ queryKey: ['staff-access-history'] }),
      ]);
      toast(result.changed ? t('Телефон для входа изменён. Пароль сохранён.', 'Giriş numarası değiştirildi. Parola aynı kaldı.')
        : t('Этот телефон уже используется для входа.', 'Bu telefon zaten giriş numarası olarak kullanılıyor.'));
      onClose();
    },
  });
  return <ConfirmDialog open title={t(`Телефон / логин — ${name}`, `Telefon / giriş numarası · ${name}`)}
    confirmLabel={t('Сохранить телефон', 'Telefonu kaydet')} busy={m.isPending}
    error={m.error} disabled={!digits} onClose={onClose} onConfirm={() => { if (digits) m.mutate(digits); }}>
    <Field label={t('Телефон для входа', 'Giriş için telefon numarası')} required hint={t('Полный номер с кодом страны', 'Ülke koduyla birlikte tam numarayı girin')}>{id =>
      <Input id={id} type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder={t('+7 900 123-45-67', '+90 500 123 45 67')} />}</Field>
    {digits && <p className="faint">{t('Новый логин:', 'Yeni giriş numarası:')} <strong>{formatPhone(digits)}</strong></p>}
    <p>{t('Пароль останется прежним. После изменения пользователю нужно войти заново с новым номером. Смены, начисления и история сохранятся.',
      'Parola aynı kalır. Kullanıcı yeni numarayla yeniden giriş yapar. Vardiyalar, kazançlar ve geçmiş korunur.')}</p>
  </ConfirmDialog>;
}
