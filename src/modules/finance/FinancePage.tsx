import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { AppError, captureSession, command } from '../../platform/backend';
import { formatDate, monthLabel } from '../../platform/dates';
import { localized, useLocale, type Language } from '../../platform/locale';
import { formatMoneyShort, minorToDecimal, toBigInt, type MinorInput } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Button, Card, Chips, DataState, Field, Money, PageHeader, Select, Skeleton } from '../../ui';
import type { RoyaltyPayment, UndatedRoyalty } from '../manager/api';
import { revenueMonth, revenueOverview } from '../revenue/api';
import { MonthNav } from '../revenue/components';
import { revenueMonthSheet } from '../revenue/monthReport';
import { PayrollSchedule } from '../staff/PayrollSchedule';
import { ExpensesCard, type Expense } from './Expenses';
import { FinanceDriveDialog } from './FinanceDriveDialog';
import { FinanceDays } from './FinanceEditor';
import { financeMonthLimit, financeOfficeMonth, financeSelection, type FinanceSection } from './financeNavigation';
import { downloadFinanceFile, FINANCE_PAYROLL_NOTE, FINANCE_REPORT_NOTE, financeExpensesMinor, financeReportRows, financeRevenueMethods, payrollAccrualLabels } from './financeReport';
import './finance.css';

interface Fin {
  month: string;
  revenue_minor: number;
  cash_minor: number;
  card_minor: number;
  plan_minor: number | null;
  pct: number | null;
  payroll_minor: number;
  payroll_halves?: readonly [MinorInput, MinorInput];
  shifts: number;
  rate_bp: number;
  royalty_minor: number;
  expenses_minor: number;
  return_minor?: number;
  net_minor: number;
  is_open: boolean;
}
interface Ledger {
  month: string; revenue_minor: number; rate_bp: number; accrued_minor: number; manual_minor: number;
  paid_minor: number; debt_minor: number; is_open: boolean; correction_minor?: number; past_debt_minor?: number;
}
interface Royalty {
  debt_minor: number; months: Ledger[]; payments: RoyaltyPayment[];
  undated?: UndatedRoyalty | null; undated_payments?: RoyaltyPayment[];
}
interface Finance {
  partner_name: string; currency: string; month: string; location_id: string | null; partner_status?: string;
  locations: { id: string; name: string; status: string }[];
  current: Fin; months: Fin[];
  by_location: (Fin & { location_id: string; location_name: string })[] | null;
  by_staff: { user_id: string; full_name: string; shifts: number; revenue_minor: number; earned_minor: number;
    payroll_halves?: readonly [MinorInput, MinorInput] }[];
  expenses: Expense[]; expense_categories: string[]; prev_expenses_count: number;
  royalty: Royalty | null;
}

function financeScope(f: Finance, language: Language) {
  return f.location_id ? f.locations.find((location) => location.id === f.location_id)?.name ?? localized(language, 'Точка', 'Satış noktası') : localized(language, 'Все точки', 'Tüm noktalar');
}

async function financeWorkbook(f: Finance, reportOnly: boolean, language: Language) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const money = (v: MinorInput) => ({ value: Number(minorToDecimal(v, f.currency)), type: Number, format: '#,##0.00' });
  const head = (value: string) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC' });
  const t = (ru: string, tr: string) => localized(language, ru, tr);
  const locale = language === 'tr' ? 'tr-TR' : 'ru-RU';
  const scope = financeScope(f, language);
  const statement = { sheet: t('Отчёт о прибылях и убытках', 'Kâr ve zarar tablosu'), columns: [{ width: 50 }, { width: 21 }], data: [
    [head(`${f.partner_name} · ${monthLabel(f.month, true, locale)} · ${scope}`)],
    [{ value: t(FINANCE_REPORT_NOTE, 'Rapor girilen kayıtlara dayanır. Eksik gelir ve giderler eklendiğinde sonuç değişir.') }],
    ...(f.current.payroll_halves ? [[{ value: t(FINANCE_PAYROLL_NOTE, 'Maaşlar kapanan vardiyalara göre tahakkuk eder. Ödeme tarihleri planlanandır.'), wrap: true }]] : []),
    [head(t('Статья', 'Kalem')), head(t('Сумма, ', 'Tutar, ') + f.currency)],
    ...financeReportRows(f.current, f.expenses, { language }).map((entry) => [
      { value: entry.detail ? entry.label + ' · ' + entry.detail : entry.label,
        indent: entry.indent, wrap: true, fontWeight: entry.total ? 'bold' as const : undefined },
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
  if (!match) throw new AppError('version-conflict', t('Выручка изменилась. Скачайте отчёт ещё раз.', 'Satış geliri değişti. Raporu yeniden indirin.'), '', '');
  const cols = [t('Месяц', 'Ay'), t('Выручка', 'Satış geliri'), t('Наличные', 'Nakit'), t('Карта', 'Kart'),
    t('Без разбивки', 'Belirtilmemiş'), t('План', 'Hedef'), t('Выполнение', 'Gerçekleşen'), t('Зарплата', 'Maaş'),
    t('Расходы', 'Giderler'), t('Остаётся', 'Kalan'), t('Возвраты', 'İadeler')].map(head);
  const row = (label: string, m: Fin) => {
    const { cash, card, unspecified } = financeRevenueMethods(m);
    return [label, money(m.revenue_minor), money(cash), money(card), money(unspecified), m.plan_minor ? money(m.plan_minor) : null,
      m.pct !== null ? { value: m.pct / 100, type: Number, format: '0.0%' } : null,
      money(m.payroll_minor), money(financeExpensesMinor(m)), money(m.net_minor), money(m.return_minor ?? 0)];
  };
  const expenseRows = f.expenses.map((e) => [e.category, e.location_name ?? t('все точки', 'tüm noktalar'), money(e.amount_minor), e.note ?? '']);
  if (toBigInt(f.current.royalty_minor) !== 0n) expenseRows.push([t('Роялти по ставке', 'Orana göre royalty'), scope, money(f.current.royalty_minor), '']);
  const payrollLabels = f.by_staff.some(staff => staff.payroll_halves) ? payrollAccrualLabels(f.month, language) : [];
  const sheets = [
    statement,
    { sheet: t('По месяцам', 'Aylara göre'), columns: [{ width: 16 }, ...Array(cols.length - 1).fill({ width: 14 })],
      data: [[{ value: `${f.partner_name} · ${scope}`, fontWeight: 'bold' as const, fontSize: 14 }], [], cols,
        ...f.months.map(m => row(monthLabel(m.month, true, locale), m))] },
    ...(f.by_location ? [{ sheet: t('По точкам', 'Noktalara göre'), columns: [{ width: 26 }, ...Array(cols.length - 1).fill({ width: 14 })],
      data: [[head(t('Точка', 'Satış noktası')), ...cols.slice(1)], ...f.by_location.map(l => row(l.location_name, l))] }] : []),
    ...(f.by_staff.length ? [{ sheet: t('Зарплата', 'Maaşlar'), columns: [{ width: 26 }, { width: 10 }, { width: 16 }, { width: 20 },
      ...payrollLabels.map(() => ({ width: 38 }))],
      data: [[t('Сотрудник', 'Çalışan'), t('Смен', 'Vardiya'), t('Выручка смен', 'Vardiya geliri'),
        t('Начислено за месяц', 'Aylık tahakkuk'), ...payrollLabels].map(head),
        ...f.by_staff.map((s) => [s.full_name, { value: s.shifts, type: Number }, money(s.revenue_minor), money(s.earned_minor),
          ...payrollLabels.map((_label, index) => s.payroll_halves ? money(s.payroll_halves[index]) : null)])] }] : []),
    ...(expenseRows.length ? [{ sheet: t('Расходы', 'Giderler'), columns: [{ width: 26 }, { width: 24 }, { width: 16 }, { width: 30 }],
      data: [[t('Категория', 'Kategori'), t('Точка', 'Satış noktası'), t('Сумма', 'Tutar'), t('Комментарий', 'Açıklama')].map(head), ...expenseRows] }] : []),
    ...(dailyRevenue.length ? [revenueMonthSheet(dailyRevenue, language)] : []),
  ];
  return writeXlsxFile(sheets);
}

async function makeFinanceReportFile(f: Finance, userId: string, reportOnly: boolean, language: Language) {
  await captureSession(userId);
  const blob = await (await financeWorkbook(f, reportOnly, language)).toBlob();
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
  const { t, locale, language } = useLocale();
  const totals = finance.current;
  return <Card className="finance-statement">
    {totals.plan_minor != null && <div className="finance-statement-meta">
      <span>{t('План', 'Hedef')}: <Money minor={totals.plan_minor} currency={finance.currency} short /></span>
      {totals.pct != null && <span>{t('Выполнено', 'Gerçekleşen')}: {Number(totals.pct).toLocaleString(locale)}%</span>}
    </div>}
    <dl className="finance-lines" aria-label={t('Данные отчёта', 'Rapor verileri')}>
      {financeReportRows(totals, finance.expenses, { language }).map(row => (
        <div key={row.id} data-row={row.id} data-indent={row.indent} className={
          row.id === 'result' ? 'finance-result' : row.id === 'revenue' || row.id === 'expenses' ? 'finance-group' : undefined}>
          <dt><span>{row.label}</span>{row.detail && <small className="finance-line-detail">{row.detail}</small>}</dt>
          <dd><Money minor={row.minor} currency={finance.currency} short strong={row.total} /></dd>
        </div>
      ))}
    </dl>
  </Card>;
}

export function FinancePage() {
  const { me, can } = useSession();
  const { t, language, locale } = useLocale();
  const qc = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const pendingSearch = useRef(search);
  useLayoutEffect(() => { pendingSearch.current = search; }, [search]);
  const officeMonth = financeOfficeMonth();
  const requestedScope = financeSelection(search, officeMonth).location;
  const requestedMonth = search.get('month');
  const calendar = useQuery({ queryKey: ['revenue', 'overview', officeMonth], enabled: can('revenue.read'),
    queryFn: () => revenueOverview(officeMonth), refetchInterval: 120_000 });
  const currentMonth = financeMonthLimit(officeMonth, calendar.data?.rows ?? [], requestedScope);
  const checkingPeriod = Boolean(calendar.isLoading && requestedMonth && requestedMonth > officeMonth);
  const { section, month, location, day } = financeSelection(search, currentMonth);
  const navigate = (changes: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(pendingSearch.current);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    pendingSearch.current = next;
    setSearch(next, { replace });
  };
  const userId = me?.user.id;
  const exportRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { exportRequest.current?.abort(); exportRequest.current = null; }, [userId, month, location]);
  const q = useQuery({ queryKey: ['finance', month, location], enabled: !checkingPeriod,
    queryFn: () => command<Finance>('finance_my', { month, location }),
    refetchInterval: 120_000 });
  const exp = useMutation({
    mutationFn: ({ report, userId, request, language }: {
      report: Finance; userId: string; request: AbortController; language: Language;
    }) => downloadFinanceFile(() => makeFinanceReportFile(report, userId, false, language), request.signal),
    networkMode: 'always',
    onError: (error, { report, request }) => {
      if (!request.signal.aborted && error instanceof AppError && error.code === 'version-conflict') {
        return qc.invalidateQueries({ queryKey: ['finance', report.month, report.location_id], exact: true });
      }
    },
    onSettled: (_data, _error, { request }) => { if (exportRequest.current === request) exportRequest.current = null; },
  });
  const [drive, setDrive] = useState<{ finance: Finance; userId: string } | null>(null);
  useEffect(() => setDrive(previous => previous && previous.userId === userId && previous.finance.month === month
    && previous.finance.location_id === location ? previous : null), [userId, month, location]);
  const availableFinance = !checkingPeriod && !q.error && q.data;
  const readOnly = !can('revenue.enter') || Boolean(q.data?.partner_status && q.data.partner_status !== 'active');
  const scopeOptions = q.data?.locations ?? [];
  const allPoints = t('Все точки', 'Tüm noktalar');

  return <div className="home finance-page">
    <PageHeader title={t('Отчёт о прибылях и убытках', 'Kâr ve zarar tablosu')} actions={<>
      <Button disabled={!availableFinance || !userId} loading={exp.isPending} onClick={() => {
        if (!availableFinance || !userId || exportRequest.current) return;
        const request = new AbortController();
        exportRequest.current = request;
        exp.mutate({ report: availableFinance, userId, request, language });
      }}><Download size={16} aria-hidden />Excel</Button>
      <Button disabled={!availableFinance || !userId} onClick={() => {
        if (availableFinance && userId) setDrive({ finance: availableFinance, userId });
      }}>Google Drive</Button>
    </>} />
    <ActionError error={exp.error} />
    {availableFinance && drive && drive.userId === userId && drive.finance.month === month && drive.finance.location_id === location &&
      <FinanceDriveDialog period={monthLabel(month, true, locale)} scope={financeScope(drive.finance, language)}
        makeFile={() => makeFinanceReportFile(drive.finance, drive.userId, true, language)} onClose={() => setDrive(null)} />}
    <div className="finance-filters">
      <MonthNav month={month} onChange={value => navigate({ month: value, day: null })} max={currentMonth} />
      {(scopeOptions.length > 0 || location) && <Field label={t('Точка', 'Satış noktası')}>
        {id => <Select id={id} value={location ?? ''} onChange={event => navigate({ location: event.target.value || null, day: null })}>
          <option value="">{allPoints}</option>
          {location && !scopeOptions.some(point => point.id === location) &&
            <option value={location}>{t('Выбранная точка', 'Seçilen nokta')}</option>}
          {scopeOptions.map(point => <option value={point.id} key={point.id}>{point.name}</option>)}
        </Select>}
      </Field>}
    </div>
    <Chips<FinanceSection> label={t('Раздел отчёта', 'Rapor bölümü')} value={section}
      onChange={value => navigate({ section: value === 'report' ? null : value, day: null })} options={[
        { id: 'report', label: t('Отчёт', 'Rapor') }, { id: 'days', label: t('По дням', 'Günlük') },
        { id: 'expenses', label: t('Расходы', 'Giderler') }, { id: 'payroll', label: t('Зарплата', 'Maaşlar') },
      ]} />
    {checkingPeriod ? <Skeleton lines={4} /> : <DataState query={q} skeleton={4}>
      {f => {
        if (section === 'days') return <FinanceDays key={f.month + (f.location_id ?? '')} month={f.month}
          location={f.location_id} locations={f.locations} requestedDay={day} readOnly={readOnly}
          clearRequestedDay={() => navigate({ day: null }, true)} />;
        if (section === 'expenses') return <ExpensesCard key={f.month + (f.location_id ?? '')} month={f.month}
          currency={f.currency} location={f.location_id} locations={f.locations}
          expenses={f.expenses} own={f.expense_categories} prevCount={Number(f.prev_expenses_count)}
          royaltyMinor={f.current.royalty_minor}
          royaltyHistory={!f.location_id && f.royalty ? <RoyaltyHistory r={f.royalty} currency={f.currency} /> : undefined}
          readOnly={readOnly || month > officeMonth} />;
        if (section === 'payroll') return <PayrollDetails finance={f} canOpenTeam={can('staff.manage') || can('staff.view')} />;
        return <FinanceStatement finance={f} />;
      }}
    </DataState>}
  </div>;
}

function PayrollDetails({ finance: f, canOpenTeam }: { finance: Finance; canOpenTeam: boolean }) {
  const { t } = useLocale();
  return <div className="stack">
    <Card title={t('Начисленная зарплата', 'Tahakkuk eden maaş')}
      actions={<Money minor={f.current.payroll_minor} currency={f.currency} short strong />}>
      {f.current.payroll_halves && <PayrollSchedule month={f.month} amounts={f.current.payroll_halves} currency={f.currency} />}
      {f.by_staff.length === 0 && <p>{t('Начислений сотрудникам за этот месяц нет.', 'Bu ay çalışanlara maaş tahakkuku yok.')}</p>}
    </Card>
    {f.by_staff.length > 0 && <Card title={t('По сотрудникам', 'Çalışanlara göre')}
      actions={canOpenTeam ? <Link to="/staff" className="link-btn">{t('Сотрудники', 'Çalışanlar')}</Link> : undefined}>
      <ul className="finance-payroll-list">
        {f.by_staff.map(staff => <li key={staff.user_id}>
          <div className="row between">
            <div><strong>{staff.full_name}</strong>
              <div className="faint">{t('Смен', 'Vardiya')}: {staff.shifts} · {t('Выручка', 'Gelir')}: <Money minor={staff.revenue_minor} currency={f.currency} short /></div>
            </div>
            <Money minor={staff.earned_minor} currency={f.currency} short strong />
          </div>
          {staff.payroll_halves && <details><summary>{t('График выплат', 'Ödeme takvimi')}</summary>
            <PayrollSchedule month={f.month} amounts={staff.payroll_halves} currency={f.currency} />
          </details>}
        </li>)}
      </ul>
    </Card>}
  </div>;
}

function RoyaltyHistory({ r, currency }: { r: Royalty; currency: string }) {
  const { t, locale } = useLocale();
  const payments = [...r.payments, ...(r.undated_payments ?? [])];
  const monthLabelFor = (month: string) => monthLabel(month, true, locale);
  const money = (value: MinorInput) => formatMoneyShort(value, currency, locale);
  const ledgerName = t('Начисления и оплаты по месяцам', 'Aylık tahakkuk ve ödemeler');
  if (!r.months.length && !payments.length && !r.undated && !r.debt_minor) return null;

  return <details className="finance-details finance-royalty-history">
    <summary>{t('История роялти', 'Royalty geçmişi')}</summary>
    <dl className="finance-lines">
      <div><dt>{t('Долг по роялти', 'Royalty borcu')}</dt><dd><Money minor={r.debt_minor} currency={currency} short strong /></dd></div>
      {r.undated && <div><dt>{t('Прошлый долг без периода', 'Dönemi belirtilmeyen geçmiş borç')}</dt>
        <dd><Money minor={r.undated.debt_minor} currency={currency} short strong /></dd></div>}
    </dl>
    {r.months.length > 0 && <>
      <div className="table-wrap" role="region" aria-label={ledgerName} tabIndex={0}>
        <table className="table">
          <thead><tr>
            <th scope="col">{t('Месяц', 'Ay')}</th><th className="r" scope="col">{t('Выручка', 'Gelir')}</th>
            <th className="r" scope="col">{t('Ставка', 'Oran')}</th><th className="r" scope="col">{t('Начислено', 'Tahakkuk')}</th>
            <th className="r" scope="col">{t('Корректировки', 'Düzeltmeler')}</th><th className="r" scope="col">{t('Прошлый долг', 'Geçmiş borç')}</th>
            <th className="r" scope="col">{t('Оплачено', 'Ödendi')}</th><th className="r" scope="col">{t('Долг', 'Borç')}</th>
          </tr></thead>
          <tbody>{r.months.map(month => <tr key={month.month}>
            <th scope="row" className="table-month">{monthLabelFor(month.month)}
              {month.is_open && <div className="faint">{t('начисляется', 'tahakkuk ediyor')}</div>}
            </th>
            <td className="r num">{money(month.revenue_minor)}</td>
            <td className="r">{(month.rate_bp / 100).toLocaleString(locale)}%</td>
            <td className="r num">{money(month.accrued_minor)}</td>
            <td className="r num">{(month.correction_minor ?? month.manual_minor) ? money(month.correction_minor ?? month.manual_minor) : '—'}</td>
            <td className="r num">{month.past_debt_minor ? money(month.past_debt_minor) : '—'}</td>
            <td className="r num">{money(month.paid_minor)}</td>
            <td className={'r num' + (Number(month.debt_minor) > 0 && !month.is_open ? ' danger-text' : '')}>
              {month.is_open ? '—' : <Money minor={month.debt_minor} currency={currency} short strong />}
            </td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
    {payments.length > 0 && <section className="finance-royalty-payments" aria-label={t('История оплат', 'Ödeme geçmişi')}>
      <h3>{t('История оплат', 'Ödeme geçmişi')}</h3>
      {payments.map((payment, i) => <div key={i} className="row between access-row">
        <span>{payment.month ? monthLabelFor(payment.month) : t('Без периода', 'Dönem belirtilmemiş')}
          <span className="finance-payment-date faint">
            {payment.paid_on ? formatDate(payment.paid_on, locale) : t('Дата оплаты не указана', 'Ödeme tarihi belirtilmemiş')}
            {payment.note && ' · ' + payment.note}
          </span>
        </span>
        <Money minor={payment.amount_minor} currency={currency} strong />
      </div>)}
    </section>}
  </details>;
}
