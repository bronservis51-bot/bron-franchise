// Owner declares the whole day; employee payment breakdown stays in their shifts.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dayLabel } from '../../platform/dates';
import { useSession } from '../../platform/session';
import { ConfirmDialog, Field, Input, Money, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { revenueTotalSet, type DayRow } from './api';

export function RevenueDialog({ location, currency, day, existing, onClose }: {
  location: string; currency: string; day: string; existing?: DayRow; staff?: { user_id: string; full_name: string }[]; onClose: () => void;
}) {
  const { me } = useSession();
  const qc = useQueryClient(); const toast = useToast();
  const [total, setTotal] = useState(existing ? String(existing.total_minor) : '');
  const [comment, setComment] = useState(existing?.entries.find(e => !e.employee_id)?.comment ?? '');
  const staffTotal = (existing?.entries ?? []).filter(e => e.employee_id).reduce((a,e) => a + Number(e.total_minor), 0);
  const save = useMutation({
    mutationFn: () => revenueTotalSet(me!.user.id, location, day, total, existing?.day_version ?? 'empty', comment.trim() || null),
    onSuccess: r => {
      toast(r && typeof r === 'object' && 'queued' in r ? 'Сохранено на устройстве — отправится при появлении сети' : 'Выручка сохранена');
      void qc.invalidateQueries({ queryKey: ['revenue'] }); void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['royalty'] }); void qc.invalidateQueries({ queryKey: ['rating'] }); onClose();
    },
  });
  return <ConfirmDialog open title={`Выручка — ${dayLabel(day)}`} confirmLabel="Сохранить" busy={save.isPending} error={save.error}
    disabled={!total || Number(total) < staffTotal} onClose={onClose} onConfirm={() => save.mutate()}>
    <Field label="Вся выручка точки за день" hint="Включая продажи сотрудников" required>{id => <MoneyInput id={id} value={total} onChange={setTotal} currency={currency} placeholder="0" />}</Field>
    {staffTotal > 0 && <p className="faint">Сотрудники уже внесли <Money minor={staffTotal} currency={currency} />. Эта сумма входит в общий итог, повторно не прибавляется.</p>}
    {total && Number(total) < staffTotal && <p role="alert">Сумма меньше внесённых смен. Сначала сотрудник должен проверить свою смену.</p>}
    <Field label="Комментарий" hint="Необязательно">{id => <Input id={id} value={comment} onChange={e => setComment(e.target.value)} />}</Field>
  </ConfirmDialog>;
}
