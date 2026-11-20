// Менеджер: вся сеть за месяц — план, факт, выполнение и пропущенные дни по каждой точке; итоги в рублях.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarX, ChevronRight } from 'lucide-react';
import { monthStart } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { Badge, Button, DataState, EmptyState, PageHeader } from '../../ui';
import { PARTNER_PREPARATION, st } from '../../ui/status';
import { MonthNav } from '../revenue/components';
import { revenueOverview, type LocationMonth } from '../revenue/api';
import { PartnerDialog } from './PartnerDialog';
import { PlanSuggestDialog } from './PlanSuggestDialog';
import { partners } from './api';

function PctBadge({ r }: { r: LocationMonth }) {
  if (r.pct === null) return <span className="faint">нет плана</span>;
  const tone = r.pct >= 100 ? 'success' : r.pct >= 80 ? 'neutral' : 'warning';
  return <span className={`badge tone-${tone}`}>{r.pct.toLocaleString('ru-RU')} %</span>;
}

function PreparationBadge({ stage }: { stage?: string | null }) {
  return stage ? <Badge tone={st(PARTNER_PREPARATION, stage)[1]}>{st(PARTNER_PREPARATION, stage)[0]}</Badge> : null;
}

export function NetworkPage() {
  const navigate = useNavigate();
  const [month, setMonth] = useState(monthStart());
  const [adding, setAdding] = useState(false);
  const [suggest, setSuggest] = useState(false);
  const q = useQuery({ queryKey: ['revenue', 'overview', month], queryFn: () => revenueOverview(month) });
  const partnerList = useQuery({ queryKey: ['partners'], queryFn: partners });
  const withoutPoints = partnerList.data?.filter(p => p.status === 'active' && q.data && !q.data.rows.some(r => r.partner_id === p.id)) ?? [];

  return (
    <>
      <PageHeader title="Франчайзи"
        actions={<>
          <Link to="/finance" className="btn btn-secondary">Экономика франшизы</Link>
          <Button onClick={() => setSuggest(true)}>Предложить план</Button>
          <Button variant="primary" onClick={() => setAdding(true)}>Добавить франчайзи</Button>
        </>} />
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <DataState query={q} skeleton={6} empty={(o) => (o.rows.length ? null : <EmptyState title="Пока нет ни одной точки" text="Добавьте франчайзи и его точки." />)}>
        {(o) => {
          const missing = o.rows.filter((r) => r.missing_days.length > 0).length;
          const pct = o.plan_rub_minor ? Math.round((Number(o.fact_rub_minor ?? 0) / Number(o.plan_rub_minor)) * 1000) / 10 : null;
          // Группировка по франчайзи: строка франчайзи, под ней его точки
          const groups = new Map<string, LocationMonth[]>();
          for (const r of o.rows) groups.set(r.partner_id, [...(groups.get(r.partner_id) ?? []), r]);
          return (
            <>
              <div className="kpis">
                <div className="kpi"><span className="v">{formatMoneyShort(Math.round(Number(o.fact_rub_minor ?? 0) / 100) * 100, 'RUB')}</span><span className="l">выручка сети</span></div>
                <div className="kpi"><span className="v">{o.plan_rub_minor ? formatMoneyShort(Math.round(Number(o.plan_rub_minor) / 100) * 100, 'RUB') : '—'}</span><span className="l">план сети</span></div>
                <div className="kpi"><span className="v">{pct === null ? '—' : `${pct.toLocaleString('ru-RU')} %`}</span><span className="l">выполнение плана</span></div>
                <div className={`kpi${missing ? ' warn' : ''}`}><span className="v">{missing}</span><span className="l">точек с невнесёнными днями</span></div>
              </div>
              {o.missing_fx.length > 0 && <p className="faint">Точки с валютами {o.missing_fx.join(', ')} не вошли в итог в рублях. Для них нет курса.</p>}
              <div className="net-table" role="table" aria-label="Точки сети">
                <div className="net-tr net-th" role="row">
                  <span role="columnheader">Точка</span><span role="columnheader" className="r">План</span><span role="columnheader" className="r">Факт</span>
                  <span role="columnheader" className="r">Выполнение</span><span role="columnheader" className="r">Не внесено</span><span />
                </div>
                {[...groups.entries()].map(([pid, list]) => (
                  <div key={pid} role="rowgroup" className="net-group">
                    <Link to={`/partners/${pid}`} className="net-partner" role="row">
                      <span className="row" style={{ minWidth: 0, flexWrap: 'wrap' }}><span style={{ overflowWrap: 'anywhere' }}>{list[0].partner_name}</span>
                        <PreparationBadge stage={partnerList.data?.find(p => p.id === pid)?.preparation_stage} /></span>
                      <ChevronRight size={16} style={{ flexShrink: 0 }} aria-hidden /></Link>
                    {list.map((r) => (
                      <button type="button" key={r.location_id} className="net-tr" role="row" onClick={() => navigate(`/partners/${pid}?location=${r.location_id}&month=${month}`)}>
                        <span role="cell" className="net-name"><strong>{r.location_name}</strong><span className="faint">{r.city} · {r.currency}</span></span>
                        <span role="cell" className="r" data-label="План">{r.plan_minor ? formatMoneyShort(r.plan_minor, r.currency) : '—'}</span>
                        <span role="cell" className="r num" data-label="Факт"><strong>{formatMoneyShort(r.fact_minor, r.currency)}</strong></span>
                        <span role="cell" className="r" data-label="Выполнение"><PctBadge r={r} /></span>
                        <span role="cell" className="r" data-label="Не внесено">{r.missing_days.length
                          ? <span className="danger-text"><CalendarX size={14} aria-hidden /> {r.missing_days.length} дн.</span> : <span className="faint">—</span>}</span>
                        <ChevronRight size={16} className="faint hide-mobile" aria-hidden />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </DataState>
      {withoutPoints.length > 0 && <section className="stack" style={{marginTop:24}}>
        <h2 className="section-title">Франчайзи без точек</h2>
        {withoutPoints.map(p => <Link key={p.id} to={`/partners/${p.id}`} className="read-card">
          <span className="todo-main"><span className="todo-title">{p.name}</span>
            {p.preparation_stage && <span className="todo-meta">{st(PARTNER_PREPARATION, p.preparation_stage)[0]}</span>}
          </span><ChevronRight size={18} aria-hidden />
        </Link>)}
      </section>}
      {adding && <PartnerDialog onClose={() => setAdding(false)} onSaved={(id) => navigate(`/partners/${id}`)} />}
      {suggest && <PlanSuggestDialog onClose={() => setSuggest(false)} />}
    </>
  );
}
