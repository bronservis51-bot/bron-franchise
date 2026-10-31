import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { command } from '../../platform/backend';
import { monthStart } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { ActionError, Button, Card, DataState, PageHeader, Select } from '../../ui';
import { MonthNav } from '../revenue/FranchiseeHome';
import { revenueOverview } from '../revenue/api';
import { royaltySummary } from './api';

interface SupplyRow { partner_id: string; partner_name: string; mapped_count: number; counterparties: string[]; sales_minor: number; cost_minor: number; profit_minor: number }
interface Unmapped { counterparty_id: string; name: string; sales_minor: number; cost_minor: number; profit_minor: number }
interface SupplySnapshot { month: string; fetched_at: string | null; period_to: string | null; currency: string; rows: SupplyRow[]; unmapped: Unmapped[] }
const money = (n: number | string | undefined, c = 'RUB') => n === undefined ? '—' : formatMoneyShort(n, c);

export function SupplyFinancePage() {
  const [month, setMonth] = useState(monthStart());
  const q = useQuery({ queryKey: ['supply', month], queryFn: () => command<SupplySnapshot>('manager_supply_snapshot', { month }) });
  const rev = useQuery({ queryKey: ['revenue', 'overview', month], queryFn: () => revenueOverview(month) });
  const royalty = useQuery({ queryKey: ['royalty', 'summary', month], queryFn: () => royaltySummary(month) });
  const qc = useQueryClient();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const bind = useMutation({ mutationFn: (counterparty: string) => command('manager_supply_map', { counterparty, partner: mapping[counterparty] }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['supply'] }); } });
  return <>
    <PageHeader title="Экономика франшизы" sub="Отчёты партнёров, роялти и наши поставки — в одной сводке."
      actions={<Button onClick={() => { void q.refetch(); void rev.refetch(); void royalty.refetch(); }} loading={q.isFetching || rev.isFetching || royalty.isFetching}><RefreshCw size={16} aria-hidden />Обновить сводку</Button>} />
    <MonthNav month={month} onChange={setMonth} max={monthStart()} />
    <ActionError error={rev.error ?? royalty.error ?? bind.error} />
    <DataState query={q} skeleton={5}>{s => {
      const total = s.rows.filter(r => r.mapped_count > 0).reduce((a, r) => ({ sales: a.sales + Number(r.sales_minor), cost: a.cost + Number(r.cost_minor), profit: a.profit + Number(r.profit_minor) }), { sales: 0, cost: 0, profit: 0 });
      return <div className="stack">
        <div className="alert tone-info"><div className="alert-body">Себестоимость и прибыль поставок доступны только менеджеру. Розничная выручка — продажи партнёра его клиентам; поставки — наши продажи партнёру.</div></div>
        {s.fetched_at ? <p className="faint">МойСклад: снимок от {new Date(s.fetched_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК. Период по {s.period_to?.slice(0, 10).split('-').reverse().join('.')}. Кнопка обновляет сводку из последнего загруженного снимка.</p>
          : <div className="alert tone-warning">Данные МойСклад за этот месяц ещё не загружены. Продажи и себестоимость неизвестны.</div>}
        <div className="kpis">
          <div className="kpi"><span className="v">{s.fetched_at ? money(total.sales) : '—'}</span><span className="l">наши продажи партнёрам, ₽</span></div>
          <div className="kpi"><span className="v">{s.fetched_at ? money(total.cost) : '—'}</span><span className="l">себестоимость отгрузок, ₽</span></div>
          <div className="kpi"><span className="v">{s.fetched_at ? money(total.profit) : '—'}</span><span className="l">валовая прибыль поставок, ₽</span></div>
        </div>
        <p className="faint">Итоги поставок включают привязанных контрагентов, с учётом возвратов. Валовая прибыль указана до расходов УК. Роялти и выручка показаны в валюте партнёра; поставки всегда в рублях.</p>
        <div className="economics-table-wrap"><table className="economics-table">
          <thead><tr><th>Партнёр</th><th>Розничная выручка</th><th>Роялти начислено / оплачено</th><th>Остаток за месяц</th><th>Наши продажи, ₽</th><th>Себестоимость, ₽</th><th>Валовая прибыль, ₽</th></tr></thead>
          <tbody>{s.rows.map(r => {
            const points = rev.data?.rows.filter(p => p.partner_id === r.partner_id);
            const rr = royalty.data?.rows.find(p => p.partner_id === r.partner_id);
            const revenue = points?.reduce((n, p) => n + Number(p.fact_minor), 0);
            const gaps = points?.reduce((n, p) => n + p.missing_days.length, 0);
            const ready = s.fetched_at && r.mapped_count > 0;
            return <tr key={r.partner_id}>
              <td><Link to={`/partners/${r.partner_id}`}>{r.partner_name}</Link><small>{r.mapped_count ? `Контрагентов: ${r.mapped_count}` : 'Нет привязки к МойСклад'}</small>{r.counterparties.length > 0 && <details><summary>Источник поставок</summary><small>{r.counterparties.join('; ')}</small></details>}</td>
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
