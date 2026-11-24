// A full-day declaration includes sales already recorded in shifts.
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toAppError } from '../../platform/backend';
import { hasPaymentDiscrepancy, RevenueBreakdown } from './RevenueBreakdown';
import { dayLabel } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { useSession } from '../../platform/session';
import { Button, Checkbox, ConfirmDialog, Field, Input, Money, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { canEditRevenueDay, revenueDayOffSet, revenueMonth, revenueSplitSet, type DayRow, type MonthDetail } from './api';

const MAX_TOTAL_MINOR = 100_000_000_000; // revenue_total_set limit in the database
type RevenueAction = 'save-split' | 'mark-off' | 'unmark-off';

export function hasRevenueDiscrepancy(row: DayRow | undefined): row is DayRow & { reported_total_minor: number } {
  return row?.reported_total_minor != null && Number(row.total_minor) > Number(row.reported_total_minor);
}

function paymentAmount(row: DayRow | undefined, method: 'cash' | 'card') {
  const reported = row?.[`reported_${method}_minor`];
  const known = reported ?? (row && !Number(row.unallocated_minor ?? 0) ? row[`${method}_minor`] : undefined);
  return known == null ? '' : String(known);
}

export function RevenueDialog({ location, locationName, currency, day, existing, dayOff = false, canMarkOff, readOnly = false, onClose }: {
  location: string; locationName: string; currency: string; day: string; existing?: DayRow; dayOff?: boolean; canMarkOff: boolean; readOnly?: boolean; onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const { me } = useSession();
  const qc = useQueryClient(); const toast = useToast();

  const initialComment = existing?.entries.find(e => !e.employee_id)?.comment ?? '';
  const [cash, setCash] = useState(() => paymentAmount(existing, 'cash'));
  const [card, setCard] = useState(() => paymentAmount(existing, 'card'));
  const [cashValid, setCashValid] = useState(true);
  const [cardValid, setCardValid] = useState(true);
  const [comment, setComment] = useState(initialComment);
  const [markOff, setMarkOff] = useState(false);
  const [freshMonth, setFreshMonth] = useState<MonthDetail>();
  const [refreshStatus, setRefreshStatus] = useState<'loading' | 'ready' | 'error'>();
  const cardInput = useRef<HTMLInputElement>(null);
  const commentInput = useRef<HTMLInputElement>(null);
  const row = freshMonth ? freshMonth.days.find(entry => entry.day === day) : existing;
  const savedComment = row?.entries.find(entry => !entry.employee_id)?.comment ?? '';
  const savedCash = paymentAmount(row, 'cash');
  const savedCard = paymentAmount(row, 'card');
  const staff = (row?.entries ?? []).filter(entry => entry.employee_id);
  const staffCash = staff.reduce((sum, entry) => sum + Number(entry.cash_minor), 0);
  const staffCard = staff.reduce((sum, entry) => sum + Number(entry.card_minor), 0);
  const total = Number(cash) + Number(card);
  const exceedsLimit = total > MAX_TOTAL_MINOR;
  const belowStaffCash = cash !== '' && Number(cash) < staffCash;
  const belowStaffCard = card !== '' && Number(card) < staffCard;
  const canSave = cash !== '' && card !== '' && cashValid && cardValid && !exceedsLimit && !belowStaffCash && !belowStaffCard;
  const action: RevenueAction = dayOff ? 'unmark-off' : markOff ? 'mark-off' : 'save-split';
  const newlyMarkedOff = !dayOff && freshMonth?.days_off?.includes(day);
  const locked = Boolean(freshMonth && (freshMonth.editable_days
    ? !canEditRevenueDay(freshMonth, day)
    : !canEditRevenueDay(freshMonth, day) || (freshMonth.status !== 'active' && action !== 'unmark-off')));
  const refreshBlocksSave = refreshStatus === 'loading' || refreshStatus === 'error';
  const saveDisabled = refreshBlocksSave || locked || newlyMarkedOff || (action === 'save-split' && !canSave);
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
      const freshRow = fresh.days.find(entry => entry.day === day);
      const currentComment = freshRow?.entries.find(entry => !entry.employee_id)?.comment ?? '';
      if (cashValid) setCash(draft => draft === savedCash ? paymentAmount(freshRow, 'cash') : draft);
      if (cardValid) setCard(draft => draft === savedCard ? paymentAmount(freshRow, 'card') : draft);
      setComment(draft => draft === savedComment ? currentComment : draft);
      setFreshMonth(fresh);
      setRefreshStatus('ready');
    } catch {
      setRefreshStatus('error');
    }
  };
  const save = useMutation({
    networkMode: 'always',
    mutationFn: (action: RevenueAction) => action === 'save-split'
      ? revenueSplitSet(me!.user.id, location, day, cash, card, row?.day_version ?? 'empty', comment.trim() || null)
      : revenueDayOffSet(location, day, action === 'mark-off'),
    onSuccess: (r, action) => {
      toast(action !== 'save-split' ? (action === 'unmark-off' ? t('Отметка о выходном снята', 'Kapalı gün işareti kaldırıldı') : t('Отмечено как выходной', 'Kapalı gün olarak işaretlendi'))
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
        (err.code === 'validation' && (action !== 'save-split' || err.field === 'day'))) {
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
    dirty={!readOnly && (markOff || !cashValid || !cardValid || cash !== savedCash || card !== savedCard || comment !== savedComment)} disabled={saveDisabled} onClose={onClose} onConfirm={readOnly ? undefined : submit}>
    <p className="muted">{locationName}</p>
    {refreshStatus === 'loading' && <p role="status">{t('Загружаем данные дня…', 'Günün verileri yükleniyor…')}</p>}
    {refreshStatus === 'ready' && !newlyMarkedOff && <p role="status">{t('Данные дня обновлены.', 'Günün verileri güncellendi.')}
      {t(' Сверьте наличные и карту перед сохранением.', ' Kaydetmeden önce nakit ve kart tutarlarını kontrol edin.')}
    </p>}
    {refreshStatus === 'error' && <div className="stack">
      <p role="alert">{t('Не удалось загрузить обновлённые данные дня. Введённая сумма сохранена в форме.', 'Günün güncel verileri yüklenemedi. Girdiğiniz tutar formda duruyor.')}</p>
      <Button size="sm" onClick={() => void refreshDay()}>{t('Обновить данные дня', 'Günün verilerini yenile')}</Button>
    </div>}
    {row && <div className="revenue-day-breakdown">
      <p><strong>{t('Выручка учтена', 'Kayıtlı ciro')} · <Money minor={row.total_minor} currency={currency} /></strong></p>
      <RevenueBreakdown row={row} currency={currency} />
    </div>}
    {hasRevenueDiscrepancy(row) && <p role="status">
      {t('Сумма смен больше ранее указанного итога (', 'Vardiya toplamı, önceden bildirilen toplamı aşıyor (')}<Money minor={row.reported_total_minor} currency={currency} />).
      {t('В выручку включено ', 'Ciroya dahil edilen tutar: ')}<Money minor={row.total_minor} currency={currency} />.
    </p>}
    {hasPaymentDiscrepancy(row) &&
      <p role="status">{t('После изменения смен разбивка разошлась с итогом дня. Сверьте наличные и карту.',
        'Vardiya değişikliğinden sonra ödeme türleri günlük kayıtla uyuşmuyor. Nakit ve kart tutarlarını kontrol edin.')}</p>}
    {(readOnly || locked) && <p>{t('Редактирование за эту дату недоступно.', 'Bu tarihi düzenleyemezsiniz.')}</p>}
    {row?.return_minor ? <p className="faint">{t('Возвраты покупателям за день · ', 'Günlük müşteri iadeleri · ')}<Money minor={row.return_minor} currency={currency} /></p> : null}
    {newlyMarkedOff && <div className="stack">
      <p role="status">{t('Дату отметили как выходной. Чтобы внести выручку, сначала снимите отметку.', 'Gün kapalı olarak işaretlendi. Ciro girmek için önce işareti kaldırın.')}</p>
      {!locked && !readOnly && <Button size="sm" disabled={refreshBlocksSave || save.isPending}
        onClick={() => save.mutate('unmark-off')}>{t('Снять отметку о выходном', 'Kapalı gün işaretini kaldır')}</Button>}
    </div>}
    {dayOff && <p>{t('Если точка работала, снимите отметку и внесите выручку за этот день.', 'Mağaza açıksa kapalı gün işaretini kaldırın ve ciroyu girin.')}</p>}
    {!readOnly && !locked && !newlyMarkedOff && canMarkOff && !row && !dayOff && <Checkbox label={t('Точка не работала', 'Mağaza kapalıydı')} checked={markOff} onChange={setMarkOff} hint={markOff ? t('Сохранится отметка «Выходной».', 'Bu gün kapalı olarak kaydedilecek.') : undefined} />}
    <div hidden={action !== 'save-split' || readOnly}>
    {row && row.reported_cash_minor == null && Number(row.unallocated_minor ?? 0) > 0 &&
      <p>{t('В старой записи часть выручки без разбивки. Сверьте полный итог, прежде чем сохранять новые суммы.',
        'Eski kayıtta cironun bir kısmının ödeme türü belirtilmemiş. Yeni tutarları kaydetmeden önce toplamı kontrol edin.')}</p>}
    <p className="muted">{t('Укажите всю выручку точки по каждому способу оплаты, включая продажи сотрудников.',
      'Çalışanların satışları dahil, mağazanın her ödeme türündeki toplam cirosunu girin.')}</p>
    <Field label={t('Наличные', 'Nakit')} required error={!cashValid ? t('Укажите сумму наличных.', 'Nakit tutarını girin.') : undefined}>
      {(id, describedBy) => <MoneyInput id={id} describedBy={describedBy} value={cash} onChange={setCash}
        onValidityChange={setCashValid} onEnter={() => cardInput.current?.focus()} enterKeyHint="next"
        requireExplicitValue currency={currency} placeholder="0" invalid={exceedsLimit || belowStaffCash} />}
    </Field>
    <Field label={t('Карта', 'Kart')} required error={!cardValid ? t('Укажите сумму по карте.', 'Kart tutarını girin.') : undefined}>
      {(id, describedBy) => <MoneyInput id={id} inputRef={el => { cardInput.current = el; }} describedBy={describedBy} value={card} onChange={setCard}
        onValidityChange={setCardValid} onEnter={() => commentInput.current?.focus()} enterKeyHint="next"
        requireExplicitValue currency={currency} placeholder="0" invalid={exceedsLimit || belowStaffCard} />}
    </Field>
    {cash !== '' && card !== '' && cashValid && cardValid && <p><strong>{t('Итого', 'Toplam')} · <Money minor={total} currency={currency} /></strong></p>}
    {staffCash + staffCard > 0 && <p className="faint">
      {t('По сменам', 'Vardiyalarda')} · <RevenueBreakdown row={{ cash_minor: staffCash, card_minor: staffCard }} currency={currency} />
    </p>}
    {exceedsLimit && <p role="alert">{t('Укажите сумму до ', 'Tutar en çok ')}<Money minor={MAX_TOTAL_MINOR} currency={currency} short />{t(' включительно.', ' olabilir.')}</p>}
    {(belowStaffCash || belowStaffCard) && <p role="alert">{t('Наличные и карта должны включать суммы, уже внесённые по сменам.', 'Nakit ve kart tutarları, vardiyalarda kaydedilen tutarları içermelidir.')}</p>}
    <Field label={t('Комментарий', 'Not')} hint={t('Необязательно', 'İsteğe bağlı')}>{(id, describedBy) => <Input id={id} ref={commentInput} aria-describedby={describedBy} value={comment} onChange={e => setComment(e.target.value)} />}</Field>
    </div>
  </ConfirmDialog>;
}
