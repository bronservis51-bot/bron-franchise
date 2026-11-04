import { CalendarX, ChevronLeft, ChevronRight } from 'lucide-react';
import { dayLabel, monthLabel, shiftMonth } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { EmptyState, Money } from '../../ui';
import { BrandPattern } from '../../ui/brand';
import { type DayRow, type MonthDetail } from './api';

export function MonthNav({ month, onChange, max }: { month: string; onChange: (m: string) => void; max?: string }) {
  return (
    <div className="month-nav">
      <button type="button" className="icon-btn" aria-label="Предыдущий месяц" onClick={() => onChange(shiftMonth(month, -1))}><ChevronLeft size={20} /></button>
      <span className="month-nav-label">{monthLabel(month)}</span>
      <button type="button" className="icon-btn" aria-label="Следующий месяц" disabled={Boolean(max && month >= max)} onClick={() => onChange(shiftMonth(month, 1))}><ChevronRight size={20} /></button>
    </div>
  );
}

/** Карточка плана месяца: факт, план, выполнение, сколько нужно в день. */
export function PlanCard({ m }: { m: MonthDetail }) {
  const pct = m.pct ?? 0;
  const isCurrent = m.today.slice(0, 7) === m.month.slice(0, 7);
  return (
    <section className="plan-card" aria-label="План месяца">
      <BrandPattern className="plan-pattern" rows={2} cols={4} />
      <div className="plan-label">Выручка за {monthLabel(m.month, false)}</div>
      <div className="plan-fact">{formatMoneyShort(m.fact_minor, m.currency)}</div>
      {m.plan_minor ? (
        <>
          <div className="plan-of">из плана {formatMoneyShort(m.plan_minor, m.currency)}</div>
          <div className="plan-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Выполнение плана">
            <span style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="plan-foot">
            <strong>{pct.toLocaleString('ru-RU')} %</strong>
            {pct >= 100 ? <span>План выполнен</span>
              : isCurrent && m.need_per_day_minor ? <span>до плана — около {formatMoneyShort(m.need_per_day_minor, m.currency)} в день</span>
              : !isCurrent ? <span>не хватило {formatMoneyShort(m.plan_minor - m.fact_minor, m.currency)}</span> : null}
          </div>
        </>
      ) : <div className="plan-of">План на этот месяц пока не поставлен</div>}
    </section>
  );
}

export function DayList({ m, onPick }: { m: MonthDetail; onPick: (day: string, row?: DayRow) => void }) {
  const byDay = new Map(m.days.map((d) => [d.day, d]));
  const missing = new Set(m.missing_days);
  const monthEnd = shiftDay(m.month, m.days_in_month - 1);
  const last = m.today < monthEnd ? m.today : monthEnd;
  // Все дни месяца до сегодня: внесённые и пропущенные, новые сверху
  const days: string[] = [];
  for (let d = last; d >= m.month; d = shiftDay(d, -1)) days.push(d);
  const editable = (d: string) => !m.editable_from || d >= m.editable_from;
  if (!days.length) return <EmptyState title="В этом месяце записей нет" />;
  return (
    <ul className="day-list2">
      {days.map((d) => {
        const r = byDay.get(d);
        const miss = missing.has(d);
        if (!r && !miss && d !== m.today) return null;
        const can = editable(d);
        return (
          <li key={d}>
            <button type="button" className={`day-row2${miss ? ' missing' : ''}`} disabled={!can} onClick={() => onPick(d, r)}>
              <span className="day-date2">{dayLabel(d)}</span>
              {r ? (
                <span className="day-sum2">
                  <Money minor={r.total_minor} currency={m.currency} short />
                  <span className="day-split">{r.comment && (/Google-таблиц/i.test(r.comment) || /Google Sheets/i.test(r.comment))
                    ? 'Из Google-таблицы: способ оплаты не указан'
                    : r.entries.some((e) => e.employee_id)
                      ? r.entries.map((e) => `${e.employee_name ?? 'вы'} ${formatMoneyShort(e.total_minor, m.currency)}`).join(' · ')
                      : `нал. ${formatMoneyShort(r.cash_minor, m.currency)} · карта ${formatMoneyShort(r.card_minor, m.currency)}`}</span>
                  {r.comment && <span className="day-split">{r.comment}</span>}
                </span>
              ) : <span className="day-sum2 day-empty">{miss ? <><CalendarX size={14} aria-hidden /> не внесено</> : 'сегодня — ещё не внесено'}</span>}
              {can && <ChevronRight size={16} className="day-chev" aria-hidden />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function shiftDay(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
