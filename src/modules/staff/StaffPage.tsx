import { Link, useSearchParams } from 'react-router';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { command, from, rows, toAppError } from '../../platform/backend';
import { dayLabel, formatDate, monthStart } from '../../platform/dates';
import { formatMoneyShort, minorToDecimal, sumMinor, type MinorInput } from '../../platform/money';
import { sameJson } from '../../platform/offline';
import { useSession } from '../../platform/session';
import { ActionError, Badge, Button, Card, Checkbox, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, KV, MoneyInput, PageHeader, Select } from '../../ui';
import { CopyCredential, CredentialFields } from '../../ui/CredentialFields';
import { useToast } from '../../ui/toast';
import { CustomPayFields, currencySymbol, customPayDraft, customPayPolicy, maxPolicyMinor, percentToBp, tierPolicy, validPolicyMoney } from './CustomPayFields';
import { MotivationPanel, PayExample, payTiming, teamPolicyForDate, useMotivation, type ShiftPolicy } from './Motivation';
import { ShiftReview, useOpenShifts } from './ShiftReview';
import { ClosedShiftCorrection, payrollShiftTime } from './ClosedShiftCorrection';
import { PhoneLoginDialog } from './PhoneLoginDialog';
import { MonthNav } from '../revenue/components';
import { FRANCHISEE_CARD_AMBIGUITY, franchiseePartnerCards } from '../revenue/partnerLifecycle';
import { formatPhone, pctBp, randomPassword, staffList, staffPaySave, staffSetActive, userSetPassword, type StaffAccess, type StaffPosition, type PayrollShift, type StaffRow } from './api';
import { phoneLoginDigits } from '../../platform/login';
import { NewAccountCredentials } from './NewAccountCredentials';
import { PayrollSchedule } from './PayrollSchedule';
import { payrollPeriodLabel, payrollPeriods, splitPayroll } from './payrollPeriods';

interface Loc { id: string; name: string; currency: string; status: string }
const locationsOf = (partner: string) => rows<Loc>(from('location').select('id, name, currency, status').eq('partner_id', partner).order('name'));

const cardSections = [
  { id: 'profile', label: 'Основное' },
  { id: 'pay', label: 'Оплата' },
  { id: 'login', label: 'Вход' },
] as const;
type CardSection = (typeof cardSections)[number]['id'];
type PayMode = 'partner' | 'fixed' | 'custom';

const payChoices = [
  { id: 'partner', title: 'Общая схема', hint: 'Гарантия, процент и премии по ступеням франчайзи.' },
  { id: 'fixed', title: 'Фикс + процент', hint: 'За каждый выход — ставка плюс доля выручки смены.' },
  { id: 'custom', title: 'Свои ступени', hint: 'Своя гарантия, пороги выручки, проценты и премии.' },
] as const;

const positionLabels: Record<StaffPosition, string> = { sales_manager: 'Менеджер продаж', trainee: 'Стажёр', manager: 'Управляющий' };
const accessLabels: Record<keyof StaffAccess, string> = { view_staff: 'Видеть сотрудников', create_staff: 'Добавлять сотрудников', procurement: 'Закупки', manage_pay: 'Редактировать оплату сотрудников' };
const defaultAccess = { view_staff: false, create_staff: false, procurement: false };
const legacyManagerAccess = { view_staff: true, create_staff: true, procurement: true };
const accessKeys = Object.keys(accessLabels) as (keyof StaffAccess)[];

function positionOf(staff?: StaffRow): StaffPosition {
  return staff?.position ?? (staff?.is_manager ? 'manager' : staff?.employee_kind === 'trainee' ? 'trainee' : 'sales_manager');
}

function payModeOf(staff?: StaffRow): PayMode {
  if (staff?.use_partner_motivation !== false) return 'partner';
  return staff.custom_pay ? 'custom' : 'fixed';
}

function payTerms(staff: StaffRow, currency: string) {
  if (payModeOf(staff) === 'partner') return 'Общая схема франчайзи';
  if (staff.custom_pay) return `Свои ступени · ${staff.custom_pay.name}`;
  return [staff.shift_fee_minor && `${formatMoneyShort(staff.shift_fee_minor, currency)} за смену`,
    staff.rate_bp && `${pctBp(staff.rate_bp)} от выручки`].filter(Boolean).join(' + ') || 'Фикс и процент равны нулю';
}

function StaffDialog({ partnerId, locations, staff, canSetAccess, canSetCustomPay, initialSection = 'profile', onClose, onChangeAccess }: {
  partnerId: string; locations: UseQueryResult<Loc[]>; staff?: StaffRow; canSetAccess: boolean; canSetCustomPay: boolean; initialSection?: CardSection;
  onClose: () => void; onChangeAccess: (staff: StaffRow, dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [section, setSection] = useState(initialSection);
  const payOnly = Boolean(staff && initialSection === 'pay');
  const [loginAction, setLoginAction] = useState<'phone' | 'password' | null>(null);
  const common = useMotivation(partnerId, canSetCustomPay && section === 'pay');
  const currency = common.data?.currency ?? locations.data?.[0]?.currency ?? 'RUB';
  const unit = currencySymbol(currency);
  const activeLocs = (locations.data ?? []).filter((l) => l.status === 'active');
  const availableLocs = (locations.data ?? []).filter((l) => l.status === 'active' || staff?.location_ids.includes(l.id));
  const initialLocations = staff?.location_ids ?? (activeLocs.length === 1 ? [activeLocs[0].id] : []);
  const [initialPosition] = useState(() => positionOf(staff));
  const [initialAccess] = useState<StaffAccess>(() => staff?.access ?? (initialPosition === 'manager' ? legacyManagerAccess : defaultAccess));
  const [payRevision] = useState(staff?.pay_revision);
  const [initialPayStart] = useState(() => staff?.pay_scheduled?.find(v => v.effective_from === staff.pay_effective_from)?.effective_from ?? '');
  const [payStart, setPayStart] = useState(initialPayStart);
  const [initialPayMode] = useState(() => payModeOf(staff));
  const [initialCustomPay] = useState(() => staff?.custom_pay);
  const [initialPassword] = useState(randomPassword);
  const [name, setName] = useState(staff?.full_name ?? '');
  const [payMode, setPayMode] = useState<PayMode>(initialPayMode);
  const [position, setPosition] = useState(initialPosition);
  const [access, setAccess] = useState(initialAccess);
  const [formula, setFormula] = useState(() => customPayDraft(initialCustomPay));
  const [start, setStart] = useState(staff?.internship_from ?? '');
  const [until, setUntil] = useState(staff?.internship_until ?? '');
  const [traineeFee, setTraineeFee] = useState(String(staff?.internship_floor_minor ?? 50000));
  const [traineeFeeParsed, setTraineeFeeParsed] = useState(true);
  const validTraineeFee = validPolicyMoney({ minor: traineeFee, valid: traineeFeeParsed });
  const [learningEnabled, setLearningEnabled] = useState(staff?.learning_enabled ?? true);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState(initialPassword);
  const [sel, setSel] = useState(initialLocations);
  const [rate, setRate] = useState(staff ? String(staff.rate_bp / 100).replace('.', ',') : '');
  const [fee, setFee] = useState(staff ? String(staff.shift_fee_minor) : '');
  const [validFee, setValidFee] = useState(true);
  const [created, setCreated] = useState<{ phone: string; password: string } | null>(null);
  const digits = phoneLoginDigits(phone);
  const bp = percentToBp(rate);
  const customPolicy = payMode === 'custom' ? customPayPolicy(formula) : null;
  const commonTerms = canSetCustomPay && !common.error ? common.data : undefined;
  const teamPolicy = commonTerms && teamPolicyForDate(commonTerms, payStart);
  const previewForDate = !payStart || payStart === commonTerms?.today || Boolean(commonTerms?.history && commonTerms.baseline);
  const payPreview: ShiftPolicy | null = payMode === 'partner' ? previewForDate && teamPolicy || null
    : payMode === 'custom' ? customPolicy ?? tierPolicy(formula)
    : validFee && bp !== null && Number.isSafeInteger(Number(fee)) ? { mode: 'legacy', rate_bp: bp, fee_minor: Number(fee) } : null;
  const formulaChanged = payMode === 'custom' && (!customPolicy || !sameJson(customPolicy, initialCustomPay));
  const positionChanged = position !== initialPosition;
  const managerPositionChanged = positionChanged && (position === 'manager' || initialPosition === 'manager');
  const accessChanged = accessKeys.some(key => Boolean(access[key]) !== Boolean(initialAccess[key]));
  const kind = !positionChanged && staff?.employee_kind ? staff.employee_kind : position === 'trainee' ? 'trainee' : 'employee';
  const validDates = !until || !start || until >= start;
  const selectedLocations = sel.filter((id) => availableLocs.some((l) => l.id === id));
  const validProfile = Boolean(locations.data && !locations.error && name.trim() && selectedLocations.length && (staff || (digits && password.length >= 6))
    && (kind !== 'trainee' || validDates));
  const currencyReady = Boolean(common.data?.currency || locations.data?.[0]?.currency);
  const validPay = (payMode !== 'fixed' || (validFee && bp !== null)) && (payMode !== 'custom' || Boolean(customPolicy))
    && (kind !== 'trainee' || validTraineeFee);
  const dirty = name !== (staff?.full_name ?? '') || phone !== '' || password !== initialPassword
    || sel.length !== initialLocations.length || sel.some((id) => !initialLocations.includes(id))
    || positionChanged || accessChanged || learningEnabled !== (staff?.learning_enabled ?? true)
    || (kind === 'trainee' && (start !== (staff?.internship_from ?? '') || until !== (staff?.internship_until ?? '')
      || traineeFee !== String(staff?.internship_floor_minor ?? 50000) || !validTraineeFee))
    || payStart !== initialPayStart || payMode !== initialPayMode
    || formulaChanged
    || (payMode === 'fixed' && (bp !== (staff?.rate_bp ?? 0) || Number(fee) !== (staff?.shift_fee_minor ?? 0) || !validFee));
  const m = useMutation({
    mutationFn: async () => {
      if (payOnly && staff) {
        if (payRevision === undefined) throw new Error('Обновите карточку, чтобы получить актуальные условия оплаты.');
        await staffPaySave({
          partner: partnerId, user: staff.user_id, use_partner: payMode === 'partner',
          rate_bp: payMode === 'fixed' ? bp ?? 0 : staff.rate_bp,
          shift_fee: payMode === 'fixed' ? fee || '0' : String(staff.shift_fee_minor),
          custom_pay: payMode === 'custom' ? customPolicy : payMode === 'partner' ? initialCustomPay ?? null : null,
          pay_effective_from: payStart || null, expected_pay_revision: payRevision,
          internship_floor_minor: kind === 'trainee' ? traineeFee : null,
        });
        return;
      }
      const submittedPassword = password;
      const settings = {
        ...(payRevision !== undefined ? { expected_pay_revision: payRevision } : {}),
        ...(payStart ? { pay_effective_from: payStart } : {}),
        employee_kind: kind, internship_from: start || null, internship_until: until || null,
        internship_floor_minor: traineeFee, learning_enabled: learningEnabled,
        ...(canSetAccess && (!staff || positionChanged) ? { position } : {}),
        ...(canSetAccess && (!staff || managerPositionChanged || accessChanged) ? {
          access: { ...access, ...(position !== 'manager' && access.manage_pay ? { manage_pay: false } : {}) },
        } : {}),
        ...(payMode === 'custom' && (formulaChanged || payMode !== initialPayMode) ? { custom_pay: customPolicy } : {}),
        ...(payMode === 'fixed' && payMode !== initialPayMode ? { custom_pay: null } : {}),
      };
      await command('staff_profile_save_phone', {
        user: staff?.user_id ?? null, partner: partnerId, full_name: name.trim(), phone, password: submittedPassword,
        locations: selectedLocations, use_partner: payMode === 'partner',
        rate_bp: payMode === 'fixed' ? bp ?? 0 : staff?.rate_bp ?? 0,
        shift_fee: payMode === 'fixed' ? fee || '0' : String(staff?.shift_fee_minor ?? 0),
        settings,
      });
      if (!staff && digits) setCreated({ phone: formatPhone(digits), password: submittedPassword });
    },
    onError: error => {
      if (toAppError(error).code === 'version-conflict') void qc.invalidateQueries({ queryKey: ['staff-list', partnerId] });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff-list', partnerId] });
      void qc.invalidateQueries({ queryKey: ['team', partnerId] });
      void qc.invalidateQueries({ queryKey: ['staff-access-history', partnerId] });
      if (staff) { toast(payOnly ? 'Условия оплаты сохранены' : 'Карточка сотрудника сохранена'); onClose(); }
    },
  });
  if (created) return <NewAccountCredentials title="Сотрудник добавлен" {...created} onClose={onClose} />;
  const editable = !staff || staff.active;
  const showSave = editable && (section !== 'login' || (canSetAccess && (!staff || dirty)));
  return (
    <>
      <ConfirmDialog open title={payOnly ? 'Условия оплаты' : staff ? 'Карточка' : 'Новый сотрудник'} cancelLabel={staff ? 'Закрыть' : undefined}
        confirmLabel={showSave ? (staff ? 'Сохранить' : 'Добавить сотрудника') : undefined} busy={m.isPending} error={m.error}
        disabled={!editable || (payOnly ? !dirty || payRevision === undefined || !currencyReady : !validProfile) || !validPay} dirty={editable && dirty} onClose={onClose} onConfirm={() => m.mutate()}>
        {staff && <p style={{ marginBottom: 'var(--space-3)', overflowWrap: 'anywhere' }}><strong>{staff.full_name}</strong></p>}
        {!payOnly && <Chips options={cardSections.filter(item => item.id !== 'login' || staff || canSetAccess)} value={section} onChange={setSection} label="Настройки сотрудника" />}
        {!payOnly && <div hidden={!editable || section !== 'profile'}>
          <Field label="Имя" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Например, Дина" maxLength={160} />}</Field>
          {!staff && (
            <div className="grid grid-2" style={{ gap: 12 }}>
              <Field label="Телефон для входа" required hint="Полный номер с кодом страны" error={phone && !digits ? 'Проверьте номер телефона' : undefined}>{(id, describedBy) =>
                <Input id={id} aria-describedby={describedBy} type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 900 000-00-00" />}</Field>
              <Field label="Пароль" required hint="Можно оставить предложенный" error={password.length < 6 ? 'Минимум 6 символов' : undefined}>{(id, describedBy) =>
                <Input id={id} aria-describedby={describedBy} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            </div>
          )}
          <DataState query={locations} skeleton={2}>{() => (
            <Field label="Точки, где работает" required error={selectedLocations.length ? undefined : 'Выберите хотя бы одну точку'}>{() => (
              <div role="group" aria-label="Точки, где работает">{availableLocs.map((l) => (
                <Checkbox key={l.id} label={l.name} hint={l.status === 'closed' ? 'Закрытая точка' : undefined}
                  checked={sel.includes(l.id)} onChange={(v) => setSel(v ? [...sel, l.id] : sel.filter((x) => x !== l.id))} />
              ))}</div>
            )}</Field>
          )}</DataState>
          <Field label="Статус сотрудника">{id => <Select id={id} value={position} disabled={!canSetAccess && position === 'manager'} onChange={e => {
            setPosition(e.target.value as StaffPosition);
            setTraineeFeeParsed(true);
          }}>
            <option value="sales_manager">Менеджер продаж</option><option value="trainee">Стажёр</option>
            {(canSetAccess || position === 'manager') && <option value="manager">Управляющий</option>}
          </Select>}</Field>
          {kind === 'trainee' && <div className="grid grid-2">
            <Field label="Начало стажировки" hint="По умолчанию сегодня по времени точки">{id => <Input id={id} type="date" value={start} onChange={e => setStart(e.target.value)} />}</Field>
            <Field label="Последний день" hint="По умолчанию один календарный месяц" error={validDates ? undefined : 'Проверьте даты стажировки'}>{(id, describedBy) =>
              <Input id={id} aria-describedby={describedBy} type="date" min={start || undefined} value={until} onChange={e => setUntil(e.target.value)} />}</Field>
          </div>}
          <Checkbox label="Обучение включено" checked={learningEnabled} onChange={setLearningEnabled} />
          {!validPay && <p className="hint">Проверьте настройки в разделе «Оплата».</p>}
        </div>}
        <div hidden={!editable || section !== 'pay'} className="pay-settings">
          {!payOnly && !locations.isSuccess ? <DataState query={locations} skeleton={2}>{() => null}</DataState>
            : payOnly && !currencyReady ? <DataState query={common} skeleton={2}>{() => null}</DataState> :
            <div className="pay-layout">
            <div className="pay-field-grid">
              <Field label={kind === 'trainee' ? 'Схема после стажировки' : 'Схема оплаты'}>{id =>
                <Select id={id} value={payMode} onChange={e => setPayMode(e.target.value as PayMode)}>
                  {payChoices.filter(choice => choice.id !== 'custom' || canSetCustomPay).map(choice =>
                    <option key={choice.id} value={choice.id}>{choice.title}</option>)}
                </Select>}</Field>
              {staff && <Field label="Новые условия действуют с" hint={payStart ? undefined : 'По умолчанию — сегодня по времени точки.'}>{(id, describedBy) =>
                <Input id={id} type="date" value={payStart} aria-describedby={describedBy} onChange={e => setPayStart(e.target.value)} />}</Field>}
            </div>
            {kind === 'trainee' && <Field label={`Гарантия стажёра за смену, ${unit}`}
              hint={until ? `До ${formatDate(until)} включительно, по ступеням общей схемы.` : 'На время стажировки действуют ступени общей схемы.'}
              error={!traineeFeeParsed ? 'Введите корректную сумму' : !validTraineeFee ? `Максимальная гарантия — ${formatMoneyShort(maxPolicyMinor, currency)}` : undefined}>{(id, describedBy) =>
                <MoneyInput id={id} describedBy={describedBy} invalid={!validTraineeFee} currency={currency} value={traineeFee} placeholder="0"
                  onChange={setTraineeFee} onValidityChange={setTraineeFeeParsed} />}</Field>}
            <div hidden={payMode !== 'fixed'}><div className="pay-field-grid">
              <Field label={`Ставка за выход, ${unit}`} error={validFee ? undefined : 'Введите корректную сумму'}>{(id, describedBy) =>
                <MoneyInput id={id} describedBy={describedBy} value={fee} onChange={setFee} onValidityChange={setValidFee} currency={currency} placeholder="0" />}</Field>
              <Field label="Доля выручки, %" error={bp !== null ? undefined : 'Введите число от 0 до 100 с точностью до сотых'}>{(id, describedBy) =>
                <Input id={id} aria-describedby={describedBy} aria-invalid={bp === null || undefined} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" />}</Field>
            </div></div>
            {canSetCustomPay && <div hidden={payMode !== 'custom'}><CustomPayFields currency={currency} draft={formula} setDraft={setFormula} /></div>}
            <details className="pay-explanation"><summary>Условия и пример расчёта</summary>
              {staff && <p className="pay-help">Сохранено: {payTerms(staff, currency)}
                {staff.pay_effective_from && ` · с ${formatDate(staff.pay_effective_from)}`}</p>}
              {staff?.pay_scheduled?.filter(v => v.effective_from !== staff.pay_effective_from).map(v =>
                <p className="pay-help" key={v.effective_from}>С {formatDate(v.effective_from)} — {v.label}</p>)}
              <p className="pay-help">{payChoices.find(choice => choice.id === payMode)?.hint}</p>
              {(payMode === 'partner' || kind === 'trainee') && canSetCustomPay && !teamPolicy &&
                <DataState query={common} skeleton={1}>{() => null}</DataState>}
              {(payMode !== 'partner' || (teamPolicy && previewForDate)) && <PayExample currency={currency} policy={payPreview}
                traineePolicy={kind === 'trainee' ? teamPolicy && validTraineeFee && previewForDate
                  ? { ...teamPolicy, floor_minor: Number(traineeFee) } : null : undefined} />}
              <p className="pay-help">{payTiming}</p>
            </details>
            {payOnly && payRevision === undefined && <p className="hint">Обновите карточку, чтобы получить актуальные условия оплаты.</p>}
            {!payOnly && !validProfile && !locations.error && <p className="hint">Проверьте поля в разделе «Основное».</p>}
          </div>}
        </div>
        {staff && !staff.active && section !== 'login' && <div style={{ containerType: 'inline-size' }}>
          {section === 'profile' ? <KV items={[
            ['Статус', positionLabels[positionOf(staff)]],
            ['Точки', staff.location_names.join(', ') || 'Точки не назначены'],
            ['Обучение', staff.learning_enabled === false ? 'Выключено' : 'Включено'],
            ...(staff.employee_kind === 'trainee' ? [['Начало стажировки', staff.internship_from ? dayLabel(staff.internship_from) : null],
              ['Последний день', staff.internship_until ? dayLabel(staff.internship_until) : null]] as [string, string | null][] : []),
          ]} /> : <DataState query={locations} skeleton={2}>{() => <KV items={[
            ['Оплата', payTerms(staff, currency)],
            ...(staff.employee_kind === 'trainee' && staff.internship_floor_minor !== undefined
              ? [['Минимум за смену на стажировке', formatMoneyShort(staff.internship_floor_minor, currency)]] as [string, string][] : []),
          ]} />}</DataState>}
        </div>}
        {section === 'login' && <div className="stack">
          {staff && <div style={{ overflowWrap: 'anywhere' }}>
            <div className="faint">Логин</div>
            <div className="row">
              <strong>{formatPhone(staff.phone) || 'Не задан'}</strong>
              {staff.phone && <CopyCredential kind="login" value={formatPhone(staff.phone)} />}
            </div>
          </div>}
          {editable && canSetAccess && <div role="group" aria-label="Права сотрудника">
            <strong>Права сотрудника</strong>
            {accessKeys.filter(key => key !== 'manage_pay' || position === 'manager').map(key => <Checkbox key={key} label={accessLabels[key]} checked={Boolean(access[key])}
              onChange={checked => setAccess(current => ({ ...current, [key]: checked }))} />)}
            {position === 'manager' && staff?.access?.legacy_staff_management && <p className="faint">
              Право «Видеть сотрудников» также открывает этому управляющему редактирование карточек и просмотр начислений на назначенных точках.
            </p>}
            {showSave && (!validProfile || !validPay) && <p className="hint">Проверьте разделы «Основное» и «Оплата».</p>}
          </div>}
          {staff && (staff.active ? <>
            <div className="row">
              <Button size="sm" disabled={m.isPending} onClick={() => setLoginAction('phone')}>Изменить телефон</Button>
              <Button size="sm" disabled={m.isPending} onClick={() => setLoginAction('password')}>Задать пароль</Button>
            </div>
            <Button size="sm" variant="ghost" className="danger-text" disabled={m.isPending} onClick={() => onChangeAccess(staff, dirty)}>Закрыть доступ</Button>
            {dirty && <p className="hint" role="status">Изменения в карточке ещё не сохранены.</p>}
          </> : <>
            <p className="faint">Доступ закрыт</p>
            <Button size="sm" onClick={() => onChangeAccess(staff, false)}>Вернуть доступ</Button>
          </>)}
        </div>}
        {staff?.active && (managerPositionChanged || accessChanged) && <p className="faint" style={{ marginTop: 'var(--space-3)' }}>
          После изменения прав сотруднику нужно войти заново.
        </p>}
      </ConfirmDialog>
      {staff && loginAction === 'phone' && <PhoneLoginDialog user={staff.user_id} name={staff.full_name} currentPhone={staff.phone} onClose={() => setLoginAction(null)} />}
      {staff && loginAction === 'password' && <PasswordReset partnerId={partnerId} staff={staff} onClose={() => setLoginAction(null)} />}
    </>
  );
}

function PasswordReset({ partnerId, staff, onClose }: { partnerId: string; staff: StaffRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState(randomPassword);
  const [issued, setIssued] = useState<string | null>(null);
  const m = useMutation({ mutationFn: async () => { const password = pw; await userSetPassword(staff.user_id, password); setIssued(password); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['staff-access-history', partnerId] }); } });
  if (issued) return <ConfirmDialog open title="Пароль изменён" cancelLabel="Готово" onClose={onClose}>
    <p>Новый пароль доступен до закрытия этого окна.</p>
    <CredentialFields login={formatPhone(staff.phone)} password={issued} />
  </ConfirmDialog>;
  return (
    <ConfirmDialog open title="Новый пароль" confirmLabel="Задать пароль" busy={m.isPending} error={m.error} disabled={pw.length < 6} onClose={onClose} onConfirm={() => m.mutate()}>
      <p><strong>{staff.full_name}</strong><br />{formatPhone(staff.phone)}</p>
      <Field label="Пароль" hint="Минимум 6 символов">{(id, describedBy) => <Input id={id} aria-describedby={describedBy} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

type PayrollRow = StaffRow & { payHalves: [bigint, bigint] };

async function downloadPayroll(list: PayrollRow[], month: string, currency: string) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const money = (v: MinorInput) => ({ value: Number(minorToDecimal(v, currency)), type: Number, format: '#,##0.00' });
  const head = (value: string) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC' });
  const periodHeadings = payrollPeriods(month).map(period => `${payrollPeriodLabel(period)} · выплата ${formatDate(period.payOn)}`);
  const totals = [sumMinor(list.map(row => row.payHalves[0])), sumMinor(list.map(row => row.payHalves[1]))];
  await writeXlsxFile([
    { sheet: 'Ведомость', columns: [26, 16, 10, 16, 16, 40, 40].map(width => ({ width })),
      data: [['Сотрудник', 'Телефон', 'Выходов', 'Выручка смен', 'Начислено за месяц', ...periodHeadings].map(head),
        ...list.map((s) => [s.full_name, formatPhone(s.phone), { value: s.month_shifts, type: Number }, money(s.month_revenue_minor),
          money(s.month_earned_minor), ...s.payHalves.map(money)]),
        [{ value: 'Итого', fontWeight: 'bold' as const }, null, null, money(sumMinor(list.map(s => s.month_revenue_minor))),
          { ...money(sumMinor(list.map(s => s.month_earned_minor))), fontWeight: 'bold' as const }, ...totals.map(money)]] },
    { sheet: 'Смены', columns: [{ width: 26 }, { width: 14 }, { width: 24 }, { width: 16 }, { width: 16 }],
      data: [['Сотрудник', 'Дата', 'Точка', 'Выручка', 'Заработок'].map(head),
        ...list.flatMap((s) => s.shifts.map((x) => [s.full_name, x.day, x.location_name, money(x.total_minor), money(x.earned_minor)]))] },
  ]).toFile(`vedomost-${month.slice(0, 7)}.xlsx`);
}

const staffSections = [
  { id: 'team', label: 'Команда' },
  { id: 'shifts', label: 'Смены и начисления' },
  { id: 'pay', label: 'Оплата' },
] as const;

const staffStatuses = [
  { id: 'active', label: 'Работают' },
  { id: 'closed', label: 'Доступ закрыт' },
] as const;

/** Список сотрудников и ведомость для франчайзи и для менеджера в карточке франчайзи. */
export function StaffPanel({ partnerId }: { partnerId: string }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const hasPermission = (permission: string) => Boolean(me?.assignments.some(a => a.permissions.includes(permission)
    && (a.scope_type === 'company' || a.scope_id === partnerId)));
  const canManageEmployees = hasPermission('staff.manage');
  const canSetEmployeePay = hasPermission('staff.pay_edit');
  const canSetAccess = hasPermission('team.manage');
  const canViewStaff = canManageEmployees || canSetEmployeePay || hasPermission('staff.view');
  const canCreateStaff = canSetAccess || hasPermission('staff.create');
  const [section, setSection] = useState<(typeof staffSections)[number]['id']>('team');
  const availableSections = staffSections.filter(item => item.id === 'team' || canManageEmployees || (item.id === 'pay' && canSetEmployeePay));
  const visibleSection = availableSections.some(item => item.id === section) ? section : 'team';
  const [status, setStatus] = useState<(typeof staffStatuses)[number]['id']>('active');
  const [search, setSearch] = useState('');
  const [month, setMonth] = useState(() => {
    const today = new Date();
    return monthStart(today.getDate() === 1 ? -1 : 0, today);
  });
  const [edit, setEdit] = useState<{ staff: StaffRow; section: CardSection } | 'new' | null>(null);
  const [access, setAccess] = useState<{ staff: StaffRow; dirty: boolean } | null>(null);
  const [correction, setCorrection] = useState<{ employee: string; shift: PayrollShift } | null>(null);
  const locs = useQuery({ queryKey: ['locations', partnerId], enabled: canManageEmployees || canCreateStaff, queryFn: () => locationsOf(partnerId) });
  const payInfo = useMotivation(partnerId, canSetEmployeePay && !canManageEmployees && visibleSection === 'pay');
  const q = useQuery({ queryKey: ['staff-list', partnerId, month, canManageEmployees, canSetEmployeePay], enabled: canViewStaff, queryFn: () => staffList(partnerId, month),
    refetchInterval: visibleSection === 'shifts' ? 120_000 : false });
  const openShifts = useOpenShifts(partnerId, canManageEmployees);
  const overdueShifts = openShifts.data?.filter(shift => shift.day < shift.today).length ?? 0;
  const canAdd = locs.data?.some((l) => l.status === 'active');
  const payrollCurrency = (locs.isSuccess ? locs.data[0]?.currency : undefined) ?? payInfo.data?.currency;
  const currency = payrollCurrency ?? 'RUB';
  const setActive = useMutation({
    mutationFn: ({ user, active }: { user: string; active: boolean }) => staffSetActive(user, active),
    onSuccess: (_, { user, active }) => {
      toast(active ? 'Доступ возвращён' : 'Доступ закрыт');
      setAccess(null);
      setEdit(current => current && current !== 'new' && current.staff.user_id === user ? null : current);
      void qc.invalidateQueries({ queryKey: ['staff-list', partnerId] });
      void qc.invalidateQueries({ queryKey: ['team', partnerId] });
      void qc.invalidateQueries({ queryKey: ['staff-access-history', partnerId] });
    },
  });
  const payroll = (q.data ?? []).filter((s) => s.month_shifts > 0 || s.shifts.length > 0)
    .map((staff): PayrollRow => ({ ...staff, payHalves: splitPayroll(month, staff.shifts) }));
  const exp = useMutation({ mutationFn: async () => {
    if (payrollCurrency) await downloadPayroll(payroll, month, payrollCurrency);
  } });
  const term = search.trim().toLocaleLowerCase('ru-RU');
  const digits = /^[+\d()\s.-]+$/.test(term) ? (phoneLoginDigits(term) ?? term.replace(/\D/g, '')) : '';
  const visibleStaff = (q.data ?? []).filter((s) => s.active === (status === 'active') && (
    !term || [s.full_name, ...s.location_names].some((value) => value.toLocaleLowerCase('ru-RU').includes(term))
    || (canManageEmployees && (s.phone.toLocaleLowerCase('ru-RU').includes(term) || (digits && s.phone.replace(/\D/g, '').includes(digits))))
  ));
  const canManageStaff = (staff: StaffRow) => canManageEmployees && staff.user_id !== me?.user.id && staff.can_manage !== false;
  const [params, setParams] = useSearchParams();
  const requestedEmployee = params.get('employee');
  useEffect(() => {
    if (!requestedEmployee || (canManageEmployees && !q.isSuccess)) return;
    const employee = canManageEmployees && q.data?.find(row =>
      row.user_id === requestedEmployee && row.active && row.can_manage === true && row.user_id !== me?.user.id);
    if (employee) setEdit({ staff: employee, section: 'profile' });
    setParams(current => {
      const next = new URLSearchParams(current);
      next.delete('employee');
      return next;
    }, { replace: true });
  }, [requestedEmployee, canManageEmployees, q.isSuccess, q.data, me?.user.id, setParams]);
  const changeAccess = (staff: StaffRow, dirty = false) => { setActive.reset(); setAccess({ staff, dirty }); };
  const selectedStaff = edit && edit !== 'new' ? q.data?.find(staff => staff.user_id === edit.staff.user_id) : undefined;
  const canOpenEdit = edit === 'new' ? canCreateStaff : selectedStaff && edit && (
    canManageStaff(selectedStaff) || (edit.section === 'pay' && selectedStaff.active && selectedStaff.can_edit_pay)
  );

  return (
    <div className="stack">
      {availableSections.length > 1 && <Chips options={availableSections} value={visibleSection} onChange={setSection} label="Разделы сотрудников" />}
      {visibleSection === 'team' && <section className="stack" aria-label="Команда">
        {(canCreateStaff || canManageEmployees) && <div className="row between">
          {canCreateStaff && <Button variant="primary" onClick={() => setEdit('new')} disabled={!canAdd}><Plus size={16} aria-hidden />Добавить сотрудника</Button>}
          {canManageEmployees && <Link className="btn btn-ghost" to={`/learning/manage?partner=${partnerId}`}>Обучение сотрудников</Link>}
        </div>}
        {canCreateStaff && locs.isSuccess && !canAdd && <p className="faint">Нет действующих точек для нового сотрудника.</p>}
        <ActionError error={locs.error} />
        {canManageEmployees && overdueShifts > 0 && <Button size="sm" onClick={() => setSection('shifts')}>Незакрытые смены за прошлые дни: {overdueShifts}</Button>}
        {canViewStaff && <>
        <Field label="Найти сотрудника">{id => <Input id={id} type="search" value={search} placeholder={canManageEmployees ? 'Имя, телефон или точка' : 'Имя или точка'} onChange={e => setSearch(e.target.value)} />}</Field>
        <Chips options={[...staffStatuses]} value={status} onChange={setStatus} label="Статус доступа" />
        <DataState query={q}>{(list) => (
          visibleStaff.length ? <div className="stack">
            {visibleStaff.map((staff) => {
              const canManage = canManageStaff(staff);
              return <Card key={staff.user_id} className={staff.active ? '' : 'muted-card'}>
                <div className="row between staff-summary" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row">
                      <strong id={`staff-name-${staff.user_id}`}>{staff.full_name}</strong>
                      <Badge tone={positionOf(staff) === 'trainee' ? 'info' : 'neutral'}>{positionLabels[positionOf(staff)]}</Badge>
                      {positionOf(staff) === 'trainee' && staff.internship_completed && <span className="faint">Стажировка завершена</span>}
                      {canManageEmployees && staff.open_shift && <Badge tone="success">На смене в «{staff.open_shift.location_name}»</Badge>}
                    </div>
                    <div className="faint">{staff.location_names.join(', ') || 'Точки не назначены'}</div>
                    {canManageEmployees && staff.phone && <div className="faint">{formatPhone(staff.phone)}</div>}
                  </div>
                  {canManage && <Button size="sm" aria-describedby={`staff-name-${staff.user_id}`}
                    onClick={() => setEdit({ staff, section: staff.active ? 'profile' : 'login' })}>Открыть карточку</Button>}
                </div>
                {canManageEmployees && !canManage && staff.user_id !== me?.user.id && <p className="faint">Доступ и условия меняет франчайзи</p>}
              </Card>;
            })}
          </div> : <EmptyState title={term ? 'Сотрудники не найдены' : !list.length ? 'Сотрудников пока нет' : status === 'active' ? 'Нет сотрудников с открытым доступом' : 'Нет сотрудников с закрытым доступом'}
            action={term ? <Button size="sm" onClick={() => setSearch('')}>Сбросить поиск</Button> : undefined} />
        )}</DataState>
        </>}
      </section>}
      {visibleSection === 'shifts' && <section className="stack" aria-label="Смены и начисления">
        <ShiftReview partner={partnerId} />
        <div className="row between">
          <MonthNav month={month} onChange={setMonth} max={monthStart()} />
          <Button size="sm" onClick={() => exp.mutate()} loading={exp.isPending} disabled={!payroll.length || !payrollCurrency}>
            <Download size={15} aria-hidden />Скачать ведомость Excel
          </Button>
        </div>
        <ActionError error={exp.error} />
        <DataState query={q}>{() => <DataState query={locs} empty={points => points.length ? null :
          <EmptyState title="За этот месяц нет закрытых смен" />}>{() => (
          <div className="stack">
            <div className="kpis">
              <div className="kpi"><span className="v">{formatMoneyShort(sumMinor(payroll.map(staff => staff.month_earned_minor)), currency)}</span><span className="l">начислено за месяц</span></div>
            </div>
            <PayrollSchedule month={month} currency={currency}
              amounts={[sumMinor(payroll.map(staff => staff.payHalves[0])), sumMinor(payroll.map(staff => staff.payHalves[1]))]} />
            {!payroll.length && <EmptyState title="За этот месяц нет закрытых смен" />}
            {payroll.map((staff) => <Card key={staff.user_id}>
              <div className="stack">
                <div className="row between staff-summary">
                  <div style={{ minWidth: 0 }}><strong>{staff.full_name}</strong>
                    <div className="faint">Выходов: {staff.month_shifts} · Выручка: {formatMoneyShort(staff.month_revenue_minor, currency)}</div>
                  </div>
                  <strong className="num">{formatMoneyShort(staff.month_earned_minor, currency)}</strong>
                </div>
                <PayrollSchedule month={month} amounts={staff.payHalves} currency={currency} />
              </div>
              {staff.shifts.length > 0 && <details style={{ marginTop: 8 }}><summary>Смены за месяц</summary>
                <ul className="list">{staff.shifts.map((shift) => <li key={shift.id} className="row between access-row">
                  <span>{dayLabel(shift.day)} · {shift.location_name}<span className="faint" style={{ display: 'block' }}>
                    {payrollShiftTime(shift)}{shift.counts_as_exit === false && ' · Дополнительная точка'} · Выручка: {formatMoneyShort(shift.total_minor, currency)}
                  </span></span>
                  <div className="row wrap">
                    <strong className="num">{formatMoneyShort(shift.earned_minor, currency)}</strong>
                    {shift.can_correct && canManageStaff(staff) && <Button size="sm" onClick={() => setCorrection({ employee: staff.full_name, shift })}>Исправить смену</Button>}
                  </div>
                </li>)}</ul>
              </details>}
            </Card>)}
          </div>
        )}</DataState>}</DataState>
      </section>}
      {(canManageEmployees || canSetEmployeePay) && <div hidden={visibleSection !== 'pay'}>
        <section className="stack" aria-label="Оплата">
          {canManageEmployees && <MotivationPanel partner={partnerId} canEdit={canSetAccess} />}
          <DataState query={q}>{(list) => {
            const activeStaff = list.filter(staff => staff.active && (canManageEmployees || staff.can_edit_pay));
            return activeStaff.length ? <Card title="Условия сотрудников"><ul className="list">
              {activeStaff.map((staff) => <li key={staff.user_id} className="row between access-row">
                <div style={{ minWidth: 0 }}>
                  <strong>{staff.full_name}</strong>
                  {payrollCurrency && <div className="faint">{payTerms(staff, payrollCurrency)}{staff.pay_effective_from && ` · с ${formatDate(staff.pay_effective_from)}`}</div>}
                  {payrollCurrency && staff.employee_kind === 'trainee' && staff.internship_floor_minor !== undefined && <div className="faint">
                    Минимум за смену на стажировке: {formatMoneyShort(staff.internship_floor_minor, currency)}
                  </div>}
                </div>
                {(canManageStaff(staff) || staff.can_edit_pay) && <Button size="sm" onClick={() => setEdit({ staff, section: 'pay' })}>Изменить</Button>}
              </li>)}
            </ul></Card> : <EmptyState title={canManageEmployees ? 'Нет сотрудников с открытым доступом' : 'Нет сотрудников для настройки оплаты'} />;
          }}</DataState>
        </section>
      </div>}
      {correction && me && canManageEmployees && <ClosedShiftCorrection employee={correction.employee} shift={correction.shift}
        currency={currency} userId={me.user.id} onClose={() => setCorrection(null)} />}
      {edit && canOpenEdit && <StaffDialog key={selectedStaff?.user_id ?? 'new'} partnerId={partnerId} locations={locs} staff={selectedStaff}
        canSetAccess={canSetAccess} canSetCustomPay={canManageEmployees || (edit !== 'new' && Boolean(selectedStaff?.can_edit_pay))} initialSection={edit === 'new' ? undefined : edit.section}
        onClose={() => setEdit(null)} onChangeAccess={changeAccess} />}
      {access && canManageEmployees && <ConfirmDialog open danger={access.staff.active} title={`${access.staff.active ? 'Закрыть' : 'Вернуть'} доступ?`} confirmLabel={access.staff.active ? 'Закрыть доступ' : 'Вернуть доступ'}
        busy={setActive.isPending} error={setActive.error} onClose={() => setAccess(null)} onConfirm={() => setActive.mutate({ user: access.staff.user_id, active: !access.staff.active })}>
        <p><strong>{access.staff.full_name}</strong></p>
        <p>{access.staff.active ? 'Сотрудник сразу потеряет доступ к кабинету. Смены и начисления сохранятся.' : 'Сотрудник сможет снова войти в кабинет.'}</p>
        {access.dirty && <p>Несохранённые изменения карточки будут отброшены.</p>}
      </ConfirmDialog>}
    </div>
  );
}

export function StaffPage() {
  const { me } = useSession();
  const ownedCards = franchiseePartnerCards(me);
  const delegated = ownedCards.length === 0 ? me?.assignments.find(a =>
    a.scope_type === 'partner' && a.permissions.some(p => p === 'staff.manage' || p === 'staff.view' || p === 'staff.create' || p === 'staff.pay_edit'))?.scope_id : undefined;
  const partner = ownedCards.length === 1 ? ownedCards[0] : delegated;
  return (
    <>
      <PageHeader title="Сотрудники" />
      {ownedCards.length > 1 ? <EmptyState title="Уточните доступ к карточке франчайзи" text={FRANCHISEE_CARD_AMBIGUITY} />
        : partner ? <StaffPanel key={partner} partnerId={partner} /> : <EmptyState title="Нет франчайзи" />}
    </>
  );
}
