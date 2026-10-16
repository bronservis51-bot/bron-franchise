// Роялти одного франчайзи: помесячно (выручка, ставка, начислено, оплачено, долг), оплаты, прошлые долги, ставка.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Percent, Plus, Trash2, Wallet } from 'lucide-react';
import { formatDate, monthLabel, monthStart } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { ActionError, Button, Card, ConfirmDialog, DataState, Field, Input, Money, PageHeader, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { manualDelete, paymentDelete, pct, rateSet, royaltyPartner } from './api';
import { ManualDebtDialog, monthOptions, PaymentDialog } from './RoyaltyDialogs';

function RateDialog({ partner, current, onClose }: { partner: string; current: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rate, setRate] = useState(String(current / 100).replace('.', ','));
  const [from, setFrom] = useState(monthStart());
  const bp = Math.round(Number(rate.replace(',', '.')) * 100);
  const m = useMutation({
    mutationFn: () => rateSet(partner, bp, from),
    onSuccess: () => { toast('Ставка сохранена'); void qc.invalidateQueries({ queryKey: ['royalty'] }); onClose(); },
  });
  return (
    <ConfirmDialog open title="Ставка роялти" confirmLabel="Сохранить ставку" busy={m.isPending} error={m.error}
      disabled={!Number.isFinite(bp) || bp < 0 || bp > 10000} onClose={onClose} onConfirm={() => m.mutate()}>
      <p className="muted">По умолчанию 7 %. Новая ставка действует с выбранного месяца; более ранние месяцы считаются по прежней.</p>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Ставка, %">{(id) => <Input id={id} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
        <Field label="Действует с">{(id) => (
          <Select id={id} value={from} onChange={(e) => setFrom(e.target.value)}>
            {monthOptions(24).map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
          </Select>
        )}</Field>
      </div>
    </ConfirmDialog>
  );
}

export function RoyaltyPartnerPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [pay, setPay] = useState<{ month?: string; amount?: number } | null>(null);
  const [manual, setManual] = useState(false);
  const [rate, setRate] = useState(false);
  const q = useQuery({ queryKey: ['royalty', 'partner', id], queryFn: () => royaltyPartner(id) });
  const delPay = useMutation({ mutationFn: paymentDelete, onSuccess: () => { toast('Оплата удалена'); void qc.invalidateQueries({ queryKey: ['royalty'] }); } });
  const delManual = useMutation({ mutationFn: manualDelete, onSuccess: () => { toast('Запись удалена'); void qc.invalidateQueries({ queryKey: ['royalty'] }); } });

  return (
    <DataState query={q}>
      {(r) => {
        const debt = r.months.filter((m) => !m.is_open).reduce((a, m) => a + Number(m.debt_minor), 0);
        const open = r.months.find((m) => m.is_open);
        return (
          <>
            <PageHeader back={{ to: '/royalty', label: 'Роялти' }} title={r.partner_name}
              sub={<span className="row"><span>ставка {pct(r.rate_bp)}</span><Link to={`/partners/${r.partner_id}`}>карточка франчайзи</Link></span>}
              actions={<>
                <Button variant="primary" onClick={() => setPay({})}><Wallet size={16} aria-hidden />Отметить оплату</Button>
                <Button onClick={() => setManual(true)}><Plus size={16} aria-hidden />Прошлый долг</Button>
                <Button variant="ghost" onClick={() => setRate(true)}><Percent size={16} aria-hidden />Ставка</Button>
              </>} />
            <div className="kpis">
              <div className={`kpi${debt > 0 ? ' warn' : ''}`}><span className="v">{formatMoneyShort(debt, r.currency)}</span><span className="l">долг за закрытые месяцы</span></div>
              {open && <div className="kpi"><span className="v">{formatMoneyShort(open.accrued_minor, r.currency)}</span><span className="l">начисляется за {monthLabel(open.month, false)}</span></div>}
            </div>
            <ActionError error={delPay.error ?? delManual.error} />
            <div className="grid grid-main">
              <Card title="По месяцам" bodyless>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Месяц</th><th className="r">Выручка</th><th className="r">Ставка</th><th className="r">Начислено</th><th className="r">Прошлый долг</th><th className="r">Оплачено</th><th className="r">Долг</th><th /></tr></thead>
                    <tbody>
                      {r.months.map((m) => (
                        <tr key={m.month}>
                          <td>{monthLabel(m.month)}{m.is_open && <div className="faint">начисляется</div>}</td>
                          <td className="r num">{formatMoneyShort(m.revenue_minor, r.currency)}</td>
                          <td className="r">{pct(m.rate_bp)}</td>
                          <td className="r num">{formatMoneyShort(m.accrued_minor, r.currency)}</td>
                          <td className="r num">{m.manual_minor ? formatMoneyShort(m.manual_minor, r.currency) : '—'}</td>
                          <td className="r num">{formatMoneyShort(m.paid_minor, r.currency)}</td>
                          <td className={`r num${m.debt_minor > 0 && !m.is_open ? ' danger-text' : ''}`}>{m.is_open ? '—' : <Money minor={m.debt_minor} currency={r.currency} short strong />}</td>
                          <td className="r">{!m.is_open && m.debt_minor > 0 && <Button size="sm" onClick={() => setPay({ month: m.month, amount: m.debt_minor })}>Оплата</Button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <div className="stack">
                <Card title="Оплаты">
                  {!r.payments.length && <p className="faint">Оплат пока нет.</p>}
                  {r.payments.map((p) => (
                    <div key={p.id} className="row between access-row">
                      <span><Money minor={p.amount_minor} currency={r.currency} strong /> <span className="faint">за {monthLabel(p.month)}</span>
                        <span className="faint" style={{ display: 'block' }}>{formatDate(p.paid_on)}{p.note ? ` · ${p.note}` : ''}</span></span>
                      <button type="button" className="icon-btn" aria-label="Удалить оплату" onClick={() => delPay.mutate(p.id)}><Trash2 size={16} /></button>
                    </div>
                  ))}
                </Card>
                <Card title="Прошлые долги">
                  {!r.manual.length && <p className="faint">Нет.</p>}
                  {r.manual.map((p) => (
                    <div key={p.id} className="row between access-row">
                      <span><Money minor={p.amount_minor} currency={r.currency} strong /> <span className="faint">за {monthLabel(p.month)}</span>
                        {p.note && <span className="faint" style={{ display: 'block' }}>{p.note}</span>}</span>
                      <button type="button" className="icon-btn" aria-label="Удалить запись" onClick={() => delManual.mutate(p.id)}><Trash2 size={16} /></button>
                    </div>
                  ))}
                </Card>
              </div>
            </div>
            {pay && <PaymentDialog partner={{ id: r.partner_id, name: r.partner_name }} currency={r.currency} month={pay.month} suggested={pay.amount} onClose={() => setPay(null)} />}
            {manual && <ManualDebtDialog partner={{ id: r.partner_id, name: r.partner_name }} currency={r.currency} onClose={() => setManual(false)} />}
            {rate && <RateDialog partner={r.partner_id} current={r.rate_bp} onClose={() => setRate(false)} />}
          </>
        );
      }}
    </DataState>
  );
}
