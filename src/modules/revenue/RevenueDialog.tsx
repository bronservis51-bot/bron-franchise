// Выручка дня: наличные + карта, итог считается сам. Если в точке работают сотрудники — выбираете, чья это смена
// (исправление смены пересчитывает заработок сотрудника), или «Я сам» — запись франчайзи.
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dayLabel } from '../../platform/dates';
import { sumMinor } from '../../platform/money';
import { useSession } from '../../platform/session';
import { Button, ConfirmDialog, Field, Input, Money, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { revenueDelete, revenueSave, type DayRow } from './api';

export function RevenueDialog({ location, currency, day, existing, staff = [], onClose }: {
  location: string; currency: string; day: string; existing?: DayRow; staff?: { user_id: string; full_name: string }[]; onClose: () => void;
}) {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const entries = existing?.entries ?? [];
  // Кто: сотрудники из записей дня и из списка точки
  const people = [...new Map([...entries.filter((e) => e.employee_id).map((e) => [e.employee_id!, e.employee_name ?? 'Сотрудник'] as const),
    ...staff.map((s) => [s.user_id, s.full_name] as const)]).entries()];
  const [who, setWho] = useState<string>(entries.length === 1 && entries[0].employee_id ? entries[0].employee_id : '');
  const entry = entries.find((e) => (e.employee_id ?? '') === who);
  const [cash, setCash] = useState(entry ? String(entry.cash_minor) : '');
  const [card, setCard] = useState(entry ? String(entry.card_minor) : '');
  const [comment, setComment] = useState(entry?.comment ?? '');
  useEffect(() => {
    setCash(entry ? String(entry.cash_minor) : '');
    setCard(entry ? String(entry.card_minor) : '');
    setComment(entry?.comment ?? '');
  }, [who]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (msg: string) => {
    toast(msg);
    void qc.invalidateQueries({ queryKey: ['revenue'] });
    void qc.invalidateQueries({ queryKey: ['staff-list'] });
    void qc.invalidateQueries({ queryKey: ['finance'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () => revenueSave(me!.user.id, location, day, cash || '0', card || '0', comment.trim() || null, who || null, entry?.revision ?? -1),
    onSuccess: (r) => done(r && typeof r === 'object' && 'queued' in r ? 'Нет сети: сохранено на устройстве, отправится само' : entry ? 'Выручка исправлена' : 'Выручка внесена'),
  });
  const del = useMutation({ mutationFn: () => revenueDelete(location, day, who || null), onSuccess: () => done('Запись удалена') });
  const total = sumMinor([cash || '0', card || '0']);
  const empty = !cash && !card && !comment.trim();
  const others = entries.filter((e) => (e.employee_id ?? '') !== who);

  return (
    <ConfirmDialog open title={`Выручка — ${dayLabel(day)}`} confirmLabel="Сохранить" busy={save.isPending} error={save.error ?? del.error}
      disabled={empty} onClose={onClose} onConfirm={() => save.mutate()}>
      {people.length > 0 && (
        <Field label="Чья смена" hint={who ? 'Исправление пересчитает заработок сотрудника за эту смену' : undefined}>{(id) => (
          <Select id={id} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Я сам (франчайзи)</option>
            {people.map(([uid, name]) => <option key={uid} value={uid}>{name}</option>)}
          </Select>
        )}</Field>
      )}
      {entry?.comment && (/Google-таблиц/i.test(entry.comment) || /Google Sheets/i.test(entry.comment)) && (
        <p className="faint">Историческая выручка перенесена одной суммой. Разбивка на наличные и оплату картой неизвестна: в базе временно вся сумма записана в поле «Наличные». При исправлении укажите реальные суммы по каждому способу оплаты.</p>
      )}
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Наличные">{(id) => <MoneyInput id={id} value={cash} onChange={setCash} currency={currency} placeholder="0" />}</Field>
        <Field label="Картой">{(id) => <MoneyInput id={id} value={card} onChange={setCard} currency={currency} placeholder="0" onEnter={() => !empty && save.mutate()} />}</Field>
      </div>
      <div className="day-total-line"><span>{people.length ? 'Итого по этой записи' : 'Итого за день'}</span><Money minor={total} currency={currency} strong /></div>
      {others.length > 0 && !who && <p className="alert tone-info">Выручка сотрудников уже входит в итог дня. Здесь укажите только ваши собственные продажи, чтобы не посчитать их дважды.</p>}
      {others.length > 0 && (
        <p className="faint">Ещё за день: {others.map((e) => `${e.employee_name ?? 'вы'} — `).map((s, i) => <span key={i}>{s}<Money minor={others[i].total_minor} currency={currency} short />{i < others.length - 1 ? '; ' : ''}</span>)}</p>
      )}
      <Field label="Комментарий" hint="Например: точка не работала, причина">{(id) => <Input id={id} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      {entry && (
        <Button variant="ghost" size="sm" loading={del.isPending} onClick={() => del.mutate()}>Удалить эту запись</Button>
      )}
    </ConfirmDialog>
  );
}
