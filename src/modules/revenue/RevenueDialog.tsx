// Owner declares the whole day; employee payment breakdown stays in their shifts.
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toAppError } from '../../platform/backend';
import { dayLabel } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { useSession } from '../../platform/session';
import { Button, Checkbox, ConfirmDialog, Field, Input, Money, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { canEditRevenueDay, revenueDayOffSet, revenueMonth, revenueTotalSet, type DayRow, type MonthDetail } from './api';

const MAX_TOTAL_MINOR = 100_000_000_000; // revenue_total_set limit in the database
type RevenueAction = 'save-total' | 'mark-off' | 'unmark-off';

export function hasRevenueDiscrepancy(row: DayRow | undefined): row is DayRow & { reported_total_minor: number } {
  return row?.reported_total_minor != null && Number(row.total_minor) > Number(row.reported_total_minor);
}

export function RevenueDialog({ location, locationName, currency, day, existing, dayOff = false, canMarkOff, readOnly = false, onClose }: {
  location: string; locationName: string; currency: string; day: string; existing?: DayRow; dayOff?: boolean; canMarkOff: boolean; readOnly?: boolean; onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const { me } = useSession();
  const qc = useQueryClient(); const toast = useToast();
  const initialTotal = existing ? String(existing.total_minor) : '';
  const initialComment = existing?.entries.find(e => !e.employee_id)?.comment ?? '';
  const [total, setTotal] = useState(initialTotal);
  const [totalValid, setTotalValid] = useState(true);
  const [comment, setComment] = useState(initialComment);
  const [markOff, setMarkOff] = useState(false);
  const [freshMonth, setFreshMonth] = useState<MonthDetail>();
  const [refreshStatus, setRefreshStatus] = useState<'loading' | 'ready' | 'error'>();
  const commentInput = useRef<HTMLInputElement>(null);
  const row = freshMonth ? freshMonth.days.find(entry => entry.day === day) : existing;
  const savedComment = row?.entries.find(entry => !entry.employee_id)?.comment ?? '';
  const staffTotal = (row?.entries ?? []).filter(e => e.employee_id).reduce((a,e) => a + Number(e.total_minor), 0);
  const exceedsLimit = Number(total) > MAX_TOTAL_MINOR;
  const belowStaffTotal = Number(total) < staffTotal;
  const canSave = total !== '' && totalValid && !exceedsLimit && !belowStaffTotal;
  const action: RevenueAction = dayOff ? 'unmark-off' : markOff ? 'mark-off' : 'save-total';
  const newlyMarkedOff = !dayOff && freshMonth?.days_off?.includes(day);
  const locked = Boolean(freshMonth && (freshMonth.editable_days
    ? !canEditRevenueDay(freshMonth, day)
    : !canEditRevenueDay(freshMonth, day) || (freshMonth.status !== 'active' && action !== 'unmark-off')));
  const refreshBlocksSave = refreshStatus === 'loading' || refreshStatus === 'error';
  const saveDisabled = refreshBlocksSave || locked || newlyMarkedOff || (action === 'save-total' && !canSave);
  const refreshDay = async () => {
    setRefreshStatus('loading');
    const month = `${day.slice(0, 7)}-01`;
    const queryKey = ['revenue', 'month', location, month];
    void qc.invalidateQueries({ queryKey: ['revenue', 'overview', month], exact: true });
    try {
      // A request started before the failed write could still carry the old version.
      await qc.cancelQueries({ queryKey, exact: true });
      const fresh = await qc.fetchQuery({
        queryKey, queryFn: () => revenueMonth(location, month), staleTime: 0, retry: false, networkMode: 'always',
      });
      const currentComment = fresh.days.find(entry => entry.day === day)?.entries.find(entry => !entry.employee_id)?.comment ?? '';
      setComment(draft => draft === savedComment ? currentComment : draft);
      setFreshMonth(fresh);
      setRefreshStatus('ready');
    } catch {
      setRefreshStatus('error');
    }
  };
  const save = useMutation({
    networkMode: 'always',
    mutationFn: (action: RevenueAction) => action === 'save-total'
      ? revenueTotalSet(me!.user.id, location, day, total, row?.day_version ?? 'empty', comment.trim() || null)
      : revenueDayOffSet(location, day, action === 'mark-off'),
    onSuccess: (r, action) => {
      toast(action !== 'save-total' ? (action === 'unmark-off' ? t('Отметка о выходном снята', 'Kapalı gün işareti kaldırıldı') : t('Отмечено как выходной', 'Kapalı gün olarak işaretlendi'))
        : r && typeof r === 'object' && 'queued' in r ? t('Сохранено на устройстве — отправится при появлении сети', 'Cihaza kaydedildi. Bağlantı kurulunca gönderilecek.') : t('Выручка сохранена', 'Ciro kaydedildi'));
      if (action === 'unmark-off' && !dayOff) {
        void qc.invalidateQueries({ queryKey: ['rating'] });
        return refreshDay();
      }
      void qc.invalidateQueries({ queryKey: ['revenue'] }); void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['royalty'] }); void qc.invalidateQueries({ queryKey: ['rating'] }); onClose();
    },
    onError: (error, action) => {
      const err = toAppError(error);
      // Calendar guards reject a day off with sales and sales on a day off as validation errors.
      if (err.code === 'version-conflict' || err.code === 'period-locked' ||
        (err.code === 'validation' && (action !== 'save-total' || err.field === 'day'))) {
        if (action === 'mark-off') setMarkOff(false);
        return refreshDay();
      }
    },
  });
  const submit = () => { if (!saveDisabled && !save.isPending) save.mutate(action); };
  const conflict = save.error && toAppError(save.error).code === 'version-conflict';
  const label = dayLabel(day, locale);
  return <ConfirmDialog open title={dayOff ? t(`Выходной · ${label}`, `Kapalı gün · ${label}`) : t(`Выручка за ${label}`, `${label} cirosu`)}
    confirmLabel={dayOff ? t('Отменить выходной', 'Kapalı gün işaretini kaldır') : t('Сохранить', 'Kaydet')} cancelLabel={readOnly ? t('Закрыть', 'Kapat') : undefined} busy={save.isPending} error={conflict ? null : save.error}
    dirty={!readOnly && (markOff || !totalValid || total !== initialTotal || comment !== savedComment)} disabled={saveDisabled} onClose={onClose} onConfirm={readOnly ? undefined : submit}>
    <p className="muted">{locationName}</p>
    {refreshStatus === 'loading' && <p role="status">{t('Загружаем данные дня…', 'Günün verileri yükleniyor…')}</p>}
    {refreshStatus === 'ready' && !newlyMarkedOff && <p role="status">{t('Данные дня обновлены.', 'Günün verileri güncellendi.')}
      {row && !hasRevenueDiscrepancy(row) ? <>{t(' Сейчас учтено ', ' Şu an kayıtlı tutar: ')}<Money minor={row.total_minor} currency={currency} />.</> : t(' Сверьте сумму перед сохранением.', ' Kaydetmeden önce tutarı kontrol edin.')}
    </p>}
    {refreshStatus === 'error' && <div className="stack">
      <p role="alert">{t('Не удалось загрузить обновлённые данные дня. Введённая сумма сохранена в форме.', 'Günün güncel verileri yüklenemedi. Girdiğiniz tutar formda duruyor.')}</p>
      <Button size="sm" onClick={() => void refreshDay()}>{t('Обновить данные дня', 'Günün verilerini yenile')}</Button>
    </div>}
    {hasRevenueDiscrepancy(row) && <p role="status">
      {t('Сумма смен больше ранее указанного итога (', 'Vardiya toplamı, önceden bildirilen toplamı aşıyor (')}<Money minor={row.reported_total_minor} currency={currency} />).
      {t('В выручку включено ', 'Ciroya dahil edilen tutar: ')}<Money minor={row.total_minor} currency={currency} />.
    </p>}
    {(readOnly || locked) && <p>{t('Редактирование за эту дату недоступно.', 'Bu tarihi düzenleyemezsiniz.')}</p>}
    {row?.return_minor ? <p className="faint">{t('Возвраты покупателям за день · ', 'Günlük müşteri iadeleri · ')}<Money minor={row.return_minor} currency={currency} /></p> : null}
    {newlyMarkedOff && <div className="stack">
      <p role="status">{t('Дату отметили как выходной. Чтобы внести выручку, сначала снимите отметку.', 'Gün kapalı olarak işaretlendi. Ciro girmek için önce işareti kaldırın.')}</p>
      {!locked && !readOnly && <Button size="sm" disabled={refreshBlocksSave || save.isPending}
        onClick={() => save.mutate('unmark-off')}>{t('Снять отметку о выходном', 'Kapalı gün işaretini kaldır')}</Button>}
    </div>}
    {dayOff && <p>{t('Если точка работала, снимите отметку и внесите выручку за этот день.', 'Mağaza açıksa kapalı gün işaretini kaldırın ve ciroyu girin.')}</p>}
    {!readOnly && !locked && !newlyMarkedOff && canMarkOff && !row && !dayOff && <Checkbox label={t('Точка не работала', 'Mağaza kapalıydı')} checked={markOff} onChange={setMarkOff} hint={markOff ? t('Сохранится отметка «Выходной».', 'Bu gün kapalı olarak kaydedilecek.') : undefined} />}
    <div hidden={action !== 'save-total' || readOnly}>
    <Field label={t('Вся выручка точки за день', 'Mağazanın günlük toplam cirosu')} hint={t('Включая продажи сотрудников', 'Çalışanların satışları dahil')} error={!totalValid ? t('Укажите сумму, например 12,50.', 'Bir tutar girin. Örneğin 12,50.') : undefined} required>{(id, describedBy) => (
      <MoneyInput id={id} describedBy={describedBy} value={total} onChange={setTotal} onValidityChange={setTotalValid} onEnter={() => commentInput.current?.focus()} enterKeyHint="next" requireExplicitValue currency={currency} placeholder="0" invalid={exceedsLimit || belowStaffTotal} />
    )}</Field>
    {staffTotal > 0 && <div className="stack">
      <p className="faint">{t('По сменам внесено ', 'Vardiyalardan kaydedilen tutar: ')}<Money minor={staffTotal} currency={currency} />{t('. Эта сумма входит в итог дня.', '. Bu tutar günlük toplama dahildir.')}</p>
      {(total === '' || (totalValid && belowStaffTotal)) && <Button size="sm" onClick={() => { setTotal(String(staffTotal)); setTotalValid(true); }}>{t('Подставить итог смен', 'Vardiya toplamını kullan')}</Button>}
    </div>}
    {totalValid && exceedsLimit && <p role="alert">{t('Укажите сумму до ', 'Tutar en çok ')}<Money minor={MAX_TOTAL_MINOR} currency={currency} short />{t(' включительно.', ' olabilir.')}</p>}
    {totalValid && total && belowStaffTotal && <p role="alert">{t('Итог дня должен включать всю выручку по сменам.', 'Günlük toplam tüm vardiya cirosunu içermeli.')}</p>}
    <Field label={t('Комментарий', 'Not')} hint={t('Необязательно', 'İsteğe bağlı')}>{(id, describedBy) => <Input id={id} ref={commentInput} aria-describedby={describedBy} value={comment} onChange={e => setComment(e.target.value)} />}</Field>
    </div>
  </ConfirmDialog>;
}
