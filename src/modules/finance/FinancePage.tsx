// Финансы франчайзи: выручка, зарплата, расходы и остаток по всем точкам или по одной.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, Pencil } from 'lucide-react';
import { AppError, captureSession, command } from '../../platform/backend';
import { formatDate, monthLabel, monthStart } from '../../platform/dates';
import { formatMoneyShort, minorToDecimal, toBigInt, type MinorInput } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Button, Card, DataState, Money, PageHeader } from '../../ui';
import type { RoyaltyPayment, UndatedRoyalty } from '../manager/api';
import { revenueMonth } from '../revenue/api';
import { MonthNav } from '../revenue/components';
import { revenueMonthSheet } from '../revenue/monthReport';
import { PayrollSchedule } from '../staff/PayrollSchedule';
import { ExpensesCard, type Expense } from './Expenses';
import { FinanceDriveDialog } from './FinanceDriveDialog';
import { FinanceEditor } from './FinanceEditor';
import { downloadFinanceFile, FINANCE_PAYROLL_NOTE, FINANCE_REPORT_NOTE, financeExpensesMinor, financeReportRows, payrollAccrualLabels } from './financeReport';
import './finance.css';

interface Fin { month: string; revenue_minor: number; cash_minor: number; card_minor: number; plan_minor: number | null; pct: number | null;
  payroll_minor: number; payroll_halves?: readonly [MinorInput, MinorInput]; shifts: number; rate_bp: number; royalty_minor: number;
  expenses_minor: number; return_minor?: number; net_minor: number; is_open: boolean }
interface Ledger { month: string; revenue_minor: number; rate_bp: number; accrued_minor: number; manual_minor: number; paid_minor: number; debt_minor: number; is_open: boolean;
  correction_minor?: number; past_debt_minor?: number }
interface Royalty { debt_minor: number; months: Ledger[]; payments: RoyaltyPayment[]; undated?: UndatedRoyalty | null; undated_payments?: RoyaltyPayment[] }
interface Finance {
  partner_name: string; currency: string; month: string; location_id: string | null;
  partner_status?: string;
  locations: { id: string; name: string; status: string }[];
  current: Fin; months: Fin[];
  by_location: (Fin & { location_id: string; location_name: string })[] | null;
  by_staff: { user_id: string; full_name: string; shifts: number; revenue_minor: number; earned_minor: number;
    payroll_halves?: readonly [MinorInput, MinorInput] }[];
  expenses: Expense[]; expense_categories: string[]; prev_expenses_count: number;
  royalty: Royalty | null;
}

const pct = (bp: number) => `${(bp / 100).toLocaleString('ru-RU')} %`;
const n = (v: number | string) => Number(v);

/** Помесячное распределение выручки. */
function MonthsChart({ months, currency }: { months: Fin[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...months.map((m) => n(m.revenue_minor)));
  const hasReturns = months.some(m => Boolean(m.return_minor));
  const parts = (m: Fin) => [
    { key: 'net', label: 'Остаётся', v: Math.max(0, n(m.net_minor)) },
    { key: 'payroll', label: 'Зарплата', v: n(m.payroll_minor) },
    { key: 'expenses', label: 'Расходы', v: Number(financeExpensesMinor(m)) },
    ...(hasReturns ? [{ key: 'returns', label: 'Возвраты', v: n(m.return_minor ?? 0) }] : []),
  ];
  const selected = hover === null ? null : months[hover];
  return (
    <figure className="fin-chart viz-root" aria-label="Выручка по месяцам">
      <div className="fin-legend" aria-hidden>
        <span><i className="sw net" />Остаётся</span><span><i className="sw payroll" />Зарплата сотрудников</span><span><i className="sw expenses" />Расходы</span>
        {hasReturns && <span><i className="sw returns" />Возвраты</span>}
      </div>
      <div className="fin-plot" onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setHover(null); }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHover(null); }}
        onKeyDown={event => { if (event.key === 'Escape') setHover(null); }}>
        <div className="fin-bars">
          {months.map((m, i) => (
            <div key={m.month} className="fin-col" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
              aria-label={`${monthLabel(m.month)}: выручка ${formatMoneyShort(m.revenue_minor, currency)}`}>
              <div className="fin-stack" style={{ height: `${(n(m.revenue_minor) / max) * 100}%` }}>
                {parts(m).map((p) => p.v > 0 && <span key={p.key} className={`seg ${p.key}`} style={{ flexGrow: p.v }} />)}
              </div>
              <span className="fin-month">{monthLabel(m.month, false).slice(0, 3)}{m.is_open ? '*' : ''}</span>
            </div>
          ))}
        </div>
      </div>
      {selected && <div className="fin-tip" role="tooltip">
        <strong>{monthLabel(selected.month)}{selected.is_open ? ' (идёт)' : ''}</strong>
        <div className="fin-tip-row">Выручка <b>{formatMoneyShort(selected.revenue_minor, currency)}</b></div>
        {parts(selected).map(p => <div className="fin-tip-row" key={p.key}>
          <span><i className={`sw ${p.key}`} />{p.label}</span><b>{formatMoneyShort(p.v, currency)}</b>
        </div>)}
      </div>}
      <figcaption className="faint">* текущий месяц — данные на сегодня</figcaption>
    </figure>
  );
}

function financeScope(f: Finance) {
  return f.location_id ? f.locations.find((location) => location.id === f.location_id)?.name ?? 'Точка' : 'Все точки';
}

async function financeWorkbook(f: Finance, reportOnly: boolean) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const money = (v: MinorInput) => ({ value: Number(minorToDecimal(v, f.currency)), type: Number, format: '#,##0.00' });
  const head = (value: string) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC' });
  const scope = financeScope(f);
  const statement = { sheet: 'Доходы и расходы', columns: [{ width: 50 }, { width: 21 }], data: [
    [head(`${f.partner_name} · ${monthLabel(f.month)} · ${scope}`)],
    [{ value: FINANCE_REPORT_NOTE }],
    ...(f.current.payroll_halves ? [[{ value: FINANCE_PAYROLL_NOTE, wrap: true }]] : []),
    [head('Статья'), head(`Сумма, ${f.currency}`)],
    ...financeReportRows(f.current, f.expenses).map((entry) => [
      { value: entry.label, indent: entry.indent, wrap: true, fontWeight: entry.total ? 'bold' as const : undefined },
      { ...money(entry.minor), fontWeight: entry.total ? 'bold' as const : undefined },
    ]),
  ] };
  if (reportOnly) return writeXlsxFile([statement]);
  const pointIds = f.location_id ? [f.location_id] : f.locations.map((point) => point.id);
  const dailyRevenue = await Promise.all(pointIds.map((id) => revenueMonth(id, f.month)));
  const totalsByPoint = new Map(f.by_location?.map((point) => [point.location_id, point]));
  const match = dailyRevenue.every((detail, index) => {
    const pointId = pointIds[index];
    const total = f.location_id ? f.current : totalsByPoint.get(pointId);
    return total && detail.month === f.month && detail.location_id === pointId
      && toBigInt(detail.fact_minor) === toBigInt(total.revenue_minor)
      && toBigInt(detail.cash_minor) === toBigInt(total.cash_minor)
      && toBigInt(detail.card_minor) === toBigInt(total.card_minor)
      && toBigInt(detail.return_minor ?? 0) === toBigInt(total.return_minor ?? 0);
  });
  if (!match) throw new AppError('version-conflict', 'Выручка изменилась. Скачайте отчёт ещё раз.', '', '');
  const cols = ['Месяц', 'Выручка', 'Наличные', 'Карта', 'Без разбивки', 'План', 'Выполнение', 'Зарплата', 'Расходы', 'Остаётся', 'Возвраты'].map(head);
  const row = (label: string, m: Fin) => [label, money(m.revenue_minor), money(m.cash_minor), money(m.card_minor), money(Number(m.revenue_minor)-Number(m.cash_minor)-Number(m.card_minor)), m.plan_minor ? money(m.plan_minor) : null,
    m.pct !== null ? { value: m.pct / 100, type: Number, format: '0.0%' } : null, money(m.payroll_minor), money(financeExpensesMinor(m)), money(m.net_minor), money(m.return_minor ?? 0)];
  const expenseRows = f.expenses.map((e) => [e.category, e.location_name ?? 'все точки', money(e.amount_minor), e.note ?? '']);
  if (toBigInt(f.current.royalty_minor) !== 0n) expenseRows.push(['Роялти по ставке', scope, money(f.current.royalty_minor), '']);
  const payrollLabels = f.by_staff.some(staff => staff.payroll_halves) ? payrollAccrualLabels(f.month) : [];
  const sheets = [
    statement,
    { sheet: 'По месяцам', columns: [{ width: 16 }, ...Array(cols.length - 1).fill({ width: 14 })],
      data: [[{ value: `${f.partner_name} — финансы (${scope})`, fontWeight: 'bold' as const, fontSize: 14 }], [], cols, ...f.months.map((m) => row(monthLabel(m.month), m))] },
    ...(f.by_location ? [{ sheet: 'По точкам', columns: [{ width: 26 }, ...Array(cols.length - 1).fill({ width: 14 })],
      data: [[head('Точка'), ...cols.slice(1)], ...f.by_location.map((l) => row(l.location_name, l))] }] : []),
    ...(f.by_staff.length ? [{ sheet: 'Зарплата', columns: [{ width: 26 }, { width: 10 }, { width: 16 }, { width: 20 },
      ...payrollLabels.map(() => ({ width: 38 }))],
      data: [['Сотрудник', 'Смен', 'Выручка смен', 'Начислено за месяц', ...payrollLabels].map(head),
        ...f.by_staff.map((s) => [s.full_name, { value: s.shifts, type: Number }, money(s.revenue_minor), money(s.earned_minor),
          ...payrollLabels.map((_label, index) => s.payroll_halves ? money(s.payroll_halves[index]) : null)])] }] : []),
    ...(expenseRows.length ? [{ sheet: 'Расходы', columns: [{ width: 26 }, { width: 24 }, { width: 16 }, { width: 30 }],
      data: [['Категория', 'Точка', 'Сумма', 'Комментарий'].map(head), ...expenseRows] }] : []),
    ...(dailyRevenue.length ? [revenueMonthSheet(dailyRevenue)] : []),
  ];
  return writeXlsxFile(sheets);
}

async function makeFinanceReportFile(f: Finance, userId: string, reportOnly: boolean) {
  await captureSession(userId);
  const blob = await (await financeWorkbook(f, reportOnly)).toBlob();
  const session = await captureSession(userId);
  const scope = await command<Finance>('finance_my', { month: f.month, location: f.location_id }, { accessToken: session.access_token });
  if (scope.partner_name !== f.partner_name || scope.location_id !== f.location_id ||
    f.locations.some(location => !scope.locations.some(current => current.id === location.id))) {
    throw new AppError('forbidden', 'Данные выбранного партнёра изменились. Откройте отчёт заново.', '', '');
  }
  await captureSession(userId);
  return new File([blob], `${reportOnly ? 'OPiU' : 'finansy'}-${f.month.slice(0, 7)}.xlsx`, { type: blob.type });
}

function FinanceStatement({ finance }: { finance: Finance }) {
  const month = finance.current;
  return (
    <Card title={`Доходы и расходы — ${monthLabel(finance.month)}`} actions={<span className="faint">{finance.currency}</span>}>
      <dl style={{ margin: 0 }}>
        {financeReportRows(month, finance.expenses).map((row, i) => (
          <div className="row between access-row" key={i}>
            <dt className={row.indent === 2 ? 'faint' : undefined} style={row.indent ? { paddingInlineStart: row.indent * 12 } : undefined}>
              {row.total ? <strong>{row.label}</strong> : row.label}
            </dt>
            <dd style={{ margin: 0 }}><Money minor={row.minor} currency={finance.currency} short strong={row.total} /></dd>
          </div>
        ))}
      </dl>
      <p className="faint">{FINANCE_REPORT_NOTE}</p>
      {month.payroll_halves && <p className="faint">{FINANCE_PAYROLL_NOTE}</p>}
      <p className="faint">
        {month.is_open && 'Текущий месяц ещё идёт. '}
        {month.plan_minor ? `План ${formatMoneyShort(month.plan_minor, finance.currency)}${month.pct === null ? '' : ` · выполнено ${n(month.pct).toLocaleString('ru-RU')} %`}` : 'План не поставлен'}
        {month.shifts > 0 && ` · закрытых смен: ${month.shifts}`}
      </p>
    </Card>
  );
}

export function FinancePage() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const [month, setMonth] = useState(monthStart());
  const [loc, setLoc] = useState<string | null>(null);
  const userId = me?.user.id;
  const exportRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { exportRequest.current?.abort(); exportRequest.current = null; }, [userId]);
  const q = useQuery({ queryKey: ['finance', month, loc], queryFn: () => command<Finance>('finance_my', { month, location: loc }), refetchInterval: 120_000 });
  const exp = useMutation({
    mutationFn: ({ report, userId, request }: { report: Finance; userId: string; request: AbortController }) =>
      downloadFinanceFile(() => makeFinanceReportFile(report, userId, false), request.signal),
    networkMode: 'always',
    onError: (error, { report, request }) => {
      if (!request.signal.aborted && error instanceof AppError && error.code === 'version-conflict') {
        return qc.invalidateQueries({ queryKey: ['finance', report.month, report.location_id], exact: true });
      }
    },
    onSettled: (_data, _error, { request }) => { if (exportRequest.current === request) exportRequest.current = null; },
  });
  const [editing, setEditing] = useState(false);
  const [drive, setDrive] = useState<{ finance: Finance; userId: string } | null>(null);
  const availableFinance = !q.error && q.data;
  const readOnly = !can('revenue.enter') || Boolean(q.data?.partner_status && q.data.partner_status !== 'active');
  const showEditor = editing && !readOnly;

  return (
    <div className="home finance-page" style={{ maxWidth: 980 }}>
      <PageHeader title="Финансы"
        actions={<>
          {!readOnly && <Button variant={showEditor ? 'primary' : 'secondary'} aria-pressed={showEditor} disabled={!q.data} onClick={() => setEditing((v) => !v)}>
            {showEditor ? <><Check size={16} aria-hidden />Готово</> : <><Pencil size={16} aria-hidden />Редактировать</>}
          </Button>}
          <Button disabled={!availableFinance || !userId} loading={exp.isPending} onClick={() => {
            if (!availableFinance || !userId || exportRequest.current) return;
            const request = new AbortController();
            exportRequest.current = request;
            exp.mutate({ report: availableFinance, userId, request });
          }}><Download size={16} aria-hidden />Excel</Button>
          <Button disabled={!availableFinance || !me} onClick={() => { if (availableFinance && me) setDrive({ finance: availableFinance, userId: me.user.id }); }}>Google Drive</Button>
        </>} />
      <ActionError error={exp.error} />
      {availableFinance && drive && drive.userId === me?.user.id && drive.finance.month === month && drive.finance.location_id === loc && (
        <FinanceDriveDialog period={monthLabel(drive.finance.month)} scope={financeScope(drive.finance)}
          makeFile={() => makeFinanceReportFile(drive.finance, drive.userId, true)} onClose={() => setDrive(null)} />
      )}
      {q.data && q.data.locations.length > 0 && (
        <div className="chips point-chips" role="group" aria-label="Точки">
          <button type="button" className="chip" aria-pressed={loc === null} onClick={() => setLoc(null)}>Все точки</button>
          {q.data.locations.map((l) => <button key={l.id} type="button" className="chip" aria-pressed={loc === l.id} onClick={() => setLoc(l.id)}>{l.name}</button>)}
        </div>
      )}
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <DataState query={q} skeleton={6}>
        {(f) => {
          const c = f.current;
          const active = f.locations.filter((l) => l.status === 'active');
          return (
            <div className="stack">
              {showEditor && (
                <FinanceEditor key={`${f.location_id}:${f.month}`} month={f.month} currency={f.currency} location={f.location_id} locations={f.locations}
                  expenses={f.expenses} own={f.expense_categories} prevCount={n(f.prev_expenses_count)} royalty={c.royalty_minor}
                  total={financeExpensesMinor(c)} />
              )}
              <FinanceStatement finance={f} />

              {!showEditor && (
                <ExpensesCard month={f.month} currency={f.currency} location={f.location_id} locations={active}
                  expenses={f.expenses} own={f.expense_categories} prevCount={n(f.prev_expenses_count)} royalty={c.royalty_minor}
                  readOnly={readOnly}
                  total={financeExpensesMinor(c)}
                  royaltyHistory={f.royalty && (f.royalty.months.length > 0 || f.royalty.payments.length > 0) && (
                    <RoyaltyHistory r={f.royalty} currency={f.currency} />
                  )} />
              )}

              <Card title="За полгода">
                <MonthsChart months={f.months} currency={f.currency} />
                <details className="finance-details">
                  <summary>Таблица по месяцам</summary>
                  <div className="table-wrap" role="region" aria-label="Финансы по месяцам" tabIndex={0} style={{ marginTop: 12 }}>
                    <table className="table">
                      <thead><tr><th>Месяц</th><th className="r">Выручка</th><th className="r">План, %</th><th className="r">Зарплата</th><th className="r">Расходы</th><th className="r">Остаётся</th></tr></thead>
                      <tbody>{[...f.months].reverse().map((m) => (
                        <tr key={m.month}><td className="table-month">{monthLabel(m.month)}{m.is_open && <div className="faint">Текущий месяц</div>}</td>
                          <td className="r num">{formatMoneyShort(m.revenue_minor, f.currency)}
                            {m.return_minor ? <div className="faint">Возвраты {formatMoneyShort(m.return_minor, f.currency)}</div> : null}</td>
                          <td className="r">{m.pct !== null ? `${n(m.pct).toLocaleString('ru-RU')} %` : '—'}</td>
                          <td className="r num">{formatMoneyShort(m.payroll_minor, f.currency)}</td>
                          <td className="r num">{formatMoneyShort(financeExpensesMinor(m), f.currency)}</td>
                          <td className="r num"><strong>{formatMoneyShort(m.net_minor, f.currency)}</strong></td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </details>
              </Card>

              {f.by_location && f.by_location.length > 1 && (
                <Card title={`По точкам — ${monthLabel(f.month)}`} bodyless>
                  <div className="table-wrap finance-points-table" role="region" aria-label="Финансы по точкам" tabIndex={0}>
                    <table className="table">
                      <thead><tr><th>Точка</th><th className="r">Выручка</th><th className="r">План, %</th><th className="r">Зарплата</th><th className="r">Расходы</th><th className="r">Остаётся</th></tr></thead>
                      <tbody>{f.by_location.map((l) => (
                        <tr key={l.location_id} className="clickable" onClick={() => setLoc(l.location_id)}>
                          <td><strong>{l.location_name}</strong></td>
                          <td className="r num">{formatMoneyShort(l.revenue_minor, f.currency)}
                            {l.return_minor ? <div className="faint">Возвраты {formatMoneyShort(l.return_minor, f.currency)}</div> : null}</td>
                          <td className="r">{l.pct !== null ? `${n(l.pct).toLocaleString('ru-RU')} %` : '—'}</td>
                          <td className="r num">{formatMoneyShort(l.payroll_minor, f.currency)}</td>
                          <td className="r num">{formatMoneyShort(financeExpensesMinor(l), f.currency)}</td>
                          <td className="r num"><strong>{formatMoneyShort(l.net_minor, f.currency)}</strong></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </Card>
              )}

              {f.by_staff.length > 0 && (
                <Card title="Зарплата сотрудников">
                  {f.by_staff.map((s) => (
                    <div key={s.user_id} className="access-row">
                      <div className="row between">
                        <span><strong>{s.full_name}</strong><span className="faint" style={{ display: 'block' }}>{s.shifts} смен · выручка {formatMoneyShort(s.revenue_minor, f.currency)}</span></span>
                        <Money minor={s.earned_minor} currency={f.currency} strong />
                      </div>
                      {s.payroll_halves && <PayrollSchedule month={f.month} amounts={s.payroll_halves} currency={f.currency} />}
                    </div>
                  ))}
                </Card>
              )}
            </div>
          );
        }}
      </DataState>
    </div>
  );
}

function RoyaltyHistory({ r, currency }: { r: Royalty; currency: string }) {
  const payments = [...r.payments, ...(r.undated_payments ?? [])];
  return (
    <details className="finance-details">
      <summary>Начисления и оплаты роялти</summary>
      <div className="row between access-row">
        <span>Долг по роялти</span>
        <Money minor={r.debt_minor} currency={currency} short strong />
      </div>
      <div className="table-wrap" role="region" aria-label="Роялти по месяцам" tabIndex={0}>
        <table className="table">
          <thead><tr><th>Месяц</th><th className="r">Выручка</th><th className="r">Ставка</th><th className="r">Начислено</th><th className="r">Корректировки</th><th className="r">Прошлый долг</th><th className="r">Оплачено</th><th className="r">Долг</th></tr></thead>
          <tbody>{r.months.map((m) => (
            <tr key={m.month}>
              <td className="table-month">{monthLabel(m.month)}{m.is_open && <div className="faint">начисляется</div>}</td>
              <td className="r num">{formatMoneyShort(m.revenue_minor, currency)}</td>
              <td className="r">{pct(m.rate_bp)}</td>
              <td className="r num">{formatMoneyShort(m.accrued_minor, currency)}</td>
              <td className="r num">{(m.correction_minor ?? m.manual_minor) ? formatMoneyShort(m.correction_minor ?? m.manual_minor, currency) : '—'}</td>
              <td className="r num">{m.past_debt_minor ? formatMoneyShort(m.past_debt_minor, currency) : '—'}</td>
              <td className="r num">{formatMoneyShort(m.paid_minor, currency)}</td>
              <td className={`r num${n(m.debt_minor) > 0 && !m.is_open ? ' danger-text' : ''}`}>{m.is_open ? '—' : <Money minor={m.debt_minor} currency={currency} short strong />}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {r.undated && <div className="row between access-row">
        <span>Прошлый долг без периода</span><Money minor={r.undated.debt_minor} currency={currency} strong />
      </div>}
      {payments.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 16 }}>Оплаты</h3>
          {payments.map((p, i) => (
            <div key={i} className="row between access-row">
              <span>{p.month ? monthLabel(p.month) : 'Без периода'}<span className="faint" style={{ display: 'block' }}>{p.paid_on ? formatDate(p.paid_on) : 'Дата оплаты не указана'}{p.note ? ` · ${p.note}` : ''}</span></span>
              <Money minor={p.amount_minor} currency={currency} strong />
            </div>
          ))}
        </>
      )}
    </details>
  );
}
