// Рейтинг франчайзи: место по прогнозу выполнения плана или по выручке; выручка открыта всем (в своей валюте и в рублях по курсу).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Award, CalendarCheck, Crown, Target, TrendingUp } from 'lucide-react';
import { command } from '../../platform/backend';
import { monthStart } from '../../platform/dates';
import { Chips, DataState, EmptyState, PageHeader } from '../../ui';
import { formatMoneyShort } from '../../platform/money';
import { MonthNav } from '../revenue/FranchiseeHome';

interface Row { rank: number; partner_id: string; partner_name: string; cities: string | null; is_me: boolean; forecast_pct: number | null;
  pct_to_date: number | null; fill_pct: number | null; growth_pct: number | null; badges: string[];
  points: number; currency: string; fact_minor: number; plan_minor: number | null; forecast_minor: number | null; fact_rub_minor: number | null; forecast_rub_minor: number | null }

const BADGE: Record<string, { label: string; icon: typeof Crown }> = {
  leader: { label: 'Лидер месяца', icon: Crown },
  plan: { label: 'Идёт на план', icon: Target },
  no_gaps: { label: 'Без пропусков', icon: CalendarCheck },
  growth: { label: 'Рост 10 %+', icon: TrendingUp },
};

const fmt = (v: number | null, plus = false) => (v === null ? '—' : `${plus && v > 0 ? '+' : ''}${v.toLocaleString('ru-RU')} %`);

export function RatingPage() {
  const [month, setMonth] = useState(monthStart());
  const [by, setBy] = useState<'plan' | 'revenue'>('plan');
  const q = useQuery({ queryKey: ['rating', month], queryFn: () => command<{ month: string; rows: Row[] }>('rating', { month }) });
  const current = month === monthStart();
  return (
    <div className="home" style={{ maxWidth: 760 }}>
      <PageHeader title="Рейтинг франчайзи" sub={by === 'revenue' ? 'Место — по выручке месяца'
        : current ? 'Место — по прогнозу выполнения плана на конец месяца при текущем темпе' : 'Итог месяца: выполнение плана'} />
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <Chips label="Сортировка" value={by} onChange={(v) => setBy(v as 'plan' | 'revenue')}
        options={[{ id: 'plan', label: 'По выполнению плана' }, { id: 'revenue', label: 'По выручке' }]} />
      <DataState query={q} empty={(d) => (d.rows.length ? null : <EmptyState title="Пока нет данных" text="Рейтинг появится, когда у точек будет план и выручка." />)}>
        {(d) => {
          const rows = by === 'plan' ? d.rows
            : [...d.rows].sort((a, b) => Number(b.fact_rub_minor ?? -1) - Number(a.fact_rub_minor ?? -1)).map((r, i) => ({ ...r, rank: i + 1 }));
          const me = rows.find((r) => r.is_me);
          const above = me && me.rank > 1 ? rows[me.rank - 2] : null;
          return (
            <>
              {me && (
                <div className="my-rank">
                  <span className="my-rank-num">{me.rank}</span>
                  <div>
                    <div><strong>Ваше место из {rows.length}</strong></div>
                    <div className="faint">{by === 'revenue'
                      ? `Выручка ${formatMoneyShort(me.fact_minor, me.currency)}${above?.fact_rub_minor != null && me.fact_rub_minor != null ? ` · до ${me.rank - 1}-го места ${formatMoneyShort(Number(above.fact_rub_minor) - Number(me.fact_rub_minor), 'RUB')}` : ''}`
                      : `${me.forecast_pct !== null ? `Прогноз: ${fmt(me.forecast_pct)} плана` : 'Без плана на этот месяц'}${above?.forecast_pct != null && me.forecast_pct !== null
                        ? ` · до ${me.rank - 1}-го места ${(above.forecast_pct - me.forecast_pct).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} п.` : ''}`}</div>
                  </div>
                </div>
              )}
              <ol className="rating-list">
                {rows.map((r) => (
                  <li key={r.partner_id} className={`rating-row${r.is_me ? ' me' : ''}${r.rank <= 3 ? ` top${r.rank}` : ''}`}>
                    <span className="rating-place">{r.rank <= 3 ? <Award size={22} aria-label={`${r.rank} место`} /> : r.rank}</span>
                    <span className="rating-main">
                      <span className="rating-name">{r.partner_name}{r.is_me && <span className="faint"> · вы</span>}</span>
                      <span className="rating-badges">{r.badges.map((b) => { const B = BADGE[b]; return B ? <span key={b} className="rating-badge"><B.icon size={12} aria-hidden />{B.label}</span> : null; })}</span>
                      <span className="rating-money">
                        <strong className="num">{formatMoneyShort(r.fact_minor, r.currency)}</strong>
                        {r.plan_minor ? <span className="faint"> из плана {formatMoneyShort(r.plan_minor, r.currency)}</span> : null}
                        {r.currency !== 'RUB' && r.fact_rub_minor != null && <span className="faint"> · ≈ {formatMoneyShort(r.fact_rub_minor, 'RUB')}</span>}
                      </span>
                      <span className="faint">{r.cities ? `${r.cities} · ` : ''}{r.points > 1 ? `${r.points} точки · ` : ''}заполнено дней {fmt(r.fill_pct)} · к прошлому месяцу {fmt(r.growth_pct, true)}</span>
                    </span>
                    <span className="rating-score">
                      <strong>{fmt(current ? r.forecast_pct : r.pct_to_date)}</strong>
                      <span className="faint">{current ? 'прогноз плана' : 'плана'}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="faint" style={{ marginTop: 12 }}>Выручка — за прошедшие дни месяца (по вчера), все точки франчайзи. Прогноз = эта выручка, пересчитанная на весь месяц, к плану. В рейтинге участвуют франчайзи в России.Заполненные дни — доля дней, за которые внесена выручка.</p>
            </>
          );
        }}
      </DataState>
    </div>
  );
}
