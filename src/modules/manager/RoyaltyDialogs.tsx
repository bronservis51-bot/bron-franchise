// Роялти у менеджера: отметить оплату, исправить начисление месяца, добавить прошлый долг — и отменить любое из этих действий.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { command } from '../../platform/backend';
import { formatDateTime, isoDate, monthLabel, monthStart, shiftMonth } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { Badge, Button, Card, ConfirmDialog, DataState, Field, Input, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { manualAdd, manualDelete, paymentAdd, paymentDelete, pct, royaltyPartner } from './api';

/** Последние 24 месяца для выбора. */
export function monthOptions(back = 24, includeCurrent = true) {
  const cur = monthStart();
  const list: string[] = [];
  for (let i = includeCurrent ? 0 : 1; i <= back; i++) list.push(shiftMonth(cur, -i));
  return list;
}

/** После действия — уведомление с кнопкой «Отменить». */
function useUndoable() {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['royalty'] });
  return (text: string, undo: () => Promise<unknown>) => {
    refresh();
    toast(text, 'success', { label: 'Отменить', onClick: () => void undo().then(() => { toast('Действие отменено'); refresh(); }, () => toast('Не удалось отменить', 'danger')) });
  };
}

export function PaymentDialog({ partner, currency, month, suggested, onClose }: {
  partner: { id: string; name: string }; currency: string; month?: string; suggested?: number; onClose: () => void;
}) {
  const done = useUndoable();
  const [m, setM] = useState(month ?? shiftMonth(monthStart(), -1));
  const [amount, setAmount] = useState(suggested && suggested > 0 ? String(suggested) : '');
  const [paidOn, setPaidOn] = useState(isoDate());
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => paymentAdd(partner.id, m, amount, paidOn, note.trim() || null) as Promise<string>,
    onSuccess: (id) => { done(`Оплата ${formatMoneyShort(amount, currency)} от ${partner.name} отмечена`, () => paymentDelete(id)); onClose(); },
  });
  return (
    <ConfirmDialog open title={`Отметить оплату — ${partner.name}`} confirmLabel="Отметить оплату" cancelLabel="Закрыть" busy={save.isPending} error={save.error}
      disabled={!amount || amount === '0'} onClose={onClose} onConfirm={() => save.mutate()}>
      <p className="muted">Деньги поступили — отметьте сумму. Ошиблись — нажмите «Отменить» в уведомлении или в журнале операций.</p>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="За месяц">{(id) => (
          <Select id={id} value={m} onChange={(e) => setM(e.target.value)}>
            {monthOptions().map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
          </Select>
        )}</Field>
        <Field label="Дата оплаты">{(id) => <Input id={id} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
      </div>
      <Field label={`Сумма, ${currency}`} required>{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} currency={currency} />}</Field>
      <Field label="Комментарий" hint="Например: номер платёжки">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

/** Исправить начисление месяца: «должно быть X». Разница записывается корректировкой, автоматический расчёт остаётся. */
export function CorrectionDialog({ partner, currency, month, onClose }: { partner: { id: string; name: string }; currency: string; month?: string; onClose: () => void }) {
  const done = useUndoable();
  const [m, setM] = useState(month ?? shiftMonth(monthStart(), -1));
  const ledger = useQuery({ queryKey: ['royalty', 'partner', partner.id], queryFn: () => royaltyPartner(partner.id) });
  const row = ledger.data?.months.find((x) => x.month === m);
  const auto = Number(row?.accrued_minor ?? 0);
  const manual = Number(row?.manual_minor ?? 0);
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setTarget(String(auto + manual)); }, [m, auto, manual]);
  const save = useMutation({
    mutationFn: () => command<{ id: string | null; delta_minor: number }>('royalty_set_accrual', { partner: partner.id, month: m, target: target || '0', note }),
    onSuccess: (r) => {
      if (!r.id) { onClose(); return; }
      done(`Начисление ${partner.name} за ${monthLabel(m)} исправлено: ${r.delta_minor > 0 ? '+' : ''}${formatMoneyShort(r.delta_minor, currency)}`, () => manualDelete(r.id!));
      onClose();
    },
  });
  const delta = Number(target || 0) - auto - manual;
  return (
    <ConfirmDialog open title={`Исправить начисление — ${partner.name}`} confirmLabel="Сохранить исправление" cancelLabel="Закрыть" busy={save.isPending}
      error={save.error} disabled={!note.trim() || delta === 0} onClose={onClose} onConfirm={() => save.mutate()}>
      <p className="muted">Система считает роялти сама. Если она ошиблась (например, выручку внесли неверно, а исправлять поздно), укажите, сколько должно быть начислено. Разница сохранится отдельной корректировкой — её можно отменить.</p>
      <Field label="Месяц">{(id) => (
        <Select id={id} value={m} onChange={(e) => setM(e.target.value)}>
          {monthOptions(24).map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
        </Select>
      )}</Field>
      <DataState query={ledger}>
        {() => (
          <div className="summary" style={{ marginBottom: 12 }}>
            <dl>
              <dt>Рассчитано системой</dt><dd>{formatMoneyShort(auto, currency)}{row ? ` · ${pct(row.rate_bp)} от ${formatMoneyShort(row.revenue_minor, currency)}` : ''}</dd>
              <dt>Корректировки и прошлые долги</dt><dd>{manual ? formatMoneyShort(manual, currency) : '—'}</dd>
              <dt>Итого сейчас</dt><dd>{formatMoneyShort(auto + manual, currency)}</dd>
            </dl>
          </div>
        )}
      </DataState>
      <Field label={`Должно быть начислено, ${currency}`} required hint={delta ? `Корректировка: ${delta > 0 ? '+' : ''}${formatMoneyShort(delta, currency)}` : 'Сумма совпадает с текущей'}>
        {(id) => <MoneyInput id={id} value={target} onChange={setTarget} currency={currency} />}</Field>
      <Field label="Причина" required hint="Её увидит франчайзи в своих финансах">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: пересчитали по акту сверки" />}</Field>
    </ConfirmDialog>
  );
}

export function ManualDebtDialog({ partner, currency, onClose }: { partner: { id: string; name: string }; currency: string; onClose: () => void }) {
  const done = useUndoable();
  const [m, setM] = useState(shiftMonth(monthStart(), -1));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => manualAdd(partner.id, m, amount, note.trim() || null) as Promise<string>,
    onSuccess: (id) => { done(`Прошлый долг ${formatMoneyShort(amount, currency)} добавлен`, () => manualDelete(id)); onClose(); },
  });
  return (
    <ConfirmDialog open title={`Прошлый долг — ${partner.name}`} confirmLabel="Добавить долг" cancelLabel="Закрыть" busy={save.isPending} error={save.error}
      disabled={!amount || amount === '0'} onClose={onClose} onConfirm={() => save.mutate()}>
      <p className="muted">Неоплаченные роялти за период до начала учёта в приложении. Сумма прибавится к долгу франчайзи.</p>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="За месяц">{(id) => (
          <Select id={id} value={m} onChange={(e) => setM(e.target.value)}>
            {monthOptions(60).map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
          </Select>
        )}</Field>
        <Field label={`Сумма, ${currency}`} required>{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} currency={currency} />}</Field>
      </div>
      <Field label="Комментарий">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: долг за май по акту сверки" />}</Field>
    </ConfirmDialog>
  );
}

interface Op { id: string; op: 'payment' | 'past_debt' | 'correction'; partner_id: string; partner_name: string; currency: string; month: string;
  amount_minor: number; note: string | null; paid_on?: string; created_at: string; by: string | null }
const OP_LABEL: Record<Op['op'], [string, 'success' | 'info' | 'warning']> = {
  payment: ['оплата', 'success'], past_debt: ['прошлый долг', 'warning'], correction: ['исправление', 'info'],
};

/** Журнал операций по роялти с отменой. */
export function RoyaltyOps({ partner, limit = 15 }: { partner?: string; limit?: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Op | null>(null);
  const q = useQuery({ queryKey: ['royalty', 'ops', partner ?? null, limit], queryFn: () => command<Op[]>('royalty_ops', { partner: partner ?? null, limit }) });
  const undo = useMutation({
    mutationFn: (o: Op) => (o.op === 'payment' ? paymentDelete(o.id) : manualDelete(o.id)),
    onSuccess: () => { toast('Операция отменена'); setConfirm(null); void qc.invalidateQueries({ queryKey: ['royalty'] }); },
  });
  return (
    <Card title="Последние операции">
      <DataState query={q} empty={(d) => (d.length ? null : <p className="faint">Операций пока нет.</p>)}>
        {(list) => (
          <>
            {list.map((o) => (
              <div key={o.id} className="row between access-row" style={{ flexWrap: 'nowrap' }}>
                <span style={{ minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}><Badge tone={OP_LABEL[o.op][1]} icon={false}>{OP_LABEL[o.op][0]}</Badge>
                    <strong className="num">{o.amount_minor > 0 && o.op === 'correction' ? '+' : ''}{formatMoneyShort(o.amount_minor, o.currency)}</strong>
                    {!partner && <span>{o.partner_name}</span>}</span>
                  <span className="faint" style={{ display: 'block' }}>за {monthLabel(o.month)}{o.note ? ` · ${o.note}` : ''} · {formatDateTime(o.created_at)}{o.by ? ` · ${o.by}` : ''}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(o)}><Undo2 size={14} aria-hidden />Отменить</Button>
              </div>
            ))}
          </>
        )}
      </DataState>
      {confirm && (
        <ConfirmDialog open danger title="Отменить операцию?" confirmLabel="Отменить операцию" cancelLabel="Не отменять" busy={undo.isPending} error={undo.error}
          onClose={() => setConfirm(null)} onConfirm={() => undo.mutate(confirm)}
          summary={[['Что', OP_LABEL[confirm.op][0]], ['Франчайзи', confirm.partner_name], ['Сумма', formatMoneyShort(confirm.amount_minor, confirm.currency)], ['Месяц', monthLabel(confirm.month)]]}>
          <p className="muted">Долг франчайзи пересчитается сразу. Отмена записывается в журнал действий.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}
