// Карточка франчайзи для менеджера: данные, договор и документы; точки, план и выручка по дням, правка любого дня, доступ.
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Edit3, KeyRound, Landmark, Plus, Target, UserPlus, X } from 'lucide-react';
import { monthStart } from '../../platform/dates';
import { Badge, Button, Card, DataState, EmptyState, PageHeader } from '../../ui';
import { PartnerCardPanel } from './PartnerCard';
import { PARTNER_STATUS, st } from '../../ui/status';
import { useToast } from '../../ui/toast';
import { DayList, MonthNav, PlanCard } from '../revenue/FranchiseeHome';
import { RevenueDialog } from '../revenue/RevenueDialog';
import { revenueMonth, type DayRow } from '../revenue/api';
import { accessRevoke, inviteCancel, locationsOf, partnerAccess, partners, type Location } from './api';
import { AccessDialog, LocationDialog, PartnerDialog, PlanDialog, SetPasswordDialog } from './PartnerDialog';
import { StaffPanel } from '../staff/StaffPage';

function AccessCard({ partnerId }: { partnerId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [pw, setPw] = useState<{ user: string; name: string } | null>(null);
  const q = useQuery({ queryKey: ['access', partnerId], queryFn: () => partnerAccess(partnerId) });
  const revoke = useMutation({ mutationFn: accessRevoke, onSuccess: () => { toast('Доступ отозван'); void qc.invalidateQueries({ queryKey: ['access', partnerId] }); } });
  const cancel = useMutation({ mutationFn: inviteCancel, onSuccess: () => void qc.invalidateQueries({ queryKey: ['access', partnerId] }) });
  return (
    <Card title="Доступ в кабинет" actions={<Button size="sm" onClick={() => setAdding(true)}><UserPlus size={15} aria-hidden />Выдать</Button>}>
      <DataState query={q}>
        {(a) => (
          <>
            {!a.users.length && !a.invites.length && <p className="faint">Доступа пока ни у кого нет.</p>}
            {a.users.map((u) => (
              <div key={u.assignment_id} className="row between access-row">
                <span><strong>{u.full_name}</strong><span className="faint" style={{ display: 'block' }}>{u.email}</span></span>
                <span className="row" style={{ flexWrap: 'nowrap' }}>
                  <button type="button" className="icon-btn" aria-label="Новый пароль" onClick={() => setPw({ user: u.user_id, name: u.full_name })}><KeyRound size={16} /></button>
                  <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate(u.assignment_id)}>Отозвать</Button>
                </span>
              </div>
            ))}
            {a.invites.map((i) => (
              <div key={i.id} className="row between access-row">
                <span>{i.email}<span className="faint" style={{ display: 'block' }}>ждёт первого входа</span></span>
                <button type="button" className="icon-btn" aria-label="Отменить приглашение" onClick={() => cancel.mutate(i.id)}><X size={16} /></button>
              </div>
            ))}
          </>
        )}
      </DataState>
      {adding && <AccessDialog partnerId={partnerId} onClose={() => setAdding(false)} />}
      {pw && <SetPasswordDialog user={pw.user} name={pw.name} onClose={() => setPw(null)} />}
    </Card>
  );
}

function LocationMonthBlock({ l, month }: { l: Location; month: string }) {
  const [plan, setPlan] = useState(false);
  const [editLoc, setEditLoc] = useState(false);
  const [edit, setEdit] = useState<{ day: string; row?: DayRow } | null>(null);
  const q = useQuery({ queryKey: ['revenue', 'month', l.id, month], queryFn: () => revenueMonth(l.id, month) });
  return (
    <DataState query={q}>
      {(m) => (
        <div className="stack">
          <PlanCard m={m} />
          <div className="row">
            <Button onClick={() => setPlan(true)}><Target size={16} aria-hidden />{m.plan_minor ? 'Изменить план' : 'Поставить план'}</Button>
            <Button variant="ghost" onClick={() => setEditLoc(true)}><Edit3 size={16} aria-hidden />Данные точки</Button>
            {l.status !== 'active' && <Badge tone="neutral">точка закрыта</Badge>}
          </div>
          <section>
            <h2 className="section-title">Выручка по дням</h2>
            <p className="faint">Менеджер может внести или исправить любой день — например, если франчайзи ошибся в прошлом месяце.</p>
            <DayList m={m} onPick={(day, row) => setEdit({ day, row })} />
          </section>
          {plan && <PlanDialog location={l} month={month} currency={l.currency} current={m.plan_minor} onClose={() => setPlan(false)} />}
          {editLoc && <LocationDialog partnerId={l.partner_id} location={l} onClose={() => setEditLoc(false)} />}
          {edit && <RevenueDialog location={l.id} currency={l.currency} day={edit.day} existing={edit.row} onClose={() => setEdit(null)} />}
        </div>
      )}
    </DataState>
  );
}

export function PartnerPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(params.get('month') ?? monthStart());
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const p = useQuery({ queryKey: ['partners'], queryFn: partners });
  const locs = useQuery({ queryKey: ['locations', id], queryFn: () => locationsOf(id) });
  const partner = p.data?.find((x) => x.id === id);
  const sel = locs.data?.find((l) => l.id === params.get('location')) ?? locs.data?.[0];
  useEffect(() => { if (sel && params.get('location') !== sel.id) setParams({ location: sel.id, month }, { replace: true }); }, [sel, params, setParams, month]);

  return (
    <DataState query={p} empty={() => (partner ? null : <EmptyState title="Франчайзи не найден" />)}>
      {() => partner && (
        <>
          <PageHeader back={{ to: '/', label: 'Франчайзи' }} title={partner.name}
            sub={<span className="row"><Badge tone={st(PARTNER_STATUS, partner.status)[1]}>{st(PARTNER_STATUS, partner.status)[0]}</Badge><span>{partner.currency}</span></span>}
            actions={<>
              <Link className="btn btn-secondary" to={`/royalty/${partner.id}`}><Landmark size={16} aria-hidden />Роялти</Link>
              <Button onClick={() => setEditing(true)}><Edit3 size={16} aria-hidden />Изменить</Button>
            </>} />
          <div className="grid grid-main">
            <div className="stack">
              <div className="row between">
                <div className="chips" role="group" aria-label="Точка" style={{ marginBottom: 0 }}>
                  {(locs.data ?? []).map((l) => (
                    <button key={l.id} type="button" className="chip" aria-pressed={l.id === sel?.id} onClick={() => setParams({ location: l.id, month })}>{l.name}</button>
                  ))}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus size={15} aria-hidden />Точка</Button>
              </div>
              <MonthNav month={month} onChange={(m) => { setMonth(m); if (sel) setParams({ location: sel.id, month: m }, { replace: true }); }} max={monthStart()} />
              {sel ? <LocationMonthBlock key={sel.id} l={sel} month={month} /> : <EmptyState title="Точек пока нет" action={<Button onClick={() => setAdding(true)}>Добавить точку</Button>} />}
              <section>
                <h2 className="section-title">Сотрудники франчайзи</h2>
                <StaffPanel partnerId={partner.id} />
              </section>
            </div>
            <div className="stack">
              <PartnerCardPanel partner={partner} />
              <AccessCard partnerId={partner.id} />
            </div>
          </div>
          {editing && <PartnerDialog partner={partner} onClose={() => setEditing(false)} />}
          {adding && <LocationDialog partnerId={partner.id} onClose={() => setAdding(false)} />}
        </>
      )}
    </DataState>
  );
}
