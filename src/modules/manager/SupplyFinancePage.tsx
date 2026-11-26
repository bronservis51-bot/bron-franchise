import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { command, toAppError } from '../../platform/backend';
import { formatDate, monthStart } from '../../platform/dates';
import { formatMoneyShort, groupByCurrency, sumMinor, toBigInt, type MinorInput } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Button, Card, DataState, PageHeader, Select, Skeleton } from '../../ui';
import { payrollAccrualLabels } from '../finance/financeReport';
import { revenueOverview, type Overview } from '../revenue/api';
import { MonthNav } from '../revenue/components';
import { royaltySummary, type RoyaltySummary } from './api';
import { economyComparison, networkSpreadsheetLink, type PartnerEconomy, type SupplyRow } from './economyComparison';
import { RoyaltyPage } from './RoyaltyPage';
import { PurchaseDocuments } from '../finance/PurchaseDocuments';
import './supply-finance.css';

interface Unmapped { counterparty_id: string; name: string; sales_minor: number; cost_minor: number; profit_minor: number }
interface SupplySnapshot { fetched_at: string | null; period_to: string | null; currency: string; rows: SupplyRow[]; unmapped: Unmapped[] }
interface ManagerEconomy { partners: PartnerEconomy[] }

const sections = [
  ['overview', 'Обзор'],
  ['comparison', 'Сравнение'],
  ['supply', 'Поставки'],
  ['documents', 'Закупки и отгрузки'],
  ['royalty', 'Роялти и оплаты'],
] as const;
type Section = typeof sections[number][0];

const money = (amount: MinorInput, currency: string) => amount == null ? '—' : formatMoneyShort(amount, currency);
const snapshotDate = new Intl.DateTimeFormat('ru-RU', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
});

function readableData<T>({ data, error }: { data: T | undefined; error: unknown }) {
  return error && ['forbidden', 'unauthenticated'].includes(toAppError(error).code) ? undefined : data;
}

export function SupplyFinancePage() {
  const [section, setSection] = useState<Section>('overview');
  const [month, setMonth] = useState(monthStart());
  const { can } = useSession();
  const showRoyalty = can('royalty.manage');
  if (!can('org.manage')) return showRoyalty ? <RoyaltyPage /> : null;

  const selected = section === 'royalty' && !showRoyalty ? 'overview' : section;
  return <div className="economy-overview">
    <div className="chips" role="group" aria-label="Раздел экономики">
      {sections.filter(([id]) => id !== 'royalty' || showRoyalty).map(([id, label]) => (
        <button key={id} type="button" className="chip" aria-pressed={selected === id} onClick={() => setSection(id)}>{label}</button>
      ))}
    </div>
    {selected === 'documents' ? <>
      <PageHeader title="Закупки и отгрузки" />
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <PurchaseDocuments key={month} month={month} manager />
    </> : selected === 'royalty' ? <RoyaltyPage /> :
      <NetworkEconomy section={selected} month={month} setMonth={setMonth} showRoyalty={showRoyalty} />}
  </div>;
}

function NetworkEconomy({ section, month, setMonth, showRoyalty }: {
  section: Exclude<Section, 'royalty' | 'documents'>; month: string; setMonth: (month: string) => void; showRoyalty: boolean;
}) {
  const { can } = useSession();
  const showRevenue = can('revenue.read');
  const showSummary = section !== 'supply';
  const showComparison = section === 'comparison';
  const q = useQuery({ queryKey: ['supply', month], queryFn: () => command<SupplySnapshot>('manager_supply_snapshot', { month }) });
  const economy = useQuery({ queryKey: ['manager-economy', month], enabled: showComparison,
    queryFn: () => command<ManagerEconomy>('manager_economy', { month }), refetchInterval: 120_000 });
  const rev = useQuery({ queryKey: ['revenue', 'overview', month], enabled: showSummary && showRevenue, queryFn: () => revenueOverview(month) });
  const royalties = useQuery({ queryKey: ['royalty', 'summary', month], enabled: showSummary && showRoyalty, queryFn: () => royaltySummary(month) });
  const report = useQuery({
    queryKey: ['manager-google-report-link'], enabled: can('org.manage'),
    queryFn: () => command<string | null>('manager_google_report_link'),
  });
  const sheetLink = networkSpreadsheetLink(readableData(report));
  const supply = readableData(q);
  const revenue = showRevenue ? readableData(rev) : undefined;
  const royalty = showRoyalty ? readableData(royalties) : undefined;
  const refresh = () => {
    void q.refetch();
    if (showComparison) void economy.refetch();
    if (showSummary && showRevenue) void rev.refetch();
    if (showSummary && showRoyalty) void royalties.refetch();
    if (report.isError) void report.refetch();
  };
  const refreshing = q.isFetching || (showComparison && economy.isFetching)
    || (showSummary && ((showRevenue && rev.isFetching) || (showRoyalty && royalties.isFetching)));
  const error = (showComparison ? economy.error : null)
    ?? (showSummary && showRevenue ? rev.error : null)
    ?? (showSummary && showRoyalty ? royalties.error : null)
    ?? (showSummary ? q.error : null);

  return <>
    <PageHeader title="Экономика" actions={<>
      {sheetLink && <a className="btn btn-primary" href={sheetLink} target="_blank" rel="noopener noreferrer">
        <ExternalLink size={16} aria-hidden />Открыть таблицы франшизы
      </a>}
      <Button variant="secondary" onClick={refresh} loading={refreshing}>
        <RefreshCw size={16} aria-hidden />Обновить сводку
      </Button>
    </>} />
    <MonthNav month={month} onChange={setMonth} max={monthStart()} />
    <ActionError error={error} />
    {section === 'overview' && <NetworkOverview showRevenue={showRevenue} showRoyalty={showRoyalty}
      revenue={revenue} royalty={royalty} supply={supply} loading={{
        revenue: rev.isLoading, royalties: royalties.isLoading, supply: q.isLoading,
      }} />}
    {showComparison && <FranchiseComparison month={month} showRevenue={showRevenue} showRoyalty={showRoyalty}
      revenue={revenue} royalty={royalty} supply={supply} economy={readableData(economy)}
      loading={q.isLoading || economy.isLoading || (showRevenue && rev.isLoading) || (showRoyalty && royalties.isLoading)} />}
    {section === 'supply' && <DataState query={q}>{snapshot => <SupplyDetails key={month} snapshot={snapshot} />}</DataState>}
  </>;
}

function NetworkOverview({ showRevenue, showRoyalty, revenue, supply, royalty, loading }: {
  showRevenue: boolean; showRoyalty: boolean; revenue?: Overview; supply?: SupplySnapshot; royalty?: RoyaltySummary;
  loading: { revenue: boolean; royalties: boolean; supply: boolean };
}) {
  const retail = groupByCurrency(revenue?.rows ?? [], row => row.currency, row => row.fact_minor);
  const missingDays = revenue?.rows.reduce((count, row) => count + row.missing_days.length, 0);
  const mapped = supply?.fetched_at ? supply.rows.filter(row => row.mapped_count > 0) : [];
  const supplyMetrics = [
    ['Продажи управляющей компании', sumMinor(mapped.map(row => row.sales_minor))],
    ['Себестоимость отгрузок', sumMinor(mapped.map(row => row.cost_minor))],
    ['Валовая прибыль поставок', sumMinor(mapped.map(row => row.profit_minor))],
  ] as const;
  return <div className="stack">
    {showRevenue && <Card title="Розница франчайзи">
      {loading.revenue ? <Skeleton /> : <div className="kpis economy-kpis">
        <div className="kpi">
          <span className="l">Выручка</span>
          {retail.size
            ? [...retail].map(([currency, amount]) => <span className="v" key={currency}>{money(amount, currency)}</span>)
            : <span className="v">—</span>}
        </div>
        <div className={'kpi' + (missingDays ? ' warn' : '')}>
          <span className="l">Пропущено дней по точкам</span>
          <span className="v">{missingDays ?? '—'}</span>
        </div>
      </div>}
    </Card>}
    {showRoyalty && <Card title="Роялти по валютам">
      {loading.royalties ? <Skeleton /> : royalty?.totals.length ? <div className="table-wrap economy-royalty-totals" role="region" aria-label="Роялти по валютам" tabIndex={0}>
        <table className="table">
          <thead><tr><th scope="col">Валюта</th><th scope="col" className="r">Начислено</th><th scope="col" className="r">Оплачено</th></tr></thead>
          <tbody>{royalty.totals.map(row => <tr key={row.currency}>
            <th scope="row">{row.currency}</th>
            <td className="r num">{money(row.accrued_minor, row.currency)}</td>
            <td className="r num">{money(row.paid_minor, row.currency)}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p>{royalty ? 'Нет данных за этот месяц.' : 'Данные роялти недоступны.'}</p>}
    </Card>}
    <Card title="Поставки франчайзи">
      {loading.supply ? <Skeleton /> : mapped.length && supply ? <div className="kpis economy-kpis">{supplyMetrics.map(([label, amount]) => (
        <div className="kpi" key={label}><span className="l">{label}</span><span className="v">{money(amount, supply.currency)}</span></div>
      ))}</div> : <p>{!supply ? 'Данные поставок недоступны.' : supply.fetched_at
        ? 'Продажи по привязанным франчайзи отсутствуют.' : 'Нет загруженного снимка за этот месяц.'}</p>}
      {supply?.fetched_at && <p className="faint">Снимок МойСклад от {snapshotDate.format(new Date(supply.fetched_at))} МСК.</p>}
    </Card>
  </div>;
}

function EconomyTable({ label, columns, children }: { label: string; columns: string[]; children: ReactNode }) {
  return <>
    <p className="economy-scroll-hint faint">Прокрутите таблицу вправо, чтобы увидеть другие показатели.</p>
    <div className="economy-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="economy-table">
        <thead><tr>{columns.map(column => <th scope="col" key={column}>{column}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  </>;
}

function FranchiseComparison({ month, showRevenue, showRoyalty, revenue, royalty, supply, economy, loading }: {
  month: string; showRevenue: boolean; showRoyalty: boolean; revenue?: Overview; royalty?: RoyaltySummary;
  supply?: SupplySnapshot; economy?: ManagerEconomy; loading: boolean;
}) {
  const label = 'Сравнение франчайзи';
  const rows = economyComparison({ points: revenue?.rows, salaries: economy?.partners, royalties: royalty?.rows, supplies: supply?.rows });
  const payrollLabels = payrollAccrualLabels(month);
  return <Card title={label} className="economy-comparison">
    {rows.length ? <EconomyTable label={label} columns={['Франчайзи',
      ...(showRevenue ? ['Розничная выручка'] : []), ...(showRoyalty ? ['Роялти'] : []), 'Зарплата', 'Расходы', 'Поставки']}>
      {rows.map(row => {
        const r = row.royalty;
        const p = row.salaries;
        const mapped = supply?.fetched_at && row.supply && row.supply.mapped_count > 0;
        return <tr key={row.id}>
          <th scope="row"><Link to={'/partners/' + row.id}>{row.name}</Link></th>
          {showRevenue && <td>
            {row.retail.size ? [...row.retail].map(([currency, amount]) =>
              <strong className="economy-value" key={currency}>{money(amount, currency)}</strong>) : '—'}
            {row.missingDays !== null && <small>{row.missingDays ? 'Пропущено дней по точкам: ' + row.missingDays : 'Все прошедшие дни заполнены'}</small>}
          </td>}
          {showRoyalty && <td>{r ? <>
            <small>Начислено: {money(toBigInt(r.accrued_minor) + toBigInt(r.manual_minor), r.currency)}</small>
            <small>Оплачено: {money(r.paid_minor, r.currency)}</small>
            <small>{r.is_open ? 'Предварительный остаток' : 'Остаток'}: <strong>{money(r.debt_minor, r.currency)}</strong></small>
          </> : '—'}</td>}
          <td>{p ? <>
            <strong className="economy-value">{money(p.payroll_minor, p.currency)}</strong>
            <small>Закрыто смен: {p.closed_shifts}</small>
            {p.payroll_halves && <details><summary>График выплат</summary>
              {p.payroll_halves.map((amount, index) => <small key={payrollLabels[index]}>{payrollLabels[index]} · {money(amount, p.currency)}</small>)}
            </details>}
          </> : '—'}</td>
          <td>{p?.expense_categories.length ? <>
            <strong className="economy-value">{money(p.expenses_minor, p.currency)}</strong>
            <details><summary>Статьи расходов</summary>
              {p.expense_categories.map(item => <small key={item.category}>{item.category}: {money(item.amount_minor, p.currency)}</small>)}
            </details>
          </> : <><span>—</span>{p && <small>Не внесены</small>}</>}</td>
          <td>{mapped && supply && row.supply ? <>
            <small>Продажи: <strong>{money(row.supply.sales_minor, supply.currency)}</strong></small>
            <small>Валовая прибыль: {money(row.supply.profit_minor, supply.currency)}</small>
          </> : '—'}</td>
        </tr>;
      })}
    </EconomyTable> : loading ? <Skeleton /> : <p>Нет данных для сравнения за этот месяц.</p>}
  </Card>;
}

function SupplyDetails({ snapshot: s }: { snapshot: SupplySnapshot }) {
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const bind = useMutation({
    mutationFn: ({ counterparty, partner }: { counterparty: string; partner: string }) => command('manager_supply_map', { counterparty, partner }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supply'] }),
  });

  return <div className="stack">
    <Card title="Поставки по франчайзи">
      {!s.fetched_at ? <p>Нет загруженного снимка за этот месяц.</p> : <>
        <p className="faint">Снимок МойСклад от {snapshotDate.format(new Date(s.fetched_at))} МСК.
          {s.period_to && ' Данные по ' + formatDate(s.period_to.slice(0, 10)) + '.'}</p>
        {s.rows.length ? <EconomyTable label="Поставки по франчайзи" columns={['Франчайзи', 'Наши продажи', 'Себестоимость', 'Валовая прибыль']}>
          {s.rows.map(row => <tr key={row.partner_id}>
            <th scope="row"><Link to={'/partners/' + row.partner_id}>{row.partner_name}</Link>
              {row.counterparties.length > 0 && <details><summary>Источники</summary><small>{row.counterparties.join(', ')}</small></details>}
            </th>
            <td>{money(row.mapped_count ? row.sales_minor : null, s.currency)}</td>
            <td>{money(row.mapped_count ? row.cost_minor : null, s.currency)}</td>
            <td>{money(row.mapped_count ? row.profit_minor : null, s.currency)}</td>
          </tr>)}
        </EconomyTable> : <p>Нет активных франчайзи в снимке.</p>}
      </>}
    </Card>
    {s.unmapped.length > 0 && <Card title={'Без привязки к франчайзи: ' + s.unmapped.length}>
      <p className="faint">Проверьте карточку МойСклад перед привязкой. Эти продажи войдут в сводку после привязки.</p>
      <ActionError error={bind.error} />
      {s.unmapped.map(c => <div className="supply-mapping" key={c.counterparty_id}>
        <div>
          <strong>{c.name}</strong>
          <small>{money(c.sales_minor, s.currency)} продаж · {money(c.cost_minor, s.currency)} себестоимость</small>
          <a className="faint" href={'https://online.moysklad.ru/app/#Company/edit?id=' + encodeURIComponent(c.counterparty_id)} target="_blank" rel="noopener noreferrer">Открыть карточку МойСклад</a>
        </div>
        <Select aria-label={'Франчайзи для ' + c.name} value={mapping[c.counterparty_id] ?? ''} disabled={bind.isPending}
          onChange={event => setMapping(value => ({ ...value, [c.counterparty_id]: event.target.value }))}>
          <option value="">Выберите франчайзи</option>
          {s.rows.map(row => <option key={row.partner_id} value={row.partner_id}>{row.partner_name}</option>)}
        </Select>
        <Button size="sm" disabled={!mapping[c.counterparty_id] || bind.isPending}
          loading={bind.isPending && bind.variables?.counterparty === c.counterparty_id}
          onClick={() => bind.mutate({ counterparty: c.counterparty_id, partner: mapping[c.counterparty_id] })}>Привязать</Button>
      </div>)}
    </Card>}
  </div>;
}
