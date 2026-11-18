// Owner declares the whole day; employee payment breakdown stays in their shifts.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dayLabel } from '../../platform/dates';
import { useSession } from '../../platform/session';
import { ConfirmDialog, Field, Input, Money, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { revenueTotalSet, type DayRow } from './api';

const MAX_TOTAL_MINOR = 100_000_000_000; // revenue_total_set limit in the database

export function RevenueDialog({ location, currency, day, existing, onClose }: {
  location: string; currency: string; day: string; existing?: DayRow; staff?: { user_id: string; full_name: string }[]; onClose: () => void;
}) {
  const { me } = useSession();
  const qc = useQueryClient(); const toast = useToast();
  const [total, setTotal] = useState(existing ? String(existing.total_minor) : '');
  const [totalValid, setTotalValid] = useState(true);
  const [comment, setComment] = useState(existing?.entries.find(e => !e.employee_id)?.comment ?? '');
  const staffTotal = (existing?.entries ?? []).filter(e => e.employee_id).reduce((a,e) => a + Number(e.total_minor), 0);
  const exceedsLimit = Number(total) > MAX_TOTAL_MINOR;
  const belowStaffTotal = Number(total) < staffTotal;
  const save = useMutation({
    mutationFn: () => revenueTotalSet(me!.user.id, location, day, total, existing?.day_version ?? 'empty', comment.trim() || null),
    onSuccess: r => {
      toast(r && typeof r === 'object' && 'queued' in r ? 'Сохранено на устройстве — отправится при появлении сети' : 'Выручка сохранена');
      void qc.invalidateQueries({ queryKey: ['revenue'] }); void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['royalty'] }); void qc.invalidateQueries({ queryKey: ['rating'] }); onClose();
    },
  });
  return <ConfirmDialog open title={`Выручка — ${dayLabel(day)}`} confirmLabel="Сохранить" busy={save.isPending} error={save.error}
    disabled={!total || !totalValid || exceedsLimit || belowStaffTotal} onClose={onClose} onConfirm={() => save.mutate()}>
    <Field label="Вся выручка точки за день" hint="Включая продажи сотрудников" required>{id => (
      <MoneyInput id={id} value={total} onChange={setTotal} onValidityChange={setTotalValid} requireExplicitValue currency={currency} placeholder="0" invalid={exceedsLimit} />
    )}</Field>
    {staffTotal > 0 && <p className="faint">Сотрудники уже внесли <Money minor={staffTotal} currency={currency} />. Эта сумма входит в общий итог, повторно не прибавляется.</p>}
    {totalValid && exceedsLimit && <p role="alert">Укажите сумму до <Money minor={MAX_TOTAL_MINOR} currency={currency} short /> включительно.</p>}
    {totalValid && total && belowStaffTotal && <p role="alert">Сумма меньше внесённых смен. Сначала сотрудник должен проверить свою смену.</p>}
    <Field label="Комментарий" hint="Необязательно">{id => <Input id={id} value={comment} onChange={e => setComment(e.target.value)} />}</Field>
  </ConfirmDialog>;
}
