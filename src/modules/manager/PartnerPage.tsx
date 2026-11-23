// Карточка франчайзи для менеджера: данные, договор и документы; точки, план и выручка по дням, правка любого дня, доступ.
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, KeyRound, Landmark, Phone, Plus, Target, UserPlus, X } from 'lucide-react';
import { monthStart } from '../../platform/dates';
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
  const [plan, setPlan] = useState(false);
  const [editLoc, setEditLoc] = useState(false);
  const [edit, setEdit] = useState<{ day: string; row?: DayRow } | null>(null);
  const q = useQuery({ queryKey: ['revenue', 'month', l.id, month], enabled: mayRead, queryFn: () => revenueMonth(l.id, month) });
  return (
    <div className="stack">
      <div className="row">
        <Button variant="ghost" onClick={() => setEditLoc(true)}><Edit3 size={16} aria-hidden />Данные точки</Button>
        {l.status !== 'active' && <Badge tone="neutral">точка закрыта</Badge>}
      </div>
      {editLoc && <LocationDialog partnerId={l.partner_id} location={l} onClose={() => setEditLoc(false)} />}
    {mayRead && <DataState query={q}>
      {(m) => (
        <div className="stack">
          <PlanCard m={m} />
          {mayPlan && <Button onClick={() => setPlan(true)}><Target size={16} aria-hidden />{m.plan_minor ? 'Изменить план' : 'Поставить план'}</Button>}
          <section>
            <h2 className="section-title">Выручка по дням</h2>
            {mayEnter && <p className="faint">Можно внести или исправить выручку за предыдущие рабочие дни.</p>}
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
  const { can } = useSession();
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(params.get('month') ?? monthStart());
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const p = useQuery({ queryKey: ['partners'], queryFn: partners });
  const locs = useQuery({ queryKey: ['locations', id], queryFn: () => locationsOf(id) });
  const status = useQuery({ queryKey: managerPartnerStatusKey, queryFn: managerPartnerStatus });
  const partner = p.data?.find((x) => x.id === id);
  const current = status.data?.find(x => x.partner_id === id);
  const sel = locs.data?.find((l) => l.id === params.get('location')) ?? locs.data?.[0];
  useEffect(() => { if (sel && params.get('location') !== sel.id) setParams({ location: sel.id, month }, { replace: true }); }, [sel, params, setParams, month]);

  return (
    <DataState query={p} empty={() => (partner ? null : <EmptyState title="Франчайзи не найден" />)}>
      {() => partner && (
        <>
          <PageHeader back={{ to: '/', label: 'Франчайзи' }} title={partner.name}
            sub={<span className="row"><PartnerStatus partner={partner} current={current} />
              <span>{partner.currency}</span></span>}
            actions={<>
              {can('royalty.manage') && <Link className="btn btn-secondary" to={`/royalty/${partner.id}`}><Landmark size={16} aria-hidden />Роялти</Link>}
              <Button onClick={() => setEditing(true)}><Edit3 size={16} aria-hidden />Изменить</Button>
            </>} />
          <div className="grid grid-main">
            <div className="stack">
              {partner.preparation_stage && <PartnerLaunchPreview partner={partner.id} />}
              <div className="row between">
                <div className="chips" role="group" aria-label="Точка" style={{ marginBottom: 0 }}>
                  {(locs.data ?? []).map((l) => (
                    <button key={l.id} type="button" className="chip" aria-pressed={l.id === sel?.id} onClick={() => setParams({ location: l.id, month })}>{l.name}</button>
                  ))}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus size={15} aria-hidden />Точка</Button>
              </div>
              {can('revenue.read') && <MonthNav month={month} onChange={(m) => { setMonth(m); if (sel) setParams({ location: sel.id, month: m }, { replace: true }); }} max={monthStart()} />}
              {sel ? <LocationMonthBlock key={sel.id} l={sel} month={month} /> : <EmptyState title="Точек пока нет" action={<Button onClick={() => setAdding(true)}>Добавить точку</Button>} />}
              <section>
                <h2 className="section-title">Сотрудники франчайзи</h2>
                <StaffPanel partnerId={partner.id} />
              </section>
            </div>
            <div className="stack">
              <PartnerCardPanel partner={partner} locations={locs.data ?? []} />
              <AccessCard partnerId={partner.id} ownerAccess={current?.owner_access} />
              <TeamAccounts partner={partner.id} />
            </div>
          </div>
          {editing && <PartnerDialog partner={partner} working={current?.working} onClose={() => setEditing(false)} />}
          {adding && <LocationDialog partnerId={partner.id} onClose={() => setAdding(false)} />}
        </>
      )}
    </DataState>
  );
}
