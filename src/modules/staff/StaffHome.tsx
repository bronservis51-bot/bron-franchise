// Экран сотрудника: закрытие смены с выручкой и личные начисления.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { calculatePay, type ShiftPolicy } from './Motivation';
import { addDays, dayLabel, formatDate, monthLabel, monthStart, shiftMonth } from '../../platform/dates';
import { localized, useLocale, type Language, type UiLocale } from '../../platform/locale';
import { formatMoneyShort, sumMinor, type MinorInput } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Alert, Button, Card, ConfirmDialog, DataState, EmptyState, Field, Input, Money, MoneyInput, Checkbox, Select } from '../../ui';
import {onOutboxChange,queuedOps} from '../../platform/outbox';
import { shiftCancel, shiftClose, shiftSubmit, staffHome, type CloseResult, type Shift, type StaffHomeData } from './api';
import { MonthNav } from '../revenue/components';
import { useOwnPartnerLifecycle } from '../revenue/partnerLifecycle';
import { ShiftReturnField, validShiftReturn } from './ShiftReturnField';
import { recordShiftReturn } from './shiftReturns';
import { PayrollSchedule } from './PayrollSchedule';
import { splitPayroll } from './payrollPeriods';
import './shift-home.css';

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
type ShiftSubmission = {
  response: CloseResult | { queued: true }; earned: bigint | null; key: string; currency: string; day: string; pointName?: string;
};
const maxShiftTotal = 100_000_000_000n;
const targetKey = (location: string, day: string) => `${location}:${day}`;

function fixedTerms(terms: { fee_minor: number; rate_bp: number }, currency: string, locale: UiLocale) {
  const fee = formatMoneyShort(terms.fee_minor, currency, locale);
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(terms.rate_bp / 10_000);
  const tr = locale === 'tr-TR';
  return [terms.fee_minor ? (tr ? `Vardiya başına ${fee}` : `${fee} за выход`) : '',
    terms.rate_bp ? (tr ? `ciro payı ${pct}` : `${pct} от выручки`) : ''].filter(Boolean).join(' + ');
}

function shiftDateRestriction(point: ShiftPoint, day: string, language: Language = 'ru') {
  if (day > point.today) return localized(language, 'Нельзя сдать смену за будущий день.', 'İleri bir tarih için vardiya girilemez.');
  if (point.awaiting_opening_date) return localized(language, 'Дата открытия ещё не указана. Обратитесь к руководителю.', 'Açılış tarihi henüz belirtilmedi. Yöneticinizle görüşün.');
  if (point.opened_on && day < point.opened_on) return localized(language, `Сдать смену можно с ${formatDate(point.opened_on)}.`, `${formatDate(point.opened_on, 'tr-TR')} tarihinden itibaren vardiya girebilirsiniz.`);
  if (point.days_off?.includes(day)) return localized(language, 'Точка не работала. Если это ошибка, обратитесь к руководителю.', 'Mağaza o gün kapalıydı. Bir hata varsa yöneticinizle görüşün.');
  return null;
}

function availableDates(point: ShiftPoint, history: Shift[], blocked: (key: string) => boolean) {
  return [point.today, addDays(point.today, -1)].filter(day =>
    !shiftDateRestriction(point, day) &&
    !(day === point.today ? point.my_today : point.my_yesterday) &&
    !history.some(shift => shift.location_id === point.location_id && shift.day === day) &&
    !blocked(targetKey(point.location_id, day)));
}

function CloseDialog({ userId, shift, points, initialPoint, initialDay, home, readOnly, blocked, currency: homeCurrency, rate, fee, policy, onClose, onDone }: {
  userId: string; shift?: Shift; points: ClosePoint[]; initialPoint?: string; initialDay?: string; home: StaffHomeData; readOnly: boolean; blocked: (key: string) => boolean;
  currency: string; rate: number; fee: number; policy?: ShiftPolicy | null; onClose: () => void;
  onDone: (submission: ShiftSubmission) => void;
}) {
  const qc = useQueryClient();
  const { t, locale, language } = useLocale();
  const editing = shift?.status === 'closed';
  const initialCash = editing ? String(shift.cash_minor) : '';
  const initialCard = editing ? String(shift.card_minor) : '';
  const onlyPoint = points.length === 1 ? points[0] : undefined;
  const [locationId, setLocationId] = useState(initialPoint ?? onlyPoint?.location_id ?? '');
  const [selectedDay, setSelectedDay] = useState(initialDay ?? onlyPoint?.dates[0] ?? '');
  const [cash, setCash] = useState(initialCash);
  const [card, setCard] = useState(initialCard);
  const initialReturn = shift?.return_minor ? String(shift.return_minor) : null;
  const [returned, setReturned] = useState<string | null>(initialReturn);
  const [returnValid, setReturnValid] = useState(true);
  const [cashValid,setCashValid]=useState(true); const [cardValid,setCardValid]=useState(true); const [zero,setZero]=useState(false);
  const [comment, setComment] = useState(shift?.comment ?? '');
  const cardInput = useRef<HTMLInputElement>(null);
  const commentInput = useRef<HTMLInputElement>(null);
  const total = sumMinor([cash || '0', card || '0']);
  const hasSalesInput = cash !== '' || card !== '';
  const exceedsLimit = total > maxShiftTotal;
  const point = points.find(item => item.location_id === locationId);
  const day = shift?.day ?? selectedDay;
  const targetMonth = day && `${day.slice(0, 7)}-01`;
  const history = useQuery({
    queryKey: ['staff', 'history', userId, targetMonth],
    queryFn: () => staffHome(targetMonth),
    enabled: Boolean(!shift && point && day && targetMonth !== home.month && !shiftDateRestriction(point, day)),
  });
  const monthData = targetMonth === home.month ? home : history.data;
  const datePoint = monthData?.locations.find(item => item.location_id === locationId) ?? point;
  const dayTaken = point && (day === point.today ? point.my_today : day === addDays(point.today, -1) ? point.my_yesterday : null);
  const key = shift?.id ?? (point && day ? targetKey(point.location_id, day) : '');
  const restriction = !shift && datePoint && day && (shiftDateRestriction(datePoint, day, language) ||
    ((dayTaken || monthData?.shifts.some(item => item.day === day && item.location_id === locationId)) && t('Ваша смена за эту дату уже сдана.', 'Bu tarihteki vardiyanız zaten kaydedildi.')) ||
    (blocked(key) && t('Проверяем статус отправки смены.', 'Vardiyanın gönderim durumu kontrol ediliyor.')));
  const currency = point?.currency ?? homeCurrency;
  const pointTerms = point && (day === point.today ? point.pay_today ?? policy :
    day === addDays(point.today, -1) ? point.pay_yesterday : undefined);
  const terms = shift ? shift.pay_policy ?? policy : pointTerms;
  const fixed = terms && 'mode' in terms ? terms : { fee_minor: fee, rate_bp: rate };
  const showEstimate = Boolean(shift || pointTerms || (point && day === point.today));
  const earned = showEstimate && !exceedsLimit ? calculatePay(total, rate, fee, terms) : null;
  const m = useMutation({
    networkMode: 'always',
    mutationFn: async () => {
      const note = comment.trim() || null;
      const target = shift ? { shiftId: shift.id, revision: shift.revision } : { locationId, day };
      const amounts = { cash: cash || '0', card: card || '0' };
      const response = returned !== initialReturn
        ? await recordShiftReturn(userId, target, { ...amounts, returned: returned ?? '0', comment: note })
        : shift ? await shiftClose(userId, shift.id, amounts.cash, amounts.card, note, shift.revision)
          : await shiftSubmit(userId, locationId, day, amounts.cash, amounts.card, note);
      return { response, key, currency, earned, day, pointName: point?.location_name ?? shift?.location_name };
    },
    onSuccess: onDone,
    onError:()=>void qc.invalidateQueries({queryKey:['staff']}),
  });
  const canSave = !readOnly && Boolean(key) && !restriction && !blocked(key) && hasSalesInput && cashValid && cardValid
    && !exceedsLimit && validShiftReturn(returned, returnValid) && (total !== 0n || zero);
  const submit = () => { if (canSave && !m.isPending) m.mutate(); };
  const dirty = cash !== initialCash || card !== initialCard || !cashValid || !cardValid || returned !== initialReturn || zero || comment !== (shift?.comment ?? '');
  return (
    <ConfirmDialog open className="staff-close-dialog" title={editing ? t('Исправить смену', 'Vardiyayı düzelt') : t('Закрыть смену', 'Vardiyayı kapat')} confirmLabel={editing ? t('Сохранить', 'Kaydet') : t('Закрыть смену', 'Vardiyayı kapat')} busy={m.isPending} error={m.error}
      disabled={!canSave} dirty={dirty} onClose={onClose} onConfirm={submit}>
      {readOnly && <p role="status">{t('Кабинет доступен для просмотра. Отправка смен приостановлена.', 'Hesap görüntülemeye açık. Vardiya gönderimi durduruldu.')}</p>}
      {shift ? <p className="muted">{dayLabel(shift.day, locale)}{shift.location_name ? `, ${shift.location_name}` : ''}</p> : <>
        {(points.length > 1 || (!point && points.length > 0)) ? <Field label={t('Торговая точка', 'Mağaza')} required>{id => (
          <Select id={id} value={point ? locationId : ''} disabled={m.isPending} onChange={event => {
            setLocationId(event.target.value);
            setSelectedDay(points.find(item => item.location_id === event.target.value)?.dates[0] ?? '');
          }}>
            <option value="">{t('Выберите точку', 'Mağaza seçin')}</option>
            {points.map(item => <option key={item.location_id} value={item.location_id}>{item.location_name}</option>)}
          </Select>
        )}</Field> : point && <p className="muted">{point.location_name}</p>}
        {point && <Field label={t('Дата смены', 'Vardiya tarihi')} required error={restriction || undefined}>{(id, describedBy) => (
          <Input id={id} type="date" aria-describedby={describedBy} value={selectedDay} min={point.opened_on ?? undefined}
            max={point.today} disabled={m.isPending} onChange={event => setSelectedDay(event.target.value)} />
        )}</Field>}
        {points.length === 0 && <p className="muted">{t('Доступных дат для сдачи смены больше нет. Проверьте статус точки.', 'Vardiya girebileceğiniz tarih kalmadı. Mağazanın durumunu kontrol edin.')}</p>}
      </>}
      <p className="faint staff-payment-hint">{t('Пустое поле равно нулю. Заполните хотя бы одно.', 'Boş alan sıfır sayılır. En az bir alanı doldurun.')}</p>
      <div className="staff-payments">
        <Field label={t('Наличные', 'Nakit')} error={!cashValid ? t('Укажите сумму наличными.', 'Nakit tutarını girin.') : undefined}>{(id, describedBy) => (
          <MoneyInput id={id} describedBy={describedBy} value={cash} onChange={value => { setCash(value); setZero(false); }} preserveBlank onValidityChange={setCashValid} onEnter={() => cardInput.current?.focus()} enterKeyHint="next" currency={currency} placeholder="0" disabled={m.isPending || readOnly} />
        )}</Field>
        <Field label={t('Картой', 'Kart')} error={!cardValid ? t('Укажите сумму по карте.', 'Kart tutarını girin.') : undefined}>{(id, describedBy) => (
          <MoneyInput id={id} inputRef={el => { cardInput.current = el; }} describedBy={describedBy} value={card} onChange={value => { setCard(value); setZero(false); }} preserveBlank onValidityChange={setCardValid} onEnter={() => commentInput.current?.focus()} enterKeyHint="next" currency={currency} placeholder="0" disabled={m.isPending || readOnly} />
        )}</Field>
      </div>
      <ShiftReturnField currency={currency} value={returned} onChange={setReturned} valid={returnValid}
        onValidityChange={setReturnValid} busy={m.isPending} />
      {hasSalesInput && cashValid && cardValid && total === 0n && <Checkbox label={t('Продаж за смену не было', 'Bu vardiyada satış yapılmadı')} checked={zero} onChange={setZero} />}
      {editing && <p className="faint">{t('Выручку можно исправить в течение 5 минут после первой сдачи. Позже обратитесь к руководителю.', 'Ciroyu ilk kayıttan sonraki 5 dakika içinde düzeltebilirsiniz. Bu süreden sonra yöneticinizle görüşün.')}</p>}
      {exceedsLimit ? <p className="danger-text" role="alert">{t(`Сумма смены не может превышать ${formatMoneyShort(maxShiftTotal, currency, locale)}.`, `Vardiya tutarı en fazla ${formatMoneyShort(maxShiftTotal, currency, locale)} olabilir.`)}</p> :
        <div className="day-total-line"><span>{t('Выручка смены', 'Vardiya cirosu')}</span><Money minor={total} currency={currency} strong /></div>}
      {(shift?.counts_as_exit === false || terms?.additional_point) && <p className="faint">{t('Выход за эту дату уже учтён на другой точке.', 'Bu tarihin vardiya ücreti başka bir mağazada hesaplandı.')}</p>}
      {earned !== null ? <>
        <div className="earn-line"><span>{t('Ожидаемое начисление', 'Tahmini kazanç')}</span><Money minor={earned} currency={currency} strong /></div>
        <p className="faint">{terms && !('mode' in terms) ? t('Больше из гарантированного минимума и процента от выручки, плюс премия', 'Asgari ücret ile ciro priminden yüksek olan tutar, artı bonus') : fixedTerms(fixed, currency, locale)}</p>
      </> : point && !exceedsLimit && <p className="faint">{t('Начисление за выбранную дату появится после сохранения.', 'Seçilen tarihin kazancı kayıttan sonra görünür.')}</p>}
      <Field label={t('Комментарий', 'Not')}>{(id) => <Input id={id} ref={commentInput} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('Необязательно', 'İsteğe bağlı')} />}</Field>
    </ConfirmDialog>
  );
}

type PointRevenue = (month: string) => ReactNode;

export function StaffHome({ pointRevenue }: { pointRevenue?: PointRevenue } = {}) {
  const { me } = useSession();
  return me && <StaffShifts key={me.user.id} userId={me.user.id} pointRevenue={pointRevenue} />;
}

type QueueSnapshot = Awaited<ReturnType<typeof queuedOps>>;
type SavedShift = { shift: Shift; currency: string; pointName?: string };
type QueuedShift = Omit<ShiftSubmission, 'response'> & { previousQueue: QueueSnapshot | undefined };
type ShiftResult = { saved: SavedShift; queued?: never } | { saved?: never; queued: QueuedShift };

function ShiftReceipt({ day, pointName, amount, currency, queued = false, announce = false, children }: {
  day: string; pointName?: string; amount: MinorInput | null; currency: string; queued?: boolean; announce?: boolean; children?: ReactNode;
}) {
  const { t, locale } = useLocale();
  const receipt = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!announce) return;
    receipt.current?.focus({ preventScroll: true });
    receipt.current?.scrollIntoView({ block: 'nearest' });
  }, [announce]);
  return <article ref={receipt} tabIndex={announce ? -1 : undefined} className="shift-receipt" data-state={queued ? 'queued' : 'closed'}>
    <div className="shift-receipt-summary" role={announce ? 'status' : undefined}>
      <div className="shift-receipt-identity">
        <strong>{!queued && <Check size={16} aria-hidden />}{queued ? t('Итог сохранён на телефоне', 'Vardiya bu cihazda kaydedildi') : t('Смена закрыта', 'Vardiya kapatıldı')}</strong>
        <time dateTime={day}>{dayLabel(day, locale)}</time>
        {pointName && <span>{pointName}</span>}
      </div>
      {amount !== null && <div className="shift-receipt-pay">
        <span>{queued ? t('Расчётное начисление', 'Tahmini kazanç') : t('Начислено', 'Tahakkuk eden kazanç')}</span>
        <Money minor={amount} currency={currency} short strong />
      </div>}
      {queued && <p className="faint">{t('Отправится при подключении к интернету.', 'İnternet bağlantısı kurulunca gönderilecek.')}</p>}
    </div>
    {children}
  </article>;
}

function closedReceipts(home: StaffHomeData, saved?: SavedShift) {
  const receipts = new Map<string, SavedShift>();
  for (const point of home.locations) {
    const corrections = [point.my_yesterday, ...(point.recent_corrections ?? [])].filter(shift => shift && canCorrect(shift));
    for (const shift of [point.my_today, ...corrections]) {
      if (shift?.status === 'closed' && (receipts.get(shift.id)?.shift.revision ?? -1) <= shift.revision) {
        receipts.set(shift.id, { shift, currency: point.currency, pointName: point.location_name });
      }
    }
  }
  if (saved && (receipts.get(saved.shift.id)?.shift.revision ?? -1) < saved.shift.revision) receipts.set(saved.shift.id, saved);
  return [...receipts.values()].sort((a, b) => b.shift.day.localeCompare(a.shift.day));
}

function ShiftHistory({ userId, current, pointRevenue }: { userId: string; current?: StaffHomeData; pointRevenue?: PointRevenue }) {
  const { t } = useLocale();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const currentMonth = current?.month ?? monthStart();
  const firstOfMonth = current?.today?.endsWith('-01');
  const defaultMonth = firstOfMonth ? shiftMonth(currentMonth, -1) : currentMonth;
  const month = selectedMonth ?? defaultMonth;
  const currentView = month === currentMonth;
  const history = useQuery({
    queryKey: ['staff', 'history', userId, month],
    enabled: !currentView,
    queryFn: () => staffHome(month),
    refetchInterval: 120_000,
  });
  const compact = Boolean(pointRevenue);
  const content = (
    <>
      <MonthNav month={month} max={currentMonth} onChange={setSelectedMonth} />
      {currentView ? current && <ShiftMonth data={current} current compact={compact} /> : history.isPaused && !history.data
        ? <p className="faint" role="status">{t('Для загрузки этого месяца нужна связь.', 'Bu ayı yüklemek için internet bağlantısı gerekiyor.')}</p>
        : <DataState query={history}>{(data) => <ShiftMonth data={data} compact={compact} />}</DataState>}
      {pointRevenue?.(month)}
    </>
  );
  return compact ? <Card title={<h2 className="card-title" data-tour-target="payroll-history">{t('Итоги месяца', 'Ay özeti')}</h2>} className="team-monthly">{content}</Card> : (
    <section className="staff-history">
      <h2 className="section-title" data-tour-target="payroll-history">{t('Мои смены и начисления', 'Vardiyalarım ve kazancım')}</h2>
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
  const { t, locale } = useLocale();
  const shiftCount = `${d.month_shifts} ${d.month_shifts % 10 === 1 && d.month_shifts % 100 !== 11 ? 'смена' : [2, 3, 4].includes(d.month_shifts % 10) && ![12, 13, 14].includes(d.month_shifts % 100) ? 'смены' : 'смен'}`;
  const revenue = formatMoneyShort(d.month_revenue_minor, d.currency, locale);
  const activity = t(`${shiftCount} · выручка смен ${revenue}`, `${d.month_shifts} vardiya · ciro ${revenue}`);
  const fixed = d.pay_policy && 'mode' in d.pay_policy ? d.pay_policy : { fee_minor: d.shift_fee_minor, rate_bp: d.rate_bp };
  const terms = current && (d.pay_policy && !('mode' in d.pay_policy)
    ? t('По ступеням кассы: минимум или процент, плюс премия', 'Ciro kademesine göre: asgari tutar veya ciro yüzdesi, artı bonus')
    : fixedTerms(fixed, d.currency, locale));
  const shifts = d.shifts.length ? (
    <ul className="staff-history-list">
      {d.shifts.map((s) => (
        <li key={s.id} className="staff-history-row">
          <div className="staff-history-details">
            <strong>{dayLabel(s.day, locale)}</strong>
            {s.location_name && <span>{s.location_name}</span>}
            <span>{t('Выручка', 'Ciro')} <Money minor={s.total_minor} currency={d.currency} short /></span>
            {s.counts_as_exit === false && <span>{t('Дополнительная точка', 'Ek mağaza')}</span>}
            {s.return_minor ? <span>{t('Возврат', 'İade')} <Money minor={s.return_minor} currency={d.currency} short /></span> : null}
          </div>
          <Money minor={s.earned_minor ?? 0} currency={d.currency} short strong />
        </li>
      ))}
    </ul>
  ) : <p className="faint">{t('Закрытых смен в этом месяце пока нет.', 'Bu ay henüz kapanmış vardiya yok.')}</p>;
  const schedule = <PayrollSchedule month={d.month} amounts={splitPayroll(d.month, d.shifts)} currency={d.currency} />;
  if (compact) return <div className="stack">
    <MonthlyDetails label={t('Мои начисления', 'Kazancım')} total={d.month_earned_minor} currency={d.currency}>
      {(d.month_shifts > 0 || d.shifts.length > 0) && <p className="faint">{activity}</p>}
      {terms && <p className="faint">{terms}</p>}
      {shifts}
    </MonthlyDetails>
    {schedule}
  </div>;
  return (
    <>
      <div className="earn-card staff-month-summary" aria-label={t('Начислено за месяц', 'Aylık kazanç')}>
        <div className="staff-month-total">
          <span>{t(`Начислено за ${monthLabel(d.month, false)}`, `${monthLabel(d.month, false, locale)} ayı kazancı`)}</span>
          <Money minor={d.month_earned_minor} currency={d.currency} short strong />
        </div>
        {(d.month_shifts > 0 || d.shifts.length > 0) && <span className="faint">{activity}</span>}
        {terms && <span className="faint">{terms}</span>}
      </div>
      {schedule}
      {d.shifts.length ? <details className="staff-history-fold"><summary>{t('Смены за месяц', 'Aylık vardiyalar')}</summary>{shifts}</details> : shifts}
    </>
  );
}

function StaffShifts({ userId, pointRevenue }: { userId: string; pointRevenue?: PointRevenue }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const { t, locale, language } = useLocale();
  const { readOnly: partnerPaused } = useOwnPartnerLifecycle();
  const mayCloseShifts = can('shift.work');
  const readOnly = partnerPaused || !mayCloseShifts;
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
  const queuedShift = (key: string) => pending.data?.some(op => (op.kind === 'shift_submit' ||
    (op.kind === 'shift_record_with_return' && !op.payload.shift))
    ? targetKey(String(op.payload.location), String(op.payload.day)) === key : op.payload.shift === key);
  const [closing, setClosing] = useState<{ shift?: Shift; locationId?: string; day?: string } | null>(null);
  const [result, setResult] = useState<ShiftResult | null>(null);
  const queuedResult = result?.queued;
  // A cached empty queue can predate the write. Only a later successful read can retire this result.
  const queueResolved = !!queuedResult && pending.isSuccess && pending.data !== queuedResult.previousQueue && !queuedShift(queuedResult.key);
  const shiftRefreshed = queueResolved && !q.isFetching;
  useEffect(() => {
    if (shiftRefreshed) setResult(current => current?.queued === queuedResult ? null : current);
  }, [shiftRefreshed, queuedResult]);
  const shownQueued = queueResolved ? undefined : queuedResult;
  const saved = result?.saved;
  const shiftBlocked = (key: string) => !pending.isSuccess || Boolean(queuedShift(key)) || (queuedResult?.key === key && !shiftRefreshed);
  const dateBlocked = (key: string) => shiftBlocked(key) || Boolean(saved && key === targetKey(saved.shift.location_id, saved.shift.day));
  const available = q.data?.locations.map(point => ({ ...point, dates: availableDates(point, q.data.shifts, dateBlocked) }))
    .filter(point => !point.awaiting_opening_date && (!point.opened_on || point.opened_on <= point.today)) ?? [];
  const cancel = useMutation({ mutationFn: shiftCancel, onSuccess: () => {setCancelling(null);void qc.invalidateQueries({ queryKey: ['staff'] });} });

  return (
    <div className="home staff-home">
      <header className="home-head">
        <div className="home-date">{new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>{t('Смена', 'Vardiya')}</h1>
      </header>

      <div className="home-body">
        <DataState query={q} skeleton={4}>
          {(d) => {
            const openShift = d.open_shift?.id === saved?.shift.id ? null : d.open_shift;
            const receipts = closedReceipts(d, saved);
            const queuedConfirmed = shownQueued && receipts.some(({ shift }) => shownQueued.key === shift.id || shownQueued.key === targetKey(shift.location_id, shift.day));
            const gaps = d.locations.filter(point => point.missing_periods?.length);
            return (
              <>
                {readOnly ? <div className="alert tone-info" role="status">
                  <div className="alert-body">{mayCloseShifts
                    ? t('Кабинет доступен для просмотра. Отправка смен приостановлена.', 'Hesap görüntülemeye açık. Vardiya gönderimi durduruldu.')
                    : t('Вы можете смотреть свои начисления. Для закрытия смен обратитесь к франчайзи.', 'Kazancınızı görüntüleyebilirsiniz. Vardiyayı kapatmak için işletme sahibinizle görüşün.')}
                  {openShift && <p>{t('Незакрытая смена', 'Açık vardiya')} · {openShift.location_name} · {formatDate(openShift.day, locale)}</p>}
                  </div>
                </div> : openShift ? (
                  <section className="shift-card" aria-label={t('Открытая смена', 'Açık vardiya')}>
                    <div className="shift-label">{t('Незакрытая смена', 'Açık vardiya')}</div>
                    <div className="staff-open-details"><span>{dayLabel(openShift.day, locale)}</span><span>{openShift.location_name}</span></div>
                    {d.locations.find(l => l.location_id === openShift.location_id)?.today !== openShift.day && <p className="danger-text">{t('Укажите выручку за дату открытой смены. Если открыли её по ошибке, отмените открытие.', 'Açık vardiyanın tarihine ait ciroyu girin. Vardiyayı yanlışlıkla açtıysanız iptal edin.')}</p>}
                    <Button variant="primary" block className="btn-lg" data-tour-target="shift-close" disabled={shiftBlocked(openShift.id)} onClick={() => setClosing({ shift: openShift })}>
                      {t('Закрыть смену и внести выручку', 'Vardiyayı kapat ve ciroyu gir')}
                    </Button>
                    <button type="button" className="link-btn" disabled={shiftBlocked(openShift.id)} onClick={() => setCancelling(openShift)}>{t('Открыл по ошибке — отменить', 'Yanlış açılan vardiyayı iptal et')}</button>
                  </section>
                ) : d.locations.length ? (
                  <section className="stack" aria-label={t('Смены сегодня', 'Bugünkü vardiyalar')}>
                    {available.length > 0 && <Button disabled={!pending.isSuccess} variant="primary" block className="btn-lg" data-tour-target="shift-close" onClick={() => setClosing({})}>{t('Закрыть смену', 'Vardiyayı kapat')}</Button>}
                    {d.locations.map(point => {
                      if (available.some(item => item.location_id === point.location_id)) return null;
                      const restriction = shiftDateRestriction(point, point.today, language) ?? shiftDateRestriction(point, addDays(point.today, -1), language);
                      return restriction && <p key={point.location_id} className="muted">{point.location_name} · {restriction}</p>;
                    })}
                  </section>
                ) : <EmptyState title={t('Вам пока не назначены точки', 'Henüz atanmış mağazanız yok')} text={t('Попросите франчайзи добавить вас на точку.', 'İşletme sahibinizden sizi bir mağazaya atamasını isteyin.')} />}

                {shownQueued && !queuedConfirmed && <ShiftReceipt day={shownQueued.day} pointName={shownQueued.pointName}
                  amount={shownQueued.earned} currency={shownQueued.currency} queued announce />}
                {!readOnly && !openShift && receipts.map(({ shift, currency, pointName }) => (
                  <ShiftReceipt key={shift.id} day={shift.day} pointName={pointName} amount={shift.earned_minor}
                    currency={currency} announce={saved?.shift.id === shift.id}>
                    {canCorrect(shift) && <Button size="sm" disabled={shiftBlocked(shift.id) || shiftBlocked(targetKey(shift.location_id, shift.day))}
                      onClick={() => setClosing({ shift: { ...shift, location_name: pointName } })}>{t('Исправить смену', 'Vardiyayı düzelt')}</Button>}
                  </ShiftReceipt>
                ))}

                {!readOnly && gaps.length > 0 && <section className="staff-calendar" aria-label={t('Дни без выручки', 'Ciro kaydı eksik günler')}>
                  <h2 className="section-title">{t('Дни без выручки', 'Ciro kaydı eksik günler')}</h2>
                  {gaps.map(point => (
                    <details className="shift-gaps" key={point.location_id}>
                      <summary>
                        <span className="shift-gaps-icon"><CalendarDays size={19} aria-hidden /></span>
                        <span className="shift-gaps-title"><strong>{point.location_name}</strong>
                          <span>{point.missing_count ? t(`Нет выручки за ${point.missing_count} дн.`, `${point.missing_count} günün ciro kaydı eksik`) : t('Пропущенные дни', 'Eksik günler')}</span></span>
                        <ChevronDown className="shift-gaps-chevron" size={18} aria-hidden />
                      </summary>
                      <div className="shift-gaps-content">
                        <p>{openShift ? t('Сначала закройте открытую смену.', 'Önce açık vardiyayı kapatın.') : t('Если вы работали в эти дни, выберите дату своей смены.', 'Bu günlerde çalıştıysanız vardiya tarihinizi seçin.')}</p>
                        <ul>
                          {point.missing_periods!.map(period => {
                            const label = formatDate(period.from, locale) + (period.until === period.from ? '' : ` — ${formatDate(period.until, locale)}`);
                            return <li key={period.from}>{openShift ? <span>{label}</span> :
                              <button type="button" disabled={!pending.isSuccess}
                                onClick={() => setClosing({ locationId: point.location_id, day: period.from })}>
                                {label}<ChevronRight size={16} aria-hidden />
                              </button>}</li>;
                          })}
                        </ul>
                      </div>
                    </details>
                  ))}
                </section>}

                <ActionError error={cancel.error} />
                {pending.isError && <Alert tone="danger" title={t('Не удалось проверить очередь смен', 'Vardiya kuyruğu kontrol edilemedi')}
                  action={<Button size="sm" onClick={() => void pending.refetch()}>{t('Повторить', 'Tekrar dene')}</Button>} />}
                {!shownQueued && pending.data?.some(op => (op.kind === 'shift_submit' || op.kind === 'shift_record_with_return' ||
                  op.payload.shift === d.open_shift?.id && d.open_shift) && !op.lastError) && <p role="status">{t('Итог ожидает отправки. Экран обновится после подтверждения сервера.', 'Vardiya gönderilmeyi bekliyor. Sunucu onayladığında ekran güncellenecek.')}</p>}

                {!pointRevenue && <ShiftHistory userId={userId} current={d} />}
              </>
            );
          }}
        </DataState>
        {pointRevenue && <ShiftHistory userId={userId} current={q.data} pointRevenue={pointRevenue} />}
      </div>
      {cancelling && <ConfirmDialog open title={t('Отменить ошибочное открытие?', 'Yanlış açılan vardiya iptal edilsin mi?')}
        confirmLabel={t('Отменить открытие', 'Vardiyayı iptal et')} cancelLabel={t('Вернуться', 'Geri dön')}
        busy={cancel.isPending} disabled={readOnly} error={cancel.error} onClose={() => setCancelling(null)} onConfirm={() => cancel.mutate(cancelling.id)}>
        <p>{cancelling.location_name} · {dayLabel(cancelling.day, locale)}</p>
        <p>{t('Можно отменить пустую открытую смену. Учтённая выручка сохранится.', 'Yalnızca boş ve açık bir vardiya iptal edilebilir. Kayıtlı ciro korunur.')}</p>
      </ConfirmDialog>}
      {closing && q.data && (
        <CloseDialog userId={userId} shift={closing.shift} initialPoint={closing.locationId} initialDay={closing.day} home={q.data} readOnly={readOnly} points={closing.shift ? [] : available} blocked={dateBlocked}
          currency={q.data.locations.find(point => point.location_id === closing.shift?.location_id)?.currency ?? q.data.currency}
          policy={q.data.pay_policy} rate={closing.shift?.rate_bp ?? q.data.rate_bp} fee={closing.shift?.shift_fee_minor ?? q.data.shift_fee_minor}
          onClose={() => setClosing(null)}
          onDone={({ response, ...submitted }) => {
            setClosing(null);
            setResult('queued' in response
              ? { queued: { ...submitted, previousQueue: qc.getQueryData<QueueSnapshot>(queueKey) } }
              : { saved: { shift: response.shift, currency: response.currency ?? submitted.currency, pointName: response.shift.location_name ?? submitted.pointName } });
            for (const name of ['staff', 'staff-list', 'team-revenue', 'revenue', 'finance', 'manager-economy', 'royalty', 'rating']) {
              void qc.invalidateQueries({ queryKey: [name] });
            }
          }} />
      )}
    </div>
  );
}
