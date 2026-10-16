// Отчётность и роялти (ROY-03…13): партнёр и финансы видят одинаковые суммы и формулу; деньги — только через команды сервера.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Download, FileUp, Plus } from 'lucide-react';
import { useSession } from '../../platform/session';
import { newOperationKey, toAppError } from '../../platform/backend';
import { addDays, formatDate, formatDateTime, formatPeriod, isoDate, monthStart } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { drafts } from '../../platform/offline';
import { formatMoney, minorToDecimal, parseMoney, sumMinor, toBigInt } from '../../platform/money';
import { ActionError, Alert, Badge, Button, Card, ConfirmDialog, DataState, EmptyState, Field, Input, KV, Money, MoneyInput, PageHeader, Select,
  Tabs, Textarea, Timeline } from '../../ui';
import { PAYMENT_STATUS, REPORT_STATUS, st, VERIFICATION } from '../../ui/status';
import { FileAttach, FileList } from '../../ui/files';
import { useToast } from '../../ui/toast';
import { useLocations, usePartners, useUserNames } from '../shared/lookups';
import { salesForReport } from '../sales/api';
import {
  accrualForReport, adjustments, allocationsFor, contractLocations, contracts, disputes, events, getAccrual, getBalance, getCalculation, getPayment,
  getPaymentBalance, getReport, lines, listBalances, listPayments, listReports, notes, policies, revisions, ROY_EVENT, royaltyCommands, salesCheck, type LineInput } from './api';

const pct = (bp: number) => `${(bp / 100).toLocaleString(intlLocale(), { maximumFractionDigits: 2 })}%`;

/** Акт сверки (ROY-12): выгрузка начислений, корректировок и оплат в CSV на устройство. */
function exportReconciliation(partnerName: string, balances: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listBalances>>>>['data'], payments: Awaited<ReturnType<typeof listPayments>> | undefined) {
  const rowsOut = [['Документ', 'Номер', 'Период/дата', 'Валюта', 'Начислено', 'Корректировки', 'Оплачено (распределено)', 'Остаток', 'Срок']];
  for (const b of balances ?? []) {
    rowsOut.push(['Начисление', b.number, b.period, b.currency, minorToDecimal(b.amount_minor, b.currency),
      minorToDecimal(toBigInt(b.debit_minor) - toBigInt(b.credit_minor), b.currency), minorToDecimal(b.allocated_minor, b.currency),
      minorToDecimal(b.outstanding_minor, b.currency), b.due_on]);
  }
  for (const p of (payments ?? []).filter((x) => x.status === 'confirmed')) {
    rowsOut.push(['Оплата', p.number, p.paid_on, p.currency, '', '', minorToDecimal(p.allocated_minor, p.currency), `аванс ${minorToDecimal(p.unallocated_minor, p.currency)}`, '']);
  }
  const csv = '﻿' + rowsOut.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `sverka-${partnerName.replace(/\W+/g, '_')}-${isoDate()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function RoyaltiesPage({ initialTab }: { initialTab?: 'reports' | 'accruals' | 'payments' }) {
  const { can, isStaff } = useSession();
  const { t } = useT();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<'reports' | 'accruals' | 'payments'>(initialTab ?? 'reports');
  const partners = usePartners();
  const reports = useQuery({ queryKey: ['reports', params.get('status')], queryFn: () => listReports(params.get('status')) });
  const balances = useQuery({ queryKey: ['balances'], queryFn: listBalances });
  const payments = useQuery({ queryKey: ['payments'], queryFn: listPayments });
  const [dialog, setDialog] = useState<null | 'new' | 'pay' | 'register'>(null);
  const pname = (id: string) => partners.data?.find((p) => p.id === id)?.name ?? '';
  const overdueOnly = params.get('overdue') === '1';
  const bal = (balances.data ?? []).filter((b) => !overdueOnly || (toBigInt(b.outstanding_minor) > 0n && b.due_on < isoDate()));
  const totals = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const b of balances.data ?? []) if (toBigInt(b.outstanding_minor) > 0n) m.set(b.currency, (m.get(b.currency) ?? 0n) + toBigInt(b.outstanding_minor));
    return [...m.entries()];
  }, [balances.data]);

  return (
    <>
      <PageHeader title={t('Роялти')} sub="Отчёты о выручке, начисления, оплаты и сверка"
        actions={
          <>
            {can('royalty.report.submit') && <Button variant="primary" onClick={() => setDialog('new')}><Plus size={16} aria-hidden />{t('Сдать отчёт')}</Button>}
            {can('payment.report') && <Button onClick={() => setDialog('pay')}>{t('Сообщить об оплате')}</Button>}
            {can('payment.confirm') && <Button onClick={() => setDialog('register')}>Зарегистрировать зачисление</Button>}
            {!isStaff && partners.data?.[0] && <Button onClick={() => exportReconciliation(partners.data![0].name, balances.data, payments.data)}><Download size={16} aria-hidden />Акт сверки</Button>}
          </>
        } />
      {totals.length > 0 && (
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          {totals.map(([cur, sum]) => (
            <Card key={cur}><div className="stat" style={{ padding: 0 }}><span className="label">Непогашенный остаток, {cur}</span><span className="value"><Money minor={sum} currency={cur} /></span><span className="faint">валюты не суммируются между собой</span></div></Card>
          ))}
        </div>
      )}
      <Tabs label="Разделы роялти" value={tab} onChange={setTab} tabs={[{ id: 'reports', label: t('Отчёты о выручке') }, { id: 'accruals', label: t('Начисления') }, { id: 'payments', label: t('Оплаты') }]} />
      {tab === 'reports' && (
        <Card bodyless>
          <DataState query={reports} empty={(d) => (d.length ? null : <EmptyState title="Отчётов нет" text={can('royalty.report.submit') ? 'Сдайте отчёт за прошедший месяц.' : undefined} />)}>
            {(d) => (
              <ul className="list">
                {d.map((r) => {
                  const [label, tone] = st(REPORT_STATUS, r.status);
                  return (
                    <li key={r.id}>
                      <Link className="list-item" to={`/royalties/reports/${r.id}`}>
                        <div className="main-col"><div className="title">{formatPeriod(r.period, intlLocale())}</div><div className="meta"><span className="mono">{r.number}</span>{isStaff && <span>{pname(r.partner_id)}</span>}{r.partner_ref && <span>№ партнёра {r.partner_ref}</span>}</div></div>
                        <div className="side"><Badge tone={tone}>{t(label)}</Badge></div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </DataState>
        </Card>
      )}
      {tab === 'accruals' && (
        <Card bodyless>
          <DataState query={balances} empty={() => (bal.length ? null : <EmptyState title={overdueOnly ? 'Просроченных начислений нет' : 'Начислений нет'} />)}>
            {() => (
              <ul className="list">
                {bal.map((b) => {
                  const overdue = toBigInt(b.outstanding_minor) > 0n && b.due_on < isoDate();
                  return (
                    <li key={b.accrual_id}>
                      <Link className="list-item" to={`/royalties/accruals/${b.accrual_id}`}>
                        <div className="main-col"><div className="title">{formatPeriod(b.period, intlLocale())}</div><div className="meta"><span className="mono">{b.number}</span>{isStaff && <span>{pname(b.partner_id)}</span>}<span>срок {formatDate(b.due_on, intlLocale())}</span></div></div>
                        <div className="side">
                          <span>Остаток <Money minor={b.outstanding_minor} currency={b.currency} strong /></span>
                          <span className="faint">из <Money minor={toBigInt(b.amount_minor) + toBigInt(b.debit_minor) - toBigInt(b.credit_minor)} currency={b.currency} /></span>
                          {overdue ? <Badge tone="danger">просрочено</Badge> : toBigInt(b.outstanding_minor) === 0n ? <Badge tone="success">оплачено</Badge> : null}
                          {toBigInt(b.disputed_minor) > 0n && <Badge tone="warning">спор</Badge>}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </DataState>
        </Card>
      )}
      {tab === 'payments' && (
        <Card bodyless>
          <DataState query={payments} empty={(d) => (d.length ? null : <EmptyState title="Оплат нет" />)}>
            {(d) => (
              <ul className="list">
                {d.map((p) => {
                  const [label, tone] = st(PAYMENT_STATUS, p.status);
                  return (
                    <li key={p.payment_id}>
                      <Link className="list-item" to={`/royalties/payments/${p.payment_id}`}>
                        <div className="main-col"><div className="title"><Money minor={p.amount_minor} currency={p.currency} /></div><div className="meta"><span className="mono">{p.number}</span>{isStaff && <span>{pname(p.partner_id)}</span>}<span>{formatDate(p.paid_on, intlLocale())}</span></div></div>
                        <div className="side"><Badge tone={tone}>{t(label)}</Badge>{p.status === 'confirmed' && toBigInt(p.unallocated_minor) > 0n && <span className="faint">не распределено <Money minor={p.unallocated_minor} currency={p.currency} /></span>}</div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </DataState>
        </Card>
      )}
      {dialog === 'new' && <NewReportDialog onClose={() => setDialog(null)} />}
      {dialog === 'pay' && <ReportPaymentDialog onClose={() => setDialog(null)} />}
      {dialog === 'register' && <RegisterPaymentDialog onClose={() => setDialog(null)} />}
    </>
  );
}

function NewReportDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const cs = useQuery({ queryKey: ['contracts'], queryFn: contracts });
  const [contract, setContract] = useState('');
  const [period, setPeriod] = useState(monthStart(-1));
  useEffect(() => { if (!contract && cs.data?.length) setContract(cs.data[0].id); }, [cs.data, contract]);
  const create = useMutation({
    mutationFn: async () => {
      const locs = await contractLocations(contract);
      return royaltyCommands.saveDraft(contract, period, locs.map((l) => ({ location_id: l.location_id, gross_minor: '0', returns_minor: '0', excluded_minor: '0', zero_reason: 'Заполните выручку' })), null, null);
    },
    onSuccess: (r) => navigate(`/royalties/reports/${r.id}`),
  });
  const periods = [-1, -2, -3].map((n) => monthStart(n));
  return (
    <ConfirmDialog open title="Отчёт о выручке" confirmLabel="Открыть отчёт" onClose={onClose} onConfirm={() => create.mutate()} busy={create.isPending} error={create.error}>
      <Field label="Договор" required>{(id) => (
        <Select id={id} value={contract} onChange={(e) => setContract(e.target.value)}>{(cs.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.number}</option>)}</Select>
      )}</Field>
      <Field label="Период" required hint="Если отчёт за период уже начат — откроется он же">{(id) => (
        <Select id={id} value={period} onChange={(e) => setPeriod(e.target.value)}>{periods.map((p) => <option key={p} value={p}>{formatPeriod(p, intlLocale())}</option>)}</Select>
      )}</Field>
    </ConfirmDialog>
  );
}

function ReportPaymentDialog({ onClose, accrual }: { onClose: () => void; accrual?: { contract_id: string; currency: string; outstanding: string } }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cs = useQuery({ queryKey: ['contracts'], queryFn: contracts });
  const [contract, setContract] = useState(accrual?.contract_id ?? '');
  const [amount, setAmount] = useState(accrual?.outstanding ?? '');
  const [date, setDate] = useState(isoDate());
  const [ref, setRef] = useState('');
  const [key] = useState(newOperationKey);
  useEffect(() => { if (!contract && cs.data?.length) setContract(cs.data[0].id); }, [cs.data, contract]);
  const cur = cs.data?.find((c) => c.id === contract)?.currency ?? accrual?.currency ?? 'RUB';
  const m = useMutation({
    mutationFn: () => royaltyCommands.paymentReport(contract, amount, cur, date, ref, null, key),
    onSuccess: (r) => { toast('Оплата сообщена. Долг уменьшится после подтверждения финансами по выписке.'); void qc.invalidateQueries({ queryKey: ['payments'] }); navigate(`/royalties/payments/${r.payment_id}`); },
  });
  return (
    <ConfirmDialog open title="Сообщить об оплате" confirmLabel="Сообщить" onClose={onClose} onConfirm={() => m.mutate()} busy={m.isPending} error={m.error}
      summary={amount ? [['Сумма', <Money key="a" minor={amount} currency={cur} />], ['Дата', formatDate(date, intlLocale())]] : undefined}>
      <Alert tone="info">Сообщение и квитанция — не подтверждение зачисления. Финансы сверят оплату с выпиской.</Alert>
      <div style={{ height: 12 }} />
      {!accrual && <Field label="Договор" required>{(id) => <Select id={id} value={contract} onChange={(e) => setContract(e.target.value)}>{(cs.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.number}</option>)}</Select>}</Field>}
      <Field label={`Сумма, ${cur}`} required>{(id) => <MoneyInput id={id} value={amount} currency={cur} onChange={setAmount} />}</Field>
      <Field label="Дата оплаты" required>{(id) => <Input id={id} type="date" max={isoDate()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      <Field label="Номер платёжного поручения" hint="Квитанцию можно приложить на следующем шаге">{(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

function RegisterPaymentDialog({ onClose, reported }: { onClose: () => void; reported?: { id: string; partner_id: string; contract_id: string | null; amount_minor: string; currency: string; paid_on: string } }) {
  const toast = useToast();
  const qc = useQueryClient();
  const partners = usePartners();
  const cs = useQuery({ queryKey: ['contracts'], queryFn: contracts });
  const [partner, setPartner] = useState(reported?.partner_id ?? '');
  const [contract, setContract] = useState(reported?.contract_id ?? '');
  const [amount, setAmount] = useState(reported ? String(reported.amount_minor) : '');
  const [date, setDate] = useState(reported?.paid_on ?? isoDate());
  const [bankRef, setBankRef] = useState('');
  const [key] = useState(newOperationKey);
  const cur = cs.data?.find((c) => c.id === contract)?.currency ?? reported?.currency ?? 'RUB';
  const m = useMutation({
    mutationFn: () => royaltyCommands.paymentRegister(partner, contract || null, amount, cur, date, bankRef, reported?.id ?? null, key),
    onSuccess: () => { toast('Зачисление зарегистрировано. Подтвердить его должен другой сотрудник финансов.'); void qc.invalidateQueries(); onClose(); },
  });
  return (
    <ConfirmDialog open title="Зарегистрировать зачисление по выписке" confirmLabel="Зарегистрировать" onClose={onClose} onConfirm={() => m.mutate()} busy={m.isPending} error={m.error}
      summary={amount && partner ? [['Партнёр', partners.data?.find((p) => p.id === partner)?.name ?? ''], ['Сумма', <Money key="a" minor={amount} currency={cur} />], ['Операция банка', bankRef || '—']] : undefined}>
      {!reported && <Field label="Партнёр" required>{(id) => <Select id={id} value={partner} onChange={(e) => { setPartner(e.target.value); setContract(''); }}><option value="">Выберите</option>{(partners.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>}
      {!reported && <Field label="Договор" required>{(id) => <Select id={id} value={contract} onChange={(e) => setContract(e.target.value)}><option value="">Выберите</option>{(cs.data ?? []).filter((c) => c.partner_id === partner).map((c) => <option key={c.id} value={c.id}>{c.number} · {c.currency}</option>)}</Select>}</Field>}
      <Field label={`Сумма зачисления по выписке, ${cur}`} required hint={reported ? 'Если банк зачислил другую сумму — укажите фактическую' : undefined}>{(id) => <MoneyInput id={id} value={amount} currency={cur} onChange={setAmount} />}</Field>
      <Field label="Дата зачисления" required>{(id) => <Input id={id} type="date" max={isoDate()} value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      <Field label="Идентификатор операции в выписке" required hint="Одна банковская операция регистрируется один раз">{(id) => <Input id={id} value={bankRef} onChange={(e) => setBankRef(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

interface CsvPreview { fileName: string; hash: string; rows: Record<string, string>[]; problems: string[] }

async function readCsv(file: File): Promise<CsvPreview> {
  const text = await file.text();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const linesIn = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = linesIn[0]?.includes(';') ? ';' : ',';
  const head = (linesIn[0] ?? '').split(sep).map((h) => h.trim().toLowerCase());
  const need = ['location_code', 'gross'];
  const problems = need.filter((n) => !head.includes(n)).map((n) => `Нет колонки «${n}»`);
  const toMinor = (v: string) => { const p = parseMoney(v || '0', 'RUB'); return p === null ? v : p.toString(); };
  const rowsOut = linesIn.slice(1).map((l) => {
    const cells = l.split(sep).map((c) => c.trim());
    const get = (k: string) => cells[head.indexOf(k)] ?? '';
    return { location_code: get('location_code'), gross_minor: toMinor(get('gross')), returns_minor: toMinor(get('returns')), excluded_minor: toMinor(get('excluded')), zero_reason: get('zero_reason') };
  });
  return { fileName: file.name, hash, rows: rowsOut, problems };
}

export function ReportPage() {
  const { id = '' } = useParams();
  const { me, can, isStaff } = useSession();
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const names = useUserNames();
  const locs = useLocations();
  const partners = usePartners();
  const report = useQuery({ queryKey: ['report', id], queryFn: () => getReport(id) });
  const r = report.data;
  const cs = useQuery({ queryKey: ['contracts'], queryFn: contracts });
  const contract = cs.data?.find((c) => c.id === r?.contract_id);
  const revs = useQuery({ queryKey: ['report', id, 'revs'], queryFn: () => revisions(id) });
  const current = revs.data?.find((v) => v.id === r?.current_revision_id);
  const ls = useQuery({ queryKey: ['report', id, 'lines', current?.id], enabled: Boolean(current?.id), queryFn: () => lines(current!.id) });
  const calc = useQuery({ queryKey: ['report', id, 'calc', r?.calculation_id], enabled: Boolean(r?.calculation_id), queryFn: () => getCalculation(r!.calculation_id!) });
  const accrual = useQuery({ queryKey: ['report', id, 'accrual'], enabled: Boolean(r && ['approved', 'closed'].includes(r.status)), queryFn: () => accrualForReport(r!.contract_id, r!.period) });
  const pol = useQuery({ queryKey: ['policies', r?.contract_id], enabled: Boolean(r?.contract_id), queryFn: () => policies(r!.contract_id) });
  const ev = useQuery({ queryKey: ['report', id, 'events'], queryFn: () => events('revenue_report', id) });
  const nt = useQuery({ queryKey: ['report', id, 'notes'], enabled: can('finance.internal'), queryFn: () => notes('revenue_report', id) });
  const check = useQuery({ queryKey: ['report', id, 'check', r?.status], enabled: Boolean(r && !['draft', 'needs_correction'].includes(r.status)), queryFn: () => salesCheck(id) });
  const daily = useQuery({ queryKey: ['sales', 'report', r?.contract_id, r?.period], enabled: Boolean(r && ['draft', 'needs_correction'].includes(r.status)),
    queryFn: () => salesForReport(r!.contract_id, r!.period) });

  const editable = Boolean(r && ['draft', 'needs_correction'].includes(r.status) && can('royalty.report.submit'));
  const cur = contract?.currency ?? 'RUB';
  const [form, setForm] = useState<LineInput[] | null>(null);
  const [comment, setComment] = useState('');
  const [partnerRef, setPartnerRef] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'submit' | 'return' | 'approve' | 'publish' | 'close'>(null);
  const [reason, setReason] = useState('');
  const [verification, setVerification] = useState('reported');
  const [segments, setSegments] = useState<{ from: string; to: string; base_minor: string }[] | null>(null);
  const [csv, setCsv] = useState<CsvPreview | null>(null);
  const [submitKey, setSubmitKey] = useState(newOperationKey);
  const [publishKey] = useState(newOperationKey);
  const [note, setNote] = useState('');
  const draftKey = `report:${id}`;

  // Форма строится из сервера; при наличии локального черновика он восстанавливается (PWA-02: черновик отчёта на устройстве)
  useEffect(() => {
    if (!ls.data || form || !me) return;
    const serverLines = ls.data.map((l) => ({ location_id: l.location_id, gross_minor: String(l.gross_minor), returns_minor: String(l.returns_minor), excluded_minor: String(l.excluded_minor), zero_reason: l.zero_reason }));
    void drafts.load<{ lines: LineInput[]; comment: string }>(me.user.id, draftKey).then((d) => {
      setForm(editable && d?.value ? d.value.lines : serverLines);
      setComment(editable && d?.value ? d.value.comment : current?.comment ?? '');
      if (editable && d?.value) setSavedAt(d.savedAt);
    });
  }, [ls.data, form, me, editable, current?.comment, draftKey]);
  useEffect(() => { if (r?.partner_ref) setPartnerRef(r.partner_ref); }, [r?.partner_ref]);
  useEffect(() => {
    if (!editable || !form || !me) return;
    const h = setTimeout(() => void drafts.save(me.user.id, draftKey, { lines: form, comment }).then(() => setSavedAt(new Date().toISOString())), 800);
    return () => clearTimeout(h);
  }, [form, comment, editable, me, draftKey]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['report', id] }); void qc.invalidateQueries({ queryKey: ['reports'] }); void qc.invalidateQueries({ queryKey: ['balances'] }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  const save = useMutation({
    mutationFn: () => royaltyCommands.saveDraft(r!.contract_id, r!.period, form ?? [], comment || null, partnerRef || null),
    onSuccess: () => { toast('Черновик сохранён на сервере'); refresh(); },
  });
  const act = useMutation({
    mutationFn: async () => {
      if (dialog === 'submit') {
        await royaltyCommands.saveDraft(r!.contract_id, r!.period, form ?? [], comment || null, partnerRef || null);
        await royaltyCommands.submit(r!.id, submitKey);
        await drafts.remove(me!.user.id, draftKey);
        setSubmitKey(newOperationKey());
        return 'Отчёт отправлен на проверку. Редакция зафиксирована.';
      }
      if (dialog === 'return') { await royaltyCommands.returnReport(r!.id, reason); return 'Отчёт возвращён партнёру'; }
      if (dialog === 'approve') {
        const res = await royaltyCommands.approve(r!.id, segments, verification, reason || null);
        return `Отчёт утверждён. Расчёт: ${formatMoney(res.amount_minor, cur, intlLocale())}`;
      }
      if (dialog === 'publish') { const a = await royaltyCommands.publish(r!.id, publishKey); return `Начисление ${a.number} опубликовано партнёру`; }
      if (dialog === 'close') { await royaltyCommands.close(r!.id); return 'Период закрыт. Исправления — только корректировкой'; }
      return '';
    },
    onSuccess: (msg) => { toast(msg); setDialog(null); setReason(''); setForm(null); refresh(); },
    onError: (e) => {
      const err = toAppError(e);
      if (err.code === 'policy-split-required' && r) {
        // ROY-01a: предложить сегменты по датам смены ставки
        const end = addDays(monthStart(1, new Date(`${r.period}T12:00:00Z`)), -1);
        const starts = (pol.data ?? []).filter((p) => p.effective_from > r.period && p.effective_from <= end).map((p) => p.effective_from);
        const bounds = [r.period, ...starts];
        setSegments(bounds.map((from, i) => ({ from, to: i + 1 < bounds.length ? addDays(bounds[i + 1], -1) : end, base_minor: '' })));
      }
    },
  });
  const importCsv = useMutation({
    mutationFn: () => royaltyCommands.importRows(r!.contract_id, r!.period, csv!.hash, csv!.fileName, csv!.rows),
    onSuccess: (res) => {
      if (res.status === 'applied') { toast(res.replayed ? 'Этот файл уже импортирован — база не удвоена' : `Импортировано строк: ${res.rows}`); setCsv(null); setForm(null); if (me) void drafts.remove(me.user.id, draftKey); refresh(); }
    },
  });
  const addNote = useMutation({ mutationFn: () => royaltyCommands.note('revenue_report', id, r!.partner_id, note), onSuccess: () => { setNote(''); void qc.invalidateQueries({ queryKey: ['report', id, 'notes'] }); } });

  const total = sumMinor((form ?? []).map((l) => toBigInt(l.gross_minor) - toBigInt(l.returns_minor) - toBigInt(l.excluded_minor)));
  const segSum = sumMinor((segments ?? []).map((s) => s.base_minor || '0'));
  const serverTotal = sumMinor((ls.data ?? []).map((l) => l.base_minor));

  return (
    <DataState query={report} empty={(d) => (d ? null : <EmptyState title="Отчёт не найден" />)}>
      {() => {
        if (!r) return null;
        const [label, tone] = st(REPORT_STATUS, r.status);
        const ver = current ? st(VERIFICATION, current.verification_level) : null;
        return (
          <>
            <PageHeader back={{ to: '/royalties', label: t('Роялти') }} title={`Отчёт за ${formatPeriod(r.period, intlLocale()).toLowerCase()}`}
              sub={<span className="row"><span className="mono">{r.number}</span>{isStaff && <span>{partners.data?.find((p) => p.id === r.partner_id)?.name}</span>}<Badge tone={tone}>{t(label)}</Badge></span>}
              actions={
                <>
                  {editable && <Button variant="primary" onClick={() => setDialog('submit')}>{t('Отправить')}</Button>}
                  {r.status === 'submitted' && can('royalty.review') && <Button onClick={() => void royaltyCommands.takeReview(r.id).then(refresh)}>Начать проверку</Button>}
                  {['submitted', 'in_review'].includes(r.status) && can('royalty.review') && <>
                    <Button onClick={() => setDialog('return')}>Вернуть на исправление</Button>
                    <Button variant="primary" onClick={() => { setSegments(null); setDialog('approve'); }}>Утвердить и рассчитать</Button>
                  </>}
                  {r.status === 'approved' && can('royalty.publish') && !accrual.data && (calc.data?.created_by === me?.user.id
                    ? <span className="faint" style={{ alignSelf: 'center' }}>Начисление публикует другой сотрудник финансов</span>
                    : <Button variant="primary" onClick={() => setDialog('publish')}>Опубликовать начисление</Button>)}
                  {r.status === 'approved' && can('royalty.publish') && accrual.data && <Button onClick={() => setDialog('close')}>Закрыть период</Button>}
                </>
              } />
            {check.data && (
              <div style={{ marginBottom: 16 }}>
                <Alert tone={check.data.diff_minor < 0 ? 'danger' : 'success'} title={check.data.diff_minor < 0 ? t('Отчёт меньше ежедневной выручки') : t('Отчёт сходится с ежедневной выручкой')}>
                  {t('В отчёте')}: {formatMoney(check.data.reported_gross_minor, cur, intlLocale())} · {t('по сменам')}: {formatMoney(check.data.daily_gross_minor, cur, intlLocale())}
                  {check.data.diff_minor !== 0 && <> · {t('разница')}: <strong>{formatMoney(check.data.diff_minor, cur, intlLocale())}</strong></>}
                  {check.data.missing_days > 0 && <> · {t('дней без смен')}: {check.data.missing_days}</>}
                </Alert>
              </div>
            )}
            {r.status === 'needs_correction' && r.return_reason && <div style={{ marginBottom: 16 }}><Alert tone="danger" title="Финансы вернули отчёт">{r.return_reason}</Alert></div>}
            <div className="grid grid-main">
              <div className="stack">
                {editable && daily.data && form && (() => {
                  const miss = daily.data.locations.reduce((n, l) => n + l.missing_days.length, 0);
                  const filled = daily.data.locations.every((l) => form.some((f) => f.location_id === l.location_id && f.gross_minor === String(l.gross_minor) && f.returns_minor === String(l.returns_minor)));
                  return (
                    <Card title="Ежедневные отчёты смен" icon={<CalendarCheck size={18} />} iconTone={miss ? 'danger' : 'dark'}>
                      <ul className="list">
                        {daily.data.locations.map((l) => (
                          <li key={l.location_id} className="row between" style={{ padding: '6px 0' }}>
                            <span><strong>{l.location_name}</strong> · <Money minor={l.gross_minor} currency={cur} /> · {t('дней')} {l.days_with_data} / {daily.data!.days_in_period}</span>
                            {l.missing_days.length > 0
                              ? <Link to={`/sales?tab=location&location=${l.location_id}&month=${r.period}`}>{t('Не заполнено')}: {l.missing_days.length} — {t('дозаполнить')}</Link>
                              : <Badge tone="success">{t('все дни внесены')}</Badge>}
                          </li>
                        ))}
                      </ul>
                      <div className="row between" style={{ marginTop: 10 }}>
                        <span className="faint">{miss ? t('Сначала дозаполните пропущенные дни, чтобы отчёт ушёл полным.') : t('Суммы месяца собраны из ежедневной выручки смен.')}</span>
                        <Button size="sm" variant={filled ? 'secondary' : 'primary'} disabled={filled} onClick={() => setForm((f) => (f ?? []).map((x) => {
                          const d = daily.data!.locations.find((l) => l.location_id === x.location_id);
                          return d ? { ...x, gross_minor: String(d.gross_minor), returns_minor: String(d.returns_minor), zero_reason: d.gross_minor ? null : x.zero_reason } : x;
                        }))}>{filled ? t('Заполнено из смен') : t('Заполнить из ежедневных отчётов')}</Button>
                      </div>
                    </Card>
                  );
                })()}
                <Card title="Выручка по точкам" actions={ver && <Badge tone={ver[1]} title="Степень проверки выручки">{ver[0]}</Badge>}>
                  {!form ? <div className="faint">Загрузка…</div> : (
                    <>
                      <div className="table-wrap">
                        <table className="table">
                          <thead><tr><th>Точка</th><th className="r">{t('Выручка')}</th><th className="r">{t('Возвраты')}</th><th className="r">{t('Исключения')}</th><th className="r">{t('База')}</th></tr></thead>
                          <tbody>
                            {form.map((l, i) => {
                              const base = toBigInt(l.gross_minor) - toBigInt(l.returns_minor) - toBigInt(l.excluded_minor);
                              const name = locs.data?.find((x) => x.id === l.location_id)?.name ?? 'Точка';
                              const upd = (patch: Partial<LineInput>) => setForm((f) => f!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                              return (
                                <tr key={l.location_id}>
                                  <td>
                                    <div style={{ fontWeight: 600 }}>{name}</div>
                                    {editable && toBigInt(l.gross_minor) === 0n && (
                                      <Input aria-label={`${t('Причина нулевой выручки')}: ${name}`} placeholder={t('Причина нулевой выручки')} value={l.zero_reason ?? ''} onChange={(e) => upd({ zero_reason: e.target.value })} style={{ marginTop: 6 }} />
                                    )}
                                    {!editable && l.zero_reason && toBigInt(l.gross_minor) === 0n && <div className="faint">{l.zero_reason}</div>}
                                  </td>
                                  {(['gross_minor', 'returns_minor', 'excluded_minor'] as const).map((k) => (
                                    <td key={k} className="r" style={{ minWidth: 130 }}>
                                      {editable ? <MoneyInput id={`${l.location_id}-${k}`} value={l[k]} currency={cur} onChange={(v) => upd({ [k]: v, ...(k === 'gross_minor' && v !== '0' ? { zero_reason: null } : {}) })} invalid={k !== 'gross_minor' && base < 0n} />
                                        : <Money minor={l[k]} currency={cur} />}
                                    </td>
                                  ))}
                                  <td className="r">{base < 0n ? <Badge tone="danger">меньше нуля</Badge> : <Money minor={base} currency={cur} />}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot><tr><td colSpan={4}>{t('Итого')}: расчётная база</td><td className="r"><Money minor={editable ? total : serverTotal} currency={cur} strong /></td></tr></tfoot>
                        </table>
                      </div>
                      {editable && (
                        <>
                          <div className="grid grid-2" style={{ marginTop: 12 }}>
                            <Field label="Номер отчёта у вас" hint="Необязательно">{(fid) => <Input id={fid} value={partnerRef} onChange={(e) => setPartnerRef(e.target.value)} />}</Field>
                            <Field label={t('Комментарий')}>{(fid) => <Input id={fid} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
                          </div>
                          <div className="row between">
                            <span className="faint">{savedAt ? `Черновик на устройстве: ${formatDateTime(savedAt, intlLocale())}` : ''}</span>
                            <span className="row">
                              <label className="btn btn-sm" style={{ cursor: 'pointer' }}><FileUp size={15} aria-hidden />Импорт CSV
                                <input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await readCsv(f)); e.target.value = ''; }} />
                              </label>
                              <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>Сохранить черновик</Button>
                            </span>
                          </div>
                          <ActionError error={save.error} />
                        </>
                      )}
                    </>
                  )}
                </Card>
                {csv && (
                  <Card title={`Предпросмотр импорта: ${csv.fileName}`}>
                    <p className="faint">Колонки: location_code; gross; returns; excluded; zero_reason. Повтор того же файла не удвоит базу.</p>
                    {csv.problems.length > 0 && <Alert tone="danger">{csv.problems.join('; ')}</Alert>}
                    <div className="table-wrap"><table className="table">
                      <thead><tr><th>#</th><th>Точка</th><th className="r">Выручка</th><th className="r">Возвраты</th><th className="r">Исключения</th></tr></thead>
                      <tbody>{csv.rows.map((x, i) => {
                        const err = importCsv.data?.errors?.filter((e) => e.row === i + 1);
                        return (
                          <tr key={i}><td>{i + 1}</td><td className="mono">{x.location_code}{err?.map((e) => <div key={e.field} style={{ color: 'var(--danger)' }}>{e.error}</div>)}</td>
                            <td className="r">{/^\d+$/.test(x.gross_minor) ? <Money minor={x.gross_minor} currency={cur} /> : <Badge tone="danger">{x.gross_minor}</Badge>}</td>
                            <td className="r">{/^\d+$/.test(x.returns_minor) ? <Money minor={x.returns_minor} currency={cur} /> : x.returns_minor}</td>
                            <td className="r">{/^\d+$/.test(x.excluded_minor) ? <Money minor={x.excluded_minor} currency={cur} /> : x.excluded_minor}</td></tr>
                        );
                      })}</tbody>
                    </table></div>
                    {importCsv.data?.status === 'rejected' && <Alert tone="danger" title="Импорт отклонён">Исправьте строки с ошибками; данные отчёта не изменены.</Alert>}
                    <ActionError error={importCsv.error} />
                    <div className="form-actions"><Button onClick={() => setCsv(null)}>Отмена</Button><Button variant="primary" disabled={csv.problems.length > 0} loading={importCsv.isPending} onClick={() => importCsv.mutate()}>Импортировать</Button></div>
                  </Card>
                )}
                {calc.data && (
                  <Card title="Расчёт роялти" actions={can('royalty.review') && <Button size="sm" variant="ghost" onClick={() => void royaltyCommands.replay(calc.data!.id).then((x) => toast(x.matches ? 'Расчёт воспроизведён по сохранённым данным: совпадает' : 'Расхождение при воспроизведении!', x.matches ? 'success' : 'danger'))}>Проверить воспроизводимость</Button>}>
                    <div className="table-wrap"><table className="table">
                      <thead><tr><th>Период действия ставки</th><th className="r">База</th><th className="r">Ставка</th><th className="r">Точно</th></tr></thead>
                      <tbody>{calc.data.inputs.segments.map((s, i) => (
                        <tr key={i}><td>{formatDate(s.from, intlLocale())} – {formatDate(s.to, intlLocale())} <span className="faint">(правила v{s.policy_version})</span></td>
                          <td className="r"><Money minor={s.base_minor} currency={calc.data!.currency} /></td><td className="r">{pct(s.rate_bp)}</td>
                          <td className="r num">{(Number(s.exact) / 100).toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td></tr>
                      ))}</tbody>
                      <tfoot><tr><td colSpan={3}>Начисление (округление: {calc.data.inputs.rounding === 'half_up' ? 'до минимальной денежной единицы, половина вверх' : calc.data.inputs.rounding})</td><td className="r"><Money minor={calc.data.amount_minor} currency={calc.data.currency} strong /></td></tr></tfoot>
                    </table></div>
                    <div className="faint">Расчёт по редакции {calc.data.inputs.rev_no}, {formatDateTime(calc.data.created_at, intlLocale())}. Входные данные сохранены и не меняются при изменении договора.</div>
                    {accrual.data && <div style={{ marginTop: 8 }}><Link to={`/royalties/accruals/${accrual.data.id}`}>Начисление {accrual.data.number}: срок оплаты {formatDate(accrual.data.due_on, intlLocale())}</Link></div>}
                  </Card>
                )}
              </div>
              <div className="stack">
                <Card title="Отчёт">
                  <KV items={[
                    ['Договор', contract?.number], ['Период', formatPeriod(r.period, intlLocale())], ['Валюта', cur],
                    ['Ставка', (pol.data ?? []).map((p) => `${pct(p.rate_bp)} с ${formatDate(p.effective_from, intlLocale())}`).slice(-2).join('; ') || '—'],
                    ['Редакция', current ? `${current.rev_no}${current.locked ? ' (зафиксирована)' : ' (черновик)'}` : '—'],
                    ['Источник', current ? { manual: 'ручной ввод', import: 'импорт файла', system: 'учётная система' }[current.source] : '—'],
                  ]} />
                </Card>
                {(revs.data?.length ?? 0) > 1 && (
                  <Card title="Редакции">
                    {revs.data!.map((v) => <div key={v.id} className="row between" style={{ padding: '3px 0' }}><span>Редакция {v.rev_no}</span><span className="faint">{v.submitted_at ? `отправлена ${formatDate(v.submitted_at, intlLocale())}` : 'черновик'}</span></div>)}
                  </Card>
                )}
                {can('finance.internal') && (
                  <Card title="Внутренние заметки финансов" actions={<Badge tone="warning">не видны партнёру</Badge>}>
                    {(nt.data ?? []).map((n) => <div key={n.id} className="message internal" style={{ marginBottom: 8 }}><div className="who"><span>{names(n.author_id)}</span><span className="faint">{formatDateTime(n.created_at, intlLocale())}</span></div>{n.body}</div>)}
                    <Field label="Заметка">{(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                    <Button size="sm" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Добавить</Button>
                  </Card>
                )}
                <Card title="История">
                  <Timeline items={(ev.data ?? []).map((e) => ({ at: e.at, who: names(e.actor_id), text: ROY_EVENT[e.action] ?? e.action, comment: e.comment }))} />
                </Card>
              </div>
            </div>
            <ConfirmDialog open={dialog !== null}
              title={{ submit: 'Отправить отчёт', return: 'Вернуть на исправление', approve: 'Утвердить отчёт и рассчитать роялти', publish: 'Опубликовать начисление', close: 'Закрыть период' }[dialog ?? 'submit']}
              confirmLabel={{ submit: 'Отправить', return: 'Вернуть', approve: 'Утвердить', publish: 'Опубликовать', close: 'Закрыть период' }[dialog ?? 'submit']}
              busy={act.isPending} error={act.error && toAppError(act.error).code !== 'policy-split-required' ? act.error : null}
              onClose={() => { setDialog(null); act.reset(); }}
              onConfirm={() => act.mutate()}
              summary={dialog === 'submit' ? [['Период', formatPeriod(r.period, intlLocale())], ['Точек', String(form?.length ?? 0)], ['Расчётная база', <Money key="b" minor={total} currency={cur} />]]
                : dialog === 'publish' && calc.data ? [['Начисление', <Money key="a" minor={calc.data.amount_minor} currency={calc.data.currency} />], ['Партнёр увидит', 'сумму, расчёт и срок оплаты']]
                : dialog === 'approve' ? [['Расчётная база', <Money key="b" minor={serverTotal} currency={cur} />]] : undefined}
            >
              {dialog === 'submit' && <p className="muted">После отправки редакция фиксируется. Исправления — новой редакцией после возврата финансами.</p>}
              {dialog === 'submit' && daily.data && (() => {
                const dailyGross = daily.data.locations.reduce((a, l) => a + toBigInt(l.gross_minor), 0n);
                const formGross = sumMinor((form ?? []).map((l) => l.gross_minor));
                return dailyGross > 0n && formGross < dailyGross ? (
                  <Alert tone="danger" title="Выручка в отчёте меньше, чем по сменам">
                    {t('По ежедневным сменам')}: {formatMoney(dailyGross, cur, intlLocale())}, {t('в отчёте')}: {formatMoney(formGross, cur, intlLocale())}.{' '}
                    {t('Расхождение будет зафиксировано и видно финансам. Если суммы в сменах ошибочны — сначала исправьте их в разделе «Выручка».')}
                  </Alert>
                ) : null;
              })()}
              {dialog === 'publish' && <p className="muted">Публиковать должен не тот сотрудник, кто утверждал расчёт (разделение обязанностей).</p>}
              {dialog === 'close' && <p className="muted">После закрытия суммы периода не редактируются; исправления оформляются корректировкой с причиной.</p>}
              {dialog === 'return' && <Field label="Что исправить" required>{(fid) => <Textarea id={fid} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
              {dialog === 'approve' && (
                <>
                  <Field label="Степень проверки выручки" hint="Утверждение не превращает отчёт партнёра в доказанную выручку">{(fid) => (
                    <Select id={fid} value={verification} onChange={(e) => setVerification(e.target.value)}>
                      <option value="reported">Со слов партнёра</option><option value="imported">Импорт из файла</option><option value="verified">Проверено по источнику (касса/учёт)</option>
                    </Select>
                  )}</Field>
                  {segments && (
                    <Alert tone="warning" title="В периоде менялась ставка">
                      Разделите базу по датам действия ставок. Без подтверждённой разбивки расчёт невозможен.
                      {segments.map((s, i) => (
                        <Field key={s.from} label={`${formatDate(s.from, intlLocale())} – ${formatDate(s.to, intlLocale())}`} required>
                          {(fid) => <MoneyInput id={fid} value={s.base_minor} currency={cur} onChange={(v) => setSegments((xs) => xs!.map((x, j) => (j === i ? { ...x, base_minor: v } : x)))} />}
                        </Field>
                      ))}
                      <div className={segSum === serverTotal ? 'faint' : 'error'} style={segSum === serverTotal ? undefined : { color: 'var(--danger)' }}>
                        Сумма сегментов <Money minor={segSum} currency={cur} /> из <Money minor={serverTotal} currency={cur} />
                      </div>
                    </Alert>
                  )}
                  <Field label="Комментарий">{(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                </>
              )}
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return <div className="row between" style={{ padding: '4px 0' }}><span className="muted">{k}</span><span>{v}</span></div>;
}

export function AccrualPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const names = useUserNames();
  const partners = usePartners();
  const a = useQuery({ queryKey: ['accrual', id], queryFn: () => getAccrual(id) });
  const b = useQuery({ queryKey: ['accrual', id, 'balance'], queryFn: () => getBalance(id) });
  const adj = useQuery({ queryKey: ['accrual', id, 'adj'], queryFn: () => adjustments(id) });
  const dis = useQuery({ queryKey: ['accrual', id, 'disputes'], queryFn: () => disputes(id) });
  const al = useQuery({ queryKey: ['accrual', id, 'alloc'], queryFn: () => allocationsFor('accrual_id', id) });
  const pays = useQuery({ queryKey: ['payments'], queryFn: listPayments });
  const ev = useQuery({ queryKey: ['accrual', id, 'events'], queryFn: () => events('accrual', id) });
  const [dialog, setDialog] = useState<null | 'adjust' | 'dispute' | 'allocate' | 'pay' | 'reverse'>(null);
  const [dir, setDir] = useState('debit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [payment, setPayment] = useState('');
  const [target, setTarget] = useState('');
  const [key, setKey] = useState(newOperationKey);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['accrual', id] }); void qc.invalidateQueries({ queryKey: ['balances'] }); void qc.invalidateQueries({ queryKey: ['payments'] }); };
  const act = useMutation({
    mutationFn: async () => {
      if (dialog === 'adjust') { await royaltyCommands.adjust(id, dir, amount, reason, key); return 'Корректировка проведена'; }
      if (dialog === 'dispute') { await royaltyCommands.disputeOpen(id, amount, reason); return 'Спор открыт; начисление сохранено'; }
      if (dialog === 'allocate') { await royaltyCommands.allocate(payment, id, amount, key); return 'Оплата распределена'; }
      if (dialog === 'reverse') { await royaltyCommands.allocationReverse(target, reason); return 'Распределение сторнировано'; }
      return '';
    },
    onSuccess: (m) => { toast(m); setDialog(null); setAmount(''); setReason(''); setKey(newOperationKey()); refresh(); },
  });
  return (
    <DataState query={a} empty={(x) => (x ? null : <EmptyState title="Начисление не найдено" />)}>
      {(x) => {
        if (!x) return null;
        const bal = b.data;
        const avail = (pays.data ?? []).filter((p) => p.partner_id === x.partner_id && p.currency === x.currency && p.status === 'confirmed' && toBigInt(p.unallocated_minor) > 0n);
        const outstanding = bal ? toBigInt(bal.outstanding_minor) : 0n;
        return (
          <>
            <PageHeader back={{ to: '/royalties/accruals', label: 'Начисления' }} title={`Роялти за ${formatPeriod(x.period, intlLocale()).toLowerCase()}`}
              sub={<span className="row"><span className="mono">{x.number}</span><span>{partners.data?.find((p) => p.id === x.partner_id)?.name}</span>
                {outstanding > 0n && x.due_on < isoDate() ? <Badge tone="danger">просрочено</Badge> : outstanding === 0n ? <Badge tone="success">оплачено</Badge> : <Badge tone="info">к оплате до {formatDate(x.due_on, intlLocale())}</Badge>}</span>}
              actions={
                <>
                  {can('payment.report') && outstanding > 0n && <Button variant="primary" onClick={() => setDialog('pay')}>Сообщить об оплате</Button>}
                  {can('payment.allocate') && outstanding > 0n && avail.length > 0 && <Button variant="primary" onClick={() => { setPayment(avail[0].payment_id); setAmount(String(outstanding < toBigInt(avail[0].unallocated_minor) ? outstanding : toBigInt(avail[0].unallocated_minor))); setDialog('allocate'); }}>Распределить оплату</Button>}
                  {can('royalty.publish') && <Button onClick={() => setDialog('adjust')}>Корректировка</Button>}
                  {(can('royalty.report.submit') || can('royalty.review')) && <Button onClick={() => setDialog('dispute')}>Открыть спор</Button>}
                </>
              } />
            <div className="grid grid-main">
              <div className="stack">
                <Card title="Сальдо">
                  {bal && <>
                    <Row k="Начислено" v={<Money minor={bal.amount_minor} currency={x.currency} />} />
                    {toBigInt(bal.debit_minor) > 0n && <Row k="+ дебетовые корректировки" v={<Money minor={bal.debit_minor} currency={x.currency} />} />}
                    {toBigInt(bal.credit_minor) > 0n && <Row k="− кредитовые корректировки" v={<Money minor={bal.credit_minor} currency={x.currency} />} />}
                    <Row k="− подтверждённые оплаты" v={<Money minor={bal.allocated_minor} currency={x.currency} />} />
                    <hr className="divider" />
                    <Row k="Остаток" v={<Money minor={bal.outstanding_minor} currency={x.currency} strong />} />
                    {toBigInt(bal.disputed_minor) > 0n && <Row k="В том числе оспаривается" v={<Money minor={bal.disputed_minor} currency={x.currency} />} />}
                    <div className="faint" style={{ marginTop: 8 }}>Остаток = начисление + дебет − кредит − распределения подтверждённых оплат. Сообщённые, но не подтверждённые оплаты не уменьшают долг.</div>
                  </>}
                </Card>
                <Card title="Оплаты" bodyless>
                  {al.data?.length ? (
                    <ul className="list">{al.data.map((l) => (
                      <li key={l.id} className="list-item">
                        <div className="main-col"><Link to={`/royalties/payments/${l.payment_id}`}>Оплата</Link> · {formatDateTime(l.created_at, intlLocale())}{l.reversed_reason && <div className="faint">Сторно: {l.reversed_reason}</div>}</div>
                        <div className="side"><Money minor={l.amount_minor} currency={x.currency} />{l.status === 'reversed' ? <Badge tone="neutral">сторнировано</Badge> : can('payment.allocate') && <Button size="sm" variant="ghost" onClick={() => { setTarget(l.id); setDialog('reverse'); }}>Сторно</Button>}</div>
                      </li>
                    ))}</ul>
                  ) : <EmptyState title="Оплат пока нет" />}
                </Card>
                {(adj.data?.length ?? 0) > 0 && <Card title="Корректировки">{adj.data!.map((j) => <Row key={j.id} k={`${j.direction === 'debit' ? '+' : '−'} ${j.reason}`} v={<Money minor={j.amount_minor} currency={x.currency} />} />)}</Card>}
                {(dis.data?.length ?? 0) > 0 && (
                  <Card title="Споры">{dis.data!.map((d) => (
                    <div key={d.id} style={{ padding: '6px 0' }}>
                      <div className="row between"><span>{d.reason}</span><span className="row"><Money minor={d.amount_minor} currency={x.currency} /><Badge tone={d.status === 'open' ? 'warning' : 'neutral'}>{{ open: 'открыт', resolved: 'урегулирован', rejected: 'отклонён' }[d.status]}</Badge></span></div>
                      {d.resolution && <div className="faint">{d.resolution}</div>}
                      {d.status === 'open' && can('royalty.publish') && <div className="row" style={{ marginTop: 6 }}>
                        <Button size="sm" onClick={() => { const res = prompt('Решение по спору'); if (res) void royaltyCommands.disputeResolve(d.id, 'resolved', res).then(refresh); }}>Урегулировать</Button>
                        <Button size="sm" variant="ghost" onClick={() => { const res = prompt('Причина отклонения'); if (res) void royaltyCommands.disputeResolve(d.id, 'rejected', res).then(refresh); }}>Отклонить</Button>
                      </div>}
                    </div>
                  ))}</Card>
                )}
              </div>
              <div className="stack">
                <Card title="Начисление">
                  <KV items={[['Сумма', <Money key="m" minor={x.amount_minor} currency={x.currency} />], ['Срок оплаты', formatDate(x.due_on, intlLocale())], ['Опубликовано', formatDateTime(x.published_at, intlLocale())], ['Опубликовал', names(x.published_by)]]} />
                </Card>
                <Card title="История"><Timeline items={(ev.data ?? []).map((e) => ({ at: e.at, who: names(e.actor_id), text: ROY_EVENT[e.action] ?? e.action, comment: e.comment }))} /></Card>
              </div>
            </div>
            {dialog === 'pay' && bal && <ReportPaymentDialog onClose={() => setDialog(null)} accrual={{ contract_id: x.contract_id, currency: x.currency, outstanding: String(bal.outstanding_minor) }} />}
            <ConfirmDialog open={dialog !== null && dialog !== 'pay'}
              title={{ adjust: 'Корректировка начисления', dispute: 'Открыть спор', allocate: 'Распределить оплату', reverse: 'Сторнировать распределение', pay: '' }[dialog ?? 'adjust']}
              confirmLabel="Подтвердить" busy={act.isPending} error={act.error} danger={dialog === 'reverse'}
              summary={dialog === 'allocate' && amount ? [['Начисление', x.number], ['Остаток долга', <Money key="o" minor={outstanding} currency={x.currency} />], ['Распределить', <Money key="a" minor={amount} currency={x.currency} />]] : undefined}
              onClose={() => { setDialog(null); act.reset(); }} onConfirm={() => act.mutate()}>
              {dialog === 'adjust' && <Field label="Направление">{(fid) => <Select id={fid} value={dir} onChange={(e) => setDir(e.target.value)}><option value="debit">Доначисление (+)</option><option value="credit">Уменьшение (−)</option></Select>}</Field>}
              {dialog === 'allocate' && <Field label="Оплата" required>{(fid) => <Select id={fid} value={payment} onChange={(e) => setPayment(e.target.value)}>{avail.map((p) => <option key={p.payment_id} value={p.payment_id}>{p.number} · свободно {formatMoney(p.unallocated_minor, p.currency, intlLocale())}</option>)}</Select>}</Field>}
              {dialog !== 'reverse' && <Field label={`Сумма, ${x.currency}`} required>{(fid) => <MoneyInput id={fid} value={amount} currency={x.currency} onChange={setAmount} />}</Field>}
              {dialog !== 'allocate' && <Field label="Причина" required>{(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}

export function PaymentPage() {
  const { id = '' } = useParams();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const names = useUserNames();
  const partners = usePartners();
  const p = useQuery({ queryKey: ['payment', id], queryFn: () => getPayment(id) });
  const pb = useQuery({ queryKey: ['payment', id, 'bal'], queryFn: () => getPaymentBalance(id) });
  const al = useQuery({ queryKey: ['payment', id, 'alloc'], queryFn: () => allocationsFor('payment_id', id) });
  const ev = useQuery({ queryKey: ['payment', id, 'events'], queryFn: () => events('payment', id) });
  const [dialog, setDialog] = useState<null | 'register' | 'reject' | 'reverse'>(null);
  const [reason, setReason] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['payment', id] }); void qc.invalidateQueries({ queryKey: ['payments'] }); void qc.invalidateQueries({ queryKey: ['balances'] }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { refresh(); setDialog(null); setReason(''); },
  });
  return (
    <DataState query={p} empty={(x) => (x ? null : <EmptyState title="Оплата не найдена" />)}>
      {(x) => {
        if (!x) return null;
        const [label, tone] = st(PAYMENT_STATUS, x.status);
        const selfRegistered = x.registered_by === me?.user.id;
        return (
          <>
            <PageHeader back={{ to: '/royalties', label: 'Роялти' }} title={<Money minor={x.amount_minor} currency={x.currency} />}
              sub={<span className="row"><span className="mono">{x.number}</span><span>{partners.data?.find((q) => q.id === x.partner_id)?.name}</span><Badge tone={tone}>{label}</Badge></span>}
              actions={can('payment.confirm') && (
                <>
                  {x.status === 'reported' && <Button variant="primary" onClick={() => setDialog('register')}>Сверить с выпиской</Button>}
                  {x.status === 'registered' && <Button variant="primary" disabled={selfRegistered} title={selfRegistered ? 'Подтверждает другой сотрудник финансов' : undefined}
                    loading={act.isPending} onClick={() => act.mutate(async () => { await royaltyCommands.paymentConfirm(x.id); toast('Зачисление подтверждено'); })}>Подтвердить зачисление</Button>}
                  {['reported', 'registered'].includes(x.status) && <Button variant="danger" onClick={() => setDialog('reject')}>Отклонить</Button>}
                  {x.status === 'confirmed' && <Button variant="danger" onClick={() => setDialog('reverse')}>Возврат платежа</Button>}
                </>
              )} />
            <ActionError error={act.error} />
            {x.status === 'reported' && <div style={{ marginBottom: 16 }}><Alert tone="warning" title="Ожидает подтверждения">Сообщение партнёра и квитанция не подтверждают зачисление. Долг не уменьшен.</Alert></div>}
            {x.status === 'registered' && selfRegistered && <div style={{ marginBottom: 16 }}><Alert tone="info">Вы зарегистрировали это зачисление. Подтвердить его должен другой сотрудник финансов.</Alert></div>}
            <div className="grid grid-main">
              <div className="stack">
                <Card title="Квитанция и документы">
                  <FileList entityType="payment" entityId={x.id} />
                  {(can('payment.report') || can('payment.confirm')) && <div style={{ marginTop: 12 }}><FileAttach entityType="payment" entityId={x.id} label="Приложить квитанцию" accept="image/*,application/pdf" prepare={(f) => royaltyCommands.attachPrepare(x.id, f)} /></div>}
                </Card>
                <Card title="Распределение" bodyless>
                  {al.data?.length ? <ul className="list">{al.data.map((l) => (
                    <li key={l.id} className="list-item"><div className="main-col"><Link to={`/royalties/accruals/${l.accrual_id}`}>Начисление</Link>{l.reversed_reason && <div className="faint">Сторно: {l.reversed_reason}</div>}</div><div className="side"><Money minor={l.amount_minor} currency={x.currency} />{l.status === 'reversed' && <Badge tone="neutral">сторнировано</Badge>}</div></li>
                  ))}</ul> : <EmptyState title="Не распределена" text={x.status === 'confirmed' ? 'Распределите оплату из карточки начисления.' : undefined} />}
                  {pb.data && x.status === 'confirmed' && toBigInt(pb.data.unallocated_minor) > 0n && <div className="card-body faint">Нераспределённый остаток (аванс): <Money minor={pb.data.unallocated_minor} currency={x.currency} /></div>}
                </Card>
              </div>
              <div className="stack">
                <Card title="Оплата">
                  <KV items={[['Дата', formatDate(x.paid_on, intlLocale())], ['Источник', { partner_report: 'сообщение партнёра', bank_statement: 'выписка банка', bank_import: 'импорт банка' }[x.source]],
                    ['П/п партнёра', x.partner_ref], ['Операция в выписке', x.bank_ref], ['Сообщил', names(x.reported_by)], ['Зарегистрировал', names(x.registered_by)], ['Подтвердил', names(x.confirmed_by)],
                    ...(x.status_reason ? [['Причина', x.status_reason] as [string, string]] : [])]} />
                </Card>
                <Card title="История"><Timeline items={(ev.data ?? []).map((e) => ({ at: e.at, who: names(e.actor_id), text: ROY_EVENT[e.action] ?? e.action, comment: e.comment }))} /></Card>
              </div>
            </div>
            {dialog === 'register' && <RegisterPaymentDialog onClose={() => { setDialog(null); refresh(); }} reported={{ id: x.id, partner_id: x.partner_id, contract_id: x.contract_id, amount_minor: String(x.amount_minor), currency: x.currency, paid_on: x.paid_on }} />}
            <ConfirmDialog open={dialog === 'reject' || dialog === 'reverse'} title={dialog === 'reject' ? 'Отклонить оплату' : 'Возврат платежа'} confirmLabel="Подтвердить" danger
              busy={act.isPending} error={act.error} onClose={() => { setDialog(null); act.reset(); }}
              onConfirm={() => act.mutate(() => (dialog === 'reject' ? royaltyCommands.paymentReject(x.id, reason) : royaltyCommands.paymentReverse(x.id, reason)))}
              summary={dialog === 'reverse' ? [['Сумма', <Money key="s" minor={x.amount_minor} currency={x.currency} />], ['Последствие', 'распределения сторнируются, долг восстановится']] : undefined}>
              <Field label="Причина" required>{(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}
