// Owner declares the whole day; employee payment breakdown stays in their shifts.
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dayLabel } from '../../platform/dates';
import { useSession } from '../../platform/session';
import { Button, ConfirmDialog, Field, Input, Money, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { revenueTotalSet, type DayRow } from './api';

const MAX_TOTAL_MINOR = 100_000_000_000; // revenue_total_set limit in the database

export function RevenueDialog({ location, locationName, currency, day, existing, onClose }: {
  location: string; locationName: string; currency: string; day: string; existing?: DayRow; onClose: () => void;
}) {
  const { me } = useSession();
  const qc = useQueryClient(); const toast = useToast();
  const initialTotal = existing ? String(existing.total_minor) : '';
  const initialComment = existing?.entries.find(e => !e.employee_id)?.comment ?? '';
  const [total, setTotal] = useState(initialTotal);
  const [totalValid, setTotalValid] = useState(true);
  const [comment, setComment] = useState(initialComment);
  const commentInput = useRef<HTMLInputElement>(null);
  const staffTotal = (existing?.entries ?? []).filter(e => e.employee_id).reduce((a,e) => a + Number(e.total_minor), 0);
  const exceedsLimit = Number(total) > MAX_TOTAL_MINOR;
  const belowStaffTotal = Number(total) < staffTotal;
  const canSave = total !== '' && totalValid && !exceedsLimit && !belowStaffTotal;
  const save = useMutation({
    mutationFn: () => revenueTotalSet(me!.user.id, location, day, total, existing?.day_version ?? 'empty', comment.trim() || null),
    onSuccess: r => {
      toast(r && typeof r === 'object' && 'queued' in r ? 'Сохранено на устройстве — отправится при появлении сети' : 'Выручка сохранена');
      void qc.invalidateQueries({ queryKey: ['revenue'] }); void qc.invalidateQueries({ queryKey: ['finance'] });
      void qc.invalidateQueries({ queryKey: ['royalty'] }); void qc.invalidateQueries({ queryKey: ['rating'] }); onClose();
    },
  });
  const submit = () => { if (canSave && !save.isPending) save.mutate(); };
  return <ConfirmDialog open title={`Выручка за ${dayLabel(day)}`} confirmLabel="Сохранить" busy={save.isPending} error={save.error}
    dirty={!totalValid || total !== initialTotal || comment !== initialComment} disabled={!canSave} onClose={onClose} onConfirm={submit}>
    <p className="muted">{locationName}</p>
    <Field label="Вся выручка точки за день" hint="Включая продажи сотрудников" error={!totalValid ? 'Укажите сумму, например 12,50.' : undefined} required>{(id, describedBy) => (
      <MoneyInput id={id} describedBy={describedBy} value={total} onChange={setTotal} onValidityChange={setTotalValid} onEnter={() => commentInput.current?.focus()} enterKeyHint="next" requireExplicitValue currency={currency} placeholder="0" invalid={exceedsLimit || belowStaffTotal} />
    )}</Field>
    {staffTotal > 0 && <div className="stack">
      <p className="faint">По сменам внесено <Money minor={staffTotal} currency={currency} />. Эта сумма входит в итог дня.</p>
      {(total === '' || (totalValid && belowStaffTotal)) && <Button size="sm" onClick={() => { setTotal(String(staffTotal)); setTotalValid(true); }}>Подставить итог смен</Button>}
    </div>}
    {totalValid && exceedsLimit && <p role="alert">Укажите сумму до <Money minor={MAX_TOTAL_MINOR} currency={currency} short /> включительно.</p>}
    {totalValid && total && belowStaffTotal && <p role="alert">Итог дня должен включать всю выручку по сменам.</p>}
    <Field label="Комментарий" hint="Необязательно">{(id, describedBy) => <Input id={id} ref={commentInput} aria-describedby={describedBy} value={comment} onChange={e => setComment(e.target.value)} />}</Field>
  </ConfirmDialog>;
}
