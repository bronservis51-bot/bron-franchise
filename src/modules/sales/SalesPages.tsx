// Ежедневная выручка: «Моя смена» — сотрудник вносит выручку и видит свой процент; «Отчёт точки» — владелец или управляющий
// видит месяц по дням и сотрудникам, дозаполняет пропуски, чтобы месячный отчёт ушёл полностью заполненным.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Check, CalendarDays, ChevronLeft, ChevronRight, Coins, PencilLine, Percent, Wallet } from 'lucide-react';
import { useSession } from '../../platform/session';
import { addDays, formatPeriod } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort, toBigInt } from '../../platform/money';
import { ActionError, Alert, Badge, Button, Card, ConfirmDialog, DataState, EmptyState, Field, Input, LinkButton, Money, MoneyInput, PageHeader, Select, Tabs, Textarea } from '../../ui';
import { useToast } from '../../ui/toast';
import { useLocationsWith } from '../shared/lookups';
import { earnings, myEarnings, pct, salesCommands, salesMonth, type MyEarnings, type SaleEntry, type SalesEmployee, type SalesMonth } from './api';
import { ShiftPanel } from './ShiftPanel';
import { LocationNotes } from '../shared/LocationNotes';

const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;
function shiftMonth(month: string, n: number) {
  const d = new Date(`${month}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return d.toISOString().slice(0, 10);
}
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** Подсказка об опечатке: сумма в 5+ раз больше средней смены (сервер сумму не ограничивает — бывает и крупная выручка). */
function unusual(revenue: string, history: { revenue_minor: number }[]) {
  if (!history.length) return false;
  const avg = history.reduce((a, x) => a + Number(x.revenue_minor), 0) / history.length;
  return avg > 0 && Number(revenue) > avg * 5;
}
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' });

function MonthNav({ month, onChange, max }: { month: string; onChange: (m: string) => void; max: string }) {
  const { t } = useT();
  return (
    <div className="row" role="group" aria-label={t('Месяц')}>
      <button type="button" className="icon-btn" aria-label={t('Предыдущий месяц')} onClick={() => onChange(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
      <strong style={{ minWidth: 130, textAlign: 'center' }}>{(() => { const p = formatPeriod(month, intlLocale()); return p.charAt(0).toUpperCase() + p.slice(1); })()}</strong>
      <button type="button" className="icon-btn" aria-label={t('Следующий месяц')} disabled={month >= max} onClick={() => onChange(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
    </div>
  );
}

function MoneyCard({ label, value, sub, dark, icon }: { label: string; value: ReactNode; sub?: ReactNode; dark?: boolean; icon?: ReactNode }) {
  const { t } = useT();
  return (
    <div className={`money-card${dark ? ' dark' : ''}`}>
      <div className="row between"><span className="l">{t(label)}</span>{icon && <span className={`icon-tile${dark ? '' : ' dark'}`} style={{ width: 32, height: 32 }}>{icon}</span>}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Моя смена */

function ShiftForm({ data, onSaved }: { data: MyEarnings; onSaved: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [loc, setLoc] = useState(data.locations[0]?.id ?? '');
  const l = data.locations.find((x) => x.id === loc) ?? data.locations[0];
  const today = l?.today ?? localToday();
  const [day, setDay] = useState(today);
  const existing = data.days.find((d) => d.location_id === l?.id && d.day === day);
  const [revenue, setRevenue] = useState('0');
  const [returns, setReturns] = useState('0');
  const [card, setCard] = useState('0');
  const [services, setServices] = useState('');
  const [comment, setComment] = useState('');
  const formKey = `${l?.id}:${day}:${existing?.revision ?? 0}`;
  useEffect(() => {
    setRevenue(String(existing?.revenue_minor ?? 0));
    setCard(String(existing?.card_minor ?? 0));
    setReturns(String(existing?.returns_minor ?? 0));
    setServices(existing ? String(existing.services_count) : '');
    setComment(existing?.comment ?? '');
  }, [formKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => salesCommands.save({ location: l!.id, day, employee: null, revenue, returns, services: Number(services || 0), comment: comment || null,
      expected_revision: existing?.revision ?? null, card: card === '0' ? null : card }),
    onSuccess: () => { toast(existing ? 'Смена обновлена' : 'Выручка за смену сохранена'); onSaved(); },
  });
  if (!l) return null;
  const net = toBigInt(revenue) - toBigInt(returns);
  const earn = net > 0n ? earnings(net, l.rate_bp) : 0n;
  const days = l.can_manage ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2];
  return (
    <details className="card manual-entry">
      <summary className="card-body"><span className="icon-tile dark" style={{ width: 32, height: 32 }}><PencilLine size={16} /></span>
        <span><strong>{t('Внести или исправить выручку за другой день')}</strong><br /><span className="faint">{t('Если забыли закрыть смену или нужно исправить сумму')}</span></span></summary>
      <div className="card-body">
      <div className="grid grid-2">
        {data.locations.length > 1 && (
          <Field label="Точка">{(id) => <Select id={id} value={l.id} onChange={(e) => setLoc(e.target.value)}>{data.locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        )}
        <Field label="День" hint={l.can_manage ? undefined : 'Сотрудник вносит выручку за последние 3 дня'}>
          {(id) => <Select id={id} value={day} onChange={(e) => setDay(e.target.value)}>
            {days.map((n) => { const d = addDays(today, -n); return <option key={d} value={d}>{n === 0 ? t('Сегодня') : n === 1 ? t('Вчера') : dayLabel(d)}{n < 2 ? ` · ${dayLabel(d)}` : ''}</option>; })}
          </Select>}
        </Field>
        <Field label={`Выручка, ${l.currency}`} required>{(id) => <MoneyInput key={`r${formKey}`} id={id} value={revenue} currency={l.currency} onChange={setRevenue} />}</Field>
        <Field label={`Из неё по карте, ${l.currency}`} hint="По отчёту терминала">{(id) => <MoneyInput key={`c${formKey}`} id={id} value={card} currency={l.currency} onChange={setCard} invalid={toBigInt(card) > toBigInt(revenue)} />}</Field>
        <Field label={`Возвраты, ${l.currency}`} hint="Если были">{(id) => <MoneyInput key={`b${formKey}`} id={id} value={returns} currency={l.currency} onChange={setReturns} invalid={net < 0n} />}</Field>
        <Field label="Услуг за смену" hint="Сколько оклеек и работ">{(id) => <Input id={id} inputMode="numeric" value={services} onChange={(e) => setServices(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label="Комментарий">{(id) => <Textarea id={id} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      </div>
      <div className="earn-preview">
        <span className="icon-tile" style={{ width: 36, height: 36 }}><Percent size={18} /></span>
        <div style={{ flex: 1 }}>
          <div className="faint">{t('Ваш процент')} {pct(l.rate_bp)} {t('от выручки за вычетом возвратов')}</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{t('За эту смену')}: {formatMoneyShort(earn, l.currency, intlLocale())}</div>
        </div>
        <Button variant="primary" loading={save.isPending} disabled={toBigInt(revenue) <= 0n || net < 0n || toBigInt(card) > toBigInt(revenue)} onClick={() => save.mutate()}>{existing ? t('Сохранить изменения') : t('Сохранить смену')}</Button>
      </div>
      {unusual(revenue, data.days.filter((x) => x.location_id === l.id && x.day !== day)) && (
        <div style={{ marginTop: 10 }}><Alert tone="warning" title="Проверьте сумму">{t('Она намного больше вашей обычной смены. Если всё верно — сохраняйте.')}</Alert></div>
      )}
      {existing?.source === 'manager' && <div className="faint" style={{ marginTop: 8 }}>{t('Эту смену внёс управляющий или франчайзи.')}</div>}
      {existing?.reduced_by_manager && <div className="faint" style={{ marginTop: 8 }}>{t('Сумму этой смены уменьшил франчайзи или управляющий — причина в комментарии.')}</div>}
      <ActionError error={save.error} />
      </div>
    </details>
  );
}

function MyShiftTab() {
  const { t } = useT();
  const qc = useQueryClient();
  const max = monthOf(localToday());
  const [month, setMonth] = useState(max);
  const q = useQuery({ queryKey: ['sales', 'my', month], queryFn: () => myEarnings(month) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['sales'] }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  return (
    <DataState query={q}>
      {(d) => {
        const tot = d.totals[0];
        const cur = tot?.currency ?? d.locations[0]?.currency ?? 'RUB';
        const rate = d.locations[0]?.rate_bp ?? d.days[0]?.rate_bp ?? 0;
        return (
          <div className="stack">
            {!d.locations.length && <Alert tone="info">{t('Вы сейчас не закреплены за точкой — внести выручку нельзя. История за прошлые месяцы ниже.')}</Alert>}
            {month === max && (d.locations.length > 0 || d.open_shift) && <ShiftPanel data={d} onChanged={refresh} />}
            {month === max && d.locations.length > 0 && <ShiftForm data={d} onSaved={refresh} />}
            <div className="row between">
              <h2 style={{ margin: 0, fontSize: 18 }}>{t('Мой заработок')}</h2>
              <MonthNav month={month} onChange={setMonth} max={max} />
            </div>
            <div className="money-hero">
              <MoneyCard dark label="Заработано за месяц" icon={<Wallet size={16} />} value={formatMoneyShort(tot?.earnings_minor ?? 0, cur, intlLocale())}
                sub={`${t('Предварительно')}: ${pct(rate)} ${t('от выручки')}`} />
              <MoneyCard label="Моя выручка" icon={<Coins size={16} />} value={formatMoneyShort(tot?.revenue_minor ?? 0, cur, intlLocale())}
                sub={tot && tot.revenue_minor !== tot.net_minor ? `${t('без возвратов')}: ${formatMoneyShort(tot.net_minor, cur, intlLocale())}` : undefined} />
              <MoneyCard label="Смен в месяце" icon={<CalendarDays size={16} />} value={tot?.shifts ?? 0}
                sub={tot?.shifts ? `${t('в среднем')} ${formatMoneyShort(BigInt(Math.round(Number(tot.revenue_minor) / tot.shifts)), cur, intlLocale())} ${t('за смену')}` : undefined} />
            </div>
            {d.totals.length > 1 && <div className="faint">{d.totals.slice(1).map((x) => `${x.currency}: ${formatMoneyShort(x.earnings_minor, x.currency, intlLocale())}`).join(' · ')}</div>}
            <Card title="Смены" bodyless>
              {!d.days.length ? <div className="card-body"><EmptyState title="Смен пока нет" text="Внесите выручку за сегодняшнюю смену — заработок посчитается сразу." /></div> : (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>{t('День')}</th><th>{t('Точка')}</th><th className="r">{t('Выручка')}</th><th className="r">{t('Возвраты')}</th><th className="r">{t('Заработок')}</th></tr></thead>
                  <tbody>{d.days.map((x) => (
                    <tr key={x.id}>
                      <td>{dayLabel(x.day)}{x.source === 'manager' && <> <Badge tone="neutral" icon={false} title="Внёс управляющий или франчайзи">{t('управляющий')}</Badge></>}
                        {x.reduced_by_manager && <> <Badge tone="warning" icon={false} title={x.comment ?? undefined}>{t('уменьшено')}</Badge></>}
                        {(x.files ?? 0) > 0 && <span className="faint" title={t('Фото кассового отчёта')}> <Camera size={13} aria-hidden /></span>}
                        {x.locked && <> <Badge tone="neutral">{t('сдано')}</Badge></>}</td>
                      <td>{x.location_name}</td>
                      <td className="r"><Money minor={x.revenue_minor} currency={x.currency} short /></td>
                      <td className="r">{x.returns_minor ? <Money minor={x.returns_minor} currency={x.currency} short /> : '—'}</td>
                      <td className="r"><strong><Money minor={x.earnings_minor} currency={x.currency} short /></strong> <span className="faint">{pct(x.rate_bp)}</span></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </Card>
            <p className="faint">{t('Заработок предварительный: окончательную сумму подтверждает бухгалтерия. Процент задаёт франчайзи или управляющий точки.')}</p>
          </div>
        );
      }}
    </DataState>
  );
}

/* ---------------------------------------------------------------- Отчёт точки */

interface CellEdit { day: string; employee: string; entry?: SaleEntry }

function CellDialog({ edit, m, onClose, onSaved }: { edit: CellEdit | null; m: SalesMonth; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const cur = m.location.currency;
  const [employee, setEmployee] = useState('');
  const [revenue, setRevenue] = useState('0');
  const [returns, setReturns] = useState('0');
  const [card, setCard] = useState('0');
  const [services, setServices] = useState('');
  const [comment, setComment] = useState('');
  const [remove, setRemove] = useState(false);
  useEffect(() => {
    if (!edit) return;
    setEmployee(edit.employee); setRemove(false); setCard(String(edit.entry?.card_minor ?? 0));
    setRevenue(String(edit.entry?.revenue_minor ?? 0)); setReturns(String(edit.entry?.returns_minor ?? 0));
    setServices(edit.entry ? String(edit.entry.services_count) : ''); setComment(edit.entry?.comment ?? '');
  }, [edit]);
  const entry = edit ? m.entries.find((e) => e.day === edit.day && e.employee_id === employee) : undefined;
  const act = useMutation({
    mutationFn: async () => {
      if (remove) {
        if (!comment.trim()) throw { message: 'validation', details: t('Укажите причину удаления в комментарии') };
        await salesCommands.remove(entry!.id, comment);
        return 'Запись удалена';
      }
      await salesCommands.save({ location: m.location.id, day: edit!.day, employee, revenue, returns, services: Number(services || 0), comment: comment || null,
        expected_revision: entry?.revision ?? null, card: card === '0' ? null : card });
      return 'Выручка сохранена';
    },
    onSuccess: (msg) => { toast(msg); onSaved(); onClose(); },
  });
  const net = toBigInt(revenue) - toBigInt(returns);
  const rate = m.employees.find((x) => x.id === employee)?.rate_bp ?? m.rate_bp;
  const reducing = entry?.source === 'self' && toBigInt(revenue) < toBigInt(entry.revenue_minor);
  return (
    <ConfirmDialog open={Boolean(edit)} title={edit ? `${t('Выручка за')} ${dayLabel(edit.day)}` : ''} confirmLabel={remove ? 'Удалить запись' : 'Сохранить'} danger={remove}
      busy={act.isPending} error={act.error} onClose={() => { act.reset(); onClose(); }} onConfirm={() => act.mutate()}>
      {edit && <div key={`${edit.day}:${employee}:${entry?.revision ?? 0}`}>
        <Field label="Сотрудник">{(id) => <Select id={id} value={employee} onChange={(e) => {
          const next = m.entries.find((x) => x.day === edit.day && x.employee_id === e.target.value);
          setEmployee(e.target.value); setRevenue(String(next?.revenue_minor ?? 0)); setReturns(String(next?.returns_minor ?? 0)); setCard(String(next?.card_minor ?? 0));
          setServices(next ? String(next.services_count) : ''); setComment(next?.comment ?? '');
        }}>{m.employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
        {!remove && <div className="grid grid-2">
          <Field label={`Выручка, ${cur}`} required>{(id) => <MoneyInput id={id} value={revenue} currency={cur} onChange={setRevenue} />}</Field>
          <Field label={`Из неё по карте, ${cur}`}>{(id) => <MoneyInput id={id} value={card} currency={cur} onChange={setCard} invalid={toBigInt(card) > toBigInt(revenue)} />}</Field>
          <Field label={`Возвраты, ${cur}`}>{(id) => <MoneyInput id={id} value={returns} currency={cur} onChange={setReturns} invalid={net < 0n} />}</Field>
          <Field label="Услуг">{(id) => <Input id={id} inputMode="numeric" value={services} onChange={(e) => setServices(e.target.value.replace(/\D/g, ''))} />}</Field>
          <div className="faint" style={{ alignSelf: 'end', paddingBottom: 12 }}>{t('Заработок сотрудника')}: <strong>{formatMoneyShort(net > 0n ? earnings(net, rate) : 0n, cur, intlLocale())}</strong> ({pct(rate)})</div>
        </div>}
        {!remove && unusual(revenue, m.entries.filter((x) => !(x.day === edit.day && x.employee_id === employee))) && (
          <Alert tone="warning" title="Проверьте сумму">{t('Она намного больше обычной смены на этой точке. Если всё верно — сохраняйте.')}</Alert>
        )}
        <Field label={remove ? 'Причина удаления' : 'Комментарий'} required={remove}>{(id) => <Textarea id={id} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={entry ? undefined : t('Например: смена не была внесена вовремя')} />}</Field>
        {entry && <label className="row faint" style={{ gap: 8 }}><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />{t('Удалить эту запись (ошибочная смена)')}</label>}
        {reducing && !remove && <Alert tone="warning" title="Сотрудник внёс эту смену сам">{t('Уменьшить сумму можно только с причиной в комментарии. Сотрудник получит уведомление, а компания увидит отметку «уменьшено».')}</Alert>}
        {entry?.source === 'self' && !reducing && !remove && <p className="faint">{t('Сотрудник внёс эту смену сам. Изменение увидит он и останется в истории.')}</p>}
      </div>}
    </ConfirmDialog>
  );
}

function CommissionCard({ m, onSaved }: { m: SalesMonth; onSaved: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [edit, setEdit] = useState<{ employee: SalesEmployee | null } | null>(null);
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(m.today);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => salesCommands.setCommission(m.location.id, edit?.employee?.id ?? null, Math.round(Number(rate.replace(',', '.')) * 100), from, note || null),
    onSuccess: () => { toast('Процент сохранён. Сотрудник получит уведомление.'); setEdit(null); onSaved(); },
  });
  const open = (e: SalesEmployee | null) => { setEdit({ employee: e }); setRate(String((e?.rate_bp ?? m.rate_bp) / 100)); setFrom(m.today); setNote(''); save.reset(); };
  const sellers = m.employees.filter((e) => e.can_sell);
  const num = Number(rate.replace(',', '.'));
  return (
    <details className="card fold">
      <summary className="card-body"><strong>{t('Процент менеджеров продаж')}</strong><span className="faint">{t('базовый')} {pct(m.rate_bp)}</span></summary>
      <div className="card-body" style={{ paddingTop: 0 }}>
      <p className="faint" style={{ marginTop: 0 }}>{t('Процент считается от выручки за вычетом возвратов. Новый процент действует с выбранной даты; прошлые смены не пересчитываются.')}</p>
      <ul className="list">
        <li className="row between" style={{ padding: '8px 0' }}>
          <span><strong>{t('Вся точка (по умолчанию)')}</strong></span>
          <span className="row"><strong>{pct(m.rate_bp)}</strong><Button size="sm" onClick={() => open(null)}>{t('Изменить')}</Button></span>
        </li>
        {sellers.map((e) => (
          <li key={e.id} className="row between" style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
            <span>{e.name}{!e.personal_rate && <span className="faint"> · {t('как у точки')}</span>}</span>
            <span className="row"><strong>{pct(e.rate_bp)}</strong><Button size="sm" onClick={() => open(e)}>{t('Изменить')}</Button></span>
          </li>
        ))}
      </ul>
      <ConfirmDialog open={Boolean(edit)} title={edit?.employee ? `${t('Процент')}: ${edit.employee.name}` : t('Процент для всей точки')} confirmLabel="Сохранить"
        busy={save.isPending} error={save.error} disabled={!(num >= 0 && num <= 100) || rate.trim() === ''} onClose={() => setEdit(null)} onConfirm={() => save.mutate()}>
        <div className="grid grid-2">
          <Field label="Процент от выручки" required>{(id) => <Input id={id} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
          <Field label="Действует с">{(id) => <Input id={id} type="date" value={from} max={addDays(m.today, 60)} onChange={(e) => setFrom(e.target.value)} />}</Field>
        </div>
        <Field label="Комментарий" hint="Например: перевыполнение плана">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </ConfirmDialog>
      </div>
    </details>
  );
}

const OFF_REASONS = ['Выходной', 'Санитарный день ТЦ', 'Болезнь', 'Ремонт'];

/** Кто скорее всего работал в этот день: тот же день недели раньше → чаще всех в месяце → первый продавец. */
function suggestEmployee(m: SalesMonth, day: string) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  const sameWd = [...m.entries].filter((e) => e.day < day && new Date(`${e.day}T12:00:00Z`).getUTCDay() === wd).sort((a, b) => b.day.localeCompare(a.day))[0];
  if (sameWd) return sameWd.employee_id;
  const freq = new Map<string, number>();
  for (const e of m.entries) freq.set(e.employee_id, (freq.get(e.employee_id) ?? 0) + 1);
  const top = [...freq].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? m.employees.find((e) => e.can_sell)?.id ?? m.employees[0]?.id ?? '';
}

/** Пустой день: «кто работал + сумма + оклейки» прямо в строке; Enter — сохранить и перейти к следующему пустому дню. */
function QuickDay({ m, day, onSaved, register }: { m: SalesMonth; day: string; onSaved: (day: string) => void; register: (day: string, el: HTMLInputElement | null) => void }) {
  const { t } = useT();
  const toast = useToast();
  const cur = m.location.currency;
  const sellers = m.employees.filter((e) => e.can_sell || m.entries.some((x) => x.employee_id === e.id));
  const [employee, setEmployee] = useState(() => suggestEmployee(m, day));
  const [revenue, setRevenue] = useState('0');
  const [services, setServices] = useState('');
  const [offOpen, setOffOpen] = useState(false);
  const save = useMutation({
    mutationFn: () => salesCommands.save({ location: m.location.id, day, employee, revenue, returns: '0', services: Number(services || 0), comment: null, expected_revision: null }),
    onSuccess: () => { toast(`${dayLabel(day)}: ${formatMoneyShort(revenue, cur, intlLocale())}`); onSaved(day); },
  });
  const off = useMutation({ mutationFn: (reason: string) => salesCommands.dayOff(m.location.id, day, true, reason), onSuccess: () => onSaved(day) });
  const ok = toBigInt(revenue) > 0n && employee;
  const submit = () => { if (ok && !save.isPending) save.mutate(); };
  if (offOpen) {
    return (
      <div className="quick-off">
        <span className="faint">{t('Почему точка не работала?')}</span>
        <div className="quick-off-options">
          {OFF_REASONS.map((r) => <button key={r} type="button" className="chip" disabled={off.isPending} onClick={() => off.mutate(r)}>{t(r)}</button>)}
          <button type="button" className="link-btn dark" onClick={() => setOffOpen(false)}>{t('Отмена')}</button>
        </div>
        <ActionError error={off.error} />
      </div>
    );
  }
  return (
    <div className="quick-day">
      <div className="quick-fields">
        {sellers.length > 1 && (
          <Select aria-label={t('Кто работал')} value={employee} onChange={(e) => setEmployee(e.target.value)} className="quick-who">
            {sellers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        )}
        <div className="quick-money">
          <MoneyInput id={`q-${day}`} value={revenue} currency={cur} onChange={setRevenue} inputRef={(el) => register(day, el)} placeholder={t('Выручка')} onEnter={submit} />
        </div>
        <Input aria-label={t('Оклеек')} inputMode="numeric" placeholder={t('Оклеек')} className="quick-svc" value={services}
          onChange={(e) => setServices(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <Button variant="primary" className="quick-save" aria-label={t('Сохранить')} disabled={!ok} loading={save.isPending} onClick={submit}><Check size={18} aria-hidden /></Button>
      </div>
      <button type="button" className="link-btn dark" onClick={() => setOffOpen(true)}>{t('Точка не работала')}</button>
      <ActionError error={save.error} />
    </div>
  );
}

function LocationReportTab() {
  const { t } = useT();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const manage = useLocationsWith('sales.manage');
  const read = useLocationsWith('sales.read');
  const locs = useMemo(() => {
    const map = new Map([...read.data, ...manage.data].map((l) => [l.id, l]));
    return [...map.values()].filter((l) => l.status !== 'closed')
      .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || a.name.localeCompare(b.name, 'ru'));
  }, [manage.data, read.data]);
  const max = monthOf(localToday());
  const location = params.get('location') ?? locs[0]?.id ?? '';
  const month = params.get('month') ?? max;
  const onlyMissing = params.get('only') === 'missing';
  const set = (patch: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) { if (v === null) n.delete(k); else n.set(k, v); }
    return n;
  }, { replace: true });
  const q = useQuery({ queryKey: ['sales', 'month', location, month], enabled: Boolean(location), queryFn: () => salesMonth(location, month) });
  const [edit, setEdit] = useState<CellEdit | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const [focusNext, setFocusNext] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['sales'] }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  const undoOff = useMutation({ mutationFn: (day: string) => salesCommands.dayOff(location, day, false, null), onSuccess: () => { toast('Отметка снята'); refresh(); } });

  // После сохранения — курсор в следующий пустой день
  useEffect(() => {
    if (!focusNext || !q.data) return;
    const next = [...inputs.current.keys()].sort().find((d) => d > focusNext);
    if (next) { const el = inputs.current.get(next); el?.focus(); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    setFocusNext(null);
  }, [q.data, focusNext]);

  if (!manage.isLoading && !read.isLoading && !locs.length) return <Card><EmptyState title="Нет точек" text="Отчёт точки доступен франчайзи, управляющему и компании." /></Card>;

  return (
    <div className="stack">
      <div className="month-bar">
        {locs.length > 1 && <Select aria-label={t('Точка')} value={location} onChange={(e) => set({ location: e.target.value })} className="month-loc">
          {locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
        <MonthNav month={month} onChange={(m) => set({ month: m })} max={max} />
      </div>
      <DataState query={q}>
        {(m) => {
          const cur = m.location.currency;
          const opening = locs.find((l) => l.id === m.location.id)?.status !== 'active';
          const editable = m.can_manage && !m.locked;
          const days: string[] = [];
          for (let d = monthOf(m.month); d <= m.today && d.startsWith(m.month.slice(0, 7)); d = addDays(d, 1)) days.push(d);
          const offs = new Map((m.days_off ?? []).map((o) => [o.day, o.reason]));
          const missing = new Set(opening ? [] : m.missing_days.filter((d) => d < m.today));
          const past = days.filter((d) => d < m.today).length;
          const filled = past - missing.size;
          const byDay = new Map<string, SaleEntry[]>();
          for (const e of m.entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
          const names = new Map(m.employees.map((e) => [e.id, e.name.split(' ')[0]]));
          const net = toBigInt(m.totals.revenue_minor) - toBigInt(m.totals.returns_minor);
          const only = onlyMissing && missing.size > 0;
          const shown = only ? days.filter((d) => missing.has(d)) : days;
          inputs.current.clear();
          const empEarn = new Map<string, bigint>();
          const empNet = new Map<string, bigint>();
          for (const e of m.entries) {
            const n = toBigInt(e.revenue_minor) - toBigInt(e.returns_minor);
            empNet.set(e.employee_id, (empNet.get(e.employee_id) ?? 0n) + n);
            empEarn.set(e.employee_id, (empEarn.get(e.employee_id) ?? 0n) + earnings(n, e.rate_bp ?? m.rate_bp));
          }
          return (
            <>
              <section className="month-summary">
                <div className="month-sum-top">
                  <div>
                    <div className="l">{t('Выручка за месяц')}</div>
                    <div className="v">{formatMoneyShort(m.totals.revenue_minor, cur, intlLocale())}</div>
                    <div className="s">{t('менеджерам')} {formatMoneyShort(m.totals.earnings_minor, cur, intlLocale())}{m.totals.revenue_minor ? ` · ${t('по карте')} ${Math.round(Number(m.totals.card_minor) * 100 / Number(m.totals.revenue_minor))}%` : ''}</div>
                  </div>
                  {!opening && <div className={`month-ring${past && filled === past ? ' full' : ''}`} style={{ ['--p' as string]: past ? filled / past : 1 }} aria-label={`${t('Заполнено')} ${filled} / ${past}`}><span>{filled}<small>/{past}</small></span></div>}
                </div>
                {m.locked ? <div className="month-note">{t('Месяц сдан отчётом. Исправления — через финансы.')}</div>
                  : missing.size > 0 ? (
                    <div className="month-actions">
                      <span>{t('Не внесено дней')}: <strong>{missing.size}</strong></span>
                      {editable && <Button variant="silver" onClick={() => set({ only: only ? null : 'missing' })}>{only ? t('Показать все дни') : t('Заполнить пропуски')}</Button>}
                    </div>
                  ) : !opening && past > 0 ? (
                    <div className="month-actions">
                      <span>🎉 {t('Все дни заполнены')}</span>
                      {can('royalty.report.submit') && <LinkButton to="/royalties" variant="silver">{t('Сдать отчёт за месяц')}</LinkButton>}
                    </div>
                  ) : null}
              </section>

              <ul className="day-list">
                {shown.map((d) => {
                  const list = byDay.get(d) ?? [];
                  const off = offs.get(d);
                  const miss = missing.has(d);
                  const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
                  const total = list.reduce((s, e) => s + toBigInt(e.revenue_minor), 0n);
                  return (
                    <li key={d} className={`day-row${miss ? ' missing' : ''}${off ? ' off' : ''}${wd === 0 || wd === 6 ? ' weekend' : ''}`}>
                      <div className="day-date">
                        <span className="day-num">{Number(d.slice(8))}</span>
                        <span className="day-wd">{new Date(`${d}T12:00:00Z`).toLocaleDateString(intlLocale(), { weekday: 'short', timeZone: 'UTC' })}</span>
                      </div>
                      <div className="day-body">
                        {list.map((e) => (
                          <button key={e.id} type="button" className="day-entry" disabled={!editable} onClick={() => setEdit({ day: d, employee: e.employee_id, entry: e })}>
                            <span className="who">{names.get(e.employee_id) ?? '—'}</span>
                            <span className="sum">{formatMoneyShort(e.revenue_minor, cur, intlLocale())}</span>
                            {e.services_count > 0 && <span className="faint">{e.services_count} {t('окл.')}</span>}
                            {e.source === 'manager' && <span className="faint" title={t('Внёс управляющий или франчайзи')}>✎</span>}
                            {e.reduced_by_manager && <span className="reduced-mark" title={`${t('Уменьшено')}: ${e.comment ?? ''}`}>↓</span>}
                            {(e.files ?? 0) > 0 && <Camera size={13} aria-hidden className="faint" />}
                          </button>
                        ))}
                        {off && <div className="day-off">{t('Не работали')} · {off}{editable && <button type="button" className="link-btn dark" onClick={() => undoOff.mutate(d)}>{t('Отменить')}</button>}</div>}
                        {!list.length && !off && editable && !opening && <QuickDay m={m} day={d} onSaved={(day) => { refresh(); setFocusNext(day); }} register={(day, el) => { if (el) inputs.current.set(day, el); }} />}
                        {!list.length && !off && (!editable || opening) && <span className="faint">{d === m.today ? t('смена идёт') : '—'}</span>}
                        {list.length > 0 && editable && m.employees.some((e) => e.can_sell && !list.some((x) => x.employee_id === e.id)) && (
                          <button type="button" className="link-btn dark" onClick={() => setEdit({ day: d, employee: m.employees.find((e) => e.can_sell && !list.some((x) => x.employee_id === e.id))!.id })}>+ {t('ещё сотрудник')}</button>
                        )}
                      </div>
                      {list.length > 1 && <div className="day-total">{formatMoneyShort(total, cur, intlLocale())}</div>}
                    </li>
                  );
                })}
              </ul>

              <Card><LocationNotes key={m.location.id} locationId={m.location.id} compact /></Card>
              <details className="card fold">
                <summary className="card-body"><strong>{t('По сотрудникам')}</strong><span className="faint">{t('выручка и заработок за месяц')}</span></summary>
                <ul className="list">
                  {m.employees.filter((e) => empNet.has(e.id) || e.can_sell).map((e) => (
                    <li key={e.id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="main-col"><div className="title">{e.on_shift_since && <span className="on-shift-dot" />}{e.name}</div><div className="meta">{pct(e.rate_bp)}</div></div>
                      <div className="side"><strong>{formatMoneyShort(empEarn.get(e.id) ?? 0n, cur, intlLocale())}</strong><span className="faint">{t('с выручки')} {formatMoneyShort(empNet.get(e.id) ?? 0n, cur, intlLocale())}</span></div>
                    </li>
                  ))}
                  <li className="list-item" style={{ cursor: 'default' }}><div className="main-col"><div className="title">{t('Итого нетто')}</div></div><div className="side"><strong>{formatMoneyShort(net, cur, intlLocale())}</strong></div></li>
                </ul>
              </details>
              {m.can_manage && <CommissionCard m={m} onSaved={refresh} />}
              <CellDialog edit={edit} m={m} onClose={() => setEdit(null)} onSaved={refresh} />
            </>
          );
        }}
      </DataState>
    </div>
  );
}

export function SalesPage() {
  const { t } = useT();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const canMy = can('sales.enter');
  const canLoc = can('sales.manage') || can('sales.read');
  // Франчайзи и управляющий по умолчанию открывают месяц точки, менеджер продаж — свою смену
  const wanted = params.get('tab') ?? (can('sales.manage') ? 'location' : 'my');
  const tab = (wanted === 'location' || !canMy) && canLoc ? 'location' : 'my';
  return (
    <>
      <PageHeader title={t('Выручка')} />
      {canMy && canLoc && (
        <div style={{ marginBottom: 16 }}>
          <Tabs label="Разделы выручки" value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })}
            tabs={[{ id: 'location', label: 'Месяц точки' }, { id: 'my', label: 'Моя смена' }]} />
        </div>
      )}
      {tab === 'my' ? <MyShiftTab /> : <LocationReportTab />}
      {!canMy && !canLoc && <Card><EmptyState title="Нет доступа" text="Раздел доступен менеджерам продаж, управляющим и франчайзи." /></Card>}
    </>
  );
}
