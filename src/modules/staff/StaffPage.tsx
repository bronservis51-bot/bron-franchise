// Сотрудники франчайзи: добавить, изменить оплату и точки, сменить пароль, удалить; ведомость заработка за месяц.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Download, KeyRound, Pencil, UserMinus, UserPlus, UserRoundCheck } from 'lucide-react';
import { from, rows } from '../../platform/backend';
import { dayLabel, monthStart } from '../../platform/dates';
import { formatMoneyShort, minorToDecimal } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Badge, Button, Card, Checkbox, ConfirmDialog, DataState, EmptyState, Field, Input, MoneyInput, PageHeader } from '../../ui';
import { useToast } from '../../ui/toast';
import { MonthNav } from '../revenue/FranchiseeHome';
import { formatPhone, pctBp, phoneDigits, randomPassword, staffCreate, staffList, staffSetActive, staffUpdate, userSetPassword, type StaffRow } from './api';

interface Loc { id: string; name: string; currency: string; status: string }
const locationsOf = (partner: string) => rows<Loc>(from('location').select('id, name, currency, status').eq('partner_id', partner).order('name'));

function StaffDialog({ partnerId, locs, staff, onClose }: { partnerId: string; locs: Loc[]; staff?: StaffRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const currency = locs[0]?.currency ?? 'RUB';
  const [name, setName] = useState(staff?.full_name ?? '');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState(randomPassword);
  const [sel, setSel] = useState<string[]>(staff?.location_ids ?? (locs.length === 1 ? [locs[0].id] : []));
  const [rate, setRate] = useState(staff ? String(staff.rate_bp / 100).replace('.', ',') : '');
  const [fee, setFee] = useState(staff ? String(staff.shift_fee_minor) : '');
  const [created, setCreated] = useState<{ phone: string; password: string } | null>(null);
  const bp = Math.round(Number((rate || '0').replace(',', '.')) * 100);
  const m = useMutation({
    mutationFn: async () => {
      if (staff) await staffUpdate({ user: staff.user_id, full_name: name, locations: sel, rate_bp: bp, shift_fee: fee || '0' });
      else await staffCreate({ partner: partnerId, full_name: name, phone, password, locations: sel, rate_bp: bp, shift_fee: fee || '0' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['staff-list'] });
      if (staff) { toast('Сохранено'); onClose(); } else setCreated({ phone: formatPhone(phoneDigits(phone)), password });
    },
  });
  if (created) {
    return (
      <ConfirmDialog open title="Сотрудник добавлен" confirmLabel="Готово" onClose={onClose} onConfirm={onClose}>
        <p>Передайте сотруднику данные для входа. Пароль больше нигде не показывается — при необходимости задайте новый.</p>
        <div className="login-card-data">
          <div><span className="faint">Сайт</span><strong>{location.origin}{location.pathname}</strong></div>
          <div><span className="faint">Телефон</span><strong>{created.phone}</strong></div>
          <div><span className="faint">Пароль</span><strong className="mono">{created.password}</strong></div>
        </div>
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(`Вход в кабинет «Бронь Сервис»: ${location.origin}${location.pathname}\nТелефон: ${created.phone}\nПароль: ${created.password}`).then(() => toast('Скопировано'))}>Скопировать для отправки</Button>
      </ConfirmDialog>
    );
  }
  const valid = name.trim() && sel.length && (staff || (phone.replace(/\D/g, '').length >= 10 && password.length >= 6)) && bp >= 0 && bp <= 10000;
  return (
    <ConfirmDialog open title={staff ? 'Сотрудник' : 'Новый сотрудник'} confirmLabel={staff ? 'Сохранить' : 'Добавить'} busy={m.isPending} error={m.error}
      disabled={!valid} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Имя" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Дина" />}</Field>
      {!staff && (
        <div className="grid grid-2" style={{ gap: 12 }}>
          <Field label="Телефон" required hint="Это логин для входа">{(id) => <Input id={id} type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 900 000-00-00" />}</Field>
          <Field label="Пароль" required hint="Можно оставить предложенный">{(id) => <Input id={id} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        </div>
      )}
      <Field label="Точки, где работает" required>{() => (
        <div>{locs.filter((l) => l.status === 'active').map((l) => (
          <Checkbox key={l.id} label={l.name} checked={sel.includes(l.id)} onChange={(v) => setSel(v ? [...sel, l.id] : sel.filter((x) => x !== l.id))} />
        ))}</div>
      )}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label={`За выход, ${currency}`} hint="Фикс за смену">{(id) => <MoneyInput id={id} value={fee} onChange={setFee} currency={currency} placeholder="0" />}</Field>
        <Field label="% от выручки смены">{(id) => <Input id={id} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" />}</Field>
      </div>
      <p className="faint">Новая оплата действует для следующих смен; закрытые смены не пересчитываются.</p>
    </ConfirmDialog>
  );
}

function PasswordReset({ staff, onClose }: { staff: StaffRow; onClose: () => void }) {
  const toast = useToast();
  const [pw, setPw] = useState(randomPassword);
  const m = useMutation({ mutationFn: () => userSetPassword(staff.user_id, pw), onSuccess: () => { toast(`Новый пароль для ${staff.full_name}: ${pw}`); onClose(); } });
  return (
    <ConfirmDialog open title={`Новый пароль — ${staff.full_name}`} confirmLabel="Задать пароль" busy={m.isPending} error={m.error} disabled={pw.length < 6} onClose={onClose} onConfirm={() => m.mutate()}>
      <p className="muted">Вход по телефону {formatPhone(staff.phone)}. Сообщите сотруднику новый пароль.</p>
      <Field label="Пароль" hint="Минимум 6 символов">{(id) => <Input id={id} value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
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

/** Список сотрудников франчайзи с ведомостью — для франчайзи и для менеджера в карточке франчайзи. */
export function StaffPanel({ partnerId }: { partnerId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [month, setMonth] = useState(monthStart());
  const [edit, setEdit] = useState<StaffRow | 'new' | null>(null);
  const [pw, setPw] = useState<StaffRow | null>(null);
  const [removing, setRemoving] = useState<StaffRow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const locs = useQuery({ queryKey: ['locations', partnerId], queryFn: () => locationsOf(partnerId) });
  const q = useQuery({ queryKey: ['staff-list', partnerId, month], queryFn: () => staffList(partnerId, month) });
  const setActive = useMutation({
    mutationFn: ({ user, active }: { user: string; active: boolean }) => staffSetActive(user, active),
    onSuccess: (_, v) => { toast(v.active ? 'Сотрудник возвращён' : 'Сотрудник удалён, вход закрыт'); setRemoving(null); void qc.invalidateQueries({ queryKey: ['staff-list'] }); },
  });
  const currency = locs.data?.[0]?.currency ?? 'RUB';
  const exp = useMutation({ mutationFn: () => downloadPayroll((q.data ?? []).filter((s) => s.month_shifts > 0), month, currency) });
  const active = (q.data ?? []).filter((s) => s.active);
  const total = active.reduce((a, s) => a + Number(s.month_earned_minor), 0);

  return (
    <>
      <div className="row between" style={{ marginBottom: 8 }}>
        <MonthNav month={month} onChange={setMonth} max={monthStart()} />
        <div className="row">
          <Button size="sm" onClick={() => exp.mutate()} loading={exp.isPending} disabled={!q.data?.some((s) => s.month_shifts)}><Download size={15} aria-hidden />Ведомость</Button>
          <Button variant="primary" onClick={() => setEdit('new')} disabled={!locs.data?.length}><UserPlus size={16} aria-hidden />Добавить</Button>
        </div>
      </div>
      <ActionError error={exp.error} />
      <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Сотрудников пока нет" text="Добавьте продавца: он будет сам открывать и закрывать смены, вносить выручку и видеть свой заработок." />)}>
        {(list) => (
          <>
            <div className="kpis">
              <div className="kpi"><span className="v">{active.length}</span><span className="l">сотрудников</span></div>
              <div className="kpi"><span className="v">{formatMoneyShort(total, currency)}</span><span className="l">начислено за месяц</span></div>
            </div>
            <div className="stack">
              {list.map((s) => (
                <Card key={s.user_id} className={s.active ? '' : 'muted-card'}>
                  <div className="row between" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row"><strong>{s.full_name}</strong>
                        {!s.active ? <Badge tone="neutral">удалён</Badge> : s.open_shift ? <Badge tone="success">на смене · {s.open_shift.location_name}</Badge> : null}</div>
                      <div className="faint">{formatPhone(s.phone)} · {s.location_names.join(', ')}</div>
                      <div className="faint">{s.shift_fee_minor ? `${formatMoneyShort(s.shift_fee_minor, currency)} за выход` : ''}{s.shift_fee_minor && s.rate_bp ? ' + ' : ''}{s.rate_bp ? `${pctBp(s.rate_bp)} от выручки` : ''}{!s.shift_fee_minor && !s.rate_bp ? 'оплата не задана' : ''}</div>
                    </div>
                    <div style={{ textAlign: 'right', flex: 'none' }}>
                      <div className="num"><strong>{formatMoneyShort(s.month_earned_minor, currency)}</strong></div>
                      <div className="faint">{s.month_shifts} смен · выручка {formatMoneyShort(s.month_revenue_minor, currency)}</div>
                    </div>
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    {s.active ? <>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(s)}><Pencil size={14} aria-hidden />Изменить</Button>
                      <Button size="sm" variant="ghost" onClick={() => setPw(s)}><KeyRound size={14} aria-hidden />Пароль</Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(s)}><UserMinus size={14} aria-hidden />Удалить</Button>
                    </> : <Button size="sm" variant="ghost" loading={setActive.isPending} onClick={() => setActive.mutate({ user: s.user_id, active: true })}><UserRoundCheck size={14} aria-hidden />Вернуть</Button>}
                    {s.shifts.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setOpen(open === s.user_id ? null : s.user_id)}>
                        {open === s.user_id ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}Смены
                      </Button>
                    )}
                  </div>
                  {open === s.user_id && (
                    <ul className="list" style={{ marginTop: 8 }}>
                      {s.shifts.map((x) => (
                        <li key={x.id} className="row between access-row">
                          <span>{dayLabel(x.day)} · {x.location_name}<span className="faint" style={{ display: 'block' }}>
                            {new Date(x.opened_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}–{new Date(x.closed_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · выручка {formatMoneyShort(x.total_minor, currency)}</span></span>
                          <strong className="num">{formatMoneyShort(x.earned_minor, currency)}</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              ))}
            </div>
          </>
        )}
      </DataState>
      {edit && locs.data && <StaffDialog partnerId={partnerId} locs={locs.data} staff={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      {pw && <PasswordReset staff={pw} onClose={() => setPw(null)} />}
      {removing && (
        <ConfirmDialog open danger title={`Удалить ${removing.full_name}?`} confirmLabel="Удалить" busy={setActive.isPending} error={setActive.error}
          onClose={() => setRemoving(null)} onConfirm={() => setActive.mutate({ user: removing.user_id, active: false })}>
          <p className="muted">Вход закроется сразу. Смены и выручка сохранятся в истории, вернуть сотрудника можно в любой момент.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

export function StaffPage() {
  const { me } = useSession();
  const partnerId = me?.assignments.find((a) => a.scope_type === 'partner')?.scope_id;
  return (
    <>
      <PageHeader title="Сотрудники" sub="Продавцы сами открывают и закрывают смены и видят свой заработок. Вы управляете ими без компании." />
      {partnerId ? <StaffPanel partnerId={partnerId} /> : <EmptyState title="Нет франчайзи" />}
    </>
  );
}
