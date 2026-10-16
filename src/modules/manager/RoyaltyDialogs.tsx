// Отметить оплату роялти и добавить прошлый неоплаченный долг.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isoDate, monthLabel, monthStart, shiftMonth } from '../../platform/dates';
import { ConfirmDialog, Field, Input, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { manualAdd, paymentAdd } from './api';

/** Последние 24 месяца для выбора. */
export function monthOptions(back = 24, includeCurrent = true) {
  const cur = monthStart();
  const list: string[] = [];
  for (let i = includeCurrent ? 0 : 1; i <= back; i++) list.push(shiftMonth(cur, -i));
  return list;
}

export function PaymentDialog({ partner, currency, month, suggested, onClose }: {
  partner: { id: string; name: string }; currency: string; month?: string; suggested?: number; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [m, setM] = useState(month ?? shiftMonth(monthStart(), -1));
  const [amount, setAmount] = useState(suggested && suggested > 0 ? String(suggested) : '');
  const [paidOn, setPaidOn] = useState(isoDate());
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => paymentAdd(partner.id, m, amount, paidOn, note.trim() || null),
    onSuccess: () => { toast('Оплата отмечена'); void qc.invalidateQueries({ queryKey: ['royalty'] }); onClose(); },
  });
  return (
    <ConfirmDialog open title={`Оплата роялти — ${partner.name}`} confirmLabel="Отметить оплату" busy={save.isPending} error={save.error}
      disabled={!amount || amount === '0'} onClose={onClose} onConfirm={() => save.mutate()}>
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

export function ManualDebtDialog({ partner, currency, onClose }: { partner: { id: string; name: string }; currency: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [m, setM] = useState(shiftMonth(monthStart(), -1));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => manualAdd(partner.id, m, amount, note.trim() || null),
    onSuccess: () => { toast('Прошлый долг добавлен'); void qc.invalidateQueries({ queryKey: ['royalty'] }); onClose(); },
  });
  return (
    <ConfirmDialog open title={`Прошлый долг — ${partner.name}`} confirmLabel="Добавить долг" busy={save.isPending} error={save.error}
      disabled={!amount || amount === '0'} onClose={onClose} onConfirm={() => save.mutate()}>
      <p className="muted">Неоплаченные роялти за период до начала учёта в приложении (или другое ручное начисление). Сумма прибавится к долгу франчайзи.</p>
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
