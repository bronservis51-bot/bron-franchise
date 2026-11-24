// Роялти одного франчайзи: помесячно (выручка, ставка, начислено, оплачено, долг), оплаты, прошлые долги, ставка.
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, PencilLine, Percent, Plus, Wallet } from 'lucide-react';
import { formatDate, monthLabel, monthStart, shiftMonth } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { Button, Card, ConfirmDialog, DataState, Field, Input, Money, PageHeader, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { RoyaltyHolidayNote } from '../finance/RoyaltyHolidayNote';
import { pct, rateSet, royaltyHolidayStartSet, royaltyPartner } from './api';
import { CorrectionDialog, ManualDebtDialog, monthOptions, PaymentDialog, RoyaltyOps } from './RoyaltyDialogs';

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
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Ставка, %">{(id) => <Input id={id} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
        <Field label="Действует с" help="Выбранный месяц уже считается по новой ставке." helpLabel="Когда применяется ставка">{(id) => (
          <Select id={id} value={from} onChange={(e) => setFrom(e.target.value)}>
            {monthOptions(24).map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
          </Select>
        )}</Field>
      </div>
    </ConfirmDialog>
  );
}

function HolidayDialog({ partner, current, onClose }: { partner: string; current: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saved] = useState(current);
  const [date, setDate] = useState(current ?? '');
  const mutation = useMutation({
    mutationFn: () => royaltyHolidayStartSet(partner, date || null, saved),
    onSuccess: () => {
      toast('Настройки каникул сохранены');
      void qc.invalidateQueries({ queryKey: ['royalty'] });
      void qc.invalidateQueries({ queryKey: ['finance'] });
      onClose();
    },
    onError: () => { void qc.invalidateQueries({ queryKey: ['royalty', 'partner', partner] }); },
  });
  return <ConfirmDialog open title="Каникулы по роялти" confirmLabel="Сохранить" busy={mutation.isPending}
    error={mutation.error} dirty={(date || null) !== saved} disabled={(date || null) === saved}
    onClose={onClose} onConfirm={() => mutation.mutate()}>
    <Field label="Подтверждённая дата открытия"
      hint="Роялти начисляются после двух календарных месяцев с этой даты. Указывайте день фактического открытия.">
      {id => <Input id={id} type="date" value={date} onChange={event => setDate(event.target.value)} />}
    </Field>
    {saved && !date && <p>Если сохранить пустую дату, каникулы снимутся и начисления за эти дни пересчитаются.</p>}
  </ConfirmDialog>;
}

export function RoyaltyPartnerPage() {
  const { id = '' } = useParams();
  const [pay, setPay] = useState<{ month?: string | null; amount?: number } | null>(null);
  const [fix, setFix] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [rate, setRate] = useState(false);
  const [holiday, setHoliday] = useState(false);
  const q = useQuery({ queryKey: ['royalty', 'partner', id], queryFn: () => royaltyPartner(id) });

  return (
    <DataState query={q}>
      {(r) => {
        const debt = r.months.filter((m) => !m.is_open).reduce((a, m) => a + Number(m.debt_minor), Number(r.undated?.debt_minor ?? 0));
        const open = r.months.find((m) => m.is_open);
        return (
          <>
            <PageHeader back={{ to: '/royalty', label: 'Роялти' }} title={r.partner_name}
              sub={<span className="row"><span>ставка {pct(r.rate_bp)}</span><Link to={`/partners/${r.partner_id}`}>карточка франчайзи</Link></span>}
              actions={<>
                <Button variant="primary" onClick={() => setPay({})}><Wallet size={16} aria-hidden />Отметить оплату</Button>
                <Button onClick={() => setFix(monthStart())}><PencilLine size={16} aria-hidden />Исправить начисление</Button>
                <Button onClick={() => setManual(true)}><Plus size={16} aria-hidden />Прошлый долг</Button>
                <Button variant="ghost" onClick={() => setHoliday(true)}><CalendarClock size={16} aria-hidden />Каникулы</Button>
                <Button variant="ghost" onClick={() => setRate(true)}><Percent size={16} aria-hidden />Ставка</Button>
              </>} />
            {r.royalty_holiday_from && <p className="muted">Открытие {formatDate(r.royalty_holiday_from)} · начисление роялти с {formatDate(r.royalty_accrual_from)}</p>}
            <div className="kpis">
              <div className={`kpi${debt > 0 ? ' warn' : ''}`}><span className="v">{formatMoneyShort(debt, r.currency)}</span><span className="l">долг по роялти</span></div>
              {open && <div className="kpi"><span className="v">{formatMoneyShort(open.accrued_minor, r.currency)}</span><span className="l">начисляется за {monthLabel(open.month, false)}</span></div>}
            </div>
            {r.undated && <Card title="Прошлый долг без периода" actions={Number(r.undated.debt_minor) > 0
              ? <Button size="sm" onClick={() => setPay({ month: null, amount: r.undated?.debt_minor })}>Оплата</Button> : undefined}>
              <span>Остаток <Money minor={r.undated.debt_minor} currency={r.currency} strong /></span>
              {Number(r.undated.paid_minor) > 0 && <p className="faint">Оплачено {formatMoneyShort(r.undated.paid_minor, r.currency)}</p>}
            </Card>}
            <div className="grid grid-main">
              <Card title="По месяцам" bodyless>
                <div className="table-wrap" role="region" aria-label="Роялти франчайзи по месяцам" tabIndex={0}>
                  <table className="table">
                    <thead><tr><th>Месяц</th><th className="r">Выручка</th><th className="r">Ставка</th><th className="r">Начислено</th><th className="r">Корректировки</th><th className="r">Прошлый долг</th><th className="r">Оплачено</th><th className="r">Долг</th><th /></tr></thead>
                    <tbody>
                      {r.months.map((m) => {
                        const inHoliday = r.royalty_holiday_from && r.royalty_holiday_until
                          && shiftMonth(m.month, 1) > r.royalty_holiday_from && m.month < r.royalty_holiday_until;
                        return (
                          <tr key={m.month}>
                            <td className="table-month">{monthLabel(m.month)}
                              {inHoliday ? <RoyaltyHolidayNote currency={r.currency} waived={m.waived_royalty_minor}
                                until={r.royalty_holiday_until} accrualFrom={r.royalty_accrual_from} />
                                : m.is_open && <div className="faint">начисляется</div>}
                            </td>
                            <td className="r num">{formatMoneyShort(m.revenue_minor, r.currency)}</td>
                            <td className="r">{pct(m.rate_bp)}</td>
                            <td className="r num">{formatMoneyShort(m.accrued_minor, r.currency)}</td>
                            <td className="r num">{(m.correction_minor ?? m.manual_minor) ? formatMoneyShort(m.correction_minor ?? m.manual_minor, r.currency) : '—'}</td>
                            <td className="r num">{m.past_debt_minor ? formatMoneyShort(m.past_debt_minor, r.currency) : '—'}</td>
                            <td className="r num">{formatMoneyShort(m.paid_minor, r.currency)}</td>
                            <td className={`r num${m.debt_minor > 0 && !m.is_open ? ' danger-text' : ''}`}>{m.is_open ? '—' : <Money minor={m.debt_minor} currency={r.currency} short strong />}</td>
                            <td className="r"><span className="table-actions">
                              {!m.is_open && m.debt_minor > 0 && <Button size="sm" onClick={() => setPay({ month: m.month, amount: m.debt_minor })}>Оплата</Button>}
                              <Button size="sm" variant="ghost" onClick={() => setFix(m.month)}>Исправить</Button></span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
              <div className="stack">
                <RoyaltyOps partner={r.partner_id} limit={30} />
              </div>
            </div>
            {pay && <PaymentDialog partner={{ id: r.partner_id, name: r.partner_name }} currency={r.currency}
              hasUndated={Number(r.undated?.debt_minor ?? 0) > 0} month={pay.month} suggested={pay.amount} onClose={() => setPay(null)} />}
            {fix && <CorrectionDialog partner={{ id: r.partner_id, name: r.partner_name }} currency={r.currency} month={fix} onClose={() => setFix(null)} />}
            {manual && <ManualDebtDialog partner={{ id: r.partner_id, name: r.partner_name }} currency={r.currency} onClose={() => setManual(false)} />}
            {holiday && <HolidayDialog partner={r.partner_id} current={r.royalty_holiday_from ?? null} onClose={() => setHoliday(false)} />}
            {rate && <RateDialog partner={r.partner_id} current={r.rate_bp} onClose={() => setRate(false)} />}
          </>
        );
      }}
    </DataState>
  );
}
