// Диалоги менеджера: франчайзи, точка, план месяца, выдача доступа.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { monthLabel } from '../../platform/dates';
import { ConfirmDialog, Field, Input, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { planSet } from '../revenue/api';
import { accessGrant, accountCreate, countries, locationSave, partnerSave, type Location, type Partner } from './api';
import { randomPassword, userSetPassword } from '../staff/api';

export function PartnerDialog({ partner, onClose, onSaved }: { partner?: Partner; onClose: () => void; onSaved?: (id: string) => void }) {
  const qc = useQueryClient();
  const c = useQuery({ queryKey: ['countries'], queryFn: countries, staleTime: Infinity });
  const [f, setF] = useState({ name: partner?.name ?? '', country: partner?.country ?? 'RU', contact_name: partner?.contact_name ?? '',
    contact_phone: partner?.contact_phone ?? '', contact_email: partner?.contact_email ?? '', status: partner?.status ?? 'active' });
  const m = useMutation({
    mutationFn: () => partnerSave({ id: partner?.id ?? null, ...f }),
    onSuccess: (id) => { void qc.invalidateQueries(); onSaved?.(id); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <ConfirmDialog open title={partner ? 'Данные франчайзи' : 'Новый франчайзи'} confirmLabel="Сохранить" busy={m.isPending} error={m.error}
      disabled={!f.name.trim()} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название" required hint="Например: Виктор (Волгоград)">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Страна" hint={partner ? 'Страну и валюту после создания не меняют' : 'Определяет валюту'}>{(id) => (
          <Select id={id} value={f.country} disabled={Boolean(partner)} onChange={set('country')}>
            {(c.data ?? []).map((x) => <option key={x.code} value={x.code}>{x.name} ({x.default_currency})</option>)}
          </Select>
        )}</Field>
        {partner && <Field label="Статус">{(id) => (
          <Select id={id} value={f.status} onChange={set('status')}>
            <option value="active">Работает</option><option value="suspended">Приостановлен</option><option value="terminated">Договор расторгнут</option>
          </Select>
        )}</Field>}
      </div>
      <Field label="Контактное лицо">{(id) => <Input id={id} value={f.contact_name} onChange={set('contact_name')} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Телефон">{(id) => <Input id={id} type="tel" value={f.contact_phone} onChange={set('contact_phone')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={f.contact_email} onChange={set('contact_email')} />}</Field>
      </div>
    </ConfirmDialog>
  );
}

export function LocationDialog({ partnerId, location, onClose }: { partnerId: string; location?: Location; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: location?.name ?? '', city: location?.city ?? '', address: location?.address ?? '',
    status: location?.status ?? 'active', opened_on: location?.opened_on ?? '' });
  const m = useMutation({
    mutationFn: () => locationSave({ id: location?.id ?? null, partner: partnerId, ...f, opened_on: f.opened_on || null }),
    onSuccess: () => { void qc.invalidateQueries(); onClose(); },
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <ConfirmDialog open title={location ? 'Точка' : 'Новая точка'} confirmLabel="Сохранить" busy={m.isPending} error={m.error}
      disabled={!f.name.trim() || !f.city.trim()} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название точки" required hint="Например: Волгоград Европа">{(id) => <Input id={id} value={f.name} onChange={set('name')} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Город" required>{(id) => <Input id={id} value={f.city} onChange={set('city')} />}</Field>
        <Field label="Дата открытия" hint="С этого дня считаются пропуски">{(id) => <Input id={id} type="date" value={f.opened_on} onChange={set('opened_on')} />}</Field>
      </div>
      <Field label="Адрес">{(id) => <Input id={id} value={f.address} onChange={set('address')} />}</Field>
      {location && <Field label="Статус">{(id) => (
        <Select id={id} value={f.status} onChange={set('status')}><option value="active">Работает</option><option value="closed">Закрыта</option></Select>
      )}</Field>}
    </ConfirmDialog>
  );
}

export function PlanDialog({ location, month, currency, current, onClose }: { location: Location; month: string; currency: string; current: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState(current ? String(current) : '');
  const m = useMutation({
    mutationFn: () => planSet(location.id, month, amount || '0'),
    onSuccess: () => { toast('План сохранён'); void qc.invalidateQueries({ queryKey: ['revenue'] }); onClose(); },
  });
  return (
    <ConfirmDialog open title={`План: ${location.name}`} confirmLabel="Сохранить план" busy={m.isPending} error={m.error} onClose={onClose} onConfirm={() => m.mutate()}>
      <p className="muted">План выручки на {monthLabel(month)}. Франчайзи увидит его на главном экране. Пусто или 0 — снять план.</p>
      <Field label={`Сумма, ${currency}`}>{(id) => <MoneyInput id={id} value={amount} onChange={setAmount} currency={currency} onEnter={() => m.mutate()} />}</Field>
    </ConfirmDialog>
  );
}

export function AccessDialog({ partnerId, onClose }: { partnerId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'create' | 'grant'>('create');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState(randomPassword);
  const [made, setMade] = useState<{ email: string; password: string } | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      if (mode === 'create') { await accountCreate(partnerId, name, email, password); return 'created' as const; }
      return (await accessGrant(partnerId, email)).status;
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['access', partnerId] });
      if (r === 'created') { setMade({ email, password }); return; }
      toast(r === 'granted' ? 'Доступ выдан' : r === 'exists' ? 'У этого пользователя уже есть доступ' : 'Приглашение сохранено');
      onClose();
    },
  });
  if (made) {
    return (
      <ConfirmDialog open title="Учётная запись создана" confirmLabel="Готово" onClose={onClose} onConfirm={onClose}>
        <p>Передайте франчайзи данные для входа. Пароль он сможет сменить сам в профиле.</p>
        <div className="login-card-data">
          <div><span className="faint">Сайт</span><strong>{location.origin}{location.pathname}</strong></div>
          <div><span className="faint">Email</span><strong>{made.email}</strong></div>
          <div><span className="faint">Пароль</span><strong className="mono">{made.password}</strong></div>
        </div>
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog open title="Доступ для франчайзи" confirmLabel={mode === 'create' ? 'Создать учётную запись' : 'Выдать доступ'} busy={m.isPending} error={m.error}
      disabled={!email.includes('@') || (mode === 'create' && (!name.trim() || password.length < 6))} onClose={onClose} onConfirm={() => m.mutate()}>
      <div className="chips" role="group" aria-label="Способ">
        <button type="button" className="chip" aria-pressed={mode === 'create'} onClick={() => setMode('create')}>Новая учётная запись</button>
        <button type="button" className="chip" aria-pressed={mode === 'grant'} onClick={() => setMode('grant')}>Уже есть в системе</button>
      </div>
      {mode === 'create' && <Field label="Имя" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
      <Field label="Email франчайзи" required>{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      {mode === 'create'
        ? <Field label="Пароль" hint="Можно оставить предложенный; франчайзи сменит его в профиле">{(id) => <Input id={id} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        : <p className="faint">Если пользователя с таким email ещё нет, доступ назначится сам при его первом входе.</p>}
    </ConfirmDialog>
  );
}

export function SetPasswordDialog({ user, name, onClose }: { user: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState(randomPassword);
  const m = useMutation({ mutationFn: () => userSetPassword(user, pw), onSuccess: () => { toast(`Новый пароль для ${name}: ${pw}`); onClose(); } });
  return (
    <ConfirmDialog open title={`Новый пароль — ${name}`} confirmLabel="Задать пароль" busy={m.isPending} error={m.error} disabled={pw.length < 6} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Пароль" hint="Минимум 6 символов. Сообщите его пользователю">{(id) => <Input id={id} value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}
