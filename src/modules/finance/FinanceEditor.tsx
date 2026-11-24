import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { CalendarX, ChevronRight } from 'lucide-react';
import { toAppError } from '../../platform/backend';
import { dayLabel } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { groupByCurrency } from '../../platform/money';
import { Alert, Button, Card, ConfirmDialog, DataState, EmptyState, Money, Skeleton } from '../../ui';
import { hasPaymentDiscrepancy, RevenueBreakdown } from '../revenue/RevenueBreakdown';
import { DayList } from '../revenue/components';
import { hasRevenueDiscrepancy, RevenueDialog } from '../revenue/RevenueDialog';
import { canEditRevenueDay, revenueMonth, type DayRow, type MonthDetail } from '../revenue/api';

type DaySelection = { point: string; day: string };
type DayEntry = { point: MonthDetail; row?: DayRow; off: boolean; missing: boolean };
interface FinanceDaysProps {
  month: string;
  location: string | null;
  locations: { id: string; name: string }[];
  requestedDay: string | null;
  readOnly: boolean;
  clearRequestedDay: () => void;
}

function entryFor(point: MonthDetail, day: string, readOnly: boolean): DayEntry | null {
  if (day < point.month || day > point.today || day.slice(0, 7) !== point.month.slice(0, 7)) return null;
  const row = point.days.find(item => item.day === day);
  const off = point.days_off?.includes(day) ?? false;
  const missing = point.missing_days.includes(day);
  if (!row && !off && !missing && (readOnly || !canEditRevenueDay(point, day))) return null;
  return { point, row, off, missing };
}

export function FinanceDays({ month, location, locations, requestedDay, readOnly, clearRequestedDay }: FinanceDaysProps) {
  const { t } = useLocale();
  const [selected, setSelected] = useState<DaySelection | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const points = location ? locations.filter(item => item.id === location) : locations;
  const queries = useQueries({ queries: points.map(point => ({
    queryKey: ['revenue', 'month', point.id, month], queryFn: () => revenueMonth(point.id, month),
  })) });
  const details = queries.flatMap(query => query.data && (!query.error ||
    !['forbidden', 'unauthenticated'].includes(toAppError(query.error).code)) ? [query.data] : []);
  const errors = queries.flatMap((query, index) => query.isError ? [{ query, name: points[index].name }] : []);
  const missingCount = details.reduce((count, point) => count + point.missing_days.length, 0);
  const showMissing = onlyMissing && missingCount > 0;
  const single = points.length === 1;
  const linkedPoint = location ?? (single ? points[0].id : null);
  const open = selected ?? (requestedDay && linkedPoint ? { point: linkedPoint, day: requestedDay } : null);
  const detail = open && details.find(point => point.location_id === open.point);
  const entry = open && detail ? entryFor(detail, open.day, readOnly) : null;
  const setOpen = (point: MonthDetail, day: string) => setSelected({ point: point.location_id, day });
  const close = () => {
    setSelected(null);
    if (requestedDay) clearRequestedDay();
  };

  if (!points.length) return <EmptyState title={t('Точки ещё не добавлены', 'Henüz satış noktası eklenmedi')} />;

  return <Card title={t('Выручка по дням', 'Günlük satış geliri')} className="finance-days"
    actions={missingCount > 0 ? <Button size="sm" variant="ghost" aria-pressed={showMissing} onClick={() => setOnlyMissing(value => !value)}>
      <CalendarX size={16} aria-hidden />{t('Пропущено', 'Eksik gün')} {missingCount}
    </Button> : undefined}>
    {single ? <DataState query={queries[0]}>
      {point => <LocationCalendar point={point} onlyMissing={showMissing} readOnly={readOnly} onPick={day => setOpen(point, day)} />}
    </DataState> : <>
      {errors.length > 0 && <Alert tone="warning" title={t('Не удалось обновить дни по точкам', 'Bazı satış noktalarının günleri güncellenemedi')}
        action={<Button size="sm" onClick={() => errors.forEach(({ query }) => void query.refetch())}>{t('Повторить', 'Tekrar dene')}</Button>}>
        {errors.map(({ name }) => name).join(', ')}
      </Alert>}
      {!details.length && queries.some(query => query.isLoading) ? <Skeleton /> :
        <AllLocationDays points={details} totalsReady={queries.every(query => query.isSuccess)}
          onlyMissing={showMissing} readOnly={readOnly} linkedDay={requestedDay}
          expanded={expanded} setExpanded={setExpanded} onPick={setOpen} />}
    </>}
    {entry && open && (readOnly || !canEditRevenueDay(entry.point, open.day)
      ? <DayHistory day={open.day} entry={entry} onClose={close} />
      : <RevenueDialog key={open.point + open.day}
          location={entry.point.location_id} locationName={entry.point.location_name} currency={entry.point.currency}
          day={open.day} existing={entry.row} dayOff={entry.off}
          canMarkOff={Boolean(entry.point.editable_days) || entry.point.status === 'active'} onClose={close} />)}
  </Card>;
}

function LocationCalendar({ point, onlyMissing, readOnly, onPick }: {
  point: MonthDetail; onlyMissing: boolean; readOnly: boolean; onPick: (day: string) => void;
}) {
  const { t } = useLocale();
  const calendar = onlyMissing ? { ...point, days: [], days_off: [] } : point;
  return <>
    {onlyMissing && <p className="faint">{t('Показаны пропущенные дни', 'Eksik günler gösteriliyor')}</p>}
    <DayList m={calendar} readOnly={readOnly || onlyMissing} showHistory onPick={onPick} />
  </>;
}

function AllLocationDays({ points, totalsReady, onlyMissing, readOnly, linkedDay, expanded, setExpanded, onPick }: {
  points: MonthDetail[]; totalsReady: boolean; onlyMissing: boolean; readOnly: boolean; linkedDay: string | null;
  expanded: boolean; setExpanded: (expanded: boolean) => void;
  onPick: (point: MonthDetail, day: string) => void;
}) {
  const { t, locale } = useLocale();
  const byDay = new Map<string, DayEntry[]>();
  for (const point of points) {
    const dates = new Set(onlyMissing ? point.missing_days : [...point.missing_days, ...(point.days_off ?? []), ...point.days.map(row => row.day), point.today]);
    for (const day of dates) {
      const entry = entryFor(point, day, readOnly);
      if (entry) byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }
  }
  const ordered = [...byDay.keys()].sort().reverse();
  const visible = expanded ? ordered : ordered.slice(0, 7);
  const dates = linkedDay && byDay.has(linkedDay) && !visible.includes(linkedDay) ? [linkedDay, ...visible] : visible;
  if (!dates.length) return <EmptyState title={t('В этом месяце записей нет', 'Bu ay kayıt yok')} />;

  return <>
    <ul className="finance-day-groups">
      {dates.map(day => {
        const entries = byDay.get(day) ?? [];
        const totals = groupByCurrency(entries.filter(entry => entry.row), entry => entry.point.currency, entry => entry.row?.total_minor);
        return <li key={day}>
          <header className="finance-day-group-title" aria-current={linkedDay === day ? 'date' : undefined}>
            <time dateTime={day}>{dayLabel(day, locale)}</time>
            {totalsReady && [...totals].map(([currency, total]) => <Money key={currency} minor={total} currency={currency} short strong />)}
          </header>
          <ul className="finance-day-points">
            {entries.map(({ point, row, off, missing }) => <li key={point.location_id}>
              <button className="finance-day-point" type="button" onClick={() => onPick(point, day)}>
                <span>{point.location_name}</span>
                <span className={missing ? 'danger-text' : undefined}>
                  {row ? <Money minor={row.total_minor} currency={point.currency} short /> :
                    off ? t('Выходной', 'Kapalı') : t('Не внесено', 'Kaydedilmedi')}
                </span>
                <ChevronRight size={16} aria-hidden />
                {row && <small className="finance-day-payment faint"><RevenueBreakdown row={row} currency={point.currency} /></small>}
                {hasRevenueDiscrepancy(row) && <small className="finance-day-warning" role="status">
                  {t('Сумма смен больше указанного итога', 'Vardiya toplamı bildirilen tutardan fazla')}
                </small>}
              </button>
            </li>)}
          </ul>
        </li>;
      })}
    </ul>
    {ordered.length > 7 && <Button variant="ghost" onClick={() => setExpanded(!expanded)}>
      {expanded ? t('Свернуть', 'Daha az göster') : t('Все дни месяца', 'Ayın tüm günleri')}
    </Button>}
  </>;
}

function DayHistory({ day, entry: { point, row, off }, onClose }: { day: string; entry: DayEntry; onClose: () => void }) {
  const { t, locale } = useLocale();
  return <ConfirmDialog open title={dayLabel(day, locale)} cancelLabel={t('Закрыть', 'Kapat')} onClose={onClose}>
    <p>{point.location_name}</p>
    {row ? <>
      <dl className="finance-lines">
        {[
          [t('Выручка', 'Satış geliri'), row.total_minor],
          [t('Наличные', 'Nakit'), row.cash_minor],
          [t('Карта', 'Kart'), row.card_minor],
          ...(row.unallocated_minor ? [[t('Без разбивки', 'Ödeme türü belirtilmemiş'), row.unallocated_minor] as const] : []),
          ...(row.return_minor ? [[t('Возвраты', 'İadeler'), row.return_minor] as const] : []),
        ].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd><Money minor={amount} currency={point.currency} short /></dd></div>)}
      </dl>
      {hasRevenueDiscrepancy(row) && <p className="danger-text">
        {t('Сумма смен больше ранее указанного итога', 'Vardiya toplamı daha önce bildirilen tutardan fazla')}
      </p>}
      {hasPaymentDiscrepancy(row) && <p className="danger-text">
        {t('После изменения смен разбивка разошлась с итогом дня.', 'Vardiya değişikliğinden sonra ödeme türleri günlük kayıtla uyuşmuyor.')}
      </p>}
      {row.comment && <p>{row.comment}</p>}
    </> : <p>{off ? t('Выходной', 'Kapalı') : t('Выручка не внесена', 'Satış geliri kaydedilmedi')}</p>}
  </ConfirmDialog>;
}
