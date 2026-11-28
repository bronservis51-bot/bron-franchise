import { useId, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Plus } from 'lucide-react';
import { command, toAppError } from '../../platform/backend';
import { monthLabel } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import type { MinorInput } from '../../platform/money';
import { useSession } from '../../platform/session';
import { Button, Card, Checkbox, ConfirmDialog, DataState, Field, Input, Money, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { saveFinancialOperation } from './financeOperations';

export interface Expense { id: string; month: string; location_id: string | null; location_name: string | null; category: string;
  amount_minor: number; note: string | null; recurring?: boolean; repeat_series_id?: string }

const expenseCategories = [
  ['Аренда', 'Kira'], ['Интернет и связь', 'İnternet ve iletişim'], ['Плёнки и материалы', 'Film ve malzeme'],
  ['Реклама', 'Reklam'], ['Коммунальные', 'Faturalar'], ['Налоги', 'Vergiler'],
  ['Банк и эквайринг', 'Banka ve POS'], ['Ремонт и оборудование', 'Onarım ve ekipman'],
] as const;

function canonicalCategory(value: string) {
  const name = value.trim();
  const russian = name.toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const turkish = name.toLocaleLowerCase('tr');
  return expenseCategories.find(([ru, tr]) =>
    russian === ru.toLocaleLowerCase('ru').replaceAll('ё', 'е') || turkish === tr.toLocaleLowerCase('tr'),
  )?.[0] ?? name;
}

interface Draft {
  id: string | null; category: string; amount: string; location: string | null; note: string; recurring: boolean;
  repeatSeriesId?: string; manualTransfer?: boolean;
}
interface ExpensePoint { id: string; name: string; status: string }

const save = (userId: string | undefined, month: string, d: Draft, manualTransferAvailable = false) =>
  saveFinancialOperation<string>(userId,
    manualTransferAvailable && !d.recurring ? 'expense_save_with_recurring' : 'expense_save_repeating', {
    p_id: d.id, p_month: month, p_location: d.location, p_category: d.category.trim(),
    p_amount: d.amount, p_note: d.note.trim() || null, p_recurring: d.recurring || Boolean(d.manualTransfer),
  });

function ExpenseDialog({ month, currency, locations, categories, draft, onClose }: {
  month: string; currency: string; locations: ExpensePoint[]; categories: string[]; draft: Draft; onClose: () => void;
}) {
  const { t } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const userId = useSession().me?.user.id;
  const [d, setD] = useState(draft);
  const [amountValid, setAmountValid] = useState(true);
  const categoryListId = useId();
  const locationInput = useRef<HTMLSelectElement>(null);
  const noteInput = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['finance'] });
  const m = useMutation({
    mutationFn: () => {
      const category = d.id && d.category === draft.category ? d.category : canonicalCategory(d.category);
      return save(userId, month, { ...d, category }, draft.manualTransfer);
    },
    onSuccess: () => {
      toast(d.id ? t('Расход изменён', 'Gider güncellendi') : t('Расход добавлен', 'Gider eklendi'));
      refresh(); onClose();
    },
  });
  const del = useMutation({
    mutationFn: () => command('expense_delete', { id: d.id }),
    onSuccess: () => {
      const back = { ...draft, id: null };
      toast(t('Расход удалён', 'Gider silindi'), 'success', draft.repeatSeriesId ? undefined : {
        label: t('Отменить', 'Geri al'),
        onClick: () => void save(userId, month, back, draft.manualTransfer)
          .then(refresh, () => toast(t('Не удалось вернуть', 'Gider geri alınamadı'), 'danger')),
      });
      refresh(); onClose();
    },
  });
  const canSave = Boolean(d.category.trim() && amountValid && d.amount && d.amount !== '0');
  const submit = () => { if (canSave && !m.isPending && !del.isPending) m.mutate(); };
  const dirty = !amountValid || d.category !== draft.category || d.amount !== draft.amount || d.location !== draft.location ||
    d.note !== draft.note || d.recurring !== draft.recurring || Boolean(d.manualTransfer) !== Boolean(draft.manualTransfer);
  return (
    <ConfirmDialog open title={d.id ? t('Изменить расход', 'Gideri düzenle') : t('Добавить расход', 'Gider ekle')}
      confirmLabel={d.id ? t('Сохранить', 'Kaydet') : t('Добавить расход', 'Gider ekle')} cancelLabel={t('Закрыть', 'Kapat')}
      busy={m.isPending || del.isPending} error={m.error ?? del.error} disabled={!canSave} dirty={dirty} onClose={onClose} onConfirm={submit}>
      <fieldset className="stack" disabled={m.isPending || del.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Field label={t('Категория', 'Kategori')} required>{id => <>
          <div className="chips" role="group" aria-label={t('Основные категории', 'Ana kategoriler')}>
            {expenseCategories.map(([ru, tr]) => <button key={ru} type="button" className="chip"
              aria-pressed={canonicalCategory(d.category) === ru} onClick={() => set({ category: t(ru, tr) })}>{t(ru, tr)}</button>)}
          </div>
          <Input id={id} list={categoryListId} value={d.category} onChange={e => set({ category: e.target.value })}
            placeholder={t('Например, аренда', 'Örneğin kira')} maxLength={60} />
          <datalist id={categoryListId}>{categories.map(category => <option key={category} value={category} />)}</datalist>
        </>}</Field>
        <Field label={t('Сумма за месяц, ', 'Aylık tutar, ') + currency}
          error={!amountValid ? t('Укажите сумму, например 12,50.', 'Örneğin 12,50 gibi bir tutar girin.') : undefined} required>{(id, describedBy) => (
          <MoneyInput id={id} describedBy={describedBy} value={d.amount} onChange={(v) => set({ amount: v })} onValidityChange={setAmountValid} onEnter={() => (locationInput.current ?? noteInput.current)?.focus()} enterKeyHint="next" currency={currency} />
        )}</Field>
        {locations.length > 0 && (
          <Field label={t('Точка', 'Satış noktası')}
            hint={t('Общий расход учитывается только в «Все точки»', 'Ortak gider yalnızca “Tüm noktalar” görünümüne eklenir')}>{(id, describedBy) => (
            <Select id={id} ref={locationInput} aria-describedby={describedBy} value={d.location ?? ''} onChange={(e) => set({ location: e.target.value || null })}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              <option value="">{t('Общий — на все точки', 'Tüm noktalar için ortak')}</option>
            </Select>
          )}</Field>
        )}
        <Field label={t('Комментарий', 'Açıklama')}>{(id) => <Input id={id} ref={noteInput} value={d.note}
          onChange={e => set({ note: e.target.value })} placeholder={t('Необязательно', 'İsteğe bağlı')} maxLength={500} />}</Field>
        <Checkbox label={t('Повторяющийся расход', 'Yinelenen gider')} checked={d.recurring}
          onChange={(recurring) => set(recurring ? { recurring, manualTransfer: false } : { recurring })}
          hint={t('Расход будет автоматически повторяться каждый месяц.', 'Gider her ay otomatik olarak tekrarlanır.')} />
        {draft.manualTransfer && <Checkbox label={t('Переносить вручную', 'Elle aktar')} checked={Boolean(d.manualTransfer)}
          onChange={(manualTransfer) => set(manualTransfer ? { manualTransfer, recurring: false } : { manualTransfer })} />}
      </fieldset>
      {d.id && <Button variant="ghost" size="sm" loading={del.isPending} disabled={m.isPending} onClick={() => del.mutate()}>
        {draft.recurring ? t('Удалить расход и будущие повторы', 'Gideri ve gelecek tekrarları sil') : t('Удалить расход', 'Gideri sil')}
      </Button>}
    </ConfirmDialog>
  );
}

interface RepeatCandidate { id: string; category: string; location_name: string | null; amount_minor: string; updated_at: string }
interface RepeatEdit { amount: string; selected: boolean; valid: boolean }

function RepeatExpensesDialog({ month, currency, onClose }: { month: string; currency: string; onClose: () => void }) {
  const { t, locale } = useLocale();
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
      toast(t('Перенесено расходов: ', 'Aktarılan gider sayısı: ') + count);
      void qc.invalidateQueries({ queryKey: ['finance'] });
      onClose();
    },
    onError: (error) => { if (toAppError(error).code === 'version-conflict') return q.refetch(); },
  });
  return (
    <ConfirmDialog open title={t('Регулярные расходы · ', 'Düzenli giderler · ') + monthLabel(month, false, locale)}
      confirmLabel={t('Перенести расходы', 'Giderleri aktar')} cancelLabel={t('Закрыть', 'Kapat')}
      busy={transfer.isPending} disabled={!canSave} dirty={Object.keys(edits).length > 0} error={transfer.error}
      onClose={onClose} onConfirm={() => { if (canSave && !transfer.isPending) transfer.mutate(); }}>
      <p>{t('Проверьте суммы перед переносом.', 'Aktarmadan önce tutarları kontrol edin.')}</p>
      <DataState query={q} empty={data => data.length ? null : <p>{t('Нет регулярных расходов для переноса.', 'Aktarılacak düzenli gider yok.')}</p>}>
        {() => <fieldset className="stack" disabled={transfer.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {rows.map(row => {
            const label = `${row.category} · ${row.location_name ?? t('Все точки', 'Tüm noktalar')}`;
            return <div key={row.id} className="stack access-row">
              <Checkbox label={label} checked={row.edit.selected}
                onChange={(selected) => edit(row.id, row.amount_minor, { selected })} />
              {row.edit.selected && <Field label={t('Сумма, ', 'Tutar, ') + currency + ' · ' + row.category} required
                error={!row.edit.valid || row.edit.amount === '0' ? t('Укажите сумму больше нуля.', 'Sıfırdan büyük bir tutar girin.') : undefined}>
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

export function ExpensesCard({ month, currency, location, locations, expenses, own, prevCount, royaltyMinor, royaltyHistory, readOnly = false }: {
  month: string; currency: string; location: string | null; locations: ExpensePoint[];
  expenses: Expense[]; own: string[]; prevCount: number;
  royaltyMinor?: MinorInput; royaltyHistory?: ReactNode; readOnly?: boolean;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRepeat, setShowRepeat] = useState(false);
  const active = locations.filter(point => point.status === 'active');
  const categories = [...new Set([...expenseCategories.map(([ru, tr]) => t(ru, tr)), ...own.slice(0, 6)])];
  const open = () => setDraft({ id: null, category: '', amount: '', location: location ?? active[0]?.id ?? null,
    note: '', recurring: false });
  const edit = (e: Expense) => setDraft({ id: e.id, category: e.category, amount: String(e.amount_minor), location: e.location_id,
    note: e.note ?? '', recurring: Boolean(e.recurring && e.repeat_series_id), repeatSeriesId: e.repeat_series_id,
    manualTransfer: Boolean(e.recurring && !e.repeat_series_id) });
  const dialogLocations = locations.filter(point => point.status === 'active' || point.id === draft?.location);

  return <Card title={t('Расходы', 'Giderler')} actions={!readOnly && <>
    <Button size="sm" variant="primary" onClick={open}><Plus size={16} aria-hidden />{t('Добавить расход', 'Gider ekle')}</Button>
    {location === null && prevCount > 0 && <Button size="sm" onClick={() => setShowRepeat(true)}>
      <Copy size={16} aria-hidden />{t('Перенести регулярные расходы', 'Düzenli giderleri aktar')}
    </Button>}
  </>}>
    {!expenses.length && <p className="faint">{t('Операционные расходы не внесены.', 'İşletme gideri kaydedilmedi.')}</p>}
    <ul className="expense-list">{expenses.map(e => {
      const info = [
        location === null && (e.location_name ?? t('все точки', 'tüm noktalar')),
        e.recurring && (e.repeat_series_id ? t('повторяющийся', 'yinelenen') : t('регулярный', 'düzenli')),
        e.note,
      ].filter(Boolean).join(' · ');
      const body = <><span className="expense-main"><strong>{e.category}</strong>
        {info && <span className="faint">{info}</span>}</span><Money minor={e.amount_minor} currency={currency} short strong /></>;
      return <li key={e.id}>{readOnly ? <div className="expense-row">{body}</div> :
        <button type="button" className="expense-row" onClick={() => edit(e)}>
          {body}<Pencil size={15} className="faint" aria-hidden />
        </button>}</li>;
    })}{royaltyMinor !== undefined && <li><div className="expense-row finance-royalty-row">
      <span className="expense-main">{t('Роялти по ставке', 'Orana göre royalty')}</span>
      <Money minor={royaltyMinor} currency={currency} short />
    </div></li>}</ul>
    {royaltyHistory}
    {!readOnly && draft && <ExpenseDialog month={month} currency={currency} locations={dialogLocations}
      categories={categories} draft={draft} onClose={() => setDraft(null)} />}
    {!readOnly && showRepeat && <RepeatExpensesDialog month={month} currency={currency} onClose={() => setShowRepeat(false)} />}
  </Card>;
}
