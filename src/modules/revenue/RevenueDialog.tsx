// Ввод итога дня: наличные + карта, итог считается сам. Тот же диалог исправляет и удаляет запись.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dayLabel } from '../../platform/dates';
import { sumMinor } from '../../platform/money';
import { Button, ConfirmDialog, Field, Input, Money, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { revenueDelete, revenueSave, type DayRow } from './api';

export function RevenueDialog({ location, currency, day, existing, onClose }: {
  location: string; currency: string; day: string; existing?: DayRow; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cash, setCash] = useState(existing ? String(existing.cash_minor) : '');
  const [card, setCard] = useState(existing ? String(existing.card_minor) : '');
  const [comment, setComment] = useState(existing?.comment ?? '');
  const done = (msg: string) => {
    toast(msg);
    void qc.invalidateQueries({ queryKey: ['revenue'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => revenueSave(location, day, cash || '0', card || '0', comment.trim() || null),
    onSuccess: () => done(existing ? 'Выручка исправлена' : 'Выручка внесена'),
  });
  const del = useMutation({ mutationFn: () => revenueDelete(location, day), onSuccess: () => done('Запись удалена') });
  const total = sumMinor([cash || '0', card || '0']);
  const empty = total === 0n && !comment.trim();

  return (
    <ConfirmDialog open title={`Выручка — ${dayLabel(day)}`} confirmLabel="Сохранить" busy={save.isPending} error={save.error ?? del.error}
      disabled={empty} onClose={onClose} onConfirm={() => save.mutate()}>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Наличные">{(id) => <MoneyInput id={id} value={cash} onChange={setCash} currency={currency} placeholder="0" />}</Field>
        <Field label="Картой">{(id) => <MoneyInput id={id} value={card} onChange={setCard} currency={currency} placeholder="0" onEnter={() => !empty && save.mutate()} />}</Field>
      </div>
      <div className="day-total-line"><span>Итого за день</span><Money minor={total} currency={currency} strong /></div>
      <Field label="Комментарий" hint="Например: точка не работала, причина">{(id) => <Input id={id} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      {existing && (
        <Button variant="ghost" size="sm" loading={del.isPending} onClick={() => del.mutate()}>Удалить запись за этот день</Button>
      )}
    </ConfirmDialog>
  );
}
