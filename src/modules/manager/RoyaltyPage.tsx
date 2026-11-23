// Роялти: сводная таблица по всем франчайзи. По умолчанию — весь неоплаченный долг; фильтр — конкретный месяц. Выгрузка в Excel.
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, PencilLine, Plus, Wallet } from 'lucide-react';
import { formatDate, monthLabel } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { Button, DataState, Money, PageHeader, Select } from '../../ui';
import { ActionError } from '../../ui';
import { pct, royaltySummary, type RoyaltyRow } from './api';
import { downloadRoyaltyExcel, royaltyRubleTotal } from './royaltyExcel';
import { CorrectionDialog, ManualDebtDialog, monthOptions, PaymentDialog, RoyaltyOps } from './RoyaltyDialogs';

export function RoyaltyPage() {
  const [month, setMonth] = useState<string>('');
  const [pay, setPay] = useState<RoyaltyRow | null>(null);
  const [manual, setManual] = useState<RoyaltyRow | null>(null);
  const [fix, setFix] = useState<RoyaltyRow | null>(null);
  const q = useQuery({ queryKey: ['royalty', 'summary', month], queryFn: () => royaltySummary(month || null) });
  const exp = useMutation({ mutationFn: () => downloadRoyaltyExcel(q.data!) });
  const all = !month;
  const open = Boolean(q.data?.month && q.data.month >= q.data.current_month);
  const balanceLabel = open ? 'Предварительный остаток' : 'Долг';
  const rubleTotal = q.data ? royaltyRubleTotal(q.data) : null;

  return (
    <>
      <PageHeader title="Роялти" sub={all ? 'Начисления, корректировки и оплаты за закрытые месяцы.' : `Роялти за ${monthLabel(month)}.`}
        actions={<Button variant="primary" disabled={!q.data} loading={exp.isPending} onClick={() => exp.mutate()}><Download size={16} aria-hidden />Скачать Excel</Button>} />
      <div className="row" style={{ marginBottom: 16 }}>
        <label htmlFor="roy-period" className="faint">Период</label>
        <Select id="roy-period" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">Закрытые месяцы</option>
          {monthOptions(24).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </Select>
      </div>
      <ActionError error={exp.error} />
      <DataState query={q} skeleton={6}>
        {(s) => (
          <>
            <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12em), 1fr))' }}>
              {s.totals.map((t) => (
                <div key={t.currency} className={`kpi${!open && t.debt_minor > 0 ? ' warn' : ''}`}>
                  <span className="v">{formatMoneyShort(t.debt_minor, t.currency)}</span>
                  <span className="l">{balanceLabel} в {t.currency}</span>
                </div>
              ))}
              {rubleTotal !== null && s.totals.length > 1 && (
                <div className="kpi"><span className="v">{formatMoneyShort(Math.round(Number(rubleTotal) / 100) * 100, 'RUB')}</span><span className="l">{balanceLabel} в рублях по курсу</span></div>
              )}
            </div>
            {open && <p className="faint">Месяц ещё открыт. Предварительный остаток учитывает начисления, корректировки и оплаты за этот месяц.</p>}
            <div className="table-wrap card" role="region" aria-label="Роялти по франчайзи" tabIndex={0}>
              <table className="table royalty-table">
                <thead>
                  <tr>
                    <th>Франчайзи</th><th className="r">Ставка</th><th className="r">Выручка</th><th className="r">Начислено</th>
                    <th className="r">Корректировки</th><th className="r">Оплачено</th><th className="r">{balanceLabel}</th>
                    {all && <th className="r">Текущий месяц</th>}<th />
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.partner_id}>
                      <td>
                        <Link to={`/royalty/${r.partner_id}`}><strong>{r.partner_name}</strong></Link>
                        <div className="faint">{r.currency}{r.last_payment_on ? ` · оплата ${formatDate(r.last_payment_on)}` : ''}{all && r.debt_months.length ? ` · долг за ${r.debt_months.length} мес.` : ''}</div>
                      </td>
                      <td className="r">{pct(r.rate_bp)}</td>
                      <td className="r num">{formatMoneyShort(r.revenue_minor, r.currency)}</td>
                      <td className="r num">{formatMoneyShort(r.accrued_minor, r.currency)}</td>
                      <td className="r num">{r.manual_minor ? formatMoneyShort(r.manual_minor, r.currency) : '—'}</td>
                      <td className="r num">{formatMoneyShort(r.paid_minor, r.currency)}</td>
                      <td className={`r num${!open && r.debt_minor > 0 ? ' danger-text' : ''}`}><Money minor={r.debt_minor} currency={r.currency} short strong /></td>
                      {all && <td className="r num faint" title="Начисляется, в долг войдёт после окончания месяца">{formatMoneyShort(r.current_accrual_minor, r.currency)}</td>}
                      <td className="r">
                        <div className="table-actions">
                          <Button size="sm" onClick={() => setPay(r)}><Wallet size={14} aria-hidden />Оплата</Button>
                          <Button size="sm" variant="ghost" title="Исправить начисление месяца" onClick={() => setFix(r)}><PencilLine size={14} aria-hidden />Исправить</Button>
                          <Button size="sm" variant="ghost" title="Добавить прошлый долг" onClick={() => setManual(r)}><Plus size={14} aria-hidden />Долг</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <RoyaltyOps />
          </>
        )}
      </DataState>
      {pay && <PaymentDialog partner={{ id: pay.partner_id, name: pay.partner_name }} currency={pay.currency}
        month={month || pay.debt_months[0]?.month} suggested={month ? pay.debt_minor : pay.debt_months[0]?.debt_minor} onClose={() => setPay(null)} />}
      {fix && <CorrectionDialog partner={{ id: fix.partner_id, name: fix.partner_name }} currency={fix.currency} month={month || undefined} onClose={() => setFix(null)} />}
      {manual && <ManualDebtDialog partner={{ id: manual.partner_id, name: manual.partner_name }} currency={manual.currency} onClose={() => setManual(null)} />}
    </>
  );
}
