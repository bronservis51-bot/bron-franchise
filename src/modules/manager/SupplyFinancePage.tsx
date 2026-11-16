import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { command } from '../../platform/backend';
import { monthStart } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { ActionError, Button, Card, DataState, PageHeader, Select } from '../../ui';
import { MonthNav } from '../revenue/components';
import { revenueOverview } from '../revenue/api';
import { royaltySummary } from './api';
import { RoyaltyPage } from './RoyaltyPage';

interface SupplyRow { partner_id: string; partner_name: string; mapped_count: number; counterparties: string[]; sales_minor: number; cost_minor: number; profit_minor: number }
interface Unmapped { counterparty_id: string; name: string; sales_minor: number; cost_minor: number; profit_minor: number }
interface SupplySnapshot { month: string; fetched_at: string | null; period_to: string | null; currency: string; rows: SupplyRow[]; unmapped: Unmapped[] }
const money = (n: number | string | undefined, c = 'RUB') => n === undefined ? '—' : formatMoneyShort(n, c);

export function SupplyFinancePage() {
  const [section, setSection] = useState<'overview' | 'royalty'>('overview');
  return <>
    <div className="chips" role="group" aria-label="Раздел экономики">
      <button type="button" className="chip" aria-pressed={section === 'overview'} onClick={() => setSection('overview')}>Обзор</button>
      <button type="button" className="chip" aria-pressed={section === 'royalty'} onClick={() => setSection('royalty')}>Роялти и оплаты</button>
    </div>
    {section === 'royalty' ? <RoyaltyPage /> : <FranchiseOverview />}
  </>;
}

function FranchiseOverview() {
  const [month, setMonth] = useState(monthStart());
  const q = useQuery({ queryKey: ['supply', month], queryFn: () => command<SupplySnapshot>('manager_supply_snapshot', { month }) });
  const rev = useQuery({ queryKey: ['revenue', 'overview', month], queryFn: () => revenueOverview(month) });
  const royalty = useQuery({ queryKey: ['royalty', 'summary', month], queryFn: () => royaltySummary(month) });
  const qc = useQueryClient();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const bind = useMutation({ mutationFn: (counterparty: string) => command('manager_supply_map', { counterparty, partner: mapping[counterparty] }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['supply'] }); } });
  return <>
    <PageHeader title="Экономика франшизы" sub="Выручка партнёров, роялти и поставки за выбранный месяц."
      actions={<Button onClick={() => { void q.refetch(); void rev.refetch(); void royalty.refetch(); }} loading={q.isFetching || rev.isFetching || royalty.isFetching}><RefreshCw size={16} aria-hidden />Обновить сводку</Button>} />
    <MonthNav month={month} onChange={setMonth} max={monthStart()} />
    <ActionError error={rev.error ?? royalty.error ?? bind.error} />
    <DataState query={q} skeleton={5}>{s => {
      const total = s.rows.filter(r => r.mapped_count > 0).reduce((a, r) => ({ sales: a.sales + Number(r.sales_minor), cost: a.cost + Number(r.cost_minor), profit: a.profit + Number(r.profit_minor) }), { sales: 0, cost: 0, profit: 0 });
      const retailByCurrency = (rev.data?.rows ?? []).reduce<Record<string, number>>((totals, row) => {
        totals[row.currency] = (totals[row.currency] ?? 0) + Number(row.fact_minor);
        return totals;
      }, {});
      const missingDays = rev.data?.rows.reduce((count, row) => count + row.missing_days.length, 0);
      const hasMappedSupply = Boolean(s.fetched_at && s.rows.some(r => r.mapped_count > 0));
      return <div className="stack">
        {s.fetched_at && <p className="faint">Снимок поставок от {new Date(s.fetched_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК. Период по {s.period_to?.slice(0, 10).split('-').reverse().join('.')}. Кнопка обновляет сводку из последнего загруженного снимка.</p>}
        <Card title="Сводка сети за месяц">
          <div className="kpis">
            <div className="kpi"><span className="l">Розничная выручка</span>
              {Object.entries(retailByCurrency).length ? Object.entries(retailByCurrency).map(([currency, value]) => <span className="v" key={currency}>{money(value, currency)}</span>) : <span className="v">—</span>}
              <span className="l">Продажи партнёров своим клиентам</span>
            </div>
            <div className="kpi"><span className="l">Роялти: начислено / оплачено</span>
              {royalty.data?.totals.length ? royalty.data.totals.map(row => <span className="v" key={row.currency}>{money(row.accrued_minor, row.currency)} / {money(row.paid_minor, row.currency)}</span>) : <span className="v">—</span>}
              <span className="l">По валютам, без пересчёта в одну</span>
            </div>
            <div className={`kpi${missingDays ? ' warn' : ''}`}><span className="v">{missingDays === undefined ? '—' : missingDays}</span><span className="l">Не заполнено прошедших дней</span></div>
            <div className="kpi"><span className="v">{hasMappedSupply ? money(total.sales) : '—'}</span><span className="l">Поставки: наши продажи, ₽</span></div>
            <div className="kpi"><span className="v">{hasMappedSupply ? money(total.cost) : '—'}</span><span className="l">Себестоимость отгрузок, ₽</span></div>
            <div className="kpi"><span className="v">{hasMappedSupply ? money(total.profit) : '—'}</span><span className="l">Валовая прибыль поставок, ₽</span></div>
          </div>
          <p className="faint">Это показатели выручки партнёров, роялти и поставок; они не складываются в чистую прибыль сети.</p>
        </Card>
        <div className="economics-table-wrap"><table className="economics-table">
          <thead><tr><th>Партнёр</th><th>Розничная выручка</th><th>Роялти начислено / оплачено</th><th>Остаток за месяц</th><th>Наши продажи, ₽</th><th>Себестоимость, ₽</th><th>Валовая прибыль, ₽</th></tr></thead>
          <tbody>{s.rows.map(r => {
            const points = rev.data?.rows.filter(p => p.partner_id === r.partner_id);
            const rr = royalty.data?.rows.find(p => p.partner_id === r.partner_id);
            const revenue = points?.reduce((n, p) => n + Number(p.fact_minor), 0);
            const gaps = points?.reduce((n, p) => n + p.missing_days.length, 0);
            const ready = s.fetched_at && r.mapped_count > 0;
            return <tr key={r.partner_id}>
              <td><Link to={`/partners/${r.partner_id}`}>{r.partner_name}</Link>{r.counterparties.length > 0 && <details><summary>Источник поставок</summary><small>{r.counterparties.join('; ')}</small></details>}</td>
              <td>{points?.length ? money(revenue, points[0].currency) : '—'}<small>{points?.length ? gaps ? `Не заполнено ${gaps} дней по точкам` : 'Все прошедшие дни заполнены' : 'Нет отчётов по точкам'}</small></td>
              <td>{rr ? `${money(Number(rr.accrued_minor) + Number(rr.manual_minor), rr.currency)} / ${money(rr.paid_minor, rr.currency)}` : '—'}</td>
              <td>{rr ? money(Number(rr.accrued_minor) + Number(rr.manual_minor) - Number(rr.paid_minor), rr.currency) : '—'}{rr?.is_open && <small>Месяц ещё открыт</small>}</td>
              <td>{ready ? money(r.sales_minor) : '—'}</td><td>{ready ? money(r.cost_minor) : '—'}</td><td>{ready ? money(r.profit_minor) : '—'}</td>
            </tr>;
          })}</tbody>
        </table></div>
        {s.unmapped.length > 0 && <Card title={`Без привязки к партнёру: ${s.unmapped.length}`}>
          <p className="faint">Эти суммы не входят в итоги выше. Привязывайте карточку после проверки личности; одинаковое имя не подтверждает совпадение.</p>
          {s.unmapped.map(c => <div className="supply-mapping" key={c.counterparty_id}>
            <div><strong>{c.name}</strong><small>{money(c.sales_minor)} продаж · {money(c.cost_minor)} себестоимость</small><a className="faint" href={`https://online.moysklad.ru/app/#Company/edit?id=${c.counterparty_id}`} target="_blank" rel="noopener noreferrer">Открыть карточку МойСклад</a></div>
            <Select aria-label={`Партнёр для ${c.name}`} value={mapping[c.counterparty_id] ?? ''} onChange={e => setMapping(x => ({ ...x, [c.counterparty_id]: e.target.value }))}>
              <option value="">Выберите партнёра</option>{s.rows.map(p => <option key={p.partner_id} value={p.partner_id}>{p.partner_name}</option>)}
            </Select>
            <Button size="sm" disabled={!mapping[c.counterparty_id]} loading={bind.isPending} onClick={() => bind.mutate(c.counterparty_id)}>Привязать</Button>
          </div>)}
        </Card>}
      </div>;
    }}</DataState>
  </>;
}
