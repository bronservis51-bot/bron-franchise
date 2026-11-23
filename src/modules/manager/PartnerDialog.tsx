// Диалоги менеджера: франчайзи, точка, план месяца, выдача доступа.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { monthLabel } from '../../platform/dates';
import { ConfirmDialog, Field, Input, MoneyInput, Select } from '../../ui';
import { CredentialFields } from '../../ui/CredentialFields';
import { useToast } from '../../ui/toast';
import { toAppError } from '../../platform/backend';
import { planSet } from '../revenue/api';
import { accessGrant, accountCreatePhone, countries, locationSave, managerPartnerStatusKey, partnerCreate, partnerSave, type Location, type Partner, type PartnerFromLead } from './api';
import { formatPhone, randomPassword, userSetPassword } from '../staff/api';
import { PARTNER_PREPARATION } from '../../ui/status';
import { loginEmail, phoneLoginDigits } from '../../platform/login';
import { NewAccountCredentials } from '../staff/NewAccountCredentials';

function formChanged<T extends Record<string, string>>(original: T, draft: T) {
  return Object.keys(original).some(key => original[key] !== draft[key]);
}

export function PartnerDialog({ partner, working, focusContact = false, fromLead, onClose, onSaved }: {
  partner?: Partner; working?: boolean; focusContact?: boolean; onClose: () => void; onSaved?: (id: string) => void;
  fromLead?: { initial: Partial<PartnerFromLead>; create: (fields: PartnerFromLead, operation: string) => Promise<string> };
}) {
  const qc = useQueryClient();
  const contactOnly = Boolean(partner && focusContact);
  const c = useQuery({ queryKey: ['countries'], queryFn: countries, staleTime: Infinity, enabled: !contactOnly });
  const [original] = useState(() => ({ name: partner?.name ?? fromLead?.initial.name ?? '', country: partner?.country ?? fromLead?.initial.country ?? 'RU',
    contact_name: partner?.contact_name ?? fromLead?.initial.contact_name ?? '', contact_phone: partner?.contact_phone ?? fromLead?.initial.contact_phone ?? '',
    contact_email: partner?.contact_email ?? fromLead?.initial.contact_email ?? '', status: partner?.status ?? 'active',
    preparation_stage: partner?.preparation_stage ?? fromLead?.initial.preparation_stage ?? '',
    contact_city: fromLead?.initial.contact_city ?? '', contact_instagram: fromLead?.initial.contact_instagram ?? '' }));
  const [f, setF] = useState(original);
  const [version] = useState(() => ({ id: partner?.id ?? null, updatedAt: partner?.updated_at ?? null }));
  const [operation] = useState(() => crypto.randomUUID());
  const m = useMutation({
    mutationFn: () => {
      const { contact_city, contact_instagram, status, ...draft } = f;
      const fields = { ...draft, preparation_stage: draft.preparation_stage || null };
      if (fromLead) return fromLead.create({ ...fields, contact_city, contact_instagram }, operation);
      return version.id
        ? partnerSave({ ...fields, status, id: version.id, expected_updated_at: version.updatedAt })
        : partnerCreate({ ...fields, status, operation });
    },
    onError: error => { if (toAppError(error).code === 'version-conflict') void qc.invalidateQueries({ queryKey: ['partners'] }); },
    onSuccess: (id) => { void qc.invalidateQueries(); onSaved?.(id); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <ConfirmDialog open title={contactOnly ? 'Основной контакт' : partner ? 'Данные франчайзи' : 'Новый франчайзи'} confirmLabel={fromLead ? 'Создать франчайзи' : 'Сохранить'} busy={m.isPending} error={m.error}
      disabled={!f.name.trim()} dirty={formChanged(original, f)} onClose={onClose} onConfirm={() => m.mutate()}>
      {!contactOnly && <>
        <Field label="Название" required hint="Например: Виктор (Волгоград)">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="Страна" hint={partner ? 'Страну и валюту после создания не меняют' : 'Определяет валюту'}>{(id) => (
            <Select id={id} value={f.country} disabled={Boolean(partner)} onChange={set('country')}>
              {(c.data ?? []).map((x) => <option key={x.code} value={x.code}>{x.name} ({x.default_currency})</option>)}
            </Select>
          )}</Field>
          {partner && <Field label="Статус франчайзи">{(id) => (
            <Select id={id} value={f.status} onChange={set('status')}>
              <option value="active">Активен</option><option value="suspended">Приостановлен</option><option value="terminated">Договор расторгнут</option>
            </Select>
          )}</Field>}
        </div>
        <Field label="Этап подготовки" hint={working ? 'Сохранённый этап до открытия торговой точки' : 'Этап можно менять в любом порядке'}>{(id) => (
          <Select id={id} value={f.preparation_stage} onChange={set('preparation_stage')}>
            <option value="">Не указан</option>
            {Object.entries(PARTNER_PREPARATION).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}
          </Select>
        )}</Field>
      </>}
      <Field label="Контактное лицо">{(id) => <Input id={id} value={f.contact_name} onChange={set('contact_name')} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Телефон">{(id) => <Input id={id} type="tel" value={f.contact_phone} onChange={set('contact_phone')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={f.contact_email} onChange={set('contact_email')} />}</Field>
      </div>
      {fromLead && <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Город">{id => <Input id={id} value={f.contact_city} maxLength={80} onChange={set('contact_city')} />}</Field>
        <Field label="Instagram">{id => <Input id={id} value={f.contact_instagram} maxLength={30} onChange={set('contact_instagram')} />}</Field>
      </div>}
    </ConfirmDialog>
  );
}

export function LocationDialog({ partnerId, location, onClose, onSaved }: {
  partnerId: string; location?: Location; onClose: () => void; onSaved?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [original] = useState(() => ({ name: location?.name ?? '', city: location?.city ?? '', address: location?.address ?? '',
    status: location?.status ?? 'active', opened_on: location?.opened_on ?? '' }));
  const [f, setF] = useState(original);
  const [version] = useState(() => ({ id: location?.id ?? null, updatedAt: location?.updated_at ?? null }));
  const m = useMutation({
    mutationFn: () => locationSave({ id: version.id, partner: partnerId, ...f, opened_on: f.opened_on || null, expected_updated_at: version.updatedAt }),
    onError: error => { if (toAppError(error).code === 'version-conflict') void qc.invalidateQueries({ queryKey: ['locations', partnerId] }); },
    onSuccess: (id) => { void qc.invalidateQueries(); onSaved?.(id); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <ConfirmDialog open title={location ? 'Точка' : 'Новая точка'} confirmLabel="Сохранить" busy={m.isPending} error={m.error}
      disabled={!f.name.trim() || !f.city.trim()} dirty={formChanged(original, f)} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название точки" required hint="Например: Волгоград Европа">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Город" required>{(id) => <Input id={id} value={f.city} onChange={set('city')} />}</Field>
        <Field label="Дата открытия" hint="С этого дня доступны новые смены и считаются пропуски">{(id) => <Input id={id} type="date" value={f.opened_on} onChange={set('opened_on')} />}</Field>
      </div>
      <Field label="Адрес">{(id) => <Input id={id} value={f.address} onChange={set('address')} />}</Field>
      {location && <Field label="Статус точки">{(id) => (
        <Select id={id} value={f.status} onChange={set('status')}><option value="active">Активна</option><option value="closed">Закрыта</option></Select>
      )}</Field>}
    </ConfirmDialog>
  );
}

export function PlanDialog({ location, month, currency, current, onClose }: { location: Location; month: string; currency: string; current: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const initialAmount = current ? String(current) : '';
  const [amount, setAmount] = useState(initialAmount);
  const [amountValid, setAmountValid] = useState(true);
  const m = useMutation({
    mutationFn: () => planSet(location.id, month, amount || '0'),
    onSuccess: () => { toast('План сохранён'); void qc.invalidateQueries({ queryKey: ['revenue'] }); onClose(); },
  });
  const submit = () => { if (amountValid && !m.isPending) m.mutate(); };
  return (
    <ConfirmDialog open title={`План: ${location.name}`} confirmLabel="Сохранить план" busy={m.isPending} error={m.error}
      disabled={!amountValid} dirty={!amountValid || (amount || '0') !== (initialAmount || '0')} onClose={onClose} onConfirm={submit}>
      <p className="muted">{monthLabel(month)}. Чтобы снять план, оставьте поле пустым или укажите 0.</p>
      <Field label={`Сумма, ${currency}`} error={!amountValid ? 'Укажите сумму, например 1250,50.' : undefined}>{(id, describedBy) => (
        <MoneyInput id={id} describedBy={describedBy} value={amount} onChange={setAmount} currency={currency} onValidityChange={setAmountValid} onEnter={submit} />
      )}</Field>
    </ConfirmDialog>
  );
}

export function AccessDialog({ partnerId, onClose }: { partnerId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'create' | 'grant'>('create');
  const [phone, setPhone] = useState('');
  const [login, setLogin] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState(randomPassword);
  const [made, setMade] = useState<{ phone: string; password: string } | null>(null);
  const digits = phoneLoginDigits(phone);
  let grantValid = false;
  try { grantValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loginEmail(login)); } catch { /* keep the form disabled */ }
  const m = useMutation({
    mutationFn: async () => {
      if (mode === 'create') {
        const submittedPhone = phone;
        const submittedPassword = password;
        await accountCreatePhone(partnerId, name, submittedPhone, submittedPassword);
        setMade({ phone: formatPhone(phoneLoginDigits(submittedPhone)!), password: submittedPassword });
        return { status: 'created' as const };
      }
      return { status: (await accessGrant(partnerId, login)).status };
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['access', partnerId] });
      void qc.invalidateQueries({ queryKey: managerPartnerStatusKey });
      if (r.status === 'created') return;
      toast(r.status === 'granted' ? 'Доступ выдан' : r.status === 'exists' ? 'У этого пользователя уже есть доступ' : 'Пользователь не найден. Отмените подготовленное приглашение в карточке и затем создайте учётную запись.');
      onClose();
    },
  });
  if (made) return <NewAccountCredentials title="Учётная запись создана" {...made} onClose={onClose} />;
  return (
    <ConfirmDialog open title="Доступ для франчайзи" confirmLabel={mode === 'create' ? 'Создать учётную запись' : 'Выдать доступ'} busy={m.isPending} error={m.error}
      disabled={mode === 'create' ? !digits || !name.trim() || password.length < 6 : !grantValid} onClose={onClose} onConfirm={() => m.mutate()}>
      <div className="chips" role="group" aria-label="Способ">
        <button type="button" className="chip" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>Новая учётная запись</button>
        <button type="button" className="chip" aria-pressed={mode === 'grant'} onClick={() => setMode('grant')}>Уже есть в системе</button>
      </div>
      {mode === 'create' && <Field label="Имя" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
      {mode === 'create'
        ? <Field label="Телефон / логин" required hint="Полный номер с кодом страны">{(id) => <Input id={id} type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 900 123-45-67" />}</Field>
        : <Field label="Телефон или прежний логин/email" required>{(id) => <Input id={id} autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />}</Field>}
      {mode === 'create'
        ? <Field label="Пароль" hint="Можно оставить предложенный; франчайзи сменит его в профиле">{(id) => <Input id={id} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        : <p className="faint">Для нового пользователя выберите «Новая учётная запись». Выдача доступа существующему пользователю не меняет его пароль.</p>}
    </ConfirmDialog>
  );
}

export function SetPasswordDialog({ user, name, login, onClose }: { user: string; name: string; login: string; onClose: () => void }) {
  const [pw, setPw] = useState(randomPassword);
  const [issued, setIssued] = useState<string | null>(null);
  const m = useMutation({ mutationFn: async () => {
    const submitted = pw;
    await userSetPassword(user, submitted);
    setIssued(submitted);
  } });
  if (issued) return <ConfirmDialog open title="Пароль изменён" cancelLabel="Готово" onClose={onClose}>
    <p>Пароль для {name} доступен до закрытия этого окна.</p>
    <CredentialFields login={login} password={issued} />
  </ConfirmDialog>;
  return (
    <ConfirmDialog open title={`Новый пароль — ${name}`} confirmLabel="Задать пароль" busy={m.isPending} error={m.error} disabled={pw.length < 6} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Пароль" hint="Минимум 6 символов. Сообщите его пользователю">{(id) => <Input id={id} value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}
