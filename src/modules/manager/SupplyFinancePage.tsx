import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { command, toAppError } from '../../platform/backend';
import { monthStart } from '../../platform/dates';
import { useSession } from '../../platform/session';
import { formatMoneyShort } from '../../platform/money';
import { ActionError, Button, Card, ConfirmDialog, DataState, Field, Input, MoneyInput, PageHeader, Select } from '../../ui';
import { payrollAccrualLabels } from '../finance/financeReport';
import { MonthNav } from '../revenue/components';
import { revenueOverview } from '../revenue/api';
import { royaltySummary } from './api';
import { RoyaltyPage } from './RoyaltyPage';
import { useToast } from '../../ui/toast';

interface SupplyRow { partner_id: string; partner_name: string; mapped_count: number; counterparties: string[]; sales_minor: number; cost_minor: number; profit_minor: number }
interface Unmapped { counterparty_id: string; name: string; sales_minor: number; cost_minor: number; profit_minor: number }
interface SupplySnapshot { month: string; fetched_at: string | null; period_to: string | null; currency: string; rows: SupplyRow[]; unmapped: Unmapped[] }
interface NetworkExpense { id: string; category: string; amount_minor: number; note: string | null; created_at: string }
interface CompanyExpenseDraft { id: string; category: string; amount: string; note: string }
interface PartnerEconomy { partner_id: string; partner_name: string; currency: string; payroll_minor: number; payroll_halves?: [number, number];
  closed_shifts: number; expenses_minor: number;
  expense_categories: { category: string; amount_minor: number }[] }
interface ManagerEconomy { month: string; company_expenses: NetworkExpense[]; company_expense_totals: { category: string; amount_minor: number }[]; partners: PartnerEconomy[] }
const money = (n: number | string | undefined, c = 'RUB') => n === undefined ? '—' : formatMoneyShort(n, c);

function EconomyCell({ label, children }: { label: string; children: ReactNode }) {
  return <td><span className="economics-mobile-label" aria-hidden>{label}</span><div>{children}</div></td>;
}

export function SupplyFinancePage() {
  const [section, setSection] = useState<'overview' | 'royalty'>('overview');
  const { can } = useSession();
  const showRoyalty = can('royalty.manage');
  if (!can('org.manage')) return showRoyalty ? <RoyaltyPage /> : null;
  return <div className="economy-overview">
    {showRoyalty && <div className="chips" role="group" aria-label="Раздел экономики">
      <button type="button" className="chip" aria-pressed={section === 'overview'} onClick={() => setSection('overview')}>Обзор</button>
      <button type="button" className="chip" aria-pressed={section === 'royalty'} onClick={() => setSection('royalty')}>Роялти и оплаты</button>
    </div>}
    {showRoyalty && section === 'royalty' ? <RoyaltyPage /> : <FranchiseOverview />}
  </div>;
}

function FranchiseOverview() {
  const { can } = useSession();
  const showRevenue = can('revenue.read');
  const showRoyalty = can('royalty.manage');
  const [month, setMonth] = useState(monthStart());
  const payrollLabels = payrollAccrualLabels(month);
  const q = useQuery({ queryKey: ['supply', month], queryFn: () => command<SupplySnapshot>('manager_supply_snapshot', { month }) });
  const economy = useQuery({ queryKey: ['manager-economy', month], queryFn: () => command<ManagerEconomy>('manager_economy', { month }),
    refetchInterval: 120_000 });
  const rev = useQuery({ queryKey: ['revenue', 'overview', month], enabled: showRevenue, queryFn: () => revenueOverview(month) });
  const royalty = useQuery({ queryKey: ['royalty', 'summary', month], enabled: showRoyalty, queryFn: () => royaltySummary(month) });
  const revenueData = showRevenue ? rev.data : undefined;
  const royaltyData = showRoyalty ? royalty.data : undefined;
  const qc = useQueryClient();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const bind = useMutation({ mutationFn: (counterparty: string) => command('manager_supply_map', { counterparty, partner: mapping[counterparty] }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['supply'] }); } });
  return <>
    <PageHeader title="Экономика франшизы" sub="Выручка партнёров, роялти и поставки за выбранный месяц."
      actions={<Button onClick={() => { void q.refetch(); void economy.refetch(); if (showRevenue) void rev.refetch(); if (showRoyalty) void royalty.refetch(); }} loading={q.isFetching || economy.isFetching || rev.isFetching || royalty.isFetching}><RefreshCw size={16} aria-hidden />Обновить сводку</Button>} />
    <MonthNav month={month} onChange={setMonth} max={monthStart()} />
    <ActionError error={economy.error ?? (showRevenue ? rev.error : null) ?? (showRoyalty ? royalty.error : null) ?? bind.error} />
    <DataState query={q} skeleton={5}>{s => {
      const total = s.rows.filter(r => r.mapped_count > 0).reduce((a, r) => ({ sales: a.sales + Number(r.sales_minor), cost: a.cost + Number(r.cost_minor), profit: a.profit + Number(r.profit_minor) }), { sales: 0, cost: 0, profit: 0 });
      const retailByCurrency = (revenueData?.rows ?? []).reduce<Record<string, number>>((totals, row) => {
        totals[row.currency] = (totals[row.currency] ?? 0) + Number(row.fact_minor);
        return totals;
      }, {});
      const missingDays = revenueData?.rows.reduce((count, row) => count + row.missing_days.length, 0);
      const hasMappedSupply = Boolean(s.fetched_at && s.rows.some(r => r.mapped_count > 0));
      return <div className="stack">
        {s.fetched_at && <p className="faint">Снимок поставок от {new Date(s.fetched_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК. Период по {s.period_to?.slice(0, 10).split('-').reverse().join('.')}. Кнопка обновляет сводку из последнего загруженного снимка.</p>}
        <Card title="Сводка сети за месяц">
          <div className="kpis">
            <div className="kpi"><span className="l">Розничная выручка</span>
              {Object.entries(retailByCurrency).length ? Object.entries(retailByCurrency).map(([currency, value]) => <span className="v" key={currency}>{money(value, currency)}</span>) : <span className="v">—</span>}
              <span className="l">Продажи франчайзи своим клиентам</span>
            </div>
            <div className="kpi"><span className="l">Роялти: начислено / оплачено</span>
              {royaltyData?.totals.length ? royaltyData.totals.map(row => <span className="v" key={row.currency}>{money(row.accrued_minor, row.currency)} / {money(row.paid_minor, row.currency)}</span>) : <span className="v">—</span>}
              <span className="l">По валютам, без пересчёта в одну</span>
            </div>
            <div className={`kpi${missingDays ? ' warn' : ''}`}><span className="v">{missingDays === undefined ? '—' : missingDays}</span><span className="l">Не заполнено прошедших дней</span></div>
            <div className="kpi"><span className="v">{hasMappedSupply ? money(total.sales) : '—'}</span><span className="l">Поставки: наши продажи, ₽</span></div>
            <div className="kpi"><span className="v">{hasMappedSupply ? money(total.cost) : '—'}</span><span className="l">Себестоимость отгрузок, ₽</span></div>
            <div className="kpi"><span className="v">{hasMappedSupply ? money(total.profit) : '—'}</span><span className="l">Валовая прибыль поставок, ₽</span></div>
          </div>
          <p className="faint">Эти данные показывают выручку франчайзи, роялти и поставки. Для расчёта чистой прибыли сети нужны и другие данные.</p>
        </Card>
        <DataState query={economy} skeleton={3}>{e => <>
          <CompanyExpenses month={month} expenses={e.company_expenses} totals={e.company_expense_totals} />
          <Card title="Расходы и зарплаты франчайзи">
            <p className="faint">Суммы показаны в валюте каждого франчайзи. Зарплаты начислены по закрытым сменам, даты выплат указаны по графику.</p>
            <div className="economics-table-wrap" role="region" aria-label="Расходы и зарплаты франчайзи" tabIndex={0}><table className="economics-table" role="table">
              <thead><tr><th>Франчайзи</th><th>Зарплата за месяц</th><th>Закрытые смены</th><th>Расходы</th><th>Структура расходов</th></tr></thead>
              <tbody>{e.partners.map(p => <tr key={p.partner_id}>
                <td><Link to={`/partners/${p.partner_id}`}>{p.partner_name}</Link></td>
                <EconomyCell label="Зарплата за месяц">{money(p.payroll_minor,p.currency)}
                  {p.payroll_halves?.map((amount, index) => <small key={payrollLabels[index]}>
                    {payrollLabels[index]} · {money(amount, p.currency)}
                  </small>)}
                </EconomyCell>
                <EconomyCell label="Закрытые смены">{p.closed_shifts}</EconomyCell>
                <EconomyCell label="Расходы">{money(p.expenses_minor,p.currency)}</EconomyCell>
                <EconomyCell label="Структура расходов">{p.expense_categories.length ? <details><summary>Статьи: {p.expense_categories.length}</summary><small>{p.expense_categories.map(x => `${x.category}: ${money(x.amount_minor,p.currency)}`).join(' · ')}</small></details> : '—'}</EconomyCell>
              </tr>)}</tbody>
            </table></div>
            <p className="faint">Здесь нет данных по отдельным сотрудникам. Не внесённые расходы не считаются нулевыми подтверждёнными затратами.</p>
          </Card>
        </>}</DataState>
        <div className="economics-table-wrap" role="region" aria-label="Розница, роялти и поставки по франчайзи" tabIndex={0}><table className="economics-table" role="table">
          <thead><tr><th>Франчайзи</th><th>Розничная выручка</th><th>Роялти начислено / оплачено</th><th>Остаток за месяц</th><th>Наши продажи, ₽</th><th>Себестоимость, ₽</th><th>Валовая прибыль, ₽</th></tr></thead>
          <tbody>{s.rows.map(r => {
            const points = revenueData?.rows.filter(p => p.partner_id === r.partner_id);
            const rr = royaltyData?.rows.find(p => p.partner_id === r.partner_id);
            const revenue = points?.reduce((n, p) => n + Number(p.fact_minor), 0);
            const gaps = points?.reduce((n, p) => n + p.missing_days.length, 0);
            const ready = s.fetched_at && r.mapped_count > 0;
            return <tr key={r.partner_id}>
              <td><Link to={`/partners/${r.partner_id}`}>{r.partner_name}</Link>{r.counterparties.length > 0 && <details><summary>Источник поставок</summary><small>{r.counterparties.join('; ')}</small></details>}</td>
              <EconomyCell label="Розничная выручка">{points?.length ? money(revenue, points[0].currency) : '—'}<small>{points?.length ? gaps ? `Не заполнено ${gaps} дней по точкам` : 'Все прошедшие дни заполнены' : 'Нет отчётов по точкам'}</small></EconomyCell>
              <EconomyCell label="Роялти начислено / оплачено">{rr ? `${money(Number(rr.accrued_minor) + Number(rr.manual_minor), rr.currency)} / ${money(rr.paid_minor, rr.currency)}` : '—'}</EconomyCell>
              <EconomyCell label="Остаток за месяц">{rr ? money(Number(rr.accrued_minor) + Number(rr.manual_minor) - Number(rr.paid_minor), rr.currency) : '—'}{rr?.is_open && <small>Месяц ещё открыт</small>}</EconomyCell>
              <EconomyCell label="Наши продажи, ₽">{ready ? money(r.sales_minor) : '—'}</EconomyCell>
              <EconomyCell label="Себестоимость, ₽">{ready ? money(r.cost_minor) : '—'}</EconomyCell>
              <EconomyCell label="Валовая прибыль, ₽">{ready ? money(r.profit_minor) : '—'}</EconomyCell>
            </tr>;
          })}</tbody>
        </table></div>
        {s.unmapped.length > 0 && <Card title={`Без привязки к франчайзи: ${s.unmapped.length}`}>
          <p className="faint">Эти суммы не входят в итоги выше. Привязывайте карточку после проверки личности; одинаковое имя не подтверждает совпадение.</p>
          {s.unmapped.map(c => <div className="supply-mapping" key={c.counterparty_id}>
            <div><strong>{c.name}</strong><small>{money(c.sales_minor)} продаж · {money(c.cost_minor)} себестоимость</small><a className="faint" href={`https://online.moysklad.ru/app/#Company/edit?id=${c.counterparty_id}`} target="_blank" rel="noopener noreferrer">Открыть карточку МойСклад</a></div>
            <Select aria-label={`Франчайзи для ${c.name}`} value={mapping[c.counterparty_id] ?? ''} onChange={e => setMapping(x => ({ ...x, [c.counterparty_id]: e.target.value }))}>
              <option value="">Выберите франчайзи</option>{s.rows.map(p => <option key={p.partner_id} value={p.partner_id}>{p.partner_name}</option>)}
            </Select>
            <Button size="sm" disabled={!mapping[c.counterparty_id]} loading={bind.isPending} onClick={() => bind.mutate(c.counterparty_id)}>Привязать</Button>
          </div>)}
        </Card>}
      </div>;
    }}</DataState>
  </>;
}

function CompanyExpenses({ month, expenses, totals }: { month: string; expenses: NetworkExpense[]; totals: ManagerEconomy['company_expense_totals'] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<NetworkExpense | null | undefined>(undefined);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['manager-economy', month], exact: true });
  const refreshMissing = (error: unknown) => { if (toAppError(error).code === 'not-found') refresh(); };
  const save = useMutation({
    mutationFn: (value: CompanyExpenseDraft) => command<string>('manager_company_expense_save', {
      id: value.id || null, month, category: value.category.trim(), amount: value.amount, note: value.note.trim() || null,
    }),
    onSuccess: (_id, value) => { toast(value.id ? 'Расход изменён' : 'Расход управляющей компании добавлен'); setDraft(undefined); refresh(); },
    onError: refreshMissing,
  });
  const remove = useMutation({
    mutationFn: (id: string) => command('manager_company_expense_delete', { id }),
    onSuccess: () => { toast('Расход удалён'); setDeleteId(null); refresh(); },
    onError: refreshMissing,
  });
  const openExpense = (item: NetworkExpense | null) => { save.reset(); setDraft(item); };
  return <>
    <Card title="Управляющая компания">
      <p className="faint">Закупочная себестоимость поставок и отдельно учтённые расходы управляющей компании, ₽. Операционные расходы сюда не попадают автоматически.</p>
      <div className="kpis">
        {totals.length ? totals.map(row => <div className="kpi" key={row.category}><span className="l">{row.category}</span><span className="v">{money(row.amount_minor)}</span></div>) : <p className="faint">Расходы управляющей компании за этот месяц ещё не внесены.</p>}
      </div>
      {expenses.length > 0 && <ul className="expense-list">
        {expenses.map(item => <li key={item.id}><div className="expense-row">
          <span className="expense-main"><strong>{item.category}</strong>{item.note && <span className="faint">{item.note}</span>}</span>
          <strong className="num">{money(item.amount_minor)}</strong>
          <Button size="sm" variant="ghost" onClick={() => openExpense(item)}>Изменить</Button>
          <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => { remove.reset(); setDeleteId(item.id); }}>Удалить</Button>
        </div></li>)}
      </ul>}
      <Button size="sm" onClick={() => openExpense(null)}>Добавить расход</Button>
    </Card>
    {draft !== undefined && <CompanyExpenseDialog
      value={draft}
      busy={save.isPending}
      error={save.error}
      onClose={() => setDraft(undefined)}
      onSave={(value) => save.mutate(value)}
    />}
    <ConfirmDialog open={Boolean(deleteId)} title="Удалить расход управляющей компании?" confirmLabel="Удалить" cancelLabel="Отмена" danger
      busy={remove.isPending} error={remove.error} onClose={() => setDeleteId(null)} onConfirm={() => { if (deleteId) remove.mutate(deleteId); }} />
  </>;
}

function CompanyExpenseDialog({ value, busy, error, onClose, onSave }: {
  value: NetworkExpense | null; busy: boolean; error: unknown; onClose: () => void; onSave: (value: CompanyExpenseDraft) => void;
}) {
  const [category, setCategory] = useState(value?.category ?? '');
  const initialAmount = value?.amount_minor ? String(value.amount_minor) : '';
  const [amount, setAmount] = useState(initialAmount);
  const [amountValid, setAmountValid] = useState(true);
  const [note, setNote] = useState(value?.note ?? '');
  const canSave = Boolean(category.trim() && amountValid && amount && amount !== '0');
  const dirty = !amountValid || category !== (value?.category ?? '') || amount !== initialAmount || note !== (value?.note ?? '');
  return <ConfirmDialog open title={value?.id ? 'Изменить расход компании' : 'Расход управляющей компании'} confirmLabel="Сохранить" cancelLabel="Закрыть"
    busy={busy} error={error} disabled={!canSave} dirty={dirty} onClose={onClose}
    onConfirm={() => { if (canSave && !busy) onSave({ id: value?.id ?? '', category, amount, note }); }}>
    <fieldset className="stack" disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Field label="Статья расхода" required>{id => <Input id={id} value={category} onChange={event => setCategory(event.target.value)} maxLength={60} placeholder="Например: аренда офиса" autoFocus />}</Field>
      <Field label="Сумма за месяц, RUB" required error={!amountValid ? 'Укажите сумму, например 12,50.' : undefined}>
        {(id, describedBy) => <MoneyInput id={id} describedBy={describedBy} value={amount} onChange={setAmount}
          onValidityChange={setAmountValid} currency="RUB" requireExplicitValue />}
      </Field>
      <Field label="Комментарий">{id => <Input id={id} value={note} onChange={event => setNote(event.target.value)} maxLength={500} placeholder="Необязательно" />}</Field>
    </fieldset>
  </ConfirmDialog>;
}
