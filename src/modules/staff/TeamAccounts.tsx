import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router';
import { command, from, rows } from '../../platform/backend';
import { useSession, type Me } from '../../platform/session';
import { dayLabel, monthStart } from '../../platform/dates';
import { Button, Card, Checkbox, ConfirmDialog, DataState, EmptyState, Field, Input, Money, PageHeader, Select } from '../../ui';
import { CopyCredential, CredentialFields } from '../../ui/CredentialFields';
import { MonthlyDetails, StaffHome } from './StaffHome';
import { MonthNav } from '../revenue/components';
import { formatPhone, randomPassword, staffList, userSetPassword } from './api';
import { phoneLoginDigits } from '../../platform/login';
import { PhoneLoginDialog } from './PhoneLoginDialog';
import { NewAccountCredentials } from './NewAccountCredentials';

type Team = { user_id: string; full_name: string; phone: string; active: boolean; location_ids: string[]; location_names: string[] };
type TeamAction = 'new' | 'assign' | { type: 'password' | 'active'; user: Team } | {type:'scope';user:Team};
type RevenuePoint = {location_id:string; location_name:string; currency:string; total_minor:number; days:{day:string;total_minor:number}[]};

export function ownedTeamPartner(me: Me | null) {
  return me?.assignments.find((assignment) => assignment.role === 'franchisee' && assignment.scope_type === 'partner'
    && assignment.permissions.includes('team.manage'))?.scope_id;
}

export function TeamAccessPage() {
  const { me } = useSession();
  const partner = ownedTeamPartner(me);
  if (!partner) return <Navigate to="/" replace />;
  return <>
    <PageHeader title="Управляющие" />
    <TeamAccounts partner={partner} standalone />
  </>;
}

export function TeamHome() {
  const { me, can } = useSession();
  const partner = me?.assignments.find(assignment => assignment.scope_type === 'partner' && assignment.role === 'franchisee_manager')?.scope_id;
  const [month, setMonth] = useState(monthStart());
  if (can('shift.work')) return <StaffHome pointRevenue={partner ? selected => <TeamRevenue partner={partner} month={selected} /> : undefined} />;
  return <div className="home">
    <PageHeader title="Главная" />
    {partner && <Card title="Итоги месяца" className="team-monthly">
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <TeamRevenue partner={partner} month={month} />
    </Card>}
  </div>;
}
function TeamRevenue({ partner, month }: { partner: string; month: string }) {
  const q = useQuery({ queryKey: ['team-revenue', partner, month], queryFn: () => command<RevenuePoint[]>('team_revenue_month', { partner, month }) });
  return <section className="team-point-revenue">
    <h3>Выручка моих точек</h3>
    <DataState query={q}>{points => points.length ? points.map(point => (
      <MonthlyDetails key={point.location_id} label={point.location_name} total={point.total_minor} currency={point.currency}>
        {point.days.length > 0 ? <ul className="list">{point.days.map(day => (
          <li key={day.day} className="row between"><span>{dayLabel(day.day)}</span><Money minor={day.total_minor} currency={point.currency} short /></li>
        ))}</ul> : <p className="faint">За этот месяц нет выручки.</p>}
      </MonthlyDetails>
    )) : <p className="faint">Франчайзи ещё не назначил точки управления.</p>}</DataState>
  </section>;
}
export function TeamAccounts({ partner, standalone = false }: { partner: string; standalone?: boolean }) {
  const { me } = useSession(); const qc = useQueryClient();
  const canManageTeam = me?.assignments.some((assignment) => assignment.permissions.includes('team.manage')
    && (assignment.scope_type === 'company' || (assignment.scope_type === 'partner' && assignment.scope_id === partner)));
  const [action, setAction] = useState<TeamAction | null>(null);
  const [loginUser, setLoginUser] = useState<Team | null>(null);
  const [historyOpen,setHistoryOpen]=useState(false);
  const q = useQuery({ queryKey: ['team', partner], enabled: Boolean(canManageTeam), queryFn: () => command<Team[]>('team_list', { partner }) });
  const history=useQuery({queryKey:['staff-access-history',partner],enabled:Boolean(canManageTeam)&&historyOpen,
    queryFn:()=>command<{id:number;at:string;action:string;actor_name:string|null;user_name:string|null}[]>('staff_access_history',{partner})});
  if (!canManageTeam) return null;
  const closeAction = () => {
    setAction(null);
    void qc.invalidateQueries({ queryKey: ['team', partner] });
    void qc.invalidateQueries({ queryKey: ['staff-list', partner] });
    void qc.invalidateQueries({ queryKey: ['staff-access-history', partner] });
  };
  const actionLabel:Record<string,string>={'team.create':'Создан доступ управляющего','staff.create':'Создан доступ','staff.update':'Изменён профиль','staff.access':'Изменены роль или точки','user.password':'Изменён пароль','user.login':'Изменён телефон для входа','staff.remove':'Доступ закрыт','staff.restore':'Доступ возвращён','team.active':'Изменён доступ','staff.active':'Изменён доступ','team.remove':'Доступ закрыт','team.restore':'Доступ возвращён'};
  const content = <>
    <p className="faint">Управляющий видит выручку назначенных точек. Права на работу с сотрудниками и заказы настраиваются в карточке сотрудника на вкладке «Вход».</p>
    <div className="row"><Button size="sm" onClick={() => setAction('assign')}>Назначить управляющего</Button><Button size="sm" onClick={() => setAction('new')}>Новый управляющий</Button></div>
    <DataState query={q} empty={list => list.length ? null : <EmptyState title="Управляющих пока нет" />}>{list => <ul className="list">{list.map(u => <li key={u.user_id} className="access-row row between">
      <span><strong>{u.full_name}</strong><span className="faint"> · {u.active ? 'доступ открыт' : 'доступ закрыт'}</span><span className="faint" style={{display:'block'}}>{u.location_names.join(', ')||'Точки ещё не назначены'}</span></span>
      {u.user_id !== me?.user.id && <div className="row">
        {u.phone && <CopyCredential kind="login" value={formatPhone(u.phone)} />}
        {u.active && <><Button size="sm" onClick={() => setAction({ type: 'scope', user: u })}>Точки и роль</Button>
          <Button size="sm" onClick={() => setLoginUser(u)}>Телефон / логин</Button>
          <Button size="sm" onClick={() => setAction({ type: 'password', user: u })}>Пароль</Button></>}
        <Button size="sm" onClick={() => setAction({ type: 'active', user: u })}>{u.active ? 'Закрыть доступ' : 'Вернуть доступ'}</Button>
      </div>}
    </li>)}</ul>}</DataState>
    <details onToggle={e=>setHistoryOpen(e.currentTarget.open)}><summary>История доступа</summary><DataState query={history}>{list=><ul className="list">{list.map(a=><li key={a.id}><strong>{actionLabel[a.action]??'Изменён доступ'}</strong> · {a.user_name??'Сотрудник'}<span className="faint" style={{display:'block'}}>{new Date(a.at).toLocaleString('ru-RU')} · {a.actor_name??'Система'}</span></li>)}{!list.length&&<li>Изменений доступа пока нет.</li>}</ul>}</DataState></details>
    {loginUser && <PhoneLoginDialog user={loginUser.user_id} name={loginUser.full_name} currentPhone={loginUser.phone} onClose={() => setLoginUser(null)} />}
    {action && (action==='assign'||typeof action==='object'&&action.type==='scope'
      ? <StaffAccessDialog partner={partner} user={typeof action==='object'?action.user:undefined} onClose={closeAction}/>
      : <TeamDialog partner={partner} action={action} onClose={closeAction} />)}
  </>;
  return standalone ? <div className="stack">{content}</div>
    : <details className="team-accounts"><summary>Управляющие</summary>{content}</details>;
}
function StaffAccessDialog({partner,user,onClose}:{partner:string;user?:Team;onClose:()=>void}) {
  const {me}=useSession();
  const [selectedUser,setSelectedUser]=useState(user?.user_id??'');
  const [selected,setSelected]=useState<string[]>(user?.location_ids??[]);
  const [manager,setManager]=useState(true);
  const employees=useQuery({queryKey:['staff-list',partner,monthStart()],queryFn:()=>staffList(partner,monthStart())});
  const locations=useQuery({queryKey:['team-locations',partner],queryFn:()=>rows<{id:string;name:string}>(from('location').select('id,name').eq('partner_id',partner).eq('status','active'))});
  const eligible = employees.data?.filter(s => s.active && !s.is_manager && s.user_id !== me?.user.id && s.can_manage !== false);
  const m=useMutation({mutationFn:()=>command('staff_access_set',{partner,user:selectedUser,manager,locations:selected}),onSuccess:onClose});
  const selectEmployee=(id:string)=>{setSelectedUser(id);const employee=employees.data?.find(s=>s.user_id===id);setSelected(employee?.location_ids??[]);};
  return <ConfirmDialog open title={user?'Роль и точки управляющего':'Назначить управляющего'} confirmLabel="Сохранить" onConfirm={()=>m.mutate()} onClose={onClose} busy={m.isPending} error={m.error} disabled={!selectedUser||!selected.length}>
    {user ? <p>{user.full_name}</p> : <DataState query={employees}>{() => eligible?.length
      ? <Field label="Сотрудник" required>{id => <Select id={id} value={selectedUser} onChange={e => selectEmployee(e.target.value)}>
        <option value="">Выберите сотрудника</option>{eligible.map(s => <option key={s.user_id} value={s.user_id}>{s.full_name}</option>)}
      </Select>}</Field>
      : <p className="faint">Нет сотрудников, которым можно назначить эту роль.</p>}</DataState>}
    {user && <Checkbox label="Роль управляющего" checked={manager} onChange={setManager}/>}
    <Field label="Точки работы и управления" required>{()=>locations.data?.map(l=><Checkbox key={l.id} label={l.name} checked={selected.includes(l.id)} onChange={v=>setSelected(v?[...selected,l.id]:selected.filter(x=>x!==l.id))}/>)}</Field>
    <p className="faint">Действующие сеансы сотрудника завершатся. После повторного входа будут действовать новые права. Смены и начисления сохранятся. Без роли управляющего остаётся обычный доступ сотрудника.</p>
  </ConfirmDialog>;
}
function TeamDialog({ partner, action, onClose }: { partner: string; action: 'new' | { type: 'password' | 'active'; user: Team }; onClose: () => void }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [password, setPassword] = useState(randomPassword);
  const [issued, setIssued] = useState<{ phone: string; password: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const locations = useQuery({ queryKey: ['team-locations', partner], enabled: action === 'new', queryFn: () => rows<{ id: string; name: string }>(from('location').select('id,name').eq('partner_id', partner).eq('status', 'active')) });
  const access = action !== 'new' && action.type === 'active';
  const m = useMutation({ mutationFn: async () => {
    const submittedPassword = password;
    if (action === 'new') {
      const submittedPhone = phone;
      await command('staff_account_create_phone', { partner, full_name: name.trim(), phone: submittedPhone, password: submittedPassword, locations: selected, manager: true });
      setIssued({ phone: formatPhone(phoneLoginDigits(submittedPhone)!), password: submittedPassword });
      return;
    }
    if (action.type === 'active') { await command('team_set_active', { partner, user: action.user.user_id, active: !action.user.active }); return; }
    await userSetPassword(action.user.user_id, submittedPassword);
    setIssued({ phone: formatPhone(action.user.phone), password: submittedPassword });
  }, onSuccess: () => { if (access) onClose(); } });
  if (issued && action === 'new') return <NewAccountCredentials title="Управляющий добавлен" {...issued} onClose={onClose} />;
  if (issued) return <ConfirmDialog open title="Доступ готов" confirmLabel="Готово" onConfirm={onClose} onClose={onClose}>
    <p>Передайте управляющему данные для входа. Пароль повторно не показывается.</p>
    <CredentialFields login={issued.phone} password={issued.password} />
  </ConfirmDialog>;
  return <ConfirmDialog open title={action === 'new' ? 'Новый управляющий' : access ? (action.user.active ? 'Закрыть доступ?' : 'Вернуть доступ?') : 'Новый пароль'}
    confirmLabel={access ? 'Подтвердить' : 'Сохранить'} onConfirm={() => m.mutate()} onClose={onClose} busy={m.isPending} error={m.error}
    disabled={!access && (password.length < 6 || action === 'new' && (!name.trim() || !phoneLoginDigits(phone) || !selected.length))}>
    {access ? <p>История сохранится. Для следующего входа понадобится заново ввести логин и пароль.</p> : <>
      {action === 'new' && <><Field label="Имя" required>{id => <Input id={id} value={name} onChange={e => setName(e.target.value)} />}</Field>
        <Field label="Телефон / логин" required hint="Полный номер с кодом страны">{id => <Input id={id} type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+7 900 123-45-67" />}</Field></>}
      {action === 'new' && <Field label="Точки работы и управления" required>{() => locations.data?.map(l => <Checkbox key={l.id} label={l.name} checked={selected.includes(l.id)} onChange={v => setSelected(v ? [...selected, l.id] : selected.filter(x => x !== l.id))} />)}</Field>}
      {action === 'new' && <p className="faint">Управляющий сможет добавлять сотрудников на выбранные точки и заказывать материалы. Право «Видеть сотрудников» также позволит редактировать их карточки и просматривать начисления.</p>}
      <Field label="Пароль" required>{id => <Input id={id} value={password} onChange={e => setPassword(e.target.value)} />}</Field>
    </>}
  </ConfirmDialog>;
}
