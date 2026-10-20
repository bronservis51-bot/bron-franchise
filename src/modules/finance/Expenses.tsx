// Расходы франчайзи за месяц: быстрые кнопки категорий, своя категория, расход по точке или общий, повтор прошлого месяца.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Plus } from 'lucide-react';
import { command } from '../../platform/backend';
import { monthLabel } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { ActionError, Button, Card, ConfirmDialog, Field, Input, Money, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';

export interface Expense { id: string; month: string; location_id: string | null; location_name: string | null; category: string; amount_minor: number; note: string | null }

/** Частые статьи расходов точки — кнопки для быстрого добавления. */
export const EXPENSE_CATEGORIES = ['Аренда', 'Интернет и связь', 'Плёнки и материалы', 'Реклама', 'Коммунальные', 'Налоги', 'Банк и эквайринг', 'Ремонт и оборудование'];

interface Draft { id: string | null; category: string; amount: string; location: string | null; note: string }

const save = (month: string, d: Draft) =>
  command<string>('expense_save', { id: d.id, month, location: d.location, category: d.category.trim(), amount: d.amount, note: d.note.trim() || null });

function ExpenseDialog({ month, currency, locations, draft, onClose }: {
  month: string; currency: string; locations: { id: string; name: string }[]; draft: Draft; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState(draft);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['finance'] });
  const m = useMutation({
    mutationFn: () => save(month, d),
    onSuccess: () => { toast(d.id ? 'Расход изменён' : `${d.category}: ${formatMoneyShort(d.amount, currency)} добавлено`); refresh(); onClose(); },
  });
  const del = useMutation({
    mutationFn: () => command('expense_delete', { id: d.id }),
    onSuccess: () => {
      const back = { ...draft, id: null };
      toast(`Расход «${draft.category}» удалён`, 'success', { label: 'Отменить', onClick: () => void save(month, back).then(refresh, () => toast('Не удалось вернуть', 'danger')) });
      refresh(); onClose();
    },
  });
  return (
    <ConfirmDialog open title={d.id ? 'Изменить расход' : `Расход за ${monthLabel(month, false)}`} confirmLabel={d.id ? 'Сохранить' : 'Добавить расход'} cancelLabel="Закрыть"
      busy={m.isPending} error={m.error ?? del.error} disabled={!d.category.trim() || !d.amount || d.amount === '0'} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Категория" required>{(id) => (
        <Input id={id} value={d.category} onChange={(e) => set({ category: e.target.value })} placeholder="Например: аренда склада" maxLength={60} autoFocus={!draft.category} />
      )}</Field>
      <Field label={`Сумма за месяц, ${currency}`} required>{(id) => <MoneyInput id={id} value={d.amount} onChange={(v) => set({ amount: v })} currency={currency} />}</Field>
      {locations.length > 1 && (
        <Field label="Точка" hint="Общий расход учитывается только в «Все точки»">{(id) => (
          <Select id={id} value={d.location ?? ''} onChange={(e) => set({ location: e.target.value || null })}>
            <option value="">Общий — на все точки</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}</Field>
      )}
      <Field label="Комментарий">{(id) => <Input id={id} value={d.note} onChange={(e) => set({ note: e.target.value })} placeholder="Необязательно" maxLength={500} />}</Field>
      {d.id && <Button variant="ghost" size="sm" loading={del.isPending} onClick={() => del.mutate()}>Удалить расход</Button>}
    </ConfirmDialog>
  );
}

export function ExpensesCard({ month, currency, location, locations, expenses, own, prevCount, total, bare }: {
  month: string; currency: string; location: string | null; locations: { id: string; name: string }[];
  expenses: Expense[]; own: string[]; prevCount: number; total: number;
  /** Без своей карточки — внутри панели редактирования. */
  bare?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const extra = own.filter((c) => !EXPENSE_CATEGORIES.includes(c)).slice(0, 6);
  const open = (category: string) => setDraft({ id: null, category, amount: '', location: location ?? (locations.length === 1 ? locations[0].id : null), note: '' });
  const repeat = useMutation({
    mutationFn: () => command<number>('expense_repeat', { month }),
    onSuccess: (n) => { toast(n ? `Перенесено расходов: ${n}` : 'Все расходы прошлого месяца уже внесены'); void qc.invalidateQueries({ queryKey: ['finance'] }); },
  });
  const body = (
    <>
      <div className="chips expense-chips" role="group" aria-label="Добавить расход">
        {[...EXPENSE_CATEGORIES, ...extra].map((c) => (
          <button key={c} type="button" className="chip" onClick={() => open(c)}><Plus size={13} aria-hidden />{c}</button>
        ))}
        <button type="button" className="chip chip-outline" onClick={() => open('')}><Plus size={13} aria-hidden />Своя категория</button>
      </div>
      {prevCount > 0 && (
        <Button size="sm" variant="ghost" loading={repeat.isPending} onClick={() => repeat.mutate()}><Copy size={14} aria-hidden />Повторить расходы прошлого месяца</Button>
      )}
      <ActionError error={repeat.error} />
      {expenses.length ? (
        <ul className="expense-list">
          {expenses.map((e) => (
            <li key={e.id}>
              <button type="button" className="expense-row"
                onClick={() => setDraft({ id: e.id, category: e.category, amount: String(e.amount_minor), location: e.location_id, note: e.note ?? '' })}>
                <span className="expense-main"><strong>{e.category}</strong>
                  <span className="faint">{locations.length > 1 ? (e.location_name ?? 'все точки') : ''}{e.note ? `${locations.length > 1 ? ' · ' : ''}${e.note}` : ''}</span></span>
                <Money minor={e.amount_minor} currency={currency} short strong />
                <Pencil size={15} className="faint" aria-label="Изменить" />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="faint" style={{ marginTop: 8 }}>Нажмите на категорию, чтобы внести расход. Аренду и интернет удобно вносить раз в месяц — потом переносить кнопкой «Повторить».</p>}
      {expenses.length > 0 && <p className="faint" style={{ marginTop: 6 }}>Нажмите на расход, чтобы изменить сумму или удалить его.</p>}
      {draft && <ExpenseDialog month={month} currency={currency} locations={locations} draft={draft} onClose={() => setDraft(null)} />}
    </>
  );
  if (bare) return body;
  return (
    <Card title={`Расходы — ${monthLabel(month)}`} actions={expenses.length > 0 ? <strong className="num">{formatMoneyShort(total, currency)}</strong> : undefined}>
      {body}
    </Card>
  );
}
