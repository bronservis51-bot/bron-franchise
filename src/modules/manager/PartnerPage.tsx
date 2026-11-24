// Карточка франчайзи для менеджера сети.
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, KeyRound, Landmark, Phone, Plus, Target, UserPlus, X } from 'lucide-react';
import { formatDate, monthStart } from '../../platform/dates';
import { ActionError, Badge, Button, Card, DataState, EmptyState, PageHeader } from '../../ui';
import { CopyCredential } from '../../ui/CredentialFields';
import { PartnerCardPanel } from './PartnerCard';
import { useToast } from '../../ui/toast';
import { DayList, MonthNav, PlanCard } from '../revenue/components';
import { RevenueDialog } from '../revenue/RevenueDialog';
import { PartnerLaunchPreview } from '../revenue/LaunchChecklist';
import { revenueMonth, type DayRow } from '../revenue/api';
import { accessRevoke, inviteCancel, locationsOf, managerPartnerStatus, managerPartnerStatusKey, partnerAccess, partners, type Location, type ManagerPartnerStatus } from './api';
import { AccessDialog, LocationDialog, PartnerDialog, PlanDialog, SetPasswordDialog } from './PartnerDialog';
import { StaffPanel } from '../staff/StaffPage';
import { PhoneLoginDialog } from '../staff/PhoneLoginDialog';
import { TeamAccounts } from '../staff/TeamAccounts';
import { formatPhone } from '../staff/api';
import { phoneLoginInitial } from '../../platform/login';
import { useSession } from '../../platform/session';
import { OWNER_ACCESS_LABEL, PartnerStatus } from './PartnerStatus';
import './partner-page.css';

const sections = [
  { id: 'locations', label: 'Точки' },
  { id: 'contacts', label: 'Контакты' },
  { id: 'terms', label: 'Условия и роялти' },
  { id: 'team', label: 'Команда' },
  { id: 'access', label: 'Доступы' },
  { id: 'documents', label: 'Документы' },
] as const;

const staffPermissions = ['staff.manage', 'staff.view', 'staff.create', 'staff.pay_edit', 'team.manage'];

function changeParams(params: URLSearchParams, fields: Record<string, string | null>) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  return next;
}

function AccessCard({ partnerId, ownerAccess }: { partnerId: string; ownerAccess?: ManagerPartnerStatus['owner_access'] }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [pw, setPw] = useState<{ user: string; name: string; login: string } | null>(null);
  const [login, setLogin] = useState<{ user: string; name: string; phone: string } | null>(null);
  const q = useQuery({ queryKey: ['access', partnerId], queryFn: () => partnerAccess(partnerId) });
  const refreshAccess = () => {
    void qc.invalidateQueries({ queryKey: ['access', partnerId] });
    void qc.invalidateQueries({ queryKey: managerPartnerStatusKey });
  };
  const revoke = useMutation({ mutationFn: accessRevoke, onSuccess: () => { toast('Доступ отозван'); refreshAccess(); }, onError: refreshAccess });
  const cancel = useMutation({ mutationFn: inviteCancel, onSuccess: refreshAccess, onError: refreshAccess });
  return (
    <Card title="Доступ в кабинет" actions={<Button size="sm" onClick={() => setAdding(true)}><UserPlus size={15} aria-hidden />Выдать</Button>}>
      <ActionError error={revoke.error ?? cancel.error} />
      <DataState query={q}>
        {(a) => (
          <>
            {ownerAccess ? <p className="faint">{OWNER_ACCESS_LABEL[ownerAccess]}</p>
              : !a.users.length && !a.invites.length && <p className="faint">Доступа пока ни у кого нет.</p>}
            {a.users.map((u) => {
              const loginDigits = phoneLoginInitial(u.email);
              const accountLogin = loginDigits ? formatPhone(loginDigits) : u.email.replace(/@access\.bron\.local$/i, '');
              const canManage = u.user_id !== me?.user.id && u.can_manage !== false;
              return <div key={u.assignment_id} className="row between access-row">
                <span><strong>{u.full_name}</strong><span className="faint" style={{ display: 'block' }}>Логин: {accountLogin}</span></span>
                <div className="row">
                  <CopyCredential kind="login" value={accountLogin} />
                  {canManage && <>
                    <Button size="sm" variant="ghost" onClick={() => setLogin({ user: u.user_id, name: u.full_name, phone: u.phone || u.email })}><Phone size={14} aria-hidden />Телефон / логин</Button>
                    <button type="button" className="icon-btn" aria-label="Новый пароль" onClick={() => setPw({ user: u.user_id, name: u.full_name, login: accountLogin })}><KeyRound size={16} /></button>
                  </>}
                  <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate(u.assignment_id)}>Отозвать</Button>
                </div>
              </div>;
            })}
            {a.invites.map((i) => (
              <div key={i.id} className="row between access-row">
                <span>{i.email}<span className="faint" style={{ display: 'block' }}>Ожидает создания учётной записи</span></span>
                <button type="button" className="icon-btn" aria-label="Отменить приглашение" onClick={() => cancel.mutate(i.id)}><X size={16} /></button>
              </div>
            ))}
          </>
        )}
      </DataState>
      {adding && <AccessDialog partnerId={partnerId} onClose={() => setAdding(false)} />}
      {pw && <SetPasswordDialog user={pw.user} name={pw.name} login={pw.login} onClose={() => setPw(null)} />}
      {login && <PhoneLoginDialog user={login.user} name={login.name} currentPhone={login.phone} onClose={() => setLogin(null)} />}
    </Card>
  );
}

function LocationMonthBlock({ l, month }: { l: Location; month: string }) {
  const { can } = useSession();
  const mayRead = can('revenue.read');
  const mayPlan = can('plan.manage');
  const mayEnter = can('revenue.enter');
  const mayManage = can('org.manage');
  const [plan, setPlan] = useState(false);
  const [editLoc, setEditLoc] = useState(false);
  const [edit, setEdit] = useState<{ day: string; row?: DayRow } | null>(null);
  const q = useQuery({ queryKey: ['revenue', 'month', l.id, month], enabled: mayRead, queryFn: () => revenueMonth(l.id, month) });
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: l.timezone });
  const openedOn = l.opened_on && /^\d{4}-\d{2}-\d{2}$/.test(l.opened_on) ? l.opened_on : null;
  const scheduled = l.status === 'active' && openedOn && openedOn > today;
  return (
    <div className="stack">
      <div className="row between partner-point-heading">
        <div>
          <h2 className="section-title">{l.name}</h2>
          <div className="faint">{[l.city, l.address].filter(Boolean).join(', ')}</div>
          {openedOn && <div className="faint">{scheduled ? 'Открытие запланировано на' : 'Дата открытия'} {formatDate(openedOn)}</div>}
          {l.status !== 'active' && <Badge tone="neutral">Точка закрыта</Badge>}
        </div>
        {mayManage && <Button size="sm" onClick={() => setEditLoc(true)}><Edit3 size={16} aria-hidden />Данные точки</Button>}
      </div>
      {editLoc && mayManage && <LocationDialog partnerId={l.partner_id} location={l} onClose={() => setEditLoc(false)} />}
    {mayRead && <DataState query={q}>
      {(m) => (
        <div className="stack">
          <PlanCard m={m} />
          {mayPlan && <Button onClick={() => setPlan(true)}><Target size={16} aria-hidden />{m.plan_minor ? 'Изменить план' : 'Поставить план'}</Button>}
          <section>
            <h2 className="section-title">Выручка по дням</h2>
            <DayList m={m} readOnly={!mayEnter} onPick={(day, row) => setEdit({ day, row })} />
          </section>
          {plan && mayPlan && <PlanDialog location={l} month={month} currency={l.currency} current={m.plan_minor} onClose={() => setPlan(false)} />}
          {edit && <RevenueDialog location={l.id} locationName={l.name} currency={l.currency} day={edit.day} existing={edit.row}
            readOnly={!mayEnter} dayOff={m.days_off?.includes(edit.day)} canMarkOff={l.status === 'active' && (!m.opened_on || edit.day >= m.opened_on)} onClose={() => setEdit(null)} />}
        </div>
      )}
    </DataState>}
    </div>
  );
}

export function PartnerPage() {
  const { id } = useParams();
  return <PartnerWorkspace key={id} id={id ?? ''} />;
}

function PartnerWorkspace({ id }: { id: string }) {
  const { can, me } = useSession();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<'details' | 'contacts' | null>(null);
  const [adding, setAdding] = useState(false);
  const [pointHistory, setPointHistory] = useState(false);
  const mayManage = can('org.manage');
  const mayRevenue = can('revenue.read');
  const mayRoyalty = can('royalty.manage');
  const maySeeRoyalty = mayRoyalty || can('royalty.read');
  const mayTeam = Boolean(me?.assignments.some(a => (a.scope_type === 'company' || a.scope_id === id)
    && a.permissions.some(permission => staffPermissions.includes(permission))));
  const available = sections
    .filter(section => section.id === 'team' ? mayTeam : section.id === 'locations' || mayManage)
    .map(section => section.id === 'terms' && !maySeeRoyalty ? { ...section, label: 'Условия' } : section);
  const requested = params.get('section');
  const section = available.find(item => item.id === requested) ?? available[0];
  const maxMonth = monthStart();
  const requestedMonth = params.get('month');
  const month = requestedMonth && /^\d{4}-(0[1-9]|1[0-2])-01$/.test(requestedMonth) && requestedMonth <= maxMonth ? requestedMonth : maxMonth;
  const p = useQuery({ queryKey: ['partners'], queryFn: partners });
  const locs = useQuery({ queryKey: ['locations', id], queryFn: () => locationsOf(id) });
  const status = useQuery({ queryKey: managerPartnerStatusKey, queryFn: managerPartnerStatus, enabled: mayManage });
  const partner = p.data?.find((x) => x.id === id);
  const current = status.data?.find(x => x.partner_id === id);
  const sel = locs.data?.find((l) => l.id === params.get('location')) ?? locs.data?.[0];
  useEffect(() => {
    if (mayTeam && params.has('employee') && requested !== 'team') {
      setParams(changeParams(params, { section: 'team' }), { replace: true });
    }
  }, [mayTeam, params, requested, setParams]);

  const update = (fields: Record<string, string>, replace = false) =>
    setParams(changeParams(params, fields), { replace });
  const addPoint = <Button size="sm" onClick={() => setAdding(true)}><Plus size={16} aria-hidden />Добавить точку</Button>;

  return (
    <DataState query={p} empty={() => (partner ? null : <EmptyState title="Франчайзи не найден" />)}>
      {() => partner && (
        <div className="partner-page">
          <PageHeader back={{ to: '/', label: 'Франчайзи' }} title={partner.name}
            sub={<span className="row"><PartnerStatus partner={partner} current={current} />
              <span>{partner.currency}</span></span>}
            actions={mayManage && <Button onClick={() => setEditing('details')}><Edit3 size={16} aria-hidden />Изменить данные</Button>} />
          <nav className="partner-section-nav" aria-label="Разделы карточки">
            {available.map(item => <Link key={item.id} to={{ search: `?${changeParams(params, { section: item.id, employee: null })}` }}
              aria-current={section.id === item.id ? 'page' : undefined}>{item.label}</Link>)}
          </nav>
          <section className="stack partner-section" aria-label={section.label}>
            {section.id === 'locations' && <>
              {partner.preparation_stage && <PartnerLaunchPreview partner={partner.id} />}
              <DataState query={locs} skeleton={3} empty={rows => !rows.length && <EmptyState title="Точек пока нет" action={mayManage && addPoint} />}>
                {rows => <>
                  <div className="row between partner-point-actions">
                    <div className="chips partner-point-switch" role="group" aria-label="Торговая точка">
                      {rows.map(l => <button key={l.id} type="button" className="chip" aria-pressed={l.id === sel?.id}
                        onClick={() => update({ location: l.id, month })}>{l.name}</button>)}
                    </div>
                    {mayManage && addPoint}
                  </div>
                  {mayRevenue && sel && <MonthNav month={month} onChange={value => update({ location: sel.id, month: value }, true)} max={maxMonth} />}
                  {sel && <LocationMonthBlock key={sel.id} l={sel} month={month} />}
                  {mayManage && <details className="partner-disclosure" open={pointHistory} onToggle={event => setPointHistory(event.currentTarget.open)}>
                    <summary>История точек</summary>
                    {pointHistory && <PartnerCardPanel partner={partner} section="locations" locations={rows} showRevenue={mayRevenue} />}
                  </details>}
                </>}
              </DataState>
            </>}
            {section.id === 'contacts' && <PartnerCardPanel key="contacts" partner={partner} section="contacts" onEditContact={() => setEditing('contacts')} />}
            {section.id === 'terms' && <>
              {mayRoyalty && <div><Link className="btn btn-secondary" to={`/royalty/${partner.id}`}><Landmark size={16} aria-hidden />Роялти по месяцам</Link></div>}
              <PartnerCardPanel key="terms" partner={partner} section="terms" locations={locs.data} showRevenue={mayRevenue}
                showRoyalty={maySeeRoyalty} showStaff={mayTeam} />
            </>}
            {section.id === 'team' && mayTeam && <>
                <h2 className="section-title">Сотрудники франчайзи</h2>
                <StaffPanel partnerId={partner.id} />
            </>}
            {section.id === 'access' && mayManage && <>
              <AccessCard partnerId={partner.id} ownerAccess={current?.owner_access} />
              <TeamAccounts partner={partner.id} />
            </>}
            {section.id === 'documents' && <PartnerCardPanel key="documents" partner={partner} section="documents" />}
          </section>
          {editing && mayManage && <PartnerDialog partner={partner} working={current?.working} focusContact={editing === 'contacts'} onClose={() => setEditing(null)} />}
          {adding && mayManage && <LocationDialog partnerId={partner.id} onSaved={location => update({ location })} onClose={() => setAdding(false)} />}
        </div>
      )}
    </DataState>
  );
}
