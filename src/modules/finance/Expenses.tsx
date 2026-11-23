// Расходы франчайзи за месяц: быстрые кнопки категорий, своя категория, расход по точке или общий, повтор прошлого месяца.
import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Plus } from 'lucide-react';
import { command, toAppError } from '../../platform/backend';
import { monthLabel } from '../../platform/dates';
import { formatMoneyShort, toBigInt, type MinorInput } from '../../platform/money';
import { useSession } from '../../platform/session';
import { Button, Card, Checkbox, ConfirmDialog, DataState, Field, Input, Money, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { saveFinancialOperation } from './financeOperations';

export interface Expense { id: string; month: string; location_id: string | null; location_name: string | null; category: string;
  amount_minor: number; note: string | null; recurring?: boolean }

/** Частые статьи расходов точки — кнопки для быстрого добавления. */
export const EXPENSE_CATEGORIES = ['Аренда', 'Интернет и связь', 'Плёнки и материалы', 'Реклама', 'Коммунальные', 'Налоги', 'Банк и эквайринг', 'Ремонт и оборудование'];

interface Draft { id: string | null; category: string; amount: string; location: string | null; note: string; recurring: boolean }

const save = (userId: string | undefined, month: string, d: Draft) =>
  saveFinancialOperation<string>(userId, 'expense_save_with_recurring', {
    p_id: d.id, p_month: month, p_location: d.location, p_category: d.category.trim(),
    p_amount: d.amount, p_note: d.note.trim() || null, p_recurring: d.recurring,
  });

function ExpenseDialog({ month, currency, locations, draft, onClose }: {
  month: string; currency: string; locations: { id: string; name: string }[]; draft: Draft; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const userId = useSession().me?.user.id;
  const [d, setD] = useState(draft);
  const [amountValid, setAmountValid] = useState(true);
  const locationInput = useRef<HTMLSelectElement>(null);
  const noteInput = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['finance'] });
  const m = useMutation({
    mutationFn: () => save(userId, month, d),
    onSuccess: () => { toast(d.id ? 'Расход изменён' : `${d.category}: ${formatMoneyShort(d.amount, currency)} добавлено`); refresh(); onClose(); },
  });
  const del = useMutation({
    mutationFn: () => command('expense_delete', { id: d.id }),
    onSuccess: () => {
      const back = { ...draft, id: null };
      toast(`Расход «${draft.category}» удалён`, 'success', { label: 'Отменить', onClick: () => void save(userId, month, back).then(refresh, () => toast('Не удалось вернуть', 'danger')) });
      refresh(); onClose();
    },
  });
  const canSave = Boolean(d.category.trim() && amountValid && d.amount && d.amount !== '0');
  const submit = () => { if (canSave && !m.isPending && !del.isPending) m.mutate(); };
  const dirty = !amountValid || d.category !== draft.category || d.amount !== draft.amount || d.location !== draft.location ||
    d.note !== draft.note || d.recurring !== draft.recurring;
  return (
    <ConfirmDialog open title={d.id ? 'Изменить расход' : `Расход за ${monthLabel(month, false)}`} confirmLabel={d.id ? 'Сохранить' : 'Добавить расход'} cancelLabel="Закрыть"
      busy={m.isPending || del.isPending} error={m.error ?? del.error} disabled={!canSave} dirty={dirty} onClose={onClose} onConfirm={submit}>
      <fieldset className="stack" disabled={m.isPending || del.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Field label="Категория" required>{(id) => (
          <Input id={id} value={d.category} onChange={(e) => set({ category: e.target.value })} placeholder="Например: аренда склада" maxLength={60} autoFocus={!draft.category} />
        )}</Field>
        <Field label={`Сумма за месяц, ${currency}`} error={!amountValid ? 'Укажите сумму, например 12,50.' : undefined} required>{(id, describedBy) => (
          <MoneyInput id={id} describedBy={describedBy} value={d.amount} onChange={(v) => set({ amount: v })} onValidityChange={setAmountValid} onEnter={() => (locationInput.current ?? noteInput.current)?.focus()} enterKeyHint="next" currency={currency} />
        )}</Field>
        {locations.length > 0 && (
          <Field label="Точка" hint="Общий расход учитывается только в «Все точки»">{(id, describedBy) => (
            <Select id={id} ref={locationInput} aria-describedby={describedBy} value={d.location ?? ''} onChange={(e) => set({ location: e.target.value || null })}>
              <option value="">Общий — на все точки</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          )}</Field>
        )}
        <Field label="Комментарий">{(id) => <Input id={id} ref={noteInput} value={d.note} onChange={(e) => set({ note: e.target.value })} placeholder="Необязательно" maxLength={500} />}</Field>
        <Checkbox label="Регулярный расход" checked={d.recurring} onChange={(recurring) => set({ recurring })}
          hint="Предлагать для переноса в следующем месяце" />
      </fieldset>
      {d.id && <Button variant="ghost" size="sm" loading={del.isPending} disabled={m.isPending} onClick={() => del.mutate()}>Удалить расход</Button>}
    </ConfirmDialog>
  );
}

interface RepeatCandidate { id: string; category: string; location_name: string | null; amount_minor: string; updated_at: string }
interface RepeatEdit { amount: string; selected: boolean; valid: boolean }

function RepeatExpensesDialog({ month, currency, onClose }: { month: string; currency: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const userId = useSession().me?.user.id;
  const q = useQuery({
    queryKey: ['finance', 'recurring-preview', month],
    queryFn: () => command<RepeatCandidate[]>('expense_repeat_preview', { month }),
    staleTime: 0,
  });
  const [edits, setEdits] = useState<Record<string, RepeatEdit>>({});
  const rows = (q.data ?? []).map(row => ({ ...row,
    edit: edits[row.id] ?? { amount: row.amount_minor, selected: true, valid: true },
  }));
  const selected = rows.filter(row => row.edit.selected);
  const canSave = q.isSuccess && !q.isFetching && selected.length > 0 && selected.every(row =>
    row.edit.valid && Boolean(row.edit.amount) && row.edit.amount !== '0');
  const edit = (id: string, initialAmount: string, patch: Partial<RepeatEdit>) =>
    setEdits(current => ({ ...current, [id]: { ...(current[id] ?? { amount: initialAmount, selected: true, valid: true }), ...patch } }));
  const transfer = useMutation({
    mutationFn: () => saveFinancialOperation<number>(userId, 'expense_repeat_checked', {
      p_month: month, p_rows: selected.map(row => ({ id: row.id, amount: row.edit.amount, updated_at: row.updated_at })),
    }),
    onSuccess: (count) => {
      toast(`Перенесено расходов: ${count}`);
      void qc.invalidateQueries({ queryKey: ['finance'] });
      onClose();
    },
    onError: (error) => { if (toAppError(error).code === 'version-conflict') return q.refetch(); },
  });
  return (
    <ConfirmDialog open title={`Регулярные расходы за ${monthLabel(month, false)}`} confirmLabel="Перенести расходы" cancelLabel="Закрыть"
      busy={transfer.isPending} disabled={!canSave} dirty={Object.keys(edits).length > 0} error={transfer.error}
      onClose={onClose} onConfirm={() => { if (canSave && !transfer.isPending) transfer.mutate(); }}>
      <p>Проверьте суммы перед переносом. Разовые и уже учтённые расходы в списке не появляются.</p>
      <DataState query={q} empty={data => data.length ? null : <p>Нет регулярных расходов для переноса.</p>}>
        {() => <fieldset className="stack" disabled={transfer.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {rows.map(row => {
            const label = `${row.category} · ${row.location_name ?? 'Все точки'}`;
            return <div key={row.id} className="stack access-row">
              <Checkbox label={label} checked={row.edit.selected}
                onChange={(selected) => edit(row.id, row.amount_minor, { selected })} />
              {row.edit.selected && <Field label={`Сумма, ${currency} · ${row.category}`} required
                error={!row.edit.valid || row.edit.amount === '0' ? 'Укажите сумму больше нуля.' : undefined}>
                {(id, describedBy) => <MoneyInput id={id} describedBy={describedBy} value={row.edit.amount} currency={currency}
                  onChange={(amount) => edit(row.id, row.amount_minor, { amount })}
                  onValidityChange={(valid) => edit(row.id, row.amount_minor, { valid })} requireExplicitValue />}
              </Field>}
            </div>;
          })}
        </fieldset>}
      </DataState>
    </ConfirmDialog>
  );
}

export function ExpensesCard({ month, currency, location, locations, expenses, own, prevCount, total, royalty, royaltyHistory, bare, readOnly = false }: {
  month: string; currency: string; location: string | null; locations: { id: string; name: string }[];
  expenses: Expense[]; own: string[]; prevCount: number; total: MinorInput; royalty: MinorInput;
  royaltyHistory?: ReactNode;
  /** Без своей карточки — внутри панели редактирования. */
  bare?: boolean;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRepeat, setShowRepeat] = useState(false);
  const hasRoyalty = toBigInt(royalty) !== 0n;
  const extra = own.filter((c) => !EXPENSE_CATEGORIES.includes(c)).slice(0, 6);
  const showExpenseScope = locations.length > 1 || (location === null && locations.length > 0);
  const open = (category: string) => setDraft({ id: null, category, amount: '', location: location ?? (locations.length === 1 ? locations[0].id : null), note: '', recurring: false });
  const body = (
    <>
      {!readOnly && <div className="chips expense-chips" role="group" aria-label="Добавить расход">
        {[...EXPENSE_CATEGORIES, ...extra].map((c) => (
          <button key={c} type="button" className="chip" onClick={() => open(c)}><Plus size={13} aria-hidden />{c}</button>
        ))}
        <button type="button" className="chip chip-outline" onClick={() => open('')}><Plus size={13} aria-hidden />Своя категория</button>
      </div>}
      {!readOnly && location === null && prevCount > 0 &&
        <Button size="sm" variant="ghost" onClick={() => setShowRepeat(true)}><Copy size={14} aria-hidden />Перенести регулярные расходы</Button>}
      {(expenses.length > 0 || hasRoyalty) && (
        <ul className="expense-list">
          {expenses.map((e) => (
            <li key={e.id}>
              <button type="button" className="expense-row" disabled={readOnly}
                onClick={() => setDraft({ id: e.id, category: e.category, amount: String(e.amount_minor), location: e.location_id, note: e.note ?? '', recurring: !!e.recurring })}>
                <span className="expense-main"><strong>{e.category}</strong>
                  <span className="faint">{[showExpenseScope && (e.location_name ?? 'все точки'), e.recurring && 'регулярный', e.note].filter(Boolean).join(' · ')}</span></span>
                <Money minor={e.amount_minor} currency={currency} short strong />
                {!readOnly && <Pencil size={15} className="faint" aria-label="Изменить" />}
              </button>
            </li>
          ))}
          {hasRoyalty && <li><div className="expense-row expense-royalty">
            <span className="expense-main">Роялти по ставке</span>
            <Money minor={royalty} currency={currency} short strong />
          </div></li>}
        </ul>
      )}
      {!readOnly && expenses.length === 0 && <p className="faint" style={{ marginTop: 8 }}>Нажмите на категорию, чтобы внести расход.</p>}
      {!readOnly && expenses.length > 0 && <p className="faint" style={{ marginTop: 6 }}>Нажмите на расход, чтобы изменить сумму или удалить его.</p>}
      {royaltyHistory}
      {!readOnly && draft && <ExpenseDialog month={month} currency={currency} locations={locations} draft={draft} onClose={() => setDraft(null)} />}
      {!readOnly && showRepeat && <RepeatExpensesDialog month={month} currency={currency} onClose={() => setShowRepeat(false)} />}
    </>
  );
  if (bare) return body;
  return (
    <Card title={`Расходы — ${monthLabel(month)}`} actions={expenses.length > 0 || hasRoyalty ? <Money minor={total} currency={currency} short strong /> : undefined}>
      {body}
    </Card>
  );
}
