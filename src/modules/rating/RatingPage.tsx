// Рейтинг франчайзи: место по прогнозу выполнения плана, дисциплина ввода и рост. Суммы выручки не показываются.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, CalendarCheck, Crown, Target, TrendingUp } from 'lucide-react';
import { command } from '../../platform/backend';
import { monthStart } from '../../platform/dates';
import { DataState, EmptyState, PageHeader } from '../../ui';
import { MonthNav } from '../revenue/FranchiseeHome';

interface Row { rank: number; partner_id: string; partner_name: string; cities: string | null; is_me: boolean; forecast_pct: number | null;
  pct_to_date: number | null; fill_pct: number | null; growth_pct: number | null; badges: string[] }

const BADGE: Record<string, { label: string; icon: typeof Crown }> = {
  leader: { label: 'Лидер месяца', icon: Crown },
  plan: { label: 'Идёт на план', icon: Target },
  no_gaps: { label: 'Без пропусков', icon: CalendarCheck },
  growth: { label: 'Рост 10 %+', icon: TrendingUp },
};

const fmt = (v: number | null, plus = false) => (v === null ? '—' : `${plus && v > 0 ? '+' : ''}${v.toLocaleString('ru-RU')} %`);

export function RatingPage() {
  const [month, setMonth] = useState(monthStart());
  const q = useQuery({ queryKey: ['rating', month], queryFn: () => command<{ month: string; rows: Row[] }>('rating', { month }) });
  const current = month === monthStart();
  return (
    <div className="home" style={{ maxWidth: 760 }}>
      <PageHeader title="Рейтинг франчайзи" sub={current ? 'Место — по прогнозу выполнения плана на конец месяца при текущем темпе' : 'Итог месяца: выполнение плана'} />
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <DataState query={q} empty={(d) => (d.rows.length ? null : <EmptyState title="Пока нет данных" text="Рейтинг появится, когда у точек будет план и выручка." />)}>
        {(d) => {
          const me = d.rows.find((r) => r.is_me);
          return (
            <>
              {me && (
                <div className="my-rank">
                  <span className="my-rank-num">{me.rank}</span>
                  <div>
                    <div><strong>Ваше место из {d.rows.length}</strong></div>
                    <div className="faint">{me.forecast_pct !== null ? `Прогноз: ${fmt(me.forecast_pct)} плана` : 'Без плана на этот месяц'}{me.rank > 1 && d.rows[me.rank - 2]?.forecast_pct !== null && me.forecast_pct !== null
                      ? ` · до ${me.rank - 1}-го места ${(d.rows[me.rank - 2].forecast_pct! - me.forecast_pct).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.` : ''}</div>
                  </div>
                </div>
              )}
              <ol className="rating-list">
                {d.rows.map((r) => (
                  <li key={r.partner_id} className={`rating-row${r.is_me ? ' me' : ''}${r.rank <= 3 ? ` top${r.rank}` : ''}`}>
                    <span className="rating-place">{r.rank <= 3 ? <Award size={22} aria-label={`${r.rank} место`} /> : r.rank}</span>
                    <span className="rating-main">
                      <span className="rating-name">{r.partner_name}{r.is_me && <span className="faint"> · вы</span>}</span>
                      <span className="rating-badges">{r.badges.map((b) => { const B = BADGE[b]; return B ? <span key={b} className="rating-badge"><B.icon size={12} aria-hidden />{B.label}</span> : null; })}</span>
                      <span className="faint">заполнено дней {fmt(r.fill_pct)} · к прошлому месяцу {fmt(r.growth_pct, true)}</span>
                    </span>
                    <span className="rating-score">
                      <strong>{fmt(current ? r.forecast_pct : r.pct_to_date)}</strong>
                      <span className="faint">{current ? 'прогноз' : 'плана'}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="faint" style={{ marginTop: 12 }}>Прогноз = выручка за прошедшие дни, пересчитанная на весь месяц, к плану. Учитываются точки с планом. Заполненные дни — доля дней, за которые внесена выручка.</p>
            </>
          );
        }}
      </DataState>
    </div>
  );
}
