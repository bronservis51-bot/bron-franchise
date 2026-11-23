// Менеджер: вся сеть за месяц — план, факт, выполнение и пропущенные дни по каждой точке; итоги в рублях.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarX, ChevronRight } from 'lucide-react';
import { monthStart } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { useSession } from '../../platform/session';
import { Button, DataState, EmptyState, Field, Input, PageHeader } from '../../ui';
import { MonthNav } from '../revenue/components';
import { revenueOverview, type LocationMonth } from '../revenue/api';
import { PartnerDialog } from './PartnerDialog';
import { PlanSuggestDialog } from './PlanSuggestDialog';
import { managerPartnerStatus, managerPartnerStatusKey, partners } from './api';
import { OWNER_ACCESS_LABEL, PartnerStatus } from './PartnerStatus';

function PctBadge({ r }: { r: LocationMonth }) {
  if (r.pct === null) return <span className="faint">нет плана</span>;
  const tone = r.pct >= 100 ? 'success' : r.pct >= 80 ? 'neutral' : 'warning';
  return <span className={`badge tone-${tone}`}>{r.pct.toLocaleString('ru-RU')} %</span>;
}

export function NetworkPage() {
  const { can } = useSession();
  const canReadRevenue = can('revenue.read');
  const canPlan = can('plan.manage');
  const navigate = useNavigate();
  const [month, setMonth] = useState(monthStart());
  const [adding, setAdding] = useState(false);
  const [suggest, setSuggest] = useState(false);
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['revenue', 'overview', month], enabled: canReadRevenue, queryFn: () => revenueOverview(month) });
  const partnerList = useQuery({ queryKey: ['partners'], queryFn: partners });
  const status = useQuery({ queryKey: managerPartnerStatusKey, queryFn: managerPartnerStatus });
  const partnerById = new Map(partnerList.data?.map(p => [p.id, p]));
  const statusById = new Map(status.data?.map(p => [p.partner_id, p]));
  const term = search.trim().toLocaleLowerCase('ru');
  const matching = partnerList.data?.filter(p => !term || `${p.name} ${p.code}`.toLocaleLowerCase('ru').includes(term)) ?? [];
  const matchingIds = new Set(matching.map(p => p.id));
  const monthlyPartnerIds = new Set(q.data?.rows.map(r => r.partner_id));
  const outsideReport = canReadRevenue && q.isPending ? [] : matching.filter(p => !canReadRevenue || !monthlyPartnerIds.has(p.id));

  return (
    <div className="network-workspace">
      <PageHeader title="Франчайзи"
        actions={<>
          <Button variant="primary" onClick={() => setAdding(true)}>Добавить франчайзи</Button>
          {canPlan && <Button onClick={() => setSuggest(true)}>Предложить план</Button>}
        </>} />
      {canReadRevenue && <MonthNav month={month} onChange={setMonth} max={monthStart()} />}
      <Field label="Поиск франчайзи">{id => (
        <Input id={id} type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Название или код" />
      )}</Field>
      {term && partnerList.isSuccess && !matching.length && <p role="status" className="faint">Франчайзи не найдены.</p>}
      {canReadRevenue && <DataState query={q} skeleton={6} empty={(o) => (o.rows.length ? null : <EmptyState title="Пока нет ни одной точки" text="Добавьте франчайзи и его точки." />)}>
        {(o) => {
          const missing = o.rows.filter((r) => r.missing_days.length > 0).length;
          const pct = o.plan_rub_minor ? Math.round((Number(o.fact_rub_minor ?? 0) / Number(o.plan_rub_minor)) * 1000) / 10 : null;
          // Группировка по франчайзи: строка франчайзи, под ней его точки
          const groups = new Map<string, LocationMonth[]>();
          for (const r of o.rows) {
            if (!term || matchingIds.has(r.partner_id)) groups.set(r.partner_id, [...(groups.get(r.partner_id) ?? []), r]);
          }
          return (
            <>
              <div className="kpis">
                <div className="kpi"><span className="v">{formatMoneyShort(Math.round(Number(o.fact_rub_minor ?? 0) / 100) * 100, 'RUB')}</span><span className="l">выручка сети</span></div>
                <div className="kpi"><span className="v">{o.plan_rub_minor ? formatMoneyShort(Math.round(Number(o.plan_rub_minor) / 100) * 100, 'RUB') : '—'}</span><span className="l">план сети</span></div>
                <div className="kpi"><span className="v">{pct === null ? '—' : `${pct.toLocaleString('ru-RU')} %`}</span><span className="l">выполнение плана</span></div>
                <div className={`kpi${missing ? ' warn' : ''}`}><span className="v">{missing}</span><span className="l">точек с невнесёнными днями</span></div>
              </div>
              {o.missing_fx.length > 0 && <p className="faint">Точки с валютами {o.missing_fx.join(', ')} не вошли в итог в рублях. Для них нет курса.</p>}
              {groups.size > 0 && <div className="net-table" role="region" aria-label="Точки сети">
                <div className="net-tr net-th" aria-hidden>
                  <span>Точка</span><span className="r">План</span><span className="r">Факт</span>
                  <span className="r">Выполнение</span><span className="r">Не внесено</span><span />
                </div>
                {[...groups.entries()].map(([pid, list]) => (
                  <div key={pid} className="net-group">
                    <Link to={`/partners/${pid}`} className="net-partner">
                      <span className="row" style={{ minWidth: 0, flexWrap: 'wrap' }}><span style={{ overflowWrap: 'anywhere' }}>{list[0].partner_name}</span>
                        <PartnerStatus partner={partnerById.get(pid)} current={statusById.get(pid)} /></span>
                      <ChevronRight size={16} style={{ flexShrink: 0 }} aria-hidden /></Link>
                    {list.map((r) => (
                      <Link key={r.location_id} className="net-tr" to={`/partners/${pid}?location=${r.location_id}&month=${month}`}>
                        <span className="net-name"><strong>{r.location_name}</strong><span className="faint">{r.city} · {r.currency}</span></span>
                        <span className="r"><span className="net-metric-label">План</span>{r.plan_minor ? formatMoneyShort(r.plan_minor, r.currency) : '—'}</span>
                        <span className="r num"><span className="net-metric-label">Факт</span><strong>{formatMoneyShort(r.fact_minor, r.currency)}</strong></span>
                        <span className="r"><span className="net-metric-label">Выполнение</span><PctBadge r={r} /></span>
                        <span className="r"><span className="net-metric-label">Не внесено</span>{r.missing_days.length
                          ? <span className="danger-text"><CalendarX size={14} aria-hidden /> {r.missing_days.length} дн.</span> : <span className="faint">—</span>}</span>
                        <ChevronRight size={16} className="faint hide-mobile" aria-hidden />
                      </Link>
                    ))}
                  </div>
                ))}
              </div>}
            </>
          );
        }}
      </DataState>}
      {outsideReport.length > 0 && <section className="stack" style={{ marginTop: 24 }}>
        <h2 className="section-title">{!canReadRevenue || q.isError ? 'Карточки франчайзи' : 'Франчайзи вне отчёта за месяц'}</h2>
        {outsideReport.map(partner => {
          const current = statusById.get(partner.id);
          return <Link key={partner.id} to={`/partners/${partner.id}`} className="read-card">
            <span className="todo-main" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span className="todo-title">{partner.name}</span>
              <span className="row" style={{ flexWrap: 'wrap' }}>
                <PartnerStatus partner={partner} current={current} />
                {current && partner.status !== 'active' && <span className="faint">{OWNER_ACCESS_LABEL[current.owner_access]}</span>}
              </span>
            </span><ChevronRight size={18} aria-hidden style={{ flexShrink: 0 }} />
          </Link>;
        })}
      </section>}
      {adding && <PartnerDialog onClose={() => setAdding(false)} onSaved={(id) => navigate(`/partners/${id}`)} />}
      {suggest && canPlan && <PlanSuggestDialog onClose={() => setSuggest(false)} />}
    </div>
  );
}
