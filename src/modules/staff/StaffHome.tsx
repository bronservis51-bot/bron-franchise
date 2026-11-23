// Экран сотрудника: закрытие смены с выручкой и личные начисления.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { calculatePay, type ShiftPolicy } from './Motivation';
import { addDays, dayLabel, monthLabel, monthStart } from '../../platform/dates';
import { formatMoneyShort, sumMinor, type MinorInput } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Alert, Button, Card, ConfirmDialog, DataState, EmptyState, Field, Input, Money, MoneyInput, Checkbox, Select } from '../../ui';
import {onOutboxChange,queuedOps} from '../../platform/outbox';
import { pctBp, shiftCancel, shiftClose, shiftSubmit, staffHome, type Shift, type StaffHomeData } from './api';
import { MonthNav } from '../revenue/components';

/** Advisory UI only: the server checks its clock after locking the shift. */
function canCorrect(shift: Shift) {
  return shift.status === 'closed' && !!shift.closed_at && Date.now() < Date.parse(shift.closed_at) + 5 * 60_000;
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => { const h = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(h); }, [ms]);
}

type ShiftPoint = StaffHomeData['locations'][number];
type ClosePoint = ShiftPoint & { dates: string[] };
const maxShiftTotal = 100_000_000_000n;
const targetKey = (location: string, day: string) => `${location}:${day}`;

function availableDates(point: ShiftPoint, history: Shift[], blocked: (key: string) => boolean) {
  return [point.today, addDays(point.today, -1)].filter(day =>
    !(day === point.today ? point.my_today : point.my_yesterday) &&
    !history.some(shift => shift.location_id === point.location_id && shift.day === day) &&
    !blocked(targetKey(point.location_id, day)));
}

function CloseDialog({ userId, shift, points, blocked, currency: homeCurrency, rate, fee, policy, onClose, onDone }: {
  userId: string; shift?: Shift; points: ClosePoint[]; blocked: (key: string) => boolean;
  currency: string; rate: number; fee: number; policy?: ShiftPolicy | null; onClose: () => void;
  onDone: (earned: number | bigint | null, month: number | null, key: string, currency: string, day: string) => void;
}) {
  const qc = useQueryClient();
  const editing = shift?.status === 'closed';
  const initialCash = editing ? String(shift.cash_minor) : '';
  const initialCard = editing ? String(shift.card_minor) : '';
  const [locationId, setLocationId] = useState(points.length === 1 ? points[0].location_id : '');
  const [selectedDay, setSelectedDay] = useState('');
  const [cash, setCash] = useState(initialCash);
  const [card, setCard] = useState(initialCard);
  const [cashValid,setCashValid]=useState(true); const [cardValid,setCardValid]=useState(true); const [zero,setZero]=useState(false);
  const [comment, setComment] = useState(shift?.comment ?? '');
  const cardInput = useRef<HTMLInputElement>(null);
  const commentInput = useRef<HTMLInputElement>(null);
  const total = sumMinor([cash || '0', card || '0']);
  const exceedsLimit = total > maxShiftTotal;
  const point = points.find(item => item.location_id === locationId);
  const dates = point?.dates ?? [];
  const day = shift?.day ?? (dates.includes(selectedDay) ? selectedDay : dates[0]);
  const key = shift?.id ?? (point && day ? targetKey(point.location_id, day) : '');
  const currency = point?.currency ?? homeCurrency;
  const pointTerms = point && (day === point.today ? point.pay_today ?? policy : point.pay_yesterday);
  const terms = shift ? shift.pay_policy ?? policy : pointTerms;
  const fixed = terms && 'mode' in terms ? terms : { fee_minor: fee, rate_bp: rate };
  const showEstimate = Boolean(shift || pointTerms || (point && day === point.today));
  const earned = showEstimate && !exceedsLimit ? calculatePay(total, rate, fee, terms) : null;
  const m = useMutation({
    networkMode: 'always',
    mutationFn: async () => {
      const note = comment.trim() || null;
      const response = shift ? await shiftClose(userId, shift.id, cash, card, note, shift.revision)
        : await shiftSubmit(userId, locationId, day, cash, card, note);
      return { response, key, currency, day, earned };
    },
    onSuccess: ({ response, key: submittedKey, currency: submittedCurrency, day: submittedDay, earned: estimate }) => {
      const queued = 'queued' in response;
      onDone(queued ? estimate : Number(response.shift.earned_minor), queued ? null : Number(response.month_earned_minor),
        submittedKey, submittedCurrency, submittedDay);
    },
    onError:()=>void qc.invalidateQueries({queryKey:['staff']}),
  });
  const canSave = Boolean(key) && !blocked(key) && cash !== '' && card !== '' && cashValid && cardValid && !exceedsLimit && (total !== 0n || zero);
  const submit = () => { if (canSave && !m.isPending) m.mutate(); };
  const dirty = cash !== initialCash || card !== initialCard || !cashValid || !cardValid || zero || comment !== (shift?.comment ?? '');
  return (
    <ConfirmDialog open title={editing ? 'Исправить смену' : 'Закрыть смену'} confirmLabel={editing ? 'Сохранить' : 'Закрыть смену'} busy={m.isPending} error={m.error}
      disabled={!canSave} dirty={dirty} onClose={onClose} onConfirm={submit}>
      {shift ? <p className="muted">{dayLabel(shift.day)}{shift.location_name ? `, ${shift.location_name}` : ''}</p> : <>
        {points.length > 1 ? <Field label="Торговая точка" required>{id => (
          <Select id={id} value={locationId} disabled={m.isPending} onChange={event => { setLocationId(event.target.value); setSelectedDay(''); }}>
            <option value="">Выберите точку</option>
            {points.map(item => <option key={item.location_id} value={item.location_id}>{item.location_name}</option>)}
          </Select>
        )}</Field> : point && <p className="muted">{point.location_name}</p>}
        {dates.length > 1 ? <Field label="Дата смены">{id => (
          <Select id={id} value={day} disabled={m.isPending} onChange={event => setSelectedDay(event.target.value)}>
            {dates.map(date => <option key={date} value={date}>{dayLabel(date)}</option>)}
          </Select>
        )}</Field> : day && <p className="muted">{dayLabel(day)}</p>}
      </>}
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Наличные" required error={!cashValid ? 'Укажите сумму наличными.' : undefined}>{(id, describedBy) => (
          <MoneyInput id={id} describedBy={describedBy} value={cash} onChange={setCash} requireExplicitValue onValidityChange={setCashValid} onEnter={() => cardInput.current?.focus()} enterKeyHint="next" currency={currency} placeholder="0" />
        )}</Field>
        <Field label="Картой" required error={!cardValid ? 'Укажите сумму по карте.' : undefined}>{(id, describedBy) => (
          <MoneyInput id={id} inputRef={el => { cardInput.current = el; }} describedBy={describedBy} value={card} onChange={setCard} requireExplicitValue onValidityChange={setCardValid} onEnter={() => commentInput.current?.focus()} enterKeyHint="next" currency={currency} placeholder="0" />
        )}</Field>
      </div>
      {total===0n&&<Checkbox label="Подтверждаю: продаж за эту смену не было" checked={zero} onChange={setZero}/>}
      {editing&&<p className="faint">Выручку можно исправить в течение 5 минут после первой сдачи. Правка сохранится в истории без повторного начисления. Позже обратитесь к руководителю.</p>}
      {exceedsLimit ? <p className="danger-text" role="alert">Сумма смены не может превышать <Money minor={maxShiftTotal} currency={currency} short />.</p> :
        <div className="day-total-line"><span>Выручка смены</span><Money minor={total} currency={currency} strong /></div>}
      {earned !== null ? <>
        <div className="earn-line"><span>Ожидаемое начисление</span><Money minor={earned} currency={currency} strong /></div>
        <p className="faint">{terms && !('mode' in terms) ? 'Больше из гарантированного минимума и процента от выручки, плюс премия' : <>{fixed.fee_minor ? `${formatMoneyShort(fixed.fee_minor, currency)} за выход` : ''}{fixed.fee_minor && fixed.rate_bp ? ' + ' : ''}{fixed.rate_bp ? `${pctBp(fixed.rate_bp)} от выручки` : ''}</>}</p>
      </> : point && !exceedsLimit && <p className="faint">Начисление за выбранную дату появится после сохранения.</p>}
      <Field label="Комментарий">{(id) => <Input id={id} ref={commentInput} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Необязательно" />}</Field>
    </ConfirmDialog>
  );
}

type PointRevenue = (month: string) => ReactNode;

export function StaffHome({ pointRevenue }: { pointRevenue?: PointRevenue } = {}) {
  const { me } = useSession();
  return me && <StaffShifts key={me.user.id} userId={me.user.id} pointRevenue={pointRevenue} />;
}

type QueueSnapshot = Awaited<ReturnType<typeof queuedOps>>;
type ShiftResult = { earned: number | bigint; month: number; currency: string; day: string } |
  { earned: number | bigint | null; month: null; currency: string; key: string; previousQueue: QueueSnapshot | undefined };

function ShiftHistory({ userId, current, pointRevenue }: { userId: string; current?: StaffHomeData; pointRevenue?: PointRevenue }) {
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const currentMonth = current?.month ?? monthStart();
  const month = selectedMonth ?? currentMonth;
  const history = useQuery({
    queryKey: ['staff', 'history', userId, selectedMonth],
    enabled: selectedMonth !== null,
    queryFn: () => staffHome(selectedMonth),
  });
  const compact = Boolean(pointRevenue);
  const content = (
    <>
      <MonthNav month={month} max={currentMonth} onChange={(next) => setSelectedMonth(next === currentMonth ? null : next)} />
      {selectedMonth === null ? current && <ShiftMonth data={current} current compact={compact} /> : history.isPaused && !history.data
        ? <p className="faint" role="status">Для загрузки этого месяца нужна связь.</p>
        : <DataState query={history}>{(data) => <ShiftMonth data={data} compact={compact} />}</DataState>}
      {pointRevenue?.(month)}
    </>
  );
  return compact ? <Card title="Итоги месяца" className="team-monthly">{content}</Card> : (
    <section className="stack">
      <h2 className="section-title">Мои смены и начисления</h2>
      {content}
    </section>
  );
}

export function MonthlyDetails({ label, total, currency, children }: {
  label: string; total: MinorInput; currency: string; children: ReactNode;
}) {
  return <details className="monthly-details">
    <summary>
      <span className="monthly-details-values"><span>{label}</span><Money minor={total} currency={currency} short strong /></span>
      <ChevronDown size={16} aria-hidden />
    </summary>
    {children}
  </details>;
}

function ShiftMonth({ data: d, current, compact }: { data: StaffHomeData; current?: boolean; compact: boolean }) {
  const shiftCount = `${d.month_shifts} ${d.month_shifts % 10 === 1 && d.month_shifts % 100 !== 11 ? 'смена' : [2, 3, 4].includes(d.month_shifts % 10) && ![12, 13, 14].includes(d.month_shifts % 100) ? 'смены' : 'смен'}`;
  const activity = <>{shiftCount} · выручка смен {formatMoneyShort(d.month_revenue_minor, d.currency)}</>;
  const terms = current && (d.pay_policy && !('mode' in d.pay_policy) ? 'По ступеням кассы: минимум или процент, плюс премия'
    : [d.shift_fee_minor ? `${formatMoneyShort(d.shift_fee_minor, d.currency)} за выход` : '',
      d.rate_bp ? `${pctBp(d.rate_bp)} от выручки` : ''].filter(Boolean).join(' + '));
  const shifts = d.shifts.length ? (
    <ul className="day-list2">
      {d.shifts.map((s) => (
        <li key={s.id}>
          <div className="day-row2" style={{ cursor: 'default' }}>
            <span className="day-date2">{dayLabel(s.day)}</span>
            <span className="day-sum2">
              <Money minor={s.earned_minor ?? 0} currency={d.currency} short />
              <span className="day-split">{s.location_name} · выручка {formatMoneyShort(s.total_minor, d.currency)}</span>
            </span>
          </div>
        </li>
      ))}
    </ul>
  ) : <p className="faint">Закрытых смен в этом месяце пока нет.</p>;
  if (compact) return <MonthlyDetails label="Мои начисления" total={d.month_earned_minor} currency={d.currency}>
    {d.month_shifts > 0 && <p className="faint">{activity}</p>}
    {terms && <p className="faint">{terms}</p>}
    {shifts}
  </MonthlyDetails>;
  return (
    <>
      <div className="plan-card earn-card" aria-label="Начислено за месяц">
        <div className="plan-label">Начислено за {monthLabel(d.month, false)}</div>
        <div className="plan-fact">{formatMoneyShort(d.month_earned_minor, d.currency)}</div>
        <div className="plan-of">{activity}</div>
        {terms && <div className="plan-foot"><span>{terms}</span></div>}
      </div>
      {shifts}
    </>
  );
}

function StaffShifts({ userId, pointRevenue }: { userId: string; pointRevenue?: PointRevenue }) {
  const qc = useQueryClient();
  useTick(10_000);
  const q = useQuery({ queryKey: ['staff', 'home', userId], queryFn: () => staffHome(null), refetchInterval: 120_000 });
  const [cancelling,setCancelling]=useState<Shift|null>(null);
  const queueKey = ['staff', 'pending', userId];
  const pending = useQuery({
    queryKey: queueKey,
    queryFn: () => queuedOps(userId),
    networkMode: 'always',
    structuralSharing: false,
  });
  useEffect(()=>onOutboxChange(()=>void qc.invalidateQueries({queryKey:['staff']})),[qc]);
  const queuedShift = (key: string) => pending.data?.some(op => op.kind === 'shift_submit'
    ? targetKey(String(op.payload.location), String(op.payload.day)) === key : op.payload.shift === key);
  const [closing, setClosing] = useState<{ shift?: Shift; points?: ClosePoint[] } | null>(null);
  const [result, setResult] = useState<ShiftResult | null>(null);
  const queuedResult = result?.month === null ? result : null;
  // A cached empty queue can predate the write. Only a later successful read can retire this result.
  const queueResolved = queuedResult !== null && pending.isSuccess && pending.data !== queuedResult.previousQueue && !queuedShift(queuedResult.key);
  const shiftRefreshed = queueResolved && !q.isFetching;
  useEffect(() => {
    if (shiftRefreshed) setResult(current => current === queuedResult ? null : current);
  }, [shiftRefreshed, queuedResult]);
  const shownResult = queueResolved ? null : result;
  const shiftBlocked = (key: string) => !pending.isSuccess || Boolean(queuedShift(key)) || (queuedResult?.key === key && !shiftRefreshed);
  const available = q.data?.locations.map(point => ({ ...point, dates: availableDates(point, q.data.shifts, shiftBlocked) }))
    .filter(point => point.dates.length > 0) ?? [];
  const cancel = useMutation({ mutationFn: shiftCancel, onSuccess: () => {setCancelling(null);void qc.invalidateQueries({ queryKey: ['staff'] });} });

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-date">{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>Смена</h1>
      </header>

      <div className="home-body">
        <DataState query={q} skeleton={4}>
          {(d) => (
            <>
              {shownResult && (
                <div className="earn-result" role="status">
                  <span className="ok-icon"><Check size={18} aria-hidden /></span>
                  <div>
                    <div>{shownResult.month === null ? 'Итог сохранён на телефоне' : 'Смена закрыта. Вы заработали'}
                      {shownResult.earned !== null && <> {shownResult.month === null && '· Расчётный заработок '}<strong>{formatMoneyShort(shownResult.earned, shownResult.currency)}</strong></>}
                    </div>
                    {shownResult.month !== null && <div className="faint">За {monthLabel(shownResult.day, false)}: {formatMoneyShort(shownResult.month, shownResult.currency)}</div>}
                    {shownResult.month === null && <div className="faint">Отправится при подключении к интернету.</div>}
                  </div>
                </div>
              )}
              {d.open_shift ? (
                <section className="shift-card" aria-label="Открытая смена">
                  <div className="shift-label"><span className="on-dot" />Незакрытая смена · {d.open_shift.location_name}</div>
                  <div className="faint">За {dayLabel(d.open_shift.day)}</div>
                  {d.locations.find(l=>l.location_id===d.open_shift!.location_id)?.today!==d.open_shift.day&&<p className="danger-text">Эта смена открыта за прошлую дату. Не записывайте сюда сегодняшнюю выручку. Уточните итог с руководителем или отмените ошибочное открытие.</p>}
                  <Button variant="primary" block className="btn-lg" disabled={shiftBlocked(d.open_shift.id)} onClick={() => setClosing({ shift: d.open_shift! })}>
                    Закрыть смену и внести выручку
                  </Button>
                  <button type="button" className="link-btn" disabled={shiftBlocked(d.open_shift.id)} onClick={() => setCancelling(d.open_shift)}>Открыл по ошибке — отменить</button>
                </section>
              ) : d.locations.length ? (
                <section className="stack" aria-label="Смены сегодня">
                  {available.length > 0 && <Button variant="primary" block className="btn-lg" onClick={() => setClosing({ points: available })}>Закрыть смену</Button>}
                  {d.locations.flatMap(location => [location.my_today, location.my_yesterday && canCorrect(location.my_yesterday) ? location.my_yesterday : null]
                    .map(shift => shift && (
                    <button key={shift.id} type="button" disabled={shiftBlocked(shift.id) || !canCorrect(shift)} className="today-entered"
                      onClick={() => setClosing({ shift: { ...shift, location_name: location.location_name } })}>
                      <span className="ok-icon"><Check size={18} aria-hidden /></span>
                      <span>{location.location_name}{shift.day !== location.today && ` · ${dayLabel(shift.day)}`}: смена закрыта, заработано <strong>{formatMoneyShort(shift.earned_minor ?? 0, location.currency)}</strong></span>
                      <span className="faint">{canCorrect(shift) ? 'исправить в течение 5 минут' : 'для исправления обратитесь к руководителю'}</span>
                    </button>
                  )))}
                </section>
              ) : <EmptyState title="Вам пока не назначены точки" text="Попросите франчайзи добавить вас на точку." />}

              <ActionError error={cancel.error} />
              {pending.isError && <Alert tone="danger" title="Не удалось проверить очередь смен"
                action={<Button size="sm" onClick={() => void pending.refetch()}>Повторить</Button>} />}
              {!shownResult && pending.data?.some(op => (op.kind === 'shift_submit' || op.payload.shift === d.open_shift?.id && d.open_shift) && !op.lastError) && <p role="status">Итог ожидает отправки. Экран обновится после подтверждения сервера.</p>}

              {!pointRevenue && <ShiftHistory userId={userId} current={d} />}
            </>
          )}
        </DataState>
        {pointRevenue && <ShiftHistory userId={userId} current={q.data} pointRevenue={pointRevenue} />}
      </div>
      {cancelling&&<ConfirmDialog open title="Отменить ошибочное открытие?" confirmLabel="Отменить открытие" cancelLabel="Вернуться" busy={cancel.isPending} error={cancel.error} onClose={()=>setCancelling(null)} onConfirm={()=>cancel.mutate(cancelling.id)}><p>{cancelling.location_name} · {dayLabel(cancelling.day)}</p><p>Отменяется только пустая открытая смена. Сохранённую выручку это действие не удаляет.</p></ConfirmDialog>}
      {closing && q.data && (
        <CloseDialog userId={userId} shift={closing.shift} points={closing.points ?? []} blocked={shiftBlocked}
          currency={q.data.currency} policy={q.data.pay_policy} rate={closing.shift?.rate_bp ?? q.data.rate_bp} fee={closing.shift?.shift_fee_minor ?? q.data.shift_fee_minor}
          onClose={() => setClosing(null)}
          onDone={(earned, month, key, currency, day) => {
            setClosing(null);
            setResult(month === null
              ? { earned, month, key, currency, previousQueue: qc.getQueryData<QueueSnapshot>(queueKey) }
              : { earned: earned ?? 0, month, currency, day });
            void qc.invalidateQueries({ queryKey: ['staff'] });
          }} />
      )}
    </div>
  );
}
