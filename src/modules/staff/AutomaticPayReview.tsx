import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command, toAppError } from '../../platform/backend';
import { dayLabel } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { Button, Card, Checkbox, ConfirmDialog, DataState, Field, Input, Money } from '../../ui';

interface PendingDay {
  location_id: string;
  location_name: string;
  day: string;
  currency: string;
  total_minor: number | null;
  version: string;
  people: { id: string; name: string; automatic: boolean }[];
  blocked: boolean;
  unconfigured: boolean;
  confirmable: boolean;
  previously_confirmed: boolean;
}

export function AutomaticPayReview({ partner, month }: { partner: string; month: string }) {
  const { t, locale } = useLocale();
  const client = useQueryClient();
  const [selected, setSelected] = useState<PendingDay | null>(null);
  const query = useQuery({
    queryKey: ['automatic-pay-days', partner, month],
    queryFn: () => command<PendingDay[]>('automatic_pay_days', { partner, month }),
    refetchInterval: 30_000,
  });
  return <>
    <DataState query={query} skeleton={1}>{days => days.length > 0 &&
      <Card title={t('Подтвердить автоматические начисления', 'Otomatik kazançları onayla')}>
        <ul className="list">
          {days.map(day => <li key={day.location_id + day.day} className="pay-scheme-item">
            <div>
              <strong>{day.location_name} · {dayLabel(day.day, locale)}</strong>
              <div className="faint">
                {t(`Сотрудников в закрытых сменах: ${day.people.length}`, `Kapanan vardiyalardaki çalışan sayısı: ${day.people.length}`)}
              </div>
              {day.total_minor !== null && <Money minor={day.total_minor} currency={day.currency} />}
            </div>
            <Button size="sm" onClick={() => setSelected(day)}>
              {day.previously_confirmed ? t('Сверить изменения', 'Değişiklikleri incele') : t('Проверить', 'Kontrol et')}
            </Button>
          </li>)}
        </ul>
      </Card>}
    </DataState>
    {selected && <ConfirmAutomaticPay day={selected} onClose={() => setSelected(null)} onConfirmed={() => {
      setSelected(null);
      for (const key of ['automatic-pay-days', 'staff-list', 'staff', 'finance', 'manager-economy']) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    }} onConflict={() => void query.refetch()} />}
  </>;
}

function ConfirmAutomaticPay({ day, onClose, onConfirmed, onConflict }: {
  day: PendingDay; onClose: () => void; onConfirmed: () => void; onConflict: () => void;
}) {
  const { t, locale } = useLocale();
  const [checked, setChecked] = useState(false);
  const [reason, setReason] = useState('');
  const confirm = useMutation({
    mutationFn: () => command('automatic_pay_confirm', {
      location: day.location_id,
      day: day.day,
      expected_version: day.version,
      expected_staff: day.people.map(person => person.id),
      reason: day.previously_confirmed ? reason.trim() : 'Касса и фактический состав смены подтверждены',
    }),
    onSuccess: onConfirmed,
    onError: error => { if (toAppError(error).code === 'version-conflict') onConflict(); },
  });
  const disabled = !checked || day.blocked || !day.confirmable || day.total_minor === null ||
    (day.previously_confirmed && reason.trim().length < 3) || toAppError(confirm.error).code === 'version-conflict';
  return <ConfirmDialog open title={t('Касса и состав смены', 'Ciro ve vardiya ekibi')}
    confirmLabel={day.previously_confirmed ? t('Пересчитать начисления', 'Kazançları yeniden hesapla') : t('Подтвердить начисления', 'Kazançları onayla')}
    disabled={disabled} busy={confirm.isPending} error={confirm.error}
    onClose={onClose} onConfirm={() => confirm.mutate()}>
    <p><strong>{day.location_name}</strong> · {dayLabel(day.day, locale)}</p>
    {day.total_minor !== null
      ? <p>{t('Общая касса точки за день', 'Mağazanın günlük toplam cirosu')} <Money minor={day.total_minor} currency={day.currency} strong /></p>
      : <p>{t('Внесите выручку точки за этот день.', 'Bu gün için mağaza cirosunu girin.')}</p>}
    <ul>
      {day.people.map(person => <li key={person.id}>{person.name}{person.automatic &&
        <span className="faint"> · {t('автоматический расчёт', 'otomatik hesaplama')}</span>}</li>)}
    </ul>
    {day.blocked && <p>{t('Сначала закройте все открытые смены этой точки за день.', 'Önce mağazanın o günkü açık vardiyalarını kapatın.')}</p>}
    {day.unconfigured && <p>{t('Автоматическая схема рассчитана максимум на трёх сотрудников. Проверьте состав и назначенные схемы. Если они верны, согласуйте оплату по неподдерживаемым сменам отдельно.',
      'Otomatik plan en fazla üç çalışanı kapsar. Vardiya ekibini ve ücret planlarını kontrol edin. Doğruysa desteklenmeyen vardiyaların ücretini ayrıca belirleyin.')}</p>}
    <Checkbox checked={checked} onChange={setChecked} label={t('Касса полная, список совпадает с фактическим составом смены.',
      'Ciro tutarı tam ve listedeki çalışanlar vardiyaya katıldı.')} />
    {day.previously_confirmed && <Field label={t('Причина перерасчёта', 'Yeniden hesaplama nedeni')} required>{id =>
      <Input id={id} value={reason} maxLength={1000} onChange={event => setReason(event.target.value)} />}</Field>}
  </ConfirmDialog>;
}
