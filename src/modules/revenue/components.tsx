import { useState } from 'react';
import { Button } from '../../ui';
import { CalendarX, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLocale } from '../../platform/locale';
import { dayLabel, monthLabel, shiftMonth } from '../../platform/dates';
import { RevenueBreakdown } from './RevenueBreakdown';
import { formatMoneyShort } from '../../platform/money';
import { EmptyState, Money } from '../../ui';
import { BrandPattern } from '../../ui/brand';
import { canEditRevenueDay, type DayRow, type LocationMonth, type MonthDetail } from './api';

export function MonthNav({ month, onChange, max }: { month: string; onChange: (m: string) => void; max?: string }) {
  const { t, locale } = useLocale();
  return (
    <div className="month-nav">
      <button type="button" className="icon-btn" aria-label={t('Предыдущий месяц', 'Önceki ay')} onClick={() => onChange(shiftMonth(month, -1))}><ChevronLeft size={20} /></button>
      <span className="month-nav-label">{monthLabel(month, true, locale)}</span>
      <button type="button" className="icon-btn" aria-label={t('Следующий месяц', 'Sonraki ay')} disabled={Boolean(max && month >= max)} onClick={() => onChange(shiftMonth(month, 1))}><ChevronRight size={20} /></button>
    </div>
  );
}

/** Карточка плана месяца: факт, план, выполнение, сколько нужно в день. */
export function PlanCard({ m }: { m: LocationMonth }) {
  const { t, locale } = useLocale();
  const pct = m.pct ?? 0;
  const isCurrent = m.today.slice(0, 7) === m.month.slice(0, 7);
  const fact = formatMoneyShort(m.fact_minor, m.currency, locale);
  return (
    <section className="plan-card" aria-label={t('План месяца', 'Aylık hedef')}>
      <BrandPattern className="plan-pattern" rows={2} cols={4} />
      <div className="plan-label">{t('Выручка', 'Satış geliri')}</div>
      <div className="plan-fact">{fact}</div>
      {m.plan_minor ? (
        <>
          <div className="plan-of">{t('из плана', 'Hedef')} {formatMoneyShort(m.plan_minor, m.currency, locale)}</div>
          <div className="plan-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t('Выполнение плана', 'Hedefe ulaşma oranı')}>
            <span style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="plan-foot">
            <strong>{t(`${pct.toLocaleString(locale)} %`, `%${pct.toLocaleString(locale)}`)}</strong>
            {pct >= 100 ? <span>{t('План выполнен', 'Hedefe ulaşıldı')}</span>
              : isCurrent && m.need_per_day_minor ? <span>{t('до плана — около', 'Hedef için günde yaklaşık')} {formatMoneyShort(m.need_per_day_minor, m.currency, locale)} {t('в день', 'gerekli')}</span>
              : !isCurrent ? <span>{t('не хватило', 'Hedefe kalan')} {formatMoneyShort(m.plan_minor - m.fact_minor, m.currency, locale)}</span> : null}
          </div>
        </>
      ) : <div className="plan-of">{t('План не задан', 'Hedef belirlenmedi')}</div>}
    </section>
  );
}

export function DayList({ m, readOnly = false, showHistory = false, onPick }: {
  m: MonthDetail; readOnly?: boolean; showHistory?: boolean; onPick: (day: string, row?: DayRow) => void;
}) {
  const { t, locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const byDay = new Map(m.days.map((d) => [d.day, d]));
  const missing = new Set(m.missing_days);
  const daysOff = new Set(m.days_off);
  const monthEnd = shiftDay(m.month, m.days_in_month - 1);
  const last = m.today < monthEnd ? m.today : monthEnd;
  // Все дни месяца до сегодня: внесённые и пропущенные, новые сверху
  const days: string[] = [];
  for (let d = last; d >= m.month; d = shiftDay(d, -1)) {
    if (byDay.has(d) || daysOff.has(d) || ((!readOnly || showHistory) && missing.has(d)) || (!readOnly && d === m.today && canEditRevenueDay(m, d))) days.push(d);
  }
  if (!days.length) return <EmptyState title={t('В этом месяце записей нет', 'Bu ay kayıt yok')} />;
  return (
    <><ul className="day-list2">
      {(expanded ? days : days.slice(0,7)).map((d) => {
        const r = byDay.get(d);
        const miss = missing.has(d);
        const dayOff = daysOff.has(d);
        const can = showHistory || readOnly || canEditRevenueDay(m, d);
        return (
          <li key={d}>
            <button type="button" className={`day-row2${miss ? ' missing' : ''}`} disabled={!can} onClick={() => onPick(d, r)}>
              <span className="day-date2">{dayLabel(d, locale)}</span>
              {r ? (
                <span className="day-sum2">
                  <Money minor={r.total_minor} currency={m.currency} short />
                  <span className="day-split"><RevenueBreakdown row={r} currency={m.currency} /></span>
                  {r.reported_total_minor != null && Number(r.total_minor) > Number(r.reported_total_minor) && <span className="day-split" role="status">{t('Сумма смен больше ранее указанного итога — проверьте день', 'Vardiya toplamı önceki günlük toplamı aşıyor. Kaydı kontrol edin.')}</span>}
                  {r.return_minor ? <span className="day-split">{t('Возвраты', 'İadeler')} · {formatMoneyShort(r.return_minor, m.currency, locale)}</span> : null}
                  {r.comment && <span className="day-split">{r.comment}</span>}
                </span>
              ) : <span className="day-sum2 day-empty">{dayOff ? t('Выходной', 'Kapalı gün') : miss ? <><CalendarX size={14} aria-hidden /> {t('не внесено', 'girilmedi')}</> : t('сегодня — ещё не внесено', 'Bugünün cirosu henüz girilmedi')}</span>}
              {can && <ChevronRight size={16} className="day-chev" aria-hidden />}
            </button>
          </li>
        );
      })}
    </ul>{days.length > 7 && <Button variant="ghost" onClick={() => setExpanded(v => !v)}>{expanded ? t('Свернуть', 'Daralt') : t('Все дни месяца', 'Ayın tüm günleri')}</Button>}</>
  );
}

function shiftDay(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
