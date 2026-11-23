// Роялти у менеджера: отметить оплату, исправить начисление месяца, добавить прошлый долг — и отменить любое из этих действий.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { command } from '../../platform/backend';
import { formatDate, formatDateTime, isoDate, monthLabel, monthStart, shiftMonth } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { useSession } from '../../platform/session';
import { Badge, Button, Card, ConfirmDialog, DataState, Field, Input, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { saveFinancialOperation } from '../finance/financeOperations';
import { manualAdd, manualDelete, paymentDelete, pct, royaltyPartner } from './api';

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

type PaymentMatch = { id: string; month: string | null; note: string | null };
type PaymentResult = { id: string } | { matches: PaymentMatch[] };
type PaymentDraft = { key: string; month: string | null; amount: string; paidOn: string; note: string | null; reviewed: string[] };

export function PaymentDialog({ partner, currency, month, suggested, hasUndated = false, onClose }: {
  partner: { id: string; name: string }; currency: string; month?: string | null; suggested?: number; hasUndated?: boolean; onClose: () => void;
}) {
  const done = useUndoable();
  const userId = useSession().me?.user.id;
  const initialMonth = month === null && hasUndated ? '' : month ?? shiftMonth(monthStart(), -1);
  const [m, setM] = useState(initialMonth);
  const [enteredAmount, setEnteredAmount] = useState<string>();
  const [amountValid, setAmountValid] = useState(true);
  const amount = enteredAmount ?? (m === initialMonth && suggested && suggested > 0 ? String(suggested) : '');
  const [paidOn, setPaidOn] = useState(isoDate());
  const [note, setNote] = useState('');
  const [review, setReview] = useState<{ key: string; matches: PaymentMatch[] } | null>(null);
  const reviewKey = JSON.stringify([m, paidOn, amount, note.trim()]);
  const matches = review?.key === reviewKey ? review.matches : null;
  const canSave = !!(amountValid && amount && amount !== '0' && paidOn);
  const save = useMutation({
    mutationFn: (draft: PaymentDraft) => saveFinancialOperation<PaymentResult>(userId, 'royalty_payment_reviewed', {
      p_partner: partner.id, p_month: draft.month, p_amount: draft.amount, p_paid_on: draft.paidOn,
      p_note: draft.note, p_reviewed: draft.reviewed,
    }),
    onSuccess: (result, draft) => {
      if ('matches' in result) {
        setReview({ key: draft.key, matches: result.matches });
        return;
      }
      done(`Оплата ${formatMoneyShort(draft.amount, currency)} от ${partner.name} отмечена`, () => paymentDelete(result.id));
      onClose();
    },
  });
  return (
    <ConfirmDialog open title={`Отметить оплату — ${partner.name}`} confirmLabel={matches ? 'Добавить отдельный платёж' : 'Отметить оплату'} cancelLabel="Закрыть"
      busy={save.isPending} error={save.error} disabled={!canSave} onClose={onClose}
      onConfirm={() => {
        if (canSave && !save.isPending) save.mutate({
          key: reviewKey, month: m || null, amount, paidOn, note: note.trim() || null, reviewed: matches?.map(match => match.id).sort() ?? [],
        });
      }}>
      <p className="muted">Деньги поступили — отметьте сумму. Ошиблись — нажмите «Отменить» в уведомлении или в журнале операций.</p>
      <fieldset className="stack" disabled={save.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="За месяц">{(id) => (
            <Select id={id} value={m} onChange={(e) => setM(e.target.value)}>
              {hasUndated && <option value="">Без периода</option>}
              {monthOptions().map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
            </Select>
          )}</Field>
          <Field label="Дата оплаты" required>{(id) => <Input id={id} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
        </div>
        <Field label={`Сумма, ${currency}`} required error={!amountValid ? 'Проверьте сумму оплаты.' : undefined}>
          {(id, describedBy) => <MoneyInput id={id} describedBy={describedBy} value={amount} onChange={setEnteredAmount}
            onValidityChange={setAmountValid} currency={currency} />}
        </Field>
        <Field label="Комментарий" hint="Укажите номер платёжного документа, если он есть">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </fieldset>
      {matches && <div className="alert tone-warning" role="status">
        <div className="alert-body">
          <strong>Есть похожая оплата</strong>
          <p>На {formatDate(paidOn)} уже записано {formatMoneyShort(amount, currency)} от этого франчайзи. Сверьте банковскую выписку перед добавлением отдельного платежа.</p>
          <ul>{matches.map(match => <li key={match.id}>{match.month ? monthLabel(match.month) : 'Без периода'}{match.note ? ` · ${match.note}` : ''}</li>)}</ul>
        </div>
      </div>}
    </ConfirmDialog>
  );
}

/** Исправить начисление месяца: «должно быть X». Разница записывается корректировкой, автоматический расчёт остаётся. */
export function CorrectionDialog({ partner, currency, month, onClose }: { partner: { id: string; name: string }; currency: string; month?: string; onClose: () => void }) {
  const done = useUndoable();
  const userId = useSession().me?.user.id;
  const [m, setM] = useState(month ?? shiftMonth(monthStart(), -1));
  const ledger = useQuery({ queryKey: ['royalty', 'partner', partner.id], queryFn: () => royaltyPartner(partner.id) });
  const row = ledger.data?.months.find((x) => x.month === m);
  const auto = Number(row?.accrued_minor ?? 0);
  const corrections = Number(row?.correction_minor ?? row?.manual_minor ?? 0);
  const pastDebt = Number(row?.past_debt_minor ?? 0);
  const [targetDraft, setTargetDraft] = useState<string>();
  const target = targetDraft ?? (ledger.data ? String(auto + corrections) : '');
  const [targetValid, setTargetValid] = useState(true);
  const [note, setNote] = useState('');
  const delta = Number(target || 0) - auto - corrections;
  const canSave = ledger.isSuccess && targetValid && target !== '' && Boolean(note.trim()) && delta !== 0;
  const save = useMutation({
    mutationFn: (draft: { month: string; target: string; note: string }) => saveFinancialOperation<{ id: string | null; delta_minor: number }>(userId, 'royalty_set_accrual_only',
      { p_partner: partner.id, p_month: draft.month, p_target: draft.target, p_note: draft.note }),
    onSuccess: (r, draft) => {
      if (!r.id) { onClose(); return; }
      done(`Начисление ${partner.name} за ${monthLabel(draft.month)} исправлено: ${r.delta_minor > 0 ? '+' : ''}${formatMoneyShort(r.delta_minor, currency)}`, () => manualDelete(r.id!));
      onClose();
    },
  });
  return (
    <ConfirmDialog open title={`Исправить начисление — ${partner.name}`} confirmLabel="Сохранить исправление" cancelLabel="Закрыть" busy={save.isPending}
      error={save.error} disabled={!canSave} onClose={onClose}
      onConfirm={() => { if (canSave && !save.isPending) save.mutate({ month: m, target, note: note.trim() }); }}>
      <p className="muted">Система считает роялти сама. Если она ошиблась (например, выручку внесли неверно, а исправлять поздно), укажите, сколько должно быть начислено. Разница сохранится отдельной корректировкой — её можно отменить.</p>
      <fieldset className="stack" disabled={save.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Field label="Месяц">{(id) => (
          <Select id={id} value={m} onChange={(e) => {
            setM(e.target.value);
            setTargetDraft(undefined);
            setTargetValid(true);
          }}>
            {monthOptions(24).map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
          </Select>
        )}</Field>
        <DataState query={ledger}>
          {() => (
            <div className="summary" style={{ marginBottom: 12 }}>
              <dl style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
                <dt>Рассчитано системой</dt><dd>{formatMoneyShort(auto, currency)}{row ? ` · ${pct(row.rate_bp)} от ${formatMoneyShort(row.revenue_minor, currency)}` : ''}</dd>
                <dt>Корректировки начисления</dt><dd>{corrections ? formatMoneyShort(corrections, currency) : '—'}</dd>
                <dt>Начисление сейчас</dt><dd>{formatMoneyShort(auto + corrections, currency)}</dd>
                <dt>Прошлый долг</dt><dd>{pastDebt ? formatMoneyShort(pastDebt, currency) : '—'}</dd>
                <dt>Начисление и прошлый долг до оплат</dt><dd>{formatMoneyShort(auto + corrections + pastDebt, currency)}</dd>
              </dl>
            </div>
          )}
        </DataState>
        <Field label={`Должно быть начислено, ${currency}`} required error={!targetValid ? 'Укажите итоговую сумму начисления.' : undefined}
          hint={ledger.isSuccess && targetValid && target !== '' ? delta
            ? `Корректировка: ${delta > 0 ? '+' : ''}${formatMoneyShort(delta, currency)}. После исправления до оплат: ${formatMoneyShort(Number(target) + pastDebt, currency)}`
            : 'Сумма совпадает с текущей' : undefined}>
          {(id, describedBy) => <MoneyInput key={m} id={id} describedBy={describedBy} value={target} onChange={setTargetDraft}
            onValidityChange={setTargetValid} currency={currency} requireExplicitValue />}
        </Field>
        <Field label="Причина" required hint="Сохранится в журнале операций">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: пересчитали по акту сверки" />}</Field>
      </fieldset>
    </ConfirmDialog>
  );
}

export function ManualDebtDialog({ partner, currency, onClose }: { partner: { id: string; name: string }; currency: string; onClose: () => void }) {
  const done = useUndoable();
  const [m, setM] = useState(shiftMonth(monthStart(), -1));
  const [amount, setAmount] = useState('');
  const [amountValid, setAmountValid] = useState(true);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => manualAdd(partner.id, m || null, amount, note.trim() || null) as Promise<string>,
    onSuccess: (id) => { done(`Прошлый долг ${formatMoneyShort(amount, currency)} добавлен`, () => manualDelete(id)); onClose(); },
  });
  return (
    <ConfirmDialog open title={`Прошлый долг — ${partner.name}`} confirmLabel="Добавить долг" cancelLabel="Закрыть" busy={save.isPending} error={save.error}
      disabled={!amountValid || !amount || amount === '0' || (!m && !note.trim())} onClose={onClose} onConfirm={() => save.mutate()}>
      <p className="muted">Неоплаченные роялти за период до начала учёта в приложении. Сумма прибавится к долгу франчайзи.</p>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="За месяц">{(id) => (
          <Select id={id} value={m} onChange={(e) => setM(e.target.value)}>
            <option value="">Период неизвестен</option>
            {monthOptions(60).map((x) => <option key={x} value={x}>{monthLabel(x)}</option>)}
          </Select>
        )}</Field>
        <Field label={`Сумма, ${currency}`} required error={!amountValid ? 'Проверьте сумму долга.' : undefined}>
          {(id, describedBy) => <MoneyInput id={id} describedBy={describedBy} value={amount} onChange={setAmount}
            onValidityChange={setAmountValid} currency={currency} />}
        </Field>
      </div>
      <Field label="Комментарий" required={!m}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: долг за май по акту сверки" />}</Field>
    </ConfirmDialog>
  );
}

interface Op { id: string; op: 'payment' | 'past_debt' | 'correction'; partner_id: string; partner_name: string; currency: string; month: string | null;
  amount_minor: number; note: string | null; paid_on?: string | null; created_at: string; by: string | null }
const OP_LABEL: Record<Op['op'], [string, 'success' | 'info' | 'warning']> = {
  payment: ['оплата', 'success'], past_debt: ['прошлый долг', 'warning'], correction: ['исправление', 'info'],
};

const operationLabel = (op: Op) => op.op === 'payment' && op.paid_on === null ? 'оплата подтверждена без даты' : OP_LABEL[op.op][0];

/** Журнал операций по роялти с отменой. */
export function RoyaltyOps({ partner, limit = 15 }: { partner?: string; limit?: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Op | null>(null);
  const q = useQuery({ queryKey: ['royalty', 'ops', partner ?? null, limit], queryFn: () => command<Op[]>('royalty_ops_v2', { partner: partner ?? null, limit }) });
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
              <div key={o.id} className="row between access-row">
                <span style={{ minWidth: 0 }}>
                  <span className="row" style={{ gap: 6 }}><Badge tone={OP_LABEL[o.op][1]} icon={false}>{operationLabel(o)}</Badge>
                    <strong className="num">{o.amount_minor > 0 && o.op === 'correction' ? '+' : ''}{formatMoneyShort(o.amount_minor, o.currency)}</strong>
                    {!partner && <span>{o.partner_name}</span>}</span>
                  <span className="faint" style={{ display: 'block' }}>{o.month ? monthLabel(o.month) : 'Без периода'}{o.note ? ` · ${o.note}` : ''} · {formatDateTime(o.created_at)}{o.by ? ` · ${o.by}` : ''}</span>
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
          summary={[['Что', operationLabel(confirm)], ['Франчайзи', confirm.partner_name], ['Сумма', formatMoneyShort(confirm.amount_minor, confirm.currency)], ['Месяц', confirm.month ? monthLabel(confirm.month) : 'Без периода']]}>
          <p className="muted">Долг франчайзи пересчитается сразу. Отмена записывается в журнал действий.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}
