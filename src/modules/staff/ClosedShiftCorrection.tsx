import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toAppError } from '../../platform/backend';
import { formatDate } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { Checkbox, ConfirmDialog, Field, Input, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { staffShiftCorrect, type PayrollShift } from './api';
import { ShiftReturnField, validShiftReturn } from './ShiftReturnField';
import { recordShiftReturn } from './shiftReturns';
import './shift-correction.css';

export function payrollShiftTime(shift: PayrollShift) {
  const format = (value: string) => new Date(value).toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', timeZone: shift.timezone,
  });
  return shift.submitted_without_open ? `Сдана в ${format(shift.closed_at)}` : `${format(shift.opened_at)}–${format(shift.closed_at)}`;
}

export function ClosedShiftCorrection({ employee, shift, currency, userId, onClose }: {
  employee: string; shift: PayrollShift; currency: string; userId: string; onClose: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [cash, setCash] = useState(String(shift.cash_minor));
  const [card, setCard] = useState(String(shift.card_minor));
  const [cashValid, setCashValid] = useState(true);
  const [cardValid, setCardValid] = useState(true);
  const initialReturn = shift.return_minor ? String(shift.return_minor) : null;
  const [returned, setReturned] = useState<string | null>(initialReturn);
  const [returnValid, setReturnValid] = useState(true);
  const [reason, setReason] = useState('');
  const [zeroConfirmed, setZeroConfirmed] = useState(false);
  const amountsChanged = cash !== String(shift.cash_minor) || card !== String(shift.card_minor);
  const returnAmount = returned || null;
  const returnChanged = returnAmount !== initialReturn;
  const zero = cash === '0' && card === '0';
  const valid = cashValid && cardValid && cash !== '' && card !== '' && reason.trim().length >= 3
    && (amountsChanged || returnChanged) && validShiftReturn(returned, returnValid) && (!zero || !amountsChanged || zeroConfirmed);
  const save = useMutation({
    mutationFn: async () => {
      if (returnChanged) {
        await recordShiftReturn(userId, { shiftId: shift.id, revision: shift.revision }, { cash, card, returned: returnAmount ?? '0', reason: reason.trim() });
      } else {
        await staffShiftCorrect(userId, shift, cash, card, reason);
      }
    },
    onError: error => {
      if (toAppError(error).code === 'version-conflict') void client.invalidateQueries({ queryKey: ['staff-list'] });
    },
    onSuccess: () => {
      for (const key of ['staff-list', 'staff', 'team-revenue', 'revenue', 'finance', 'manager-economy', 'royalty', 'rating']) {
        void client.invalidateQueries({ queryKey: [key] });
      }
      toast('Смена исправлена');
      onClose();
    },
  });
  return <ConfirmDialog open className="shift-correction-dialog" title="Исправить закрытую смену" confirmLabel="Сохранить"
    busy={save.isPending} error={save.error} dirty={amountsChanged || returnChanged || !returnValid || Boolean(reason) || !cashValid || !cardValid}
    disabled={!valid || (save.isError && toAppError(save.error).code === 'version-conflict')} onConfirm={() => save.mutate()} onClose={onClose}>
    <p><strong>{employee}</strong> · {shift.location_name} · {formatDate(shift.day)}</p>
    <p className="faint">Выручка до исправления — {formatMoneyShort(shift.total_minor, currency)}. Заработок пересчитается по условиям этой смены.</p>
    <div className="grid grid-2">
      <Field label="Наличные">{id => <MoneyInput id={id} value={cash} currency={currency} onChange={setCash} requireExplicitValue onValidityChange={setCashValid} />}</Field>
      <Field label="Картой">{id => <MoneyInput id={id} value={card} currency={currency} onChange={setCard} requireExplicitValue onValidityChange={setCardValid} />}</Field>
    </div>
    <ShiftReturnField currency={currency} value={returned} onChange={setReturned} valid={returnValid}
      onValidityChange={setReturnValid} busy={save.isPending} />
    {zero && amountsChanged && <Checkbox label="Сверили: продаж за смену не было" checked={zeroConfirmed} onChange={setZeroConfirmed} />}
    <Field label="Причина исправления" required>{id => <Input id={id} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} />}</Field>
  </ConfirmDialog>;
}
