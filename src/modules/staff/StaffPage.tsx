import { Link } from 'react-router';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { command, from, rows } from '../../platform/backend';
import { dayLabel, monthStart } from '../../platform/dates';
import { formatMoneyShort, minorToDecimal } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Badge, Button, Card, Checkbox, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, KV, MoneyInput, PageHeader, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { MotivationPanel } from './Motivation';
import { ShiftReview, useOpenShifts } from './ShiftReview';
import { PhoneLoginDialog } from './PhoneLoginDialog';
import { MonthNav } from '../revenue/components';
import { formatPhone, pctBp, randomPassword, staffList, staffSetActive, userSetPassword, type StaffRow } from './api';
import { phoneLoginDigits } from '../../platform/login';

interface Loc { id: string; name: string; currency: string; status: string }
const locationsOf = (partner: string) => rows<Loc>(from('location').select('id, name, currency, status').eq('partner_id', partner).order('name'));

const cardSections = [
  { id: 'profile', label: 'Основное' },
  { id: 'pay', label: 'Оплата' },
  { id: 'login', label: 'Вход' },
] as const;
type CardSection = (typeof cardSections)[number]['id'];

function payTerms(staff: StaffRow, currency: string) {
  if (staff.use_partner_motivation) return 'Общая схема франчайзи';
  return [staff.shift_fee_minor && `${formatMoneyShort(staff.shift_fee_minor, currency)} за смену`,
    staff.rate_bp && `${pctBp(staff.rate_bp)} от выручки`].filter(Boolean).join(' + ') || 'Фикс и процент равны нулю';
}

function StaffDialog({ partnerId, locations, staff, initialSection = 'profile', onClose, onChangeAccess }: {
  partnerId: string; locations: UseQueryResult<Loc[]>; staff?: StaffRow; initialSection?: CardSection;
  onClose: () => void; onChangeAccess: (staff: StaffRow, dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [section, setSection] = useState(initialSection);
  const [loginAction, setLoginAction] = useState<'phone' | 'password' | null>(null);
  const currency = locations.data?.[0]?.currency ?? 'RUB';
  const activeLocs = (locations.data ?? []).filter((l) => l.status === 'active');
  const availableLocs = (locations.data ?? []).filter((l) => l.status === 'active' || staff?.location_ids.includes(l.id));
  const initialLocations = staff?.location_ids ?? (activeLocs.length === 1 ? [activeLocs[0].id] : []);
  const [initialPassword] = useState(randomPassword);
  const [name, setName] = useState(staff?.full_name ?? '');
  const [usePartner, setUsePartner] = useState(staff?.use_partner_motivation ?? true);
  const [kind, setKind] = useState(staff?.employee_kind ?? 'employee');
  const [start, setStart] = useState(staff?.internship_from ?? '');
  const [until, setUntil] = useState(staff?.internship_until ?? '');
  const [traineeFee, setTraineeFee] = useState(String(staff?.internship_floor_minor ?? 50000));
  const [validTraineeFee, setValidTraineeFee] = useState(true);
  const [learningEnabled, setLearningEnabled] = useState(staff?.learning_enabled ?? true);
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState(initialPassword);
  const [sel, setSel] = useState(initialLocations);
  const [rate, setRate] = useState(staff ? String(staff.rate_bp / 100).replace('.', ',') : '');
  const [fee, setFee] = useState(staff ? String(staff.shift_fee_minor) : '');
  const [validFee, setValidFee] = useState(true);
  const [created, setCreated] = useState<{ phone: string; password: string } | null>(null);
  const digits = phoneLoginDigits(phone);
  const percent = Number(rate.trim().replace(',', '.'));
  const validRate = (!rate.trim() || /^\d+(?:[,.]\d{0,2})?$/.test(rate.trim())) && percent >= 0 && percent <= 100;
  const validDates = !until || !start || until >= start;
  const selectedLocations = sel.filter((id) => availableLocs.some((l) => l.id === id));
  const validProfile = Boolean(locations.data && !locations.error && name.trim() && selectedLocations.length && (staff || (digits && password.length >= 6))
    && (kind !== 'trainee' || validDates));
  const validPay = (usePartner || (validFee && validRate)) && (kind !== 'trainee' || validTraineeFee);
  const dirty = name !== (staff?.full_name ?? '') || phone !== '' || password !== initialPassword
    || sel.length !== initialLocations.length || sel.some((id) => !initialLocations.includes(id))
    || kind !== (staff?.employee_kind ?? 'employee') || learningEnabled !== (staff?.learning_enabled ?? true)
    || (kind === 'trainee' && (start !== (staff?.internship_from ?? '') || until !== (staff?.internship_until ?? '')
      || traineeFee !== String(staff?.internship_floor_minor ?? 50000) || !validTraineeFee))
    || usePartner !== (staff?.use_partner_motivation ?? true)
    || (!usePartner && (percent !== (staff?.rate_bp ?? 0) / 100 || Number(fee) !== (staff?.shift_fee_minor ?? 0) || !validFee || !validRate));
  const m = useMutation({
    mutationFn: async () => {
      const submittedPassword = password;
      const settings = { employee_kind: kind, internship_from: start || null, internship_until: until || null,
        internship_floor_minor: traineeFee, learning_enabled: learningEnabled };
      await command('staff_profile_save_phone', {
        user: staff?.user_id ?? null, partner: partnerId, full_name: name.trim(), phone, password: submittedPassword,
        locations: selectedLocations, use_partner: usePartner,
        rate_bp: usePartner ? staff?.rate_bp ?? 0 : Math.round(percent * 100),
        shift_fee: usePartner ? String(staff?.shift_fee_minor ?? 0) : fee || '0',
        settings,
      });
      if (!staff && digits) setCreated({ phone: formatPhone(digits), password: submittedPassword });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff-list', partnerId] });
      void qc.invalidateQueries({ queryKey: ['team', partnerId] });
      void qc.invalidateQueries({ queryKey: ['staff-access-history', partnerId] });
      if (staff) { toast('Карточка сотрудника сохранена'); onClose(); }
    },
  });
  if (created) return <StaffCredentials title="Сотрудник добавлен" {...created} onClose={onClose} />;
  const editable = !staff || staff.active;
  const showSave = editable && section !== 'login';
  return (
    <>
      <ConfirmDialog open title={staff ? 'Карточка' : 'Новый сотрудник'} cancelLabel={staff ? 'Закрыть' : undefined}
        confirmLabel={showSave ? (staff ? 'Сохранить' : 'Добавить сотрудника') : undefined} busy={m.isPending} error={m.error}
        disabled={!editable || !validProfile || !validPay} dirty={editable && dirty} onClose={onClose} onConfirm={() => m.mutate()}>
        {staff && <>
          <p style={{ marginBottom: 'var(--space-3)', overflowWrap: 'anywhere' }}><strong>{staff.full_name}</strong></p>
          <Chips options={[...cardSections]} value={section} onChange={setSection} label="Настройки сотрудника" />
        </>}
        <div hidden={!editable || Boolean(staff && section !== 'profile')}>
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
          <Field label="Статус сотрудника">{id => <Select id={id} value={kind} onChange={e => {
            setKind(e.target.value as 'employee' | 'trainee');
            setValidTraineeFee(true);
          }}>
            <option value="employee">Обычный сотрудник</option><option value="trainee">Стажёр</option>
          </Select>}</Field>
          {kind === 'trainee' && <div className="grid grid-2">
            <Field label="Начало стажировки" hint="По умолчанию сегодня по времени точки">{id => <Input id={id} type="date" value={start} onChange={e => setStart(e.target.value)} />}</Field>
            <Field label="Последний день" hint="По умолчанию один календарный месяц" error={validDates ? undefined : 'Проверьте даты стажировки'}>{(id, describedBy) =>
              <Input id={id} aria-describedby={describedBy} type="date" min={start || undefined} value={until} onChange={e => setUntil(e.target.value)} />}</Field>
          </div>}
          <Checkbox label="Обучение включено" checked={learningEnabled} onChange={setLearningEnabled} />
          {staff && !validPay && <p className="hint">Проверьте сумму или процент в разделе «Оплата».</p>}
        </div>
        <div hidden={!editable || Boolean(staff && section !== 'pay')}>
          <DataState query={locations} skeleton={2}>{() => <>
            {kind === 'trainee' && <Field label={`Минимум стажёра за смену, ${currency}`} hint="Начисляется большее из минимума и процента, затем прибавляется премия."
                error={validTraineeFee ? undefined : 'Введите корректную сумму'}>{id =>
                <MoneyInput id={id} currency={currency} value={traineeFee} onChange={setTraineeFee} onValidityChange={setValidTraineeFee} />}</Field>}
            <Field label={kind === 'trainee' ? 'Условия оплаты после стажировки' : 'Условия оплаты'}
              hint={usePartner ? 'Общая схема франчайзи. Из минимума и процента берётся большее, затем прибавляется премия.' : 'Фикс за смену суммируется с процентом.'}>
              {(id, describedBy) => <Select id={id} aria-describedby={describedBy} value={usePartner ? 'partner' : 'individual'} onChange={e => {
                setUsePartner(e.target.value === 'partner');
                setValidFee(true);
              }}><option value="partner">Общая схема франчайзи</option><option value="individual">Фикс за смену + процент</option></Select>}
            </Field>
            {!usePartner && <div className="grid grid-2" style={{ gap: 12 }}>
              <Field label={`За выход, ${currency}`} error={validFee ? undefined : 'Введите корректную сумму'}>{(id) =>
                <MoneyInput id={id} value={fee} onChange={setFee} onValidityChange={setValidFee} currency={currency} placeholder="0" />}</Field>
              <Field label="% от выручки смены" error={validRate ? undefined : 'Введите число от 0 до 100 с точностью до сотых'}>{(id, describedBy) =>
                <Input id={id} aria-describedby={describedBy} aria-invalid={!validRate || undefined} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" />}</Field>
            </div>}
            {staff && <p className="faint">Новая оплата применяется к сменам, открытым после сохранения.</p>}
            {staff && !validProfile && !locations.error && <p className="hint">Проверьте поля в разделе «Основное».</p>}
          </>}</DataState>
        </div>
        {staff && !staff.active && section !== 'login' && <div style={{ containerType: 'inline-size' }}>
          {section === 'profile' ? <KV items={[
            ['Точки', staff.location_names.join(', ') || 'Точки не назначены'],
            ['Обучение', staff.learning_enabled === false ? 'Выключено' : 'Включено'],
            ...(staff.employee_kind === 'trainee' ? [['Статус', 'Стажёр'], ['Начало стажировки', staff.internship_from ? dayLabel(staff.internship_from) : null],
              ['Последний день', staff.internship_until ? dayLabel(staff.internship_until) : null]] as [string, string | null][] : []),
          ]} /> : <DataState query={locations} skeleton={2}>{() => <KV items={[
            ['Оплата', payTerms(staff, currency)],
            ...(staff.employee_kind === 'trainee' && staff.internship_floor_minor !== undefined
              ? [['Минимум за смену на стажировке', formatMoneyShort(staff.internship_floor_minor, currency)]] as [string, string][] : []),
          ]} />}</DataState>}
        </div>}
        {staff && section === 'login' && <div className="stack">
          <div style={{ overflowWrap: 'anywhere' }}>
            <div className="faint">Логин</div>
            <strong>{formatPhone(staff.phone) || 'Не задан'}</strong>
          </div>
          {staff.active ? <>
            <div className="row">
              <Button size="sm" disabled={m.isPending} onClick={() => setLoginAction('phone')}>Изменить телефон</Button>
              <Button size="sm" disabled={m.isPending} onClick={() => setLoginAction('password')}>Задать пароль</Button>
            </div>
            <Button size="sm" variant="ghost" className="danger-text" disabled={m.isPending} onClick={() => onChangeAccess(staff, dirty)}>Закрыть доступ</Button>
            {dirty && <p className="hint" role="status">Изменения в карточке ещё не сохранены.</p>}
          </> : <>
            <p className="faint">Доступ закрыт</p>
            <Button size="sm" onClick={() => onChangeAccess(staff, false)}>Вернуть доступ</Button>
          </>}
        </div>}
      </ConfirmDialog>
      {staff && loginAction === 'phone' && <PhoneLoginDialog user={staff.user_id} name={staff.full_name} currentPhone={staff.phone} onClose={() => setLoginAction(null)} />}
      {staff && loginAction === 'password' && <PasswordReset partnerId={partnerId} staff={staff} onClose={() => setLoginAction(null)} />}
    </>
  );
}

function StaffCredentials({ title, phone, password, onClose }: { title: string; phone: string; password: string; onClose: () => void }) {
  const toast = useToast();
  const [copyError, setCopyError] = useState(false);
  const site = `${location.origin}${location.pathname}`;
  const copy = async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(`Вход в кабинет «Бронь Сервис»: ${site}\nЛогин: ${phone}\nПароль: ${password}`);
      toast('Данные для входа скопированы');
    } catch {
      setCopyError(true);
    }
  };
  return (
    <ConfirmDialog open title={title} cancelLabel="Готово" onClose={onClose}>
      <p>Передайте сотруднику данные для входа. Пароль показан только сейчас.</p>
      <div className="login-card-data">
        <div><span className="faint">Сайт</span><strong>{site}</strong></div>
        <div><span className="faint">Логин</span><strong>{phone}</strong></div>
        <div><span className="faint">Пароль</span><strong className="mono">{password}</strong></div>
      </div>
      <Button size="sm" onClick={() => void copy()}>Скопировать данные для входа</Button>
      {copyError && <p role="status">Скопируйте данные вручную.</p>}
    </ConfirmDialog>
  );
}

function PasswordReset({ partnerId, staff, onClose }: { partnerId: string; staff: StaffRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState(randomPassword);
  const [issued, setIssued] = useState<string | null>(null);
  const m = useMutation({ mutationFn: async () => { const password = pw; await userSetPassword(staff.user_id, password); setIssued(password); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['staff-access-history', partnerId] }); } });
  if (issued) return <StaffCredentials title="Пароль изменён" phone={formatPhone(staff.phone)} password={issued} onClose={onClose} />;
  return (
    <ConfirmDialog open title="Новый пароль" confirmLabel="Задать пароль" busy={m.isPending} error={m.error} disabled={pw.length < 6} onClose={onClose} onConfirm={() => m.mutate()}>
      <p><strong>{staff.full_name}</strong><br />{formatPhone(staff.phone)}</p>
      <Field label="Пароль" hint="Минимум 6 символов">{(id, describedBy) => <Input id={id} aria-describedby={describedBy} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

async function downloadPayroll(list: StaffRow[], month: string, currency: string) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const money = (v: number) => ({ value: Number(minorToDecimal(v, currency)), type: Number, format: '#,##0.00' });
  const head = (value: string) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC' });
  await writeXlsxFile([
    { sheet: 'Ведомость', columns: [{ width: 26 }, { width: 16 }, { width: 10 }, { width: 16 }, { width: 16 }],
      data: [['Сотрудник', 'Телефон', 'Смен', 'Выручка смен', 'Заработок'].map(head),
        ...list.map((s) => [s.full_name, formatPhone(s.phone), { value: s.month_shifts, type: Number }, money(s.month_revenue_minor), money(s.month_earned_minor)]),
        [{ value: 'Итого', fontWeight: 'bold' as const }, null, null, money(list.reduce((a, s) => a + Number(s.month_revenue_minor), 0)),
          { ...money(list.reduce((a, s) => a + Number(s.month_earned_minor), 0)), fontWeight: 'bold' as const }]] },
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
  const [section, setSection] = useState<(typeof staffSections)[number]['id']>('team');
  const [status, setStatus] = useState<(typeof staffStatuses)[number]['id']>('active');
  const [search, setSearch] = useState('');
  const [month, setMonth] = useState(monthStart());
  const [edit, setEdit] = useState<{ staff: StaffRow; section: CardSection } | 'new' | null>(null);
  const [access, setAccess] = useState<{ staff: StaffRow; dirty: boolean } | null>(null);
  const locs = useQuery({ queryKey: ['locations', partnerId], queryFn: () => locationsOf(partnerId) });
  const q = useQuery({ queryKey: ['staff-list', partnerId, month], queryFn: () => staffList(partnerId, month) });
  const openShifts = useOpenShifts(partnerId);
  const overdueShifts = openShifts.data?.filter(shift => shift.day < shift.today).length ?? 0;
  const canAdd = locs.data?.some((l) => l.status === 'active');
  const currency = locs.data?.[0]?.currency ?? 'RUB';
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
  const payroll = (q.data ?? []).filter((s) => s.month_shifts > 0);
  const exp = useMutation({ mutationFn: () => downloadPayroll(payroll, month, currency) });
  const term = search.trim().toLocaleLowerCase('ru-RU');
  const digits = /^[+\d()\s.-]+$/.test(term) ? (phoneLoginDigits(term) ?? term.replace(/\D/g, '')) : '';
  const visibleStaff = (q.data ?? []).filter((s) => s.active === (status === 'active') && (
    !term || [s.full_name, s.phone, ...s.location_names].some((value) => value.toLocaleLowerCase('ru-RU').includes(term))
    || (digits && s.phone.replace(/\D/g, '').includes(digits))
  ));
  const canManageStaff = (staff: StaffRow) => staff.user_id !== me?.user.id && staff.can_manage !== false;
  const changeAccess = (staff: StaffRow, dirty = false) => { setActive.reset(); setAccess({ staff, dirty }); };
  const selectedStaff = edit && edit !== 'new' ? q.data?.find(staff => staff.user_id === edit.staff.user_id) ?? edit.staff : undefined;

  return (
    <div className="stack">
      <Chips options={[...staffSections]} value={section} onChange={setSection} label="Разделы сотрудников" />
      {section === 'team' && <section className="stack" aria-label="Команда">
        <div className="row between">
          <Button variant="primary" onClick={() => setEdit('new')} disabled={!canAdd}><Plus size={16} aria-hidden />Добавить сотрудника</Button>
          <Link className="btn btn-ghost" to={`/learning/manage?partner=${partnerId}`}>Обучение сотрудников</Link>
        </div>
        {locs.isSuccess && !canAdd && <p className="faint">Нет действующих точек для нового сотрудника.</p>}
        <ActionError error={locs.error} />
        {overdueShifts > 0 && <Button size="sm" onClick={() => setSection('shifts')}>Незакрытые смены за прошлые дни: {overdueShifts}</Button>}
        <Field label="Найти сотрудника">{id => <Input id={id} type="search" value={search} placeholder="Имя, телефон или точка" onChange={e => setSearch(e.target.value)} />}</Field>
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
                      {staff.is_manager && <Badge tone="neutral">Управляющий</Badge>}
                      {staff.employee_kind === 'trainee' && <Badge tone="info">Стажёр</Badge>}
                      {staff.open_shift && <Badge tone="success">На смене в «{staff.open_shift.location_name}»</Badge>}
                    </div>
                    <div className="faint">{staff.location_names.join(', ') || 'Точки не назначены'}</div>
                    {staff.phone && <div className="faint">{formatPhone(staff.phone)}</div>}
                  </div>
                  {canManage && <Button size="sm" aria-describedby={`staff-name-${staff.user_id}`}
                    onClick={() => setEdit({ staff, section: staff.active ? 'profile' : 'login' })}>Открыть карточку</Button>}
                </div>
                {!canManage && staff.user_id !== me?.user.id && <p className="faint">Доступ и условия меняет франчайзи</p>}
              </Card>;
            })}
          </div> : <EmptyState title={term ? 'Сотрудники не найдены' : !list.length ? 'Сотрудников пока нет' : status === 'active' ? 'Нет сотрудников с открытым доступом' : 'Нет сотрудников с закрытым доступом'}
            action={term ? <Button size="sm" onClick={() => setSearch('')}>Сбросить поиск</Button> : undefined} />
        )}</DataState>
      </section>}
      {section === 'shifts' && <section className="stack" aria-label="Смены и начисления">
        <ShiftReview partner={partnerId} />
        <div className="row between">
          <MonthNav month={month} onChange={setMonth} max={monthStart()} />
          <Button size="sm" onClick={() => exp.mutate()} loading={exp.isPending} disabled={!payroll.length}>
            <Download size={15} aria-hidden />Скачать ведомость Excel
          </Button>
        </div>
        <ActionError error={exp.error} />
        <DataState query={q}>{() => payroll.length ? (
          <div className="stack">
            <div className="kpis">
              <div className="kpi"><span className="v">{formatMoneyShort(payroll.reduce((a, s) => a + Number(s.month_earned_minor), 0), currency)}</span><span className="l">начислено за месяц</span></div>
            </div>
            {payroll.map((staff) => <Card key={staff.user_id}>
              <div className="row between staff-summary">
                <div style={{ minWidth: 0 }}><strong>{staff.full_name}</strong>
                  <div className="faint">Смены: {staff.month_shifts} · Выручка: {formatMoneyShort(staff.month_revenue_minor, currency)}</div>
                </div>
                <strong className="num">{formatMoneyShort(staff.month_earned_minor, currency)}</strong>
              </div>
              {staff.shifts.length > 0 && <details style={{ marginTop: 8 }}><summary>Смены за месяц</summary>
                <ul className="list">{staff.shifts.map((shift) => <li key={shift.id} className="row between access-row">
                  <span>{dayLabel(shift.day)} · {shift.location_name}<span className="faint" style={{ display: 'block' }}>
                    {new Date(shift.opened_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}–{new Date(shift.closed_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · Выручка: {formatMoneyShort(shift.total_minor, currency)}
                  </span></span>
                  <strong className="num">{formatMoneyShort(shift.earned_minor, currency)}</strong>
                </li>)}</ul>
              </details>}
            </Card>)}
          </div>
        ) : <EmptyState title="За этот месяц нет закрытых смен" />}</DataState>
      </section>}
      <div hidden={section !== 'pay'}>
        <section className="stack" aria-label="Оплата">
          <MotivationPanel partner={partnerId} />
          <DataState query={q}>{(list) => {
            const activeStaff = list.filter((staff) => staff.active);
            return activeStaff.length ? <Card title="Условия сотрудников"><ul className="list">
              {activeStaff.map((staff) => <li key={staff.user_id} className="row between access-row">
                <div style={{ minWidth: 0 }}>
                  <strong>{staff.full_name}</strong>
                  <div className="faint">{payTerms(staff, currency)}</div>
                  {staff.employee_kind === 'trainee' && staff.internship_floor_minor !== undefined && <div className="faint">
                    Минимум за смену на стажировке: {formatMoneyShort(staff.internship_floor_minor, currency)}
                  </div>}
                </div>
                {canManageStaff(staff) && <Button size="sm" onClick={() => setEdit({ staff, section: 'pay' })}>Изменить</Button>}
              </li>)}
            </ul></Card> : <EmptyState title="Нет сотрудников с открытым доступом" />;
          }}</DataState>
        </section>
      </div>
      {edit && <StaffDialog key={selectedStaff?.user_id ?? 'new'} partnerId={partnerId} locations={locs} staff={selectedStaff}
        initialSection={edit === 'new' ? undefined : edit.section} onClose={() => setEdit(null)} onChangeAccess={changeAccess} />}
      {access && <ConfirmDialog open danger={access.staff.active} title={`${access.staff.active ? 'Закрыть' : 'Вернуть'} доступ?`} confirmLabel={access.staff.active ? 'Закрыть доступ' : 'Вернуть доступ'}
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
  const partnerId = me?.assignments.find((a) => a.scope_type === 'partner')?.scope_id;
  return (
    <>
      <PageHeader title="Сотрудники" />
      {partnerId ? <StaffPanel partnerId={partnerId} /> : <EmptyState title="Нет франчайзи" />}
    </>
  );
}
