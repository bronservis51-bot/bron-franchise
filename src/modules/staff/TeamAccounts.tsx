import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { command, from, rows } from '../../platform/backend';
import { useLocale } from '../../platform/locale';
import { useSession, type Me } from '../../platform/session';
import { dayLabel, monthStart } from '../../platform/dates';
import { Button, Card, Checkbox, ConfirmDialog, DataState, EmptyState, Field, Input, Money, PageHeader, Select } from '../../ui';
import { CopyCredential, CredentialFields } from '../../ui/CredentialFields';
import { MonthlyDetails, StaffHome } from './StaffHome';
import { MonthNav } from '../revenue/components';
import { FRANCHISEE_CARD_AMBIGUITY, franchiseePartnerCards } from '../revenue/partnerLifecycle';
import { formatPhone, randomPassword, staffList, userSetPassword } from './api';
import { phoneLoginDigits } from '../../platform/login';
import { PhoneLoginDialog } from './PhoneLoginDialog';
import { NewAccountCredentials } from './NewAccountCredentials';

type Team = { user_id: string; full_name: string; phone: string; active: boolean; location_ids: string[]; location_names: string[] };
type TeamAction = 'new' | 'assign' | { type: 'password' | 'active'; user: Team } | {type:'scope';user:Team};
type RevenuePoint = {location_id:string; location_name:string; currency:string; total_minor:number; missing_days?:string[];
  days:{day:string;total_minor:number;return_minor?:number}[]};

export function ownedTeamPartner(me: Me | null) {
  const cards = franchiseePartnerCards(me);
  if (cards.length !== 1) return;
  return me?.assignments.find(assignment => assignment.role === 'franchisee' && assignment.scope_type === 'partner'
    && assignment.scope_id === cards[0] && assignment.permissions.includes('team.manage'))?.scope_id;
}

export function TeamAccessPage() {
  const { t } = useLocale();
  const { me } = useSession();
  const partner = ownedTeamPartner(me);
  if (franchiseePartnerCards(me).length > 1) return <>
    <PageHeader title={t('Управляющие', 'Mağaza yöneticileri')} />
    <EmptyState title={t('Уточните доступ к карточке франчайзи', 'Franchise kartı erişimini doğrulayın')} text={t(FRANCHISEE_CARD_AMBIGUITY, 'Bu hesap birden fazla franchise kartına erişiyor. Franchise yöneticinize danışın.')} />
  </>;
  if (!partner) return <Navigate to="/" replace />;
  return <>
    <PageHeader title={t('Управляющие', 'Mağaza yöneticileri')} />
    <TeamAccounts partner={partner} standalone />
  </>;
}

export function TeamHome() {
  const { t } = useLocale();
  const { me, can } = useSession();
  const partner = me?.assignments.find(assignment => assignment.scope_type === 'partner' && assignment.role === 'franchisee_manager')?.scope_id;
  const [month, setMonth] = useState(monthStart());
  if (can('shift.work')) return <StaffHome pointRevenue={partner ? selected => <TeamRevenue partner={partner} month={selected} /> : undefined} />;
  return <div className="home">
    <PageHeader title={t('Главная', 'Ana sayfa')} />
    {partner && <Card title={t('Итоги месяца', 'Aylık özet')} className="team-monthly">
      <MonthNav month={month} onChange={setMonth} max={monthStart()} />
      <TeamRevenue partner={partner} month={month} showMissing />
    </Card>}
  </div>;
}
function TeamRevenue({ partner, month, showMissing }: { partner: string; month: string; showMissing?: boolean }) {
  const { t, locale } = useLocale();
  const q = useQuery({ queryKey: ['team-revenue', partner, month], queryFn: () => command<RevenuePoint[]>('team_revenue_month', { partner, month }) });
  return <section className="team-point-revenue">
    <h3>{t('Выручка моих точек', 'Mağazalarımın cirosu')}</h3>
    <DataState query={q}>{points => points.length ? points.map(point => (
      <div key={point.location_id}>
        {showMissing && point.missing_days?.length ? <p role="status" className="faint">
          {t(`${point.location_name} · нет выручки за ${point.missing_days.length} дн.`, `${point.location_name} · ${point.missing_days.length} günün cirosu eksik`)}
        </p> : null}
        <MonthlyDetails label={point.location_name} total={point.total_minor} currency={point.currency}>
          {point.days.length > 0 ? <ul className="list">{point.days.map(day => (
            <li key={day.day} className="row between"><span>{dayLabel(day.day, locale)}
              {day.return_minor ? <span className="faint" style={{ display: 'block' }}>Возвраты · <Money minor={day.return_minor} currency={point.currency} short /></span> : null}
            </span><Money minor={day.total_minor} currency={point.currency} short /></li>
          ))}</ul> : <p className="faint">{t('За этот месяц нет выручки.', 'Bu ay için ciro kaydı yok.')}</p>}
        </MonthlyDetails>
      </div>
    )) : <p className="faint">{t('Франчайзи ещё не назначил точки управления.', 'Franchise işletmecisi henüz mağaza atamadı.')}</p>}</DataState>
  </section>;
}
export function TeamAccounts({ partner, standalone = false }: { partner: string; standalone?: boolean }) {
  const { t, locale } = useLocale();
  const { me } = useSession(); const qc = useQueryClient();
  const navigate = useNavigate();
  const route = useLocation();
  const canManageTeam = me?.assignments.some((assignment) => assignment.permissions.includes('team.manage')
    && (assignment.scope_type === 'company' || (assignment.scope_type === 'partner' && assignment.scope_id === partner)));
  const [action, setAction] = useState<TeamAction | null>(null);
  const [loginUser, setLoginUser] = useState<Team | null>(null);
  const [historyOpen,setHistoryOpen]=useState(false);
  const q = useQuery({ queryKey: ['team', partner], enabled: Boolean(canManageTeam), queryFn: () => command<Team[]>('team_list', { partner }) });
  const history=useQuery({queryKey:['staff-access-history',partner],enabled:Boolean(canManageTeam)&&historyOpen,
    queryFn:()=>command<{id:number;at:string;action:string;actor_name:string|null;user_name:string|null}[]>('staff_access_history',{partner})});
  if (!canManageTeam) return null;
  const openEmployee = (id: string) => {
    const params = new URLSearchParams(standalone ? '' : route.search);
    params.set('employee', id);
    setAction(null);
    void navigate({ pathname: standalone ? '/staff' : route.pathname, search: `?${params}` });
  };
  const closeAction = () => {
    setAction(null);
    void qc.invalidateQueries({ queryKey: ['team', partner] });
    void qc.invalidateQueries({ queryKey: ['staff-list', partner] });
    void qc.invalidateQueries({ queryKey: ['staff-access-history', partner] });
  };
  const actionLabel:Record<string,string>={'team.create':t('Создан доступ управляющего', 'Yönetici erişimi açıldı'),'staff.create':t('Создан доступ', 'Erişim açıldı'),'staff.update':t('Изменён профиль', 'Profil değiştirildi'),'staff.access':t('Изменены роль или точки', 'Rol veya mağazalar değiştirildi'),'user.password':t('Изменён пароль', 'Parola değiştirildi'),'user.login':t('Изменён телефон для входа', 'Giriş numarası değiştirildi'),'staff.remove':t('Доступ закрыт', 'Erişim kapatıldı'),'staff.restore':t('Доступ возвращён', 'Erişim geri açıldı'),'team.active':t('Изменён доступ', 'Erişim değiştirildi'),'staff.active':t('Изменён доступ', 'Erişim değiştirildi'),'team.remove':t('Доступ закрыт', 'Erişim kapatıldı'),'team.restore':t('Доступ возвращён', 'Erişim geri açıldı')};
  const content = <>
    <p className="faint">{t('Управляющий видит выручку назначенных точек. Права на работу с сотрудниками, их оплату и заказы настраиваются в карточке сотрудника.', 'Yönetici, atandığı mağazaların cirosunu görür. Çalışan, ücret ve sipariş yetkileri çalışan kartından yönetilir.')}</p>
    <div className="row"><Button size="sm" onClick={() => setAction('assign')}>{t('Назначить управляющего', 'Yönetici ata')}</Button><Button size="sm" onClick={() => setAction('new')}>{t('Новый управляющий', 'Yeni yönetici')}</Button></div>
    <DataState query={q} empty={list => list.length ? null : <EmptyState title={t('Управляющих пока нет', 'Henüz yönetici yok')} />}>{list => <ul className="list">{list.map(u => <li key={u.user_id} className="access-row row between">
      <span><strong>{u.full_name}</strong><span className="faint"> · {u.active ? t('доступ открыт', 'erişim açık') : t('доступ закрыт', 'erişim kapalı')}</span><span className="faint" style={{display:'block'}}>{u.location_names.join(', ')||t('Точки ещё не назначены', 'Henüz mağaza atanmadı')}</span></span>
      {u.user_id !== me?.user.id && <div className="row">
        {u.phone && <CopyCredential kind="login" value={formatPhone(u.phone)} />}
        {u.active && <><Button size="sm" onClick={() => setAction({ type: 'scope', user: u })}>{t('Точки и роль', 'Mağazalar ve rol')}</Button>
          <Button size="sm" onClick={() => setLoginUser(u)}>{t('Телефон / логин', 'Telefon / giriş numarası')}</Button>
          <Button size="sm" onClick={() => setAction({ type: 'password', user: u })}>{t('Пароль', 'Parola')}</Button></>}
        <Button size="sm" onClick={() => setAction({ type: 'active', user: u })}>{u.active ? t('Закрыть доступ', 'Erişimi kapat') : t('Вернуть доступ', 'Erişimi geri aç')}</Button>
      </div>}
    </li>)}</ul>}</DataState>
    <details onToggle={e=>setHistoryOpen(e.currentTarget.open)}><summary>{t('История доступа', 'Erişim geçmişi')}</summary><DataState query={history}>{list=><ul className="list">{list.map(a=><li key={a.id}><strong>{actionLabel[a.action]??t('Изменён доступ', 'Erişim değiştirildi')}</strong> · {a.user_name??t('Сотрудник', 'Çalışan')}<span className="faint" style={{display:'block'}}>{new Date(a.at).toLocaleString(locale)} · {a.actor_name??t('Система', 'Sistem')}</span></li>)}{!list.length&&<li>{t('Изменений доступа пока нет.', 'Henüz erişim değişikliği yok.')}</li>}</ul>}</DataState></details>
    {loginUser && <PhoneLoginDialog user={loginUser.user_id} name={loginUser.full_name} currentPhone={loginUser.phone} onClose={() => setLoginUser(null)} />}
    {action === 'assign' && <AssignManagerDialog partner={partner} onOpen={openEmployee} onClose={closeAction} />}
    {action && action !== 'assign' && (typeof action === 'object' && action.type === 'scope'
      ? <StaffAccessDialog partner={partner} user={action.user} onClose={closeAction} />
      : <TeamDialog partner={partner} action={action} onClose={closeAction} />)}
  </>;
  return standalone ? <div className="stack">{content}</div>
    : <details className="team-accounts"><summary>{t('Управляющие', 'Mağaza yöneticileri')}</summary>{content}</details>;
}
function AssignManagerDialog({ partner, onOpen, onClose }: { partner: string; onOpen: (id: string) => void; onClose: () => void }) {
  const { t } = useLocale();
  const { me } = useSession();
  const [selected, setSelected] = useState('');
  const [month] = useState(monthStart);
  const employees = useQuery({ queryKey: ['staff-list', partner, month, true], queryFn: () => staffList(partner, month) });
  const eligible = employees.data?.filter(s => s.active && !s.is_manager && s.user_id !== me?.user.id && s.can_manage === true) ?? [];
  return <ConfirmDialog open title={t('Назначить управляющего', 'Yönetici ata')} confirmLabel={t('Открыть карточку', 'Çalışan kartını aç')}
    onConfirm={() => onOpen(selected)} onClose={onClose} disabled={!eligible.some(s => s.user_id === selected)}>
    <DataState query={employees}>{() => eligible.length
      ? <Field label={t('Сотрудник', 'Çalışan')} required>{id => <Select id={id} value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">{t('Выберите сотрудника', 'Çalışan seçin')}</option>{eligible.map(s => <option key={s.user_id} value={s.user_id}>{s.full_name}</option>)}
      </Select>}</Field>
      : <p className="faint">{t('Нет сотрудников, которым можно назначить эту роль.', 'Bu role atanabilecek çalışan yok.')}</p>}</DataState>
    <p className="faint">{t('В карточке выберите должность «Управляющий», точки и нужные права. Сохранятся логин, смены и начисления сотрудника.', 'Çalışan kartında yönetici rolünü, mağazaları ve yetkileri seçin. Giriş bilgileri, vardiyaları ve kazancı korunur.')}</p>
  </ConfirmDialog>;
}

function StaffAccessDialog({partner,user,onClose}:{partner:string;user:Team;onClose:()=>void}) {
  const { t } = useLocale();
  const [selected,setSelected]=useState<string[]>(user.location_ids);
  const [manager,setManager]=useState(true);
  const locations=useQuery({queryKey:['team-locations',partner],queryFn:()=>rows<{id:string;name:string}>(from('location').select('id,name').eq('partner_id',partner).eq('status','active'))});
  const m=useMutation({mutationFn:()=>command('staff_access_set',{partner,user:user.user_id,manager,locations:selected}),onSuccess:onClose});
  return <ConfirmDialog open title={t('Роль и точки управляющего', 'Yöneticinin rolü ve mağazaları')} confirmLabel={t('Сохранить', 'Kaydet')} onConfirm={()=>m.mutate()} onClose={onClose} busy={m.isPending} error={m.error} disabled={!selected.length}>
    <p>{user.full_name}</p>
    <Checkbox label={t('Роль управляющего', 'Yönetici rolü')} checked={manager} onChange={setManager}/>
    <Field label={t('Точки работы и управления', 'Çalışılan ve yönetilen mağazalar')} required>{()=>locations.data?.map(l=><Checkbox key={l.id} label={l.name} checked={selected.includes(l.id)} onChange={v=>setSelected(v?[...selected,l.id]:selected.filter(x=>x!==l.id))}/>)}</Field>
    <p className="faint">{t('Действующие сеансы сотрудника завершатся. После повторного входа будут действовать новые права. Смены и начисления сохранятся. Без роли управляющего остаётся обычный доступ сотрудника.', 'Çalışanın açık oturumları kapanır. Yeniden girişte yeni yetkileri geçerli olur. Vardiyaları ve kazancı korunur. Yönetici rolü kaldırılırsa çalışan erişimi devam eder.')}</p>
  </ConfirmDialog>;
}
function TeamDialog({ partner, action, onClose }: { partner: string; action: 'new' | { type: 'password' | 'active'; user: Team }; onClose: () => void }) {
  const { t } = useLocale();
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
  if (issued && action === 'new') return <NewAccountCredentials title={t('Управляющий добавлен', 'Yönetici eklendi')} {...issued} onClose={onClose} />;
  if (issued) return <ConfirmDialog open title={t('Доступ готов', 'Erişim hazır')} confirmLabel={t('Готово', 'Bitti')} onConfirm={onClose} onClose={onClose}>
    <p>{t('Передайте управляющему данные для входа. Пароль повторно не показывается.', 'Giriş bilgilerini yöneticiye iletin. Parola tekrar gösterilmez.')}</p>
    <CredentialFields login={issued.phone} password={issued.password} />
  </ConfirmDialog>;
  return <ConfirmDialog open title={action === 'new' ? t('Новый управляющий', 'Yeni yönetici') : access ? (action.user.active ? t('Закрыть доступ?', 'Erişim kapatılsın mı?') : t('Вернуть доступ?', 'Erişim geri açılsın mı?')) : t('Новый пароль', 'Yeni parola')}
    confirmLabel={access ? t('Подтвердить', 'Onayla') : t('Сохранить', 'Kaydet')} onConfirm={() => m.mutate()} onClose={onClose} busy={m.isPending} error={m.error}
    disabled={!access && (password.length < 6 || action === 'new' && (!name.trim() || !phoneLoginDigits(phone) || !selected.length))}>
    {access ? <p>{t('История сохранится. Для следующего входа понадобится заново ввести логин и пароль.', 'Geçmiş korunur. Bir sonraki girişte giriş numarası ve parola yeniden girilir.')}</p> : <>
      {action === 'new' && <><p className="faint">{t('Для новой учётной записи доступны управление сотрудниками и их оплатой на выбранных точках, а также заказы.', 'Yeni hesap seçilen mağazalardaki çalışanları ve ücretlerini yönetebilir, ayrıca sipariş verebilir.')}</p>
        <Field label={t('Имя', 'Ad')} required>{id => <Input id={id} value={name} onChange={e => setName(e.target.value)} />}</Field>
        <Field label={t('Телефон / логин', 'Telefon / giriş numarası')} required hint={t('Полный номер с кодом страны', 'Ülke koduyla birlikte tam numarayı girin')}>{id => <Input id={id} type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+7 900 123-45-67" />}</Field></>}
      {action === 'new' && <Field label={t('Точки работы и управления', 'Çalışılan ve yönetilen mağazalar')} required>{() => locations.data?.map(l => <Checkbox key={l.id} label={l.name} checked={selected.includes(l.id)} onChange={v => setSelected(v ? [...selected, l.id] : selected.filter(x => x !== l.id))} />)}</Field>}
      {action === 'new' && <p className="faint">{t('Управляющий сможет добавлять сотрудников на выбранные точки и заказывать материалы. Право «Видеть сотрудников» также позволит редактировать их карточки и просматривать начисления.', 'Yönetici seçilen mağazalara çalışan ekleyebilir ve malzeme sipariş edebilir. Çalışanları görüntüleme yetkisiyle kartlarını düzenleyebilir ve kazançlarını görebilir.')}</p>}
      <Field label={t('Пароль', 'Parola')} required>{id => <Input id={id} value={password} onChange={e => setPassword(e.target.value)} />}</Field>
    </>}
  </ConfirmDialog>;
}
