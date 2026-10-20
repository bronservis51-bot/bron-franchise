// Финансы франчайзи: выручка, зарплата сотрудников, роялти, расходы и что остаётся — по всем точкам или по одной; помесячно, с долгом и оплатами.
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { command } from '../../platform/backend';
import { formatDate, monthLabel, monthStart } from '../../platform/dates';
import { formatMoneyShort, minorToDecimal } from '../../platform/money';
import { ActionError, Button, Card, DataState, Money, PageHeader } from '../../ui';
import { MonthNav } from '../revenue/FranchiseeHome';
import { ExpensesCard, type Expense } from './Expenses';

interface Fin { month: string; revenue_minor: number; cash_minor: number; card_minor: number; plan_minor: number | null; pct: number | null;
  payroll_minor: number; shifts: number; rate_bp: number; royalty_minor: number; expenses_minor: number; net_minor: number; is_open: boolean }
interface Ledger { month: string; revenue_minor: number; rate_bp: number; accrued_minor: number; manual_minor: number; paid_minor: number; debt_minor: number; is_open: boolean }
interface Royalty { rate_bp: number; debt_minor: number; live: { month: string; revenue_minor: number; accrued_minor: number; projected_accrual_minor: number };
  months: Ledger[]; payments: { month: string; amount_minor: number; paid_on: string; note: string | null }[] }
interface Finance {
  partner_name: string; currency: string; month: string; location_id: string | null;
  locations: { id: string; name: string; status: string }[];
  current: Fin; months: Fin[];
  by_location: (Fin & { location_id: string; location_name: string })[] | null;
  by_staff: { user_id: string; full_name: string; shifts: number; revenue_minor: number; earned_minor: number }[];
  expenses: Expense[]; expense_categories: string[]; prev_expenses_count: number;
  royalty: Royalty | null;
}

const pct = (bp: number) => `${(bp / 100).toLocaleString('ru-RU')} %`;
const n = (v: number | string) => Number(v);

/** Помесячно: на что разошлась выручка — остаток, зарплата, роялти, расходы (столбцы с разбивкой, подсказка при наведении). */
function MonthsChart({ months, currency }: { months: Fin[]; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...months.map((m) => n(m.revenue_minor)));
  const parts = (m: Fin) => [
    { key: 'net', label: 'Остаётся', v: Math.max(0, n(m.net_minor)) },
    { key: 'payroll', label: 'Зарплата', v: n(m.payroll_minor) },
    { key: 'royalty', label: 'Роялти', v: n(m.royalty_minor) },
    { key: 'expenses', label: 'Расходы', v: n(m.expenses_minor) },
  ];
  return (
    <figure className="fin-chart viz-root" aria-label="Выручка по месяцам: остаётся, зарплата, роялти, расходы">
      <div className="fin-legend" aria-hidden>
        <span><i className="sw net" />Остаётся</span><span><i className="sw payroll" />Зарплата сотрудников</span><span><i className="sw royalty" />Роялти</span><span><i className="sw expenses" />Расходы</span>
      </div>
      <div className="fin-bars" onMouseLeave={() => setHover(null)}>
        {months.map((m, i) => (
          <div key={m.month} className="fin-col" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
            aria-label={`${monthLabel(m.month)}: выручка ${formatMoneyShort(m.revenue_minor, currency)}`}>
            <div className="fin-stack" style={{ height: `${(n(m.revenue_minor) / max) * 100}%` }}>
              {parts(m).map((p) => p.v > 0 && <span key={p.key} className={`seg ${p.key}`} style={{ flexGrow: p.v }} />)}
            </div>
            <span className="fin-month">{monthLabel(m.month, false).slice(0, 3)}{m.is_open ? '*' : ''}</span>
            {hover === i && (
              <div className="fin-tip" role="tooltip">
                <strong>{monthLabel(m.month)}{m.is_open ? ' (идёт)' : ''}</strong>
                <span>Выручка <b>{formatMoneyShort(m.revenue_minor, currency)}</b></span>
                {parts(m).map((p) => <span key={p.key}><i className={`sw ${p.key}`} />{p.label} <b>{formatMoneyShort(p.v, currency)}</b></span>)}
              </div>
            )}
          </div>
        ))}
      </div>
      <figcaption className="faint">* текущий месяц — данные на сегодня</figcaption>
    </figure>
  );
}

async function downloadFinance(f: Finance) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const money = (v: number) => ({ value: Number(minorToDecimal(v, f.currency)), type: Number, format: '#,##0.00' });
  const head = (value: string) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC' });
  const scope = f.location_id ? f.locations.find((l) => l.id === f.location_id)?.name ?? '' : 'все точки';
  const cols = ['Месяц', 'Выручка', 'Наличные', 'Карта', 'План', 'Выполнение', 'Зарплата', 'Роялти', 'Расходы', 'Остаётся'].map(head);
  const row = (label: string, m: Fin) => [label, money(m.revenue_minor), money(m.cash_minor), money(m.card_minor), m.plan_minor ? money(m.plan_minor) : null,
    m.pct !== null ? { value: m.pct / 100, type: Number, format: '0.0%' } : null, money(m.payroll_minor), money(m.royalty_minor), money(m.expenses_minor), money(m.net_minor)];
  const sheets = [
    { sheet: 'По месяцам', columns: [{ width: 16 }, ...Array(9).fill({ width: 14 })],
      data: [[{ value: `${f.partner_name} — финансы (${scope})`, fontWeight: 'bold' as const, fontSize: 14 }], [], cols, ...f.months.map((m) => row(monthLabel(m.month), m))] },
    ...(f.by_location ? [{ sheet: 'По точкам', columns: [{ width: 26 }, ...Array(9).fill({ width: 14 })],
      data: [[head('Точка'), ...cols.slice(1)], ...f.by_location.map((l) => row(l.location_name, l))] }] : []),
    ...(f.by_staff.length ? [{ sheet: 'Зарплата', columns: [{ width: 26 }, { width: 10 }, { width: 16 }, { width: 16 }],
      data: [['Сотрудник', 'Смен', 'Выручка смен', 'Заработок'].map(head), ...f.by_staff.map((s) => [s.full_name, { value: s.shifts, type: Number }, money(s.revenue_minor), money(s.earned_minor)])] }] : []),
    ...(f.expenses.length ? [{ sheet: 'Расходы', columns: [{ width: 26 }, { width: 24 }, { width: 16 }, { width: 30 }],
      data: [['Категория', 'Точка', 'Сумма', 'Комментарий'].map(head), ...f.expenses.map((e) => [e.category, e.location_name ?? 'все точки', money(e.amount_minor), e.note ?? ''])] }] : []),
  ];
  await writeXlsxFile(sheets).toFile(`finansy-${f.month.slice(0, 7)}.xlsx`);
}

export function FinancePage() {
  const [month, setMonth] = useState(monthStart());
  const [loc, setLoc] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['finance', month, loc], queryFn: () => command<Finance>('finance_my', { month, location: loc }), refetchInterval: 120_000 });
  const exp = useMutation({ mutationFn: () => downloadFinance(q.data!) });

  return (
    <div className="home" style={{ maxWidth: 980 }}>
      <PageHeader title="Финансы" sub="Выручка, зарплата сотрудников, роялти, ваши расходы и что остаётся. Выручка, зарплата и роялти считаются сами."
        actions={<Button disabled={!q.data} loading={exp.isPending} onClick={() => exp.mutate()}><Download size={16} aria-hidden />Excel</Button>} />
      <ActionError error={exp.error} />
      {q.data && q.data.locations.length > 1 && (
        <div className="chips point-chips" role="group" aria-label="Точки">
          <button type="button" className="chip" aria-pressed={loc === null} onClick={() => setLoc(null)}>Все точки</button>
          {q.data.locations.map((l) => <button key={l.id} type="button" className="chip" aria-pressed={loc === l.id} onClick={() => setLoc(l.id)}>{l.name}</button>)}
        </div>
      )}
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <DataState query={q} skeleton={6}>
        {(f) => {
          const c = f.current;
          return (
            <div className="stack">
              <div className="kpis fin-kpis">
                <div className="kpi"><span className="v">{formatMoneyShort(c.revenue_minor, f.currency)}</span>
                  <span className="l">выручка · нал. {formatMoneyShort(c.cash_minor, f.currency)} · карта {formatMoneyShort(c.card_minor, f.currency)}</span></div>
                <div className="kpi"><span className="v">{c.pct !== null ? `${n(c.pct).toLocaleString('ru-RU')} %` : '—'}</span>
                  <span className="l">{c.plan_minor ? `плана ${formatMoneyShort(c.plan_minor, f.currency)}` : 'план не поставлен'}</span></div>
                <div className="kpi"><span className="v">{formatMoneyShort(c.payroll_minor, f.currency)}</span><span className="l">зарплата сотрудников · {c.shifts} смен</span></div>
                <div className="kpi"><span className="v">{formatMoneyShort(c.royalty_minor, f.currency)}</span><span className="l">роялти {pct(c.rate_bp)}{c.is_open ? ' · начисляется' : ''}</span></div>
                <div className="kpi"><span className="v">{formatMoneyShort(c.expenses_minor, f.currency)}</span><span className="l">расходы{f.expenses.length ? ` · ${f.expenses.length} шт.` : ' · не внесены'}</span></div>
                <div className={`kpi kpi-accent${n(c.net_minor) < 0 ? ' warn' : ''}`}><span className="v">{formatMoneyShort(c.net_minor, f.currency)}</span><span className="l">остаётся после зарплаты, роялти и расходов</span></div>
              </div>

              <ExpensesCard month={f.month} currency={f.currency} location={f.location_id} locations={f.locations.filter((l) => l.status === 'active')}
                expenses={f.expenses} own={f.expense_categories} prevCount={n(f.prev_expenses_count)} total={n(c.expenses_minor)} />

              <Card title="За полгода">
                <MonthsChart months={f.months} currency={f.currency} />
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table className="table">
                    <thead><tr><th>Месяц</th><th className="r">Выручка</th><th className="r">План</th><th className="r">Зарплата</th><th className="r">Роялти</th><th className="r">Расходы</th><th className="r">Остаётся</th></tr></thead>
                    <tbody>{[...f.months].reverse().map((m) => (
                      <tr key={m.month}><td>{monthLabel(m.month)}{m.is_open && <span className="faint"> · идёт</span>}</td>
                        <td className="r num">{formatMoneyShort(m.revenue_minor, f.currency)}</td>
                        <td className="r">{m.pct !== null ? `${n(m.pct).toLocaleString('ru-RU')} %` : '—'}</td>
                        <td className="r num">{formatMoneyShort(m.payroll_minor, f.currency)}</td>
                        <td className="r num">{formatMoneyShort(m.royalty_minor, f.currency)}</td>
                        <td className="r num">{formatMoneyShort(m.expenses_minor, f.currency)}</td>
                        <td className="r num"><strong>{formatMoneyShort(m.net_minor, f.currency)}</strong></td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </Card>

              {f.by_location && f.by_location.length > 1 && (
                <Card title={`По точкам — ${monthLabel(f.month)}`} bodyless>
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Точка</th><th className="r">Выручка</th><th className="r">План</th><th className="r">Зарплата</th><th className="r">Роялти</th><th className="r">Расходы</th><th className="r">Остаётся</th></tr></thead>
                      <tbody>{f.by_location.map((l) => (
                        <tr key={l.location_id} className="clickable" onClick={() => setLoc(l.location_id)}>
                          <td><strong>{l.location_name}</strong></td>
                          <td className="r num">{formatMoneyShort(l.revenue_minor, f.currency)}</td>
                          <td className="r">{l.pct !== null ? `${n(l.pct).toLocaleString('ru-RU')} %` : '—'}</td>
                          <td className="r num">{formatMoneyShort(l.payroll_minor, f.currency)}</td>
                          <td className="r num">{formatMoneyShort(l.royalty_minor, f.currency)}</td>
                          <td className="r num">{formatMoneyShort(l.expenses_minor, f.currency)}</td>
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
                    <div key={s.user_id} className="row between access-row">
                      <span><strong>{s.full_name}</strong><span className="faint" style={{ display: 'block' }}>{s.shifts} смен · выручка {formatMoneyShort(s.revenue_minor, f.currency)}</span></span>
                      <Money minor={s.earned_minor} currency={f.currency} strong />
                    </div>
                  ))}
                </Card>
              )}

              {f.royalty ? <RoyaltySection r={f.royalty} currency={f.currency} /> : (
                <p className="faint">Долг и оплаты роялти считаются по франчайзи целиком — выберите «Все точки», чтобы их увидеть.</p>
              )}
            </div>
          );
        }}
      </DataState>
    </div>
  );
}

function RoyaltySection({ r, currency }: { r: Royalty; currency: string }) {
  return (
    <Card title="Роялти">
      <div className="kpis" style={{ marginTop: 0 }}>
        <div className="kpi"><span className="v">{formatMoneyShort(r.live.accrued_minor, currency)}</span><span className="l">начислено за {monthLabel(r.live.month, false)} на сейчас</span></div>
        <div className="kpi"><span className="v">≈ {formatMoneyShort(Math.round(n(r.live.projected_accrual_minor) / 100) * 100, currency)}</span><span className="l">к концу месяца при текущем темпе</span></div>
        <div className={`kpi${n(r.debt_minor) > 0 ? ' warn' : ''}`}><span className="v">{formatMoneyShort(r.debt_minor, currency)}</span><span className="l">долг за закрытые месяцы</span></div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Месяц</th><th className="r">Выручка</th><th className="r">Ставка</th><th className="r">Начислено</th><th className="r">Корректировки</th><th className="r">Оплачено</th><th className="r">Долг</th></tr></thead>
          <tbody>{r.months.map((m) => (
            <tr key={m.month}>
              <td>{monthLabel(m.month)}{m.is_open && <div className="faint">начисляется</div>}</td>
              <td className="r num">{formatMoneyShort(m.revenue_minor, currency)}</td>
              <td className="r">{pct(m.rate_bp)}</td>
              <td className="r num">{formatMoneyShort(m.accrued_minor, currency)}</td>
              <td className="r num">{n(m.manual_minor) ? formatMoneyShort(m.manual_minor, currency) : '—'}</td>
              <td className="r num">{formatMoneyShort(m.paid_minor, currency)}</td>
              <td className={`r num${n(m.debt_minor) > 0 && !m.is_open ? ' danger-text' : ''}`}>{m.is_open ? '—' : <Money minor={m.debt_minor} currency={currency} short strong />}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {r.payments.length > 0 && (
        <>
          <h3 className="section-title" style={{ marginTop: 16 }}>Оплаты</h3>
          {r.payments.map((p, i) => (
            <div key={i} className="row between access-row">
              <span>за {monthLabel(p.month)}<span className="faint" style={{ display: 'block' }}>{formatDate(p.paid_on)}{p.note ? ` · ${p.note}` : ''}</span></span>
              <Money minor={p.amount_minor} currency={currency} strong />
            </div>
          ))}
        </>
      )}
      <p className="faint" style={{ marginTop: 8 }}>Оплату отмечает менеджер по франшизе, когда деньги поступили. Корректировки — исправления начисления менеджером.</p>
    </Card>
  );
}
