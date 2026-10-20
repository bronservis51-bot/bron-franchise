// Экран сотрудника: открыть смену → закрыть с выручкой → сразу видно, сколько заработал. Ниже — план точки и смены месяца.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Check, ChevronRight, Clock, Play, Square, Wallet } from 'lucide-react';
import { command } from '../../platform/backend';
import { dayLabel, monthLabel } from '../../platform/dates';
import { formatMoneyShort, sumMinor } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Button, ConfirmDialog, DataState, EmptyState, Field, Input, Money, MoneyInput } from '../../ui';
import { useToast } from '../../ui/toast';
import { pctBp, shiftCancel, shiftClose, shiftOpen, staffHome, type Shift } from './api';

function since(iso: string) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => { const h = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(h); }, [ms]);
}

function CloseDialog({ shift, currency, rate, fee, onClose, onDone }: {
  shift: Shift; currency: string; rate: number; fee: number; onClose: () => void; onDone: (earned: number, month: number | null) => void;
}) {
  const { me } = useSession();
  const editing = shift.status === 'closed';
  const [cash, setCash] = useState(editing ? String(shift.cash_minor) : '');
  const [card, setCard] = useState(editing ? String(shift.card_minor) : '');
  const [comment, setComment] = useState(shift.comment ?? '');
  const total = sumMinor([cash || '0', card || '0']);
  const earned = BigInt(fee) + (total * BigInt(rate) + 5000n) / 10000n;
  const m = useMutation({
    mutationFn: () => shiftClose(me!.user.id, shift.id, cash || '0', card || '0', comment.trim() || null),
    onSuccess: (r) => onDone(Number(earned), 'queued' in r ? null : Number(r.month_earned_minor)),
  });
  return (
    <ConfirmDialog open title={editing ? 'Исправить смену' : 'Закрыть смену'} confirmLabel={editing ? 'Сохранить' : 'Закрыть смену'} busy={m.isPending} error={m.error}
      onClose={onClose} onConfirm={() => m.mutate()}>
      <p className="muted">Внесите выручку за смену{shift.location_name ? ` — ${shift.location_name}` : ''}.</p>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Наличные">{(id) => <MoneyInput id={id} value={cash} onChange={setCash} currency={currency} placeholder="0" />}</Field>
        <Field label="Картой">{(id) => <MoneyInput id={id} value={card} onChange={setCard} currency={currency} placeholder="0" />}</Field>
      </div>
      <div className="day-total-line"><span>Выручка смены</span><Money minor={total} currency={currency} strong /></div>
      <div className="earn-line"><Wallet size={18} aria-hidden /><span>Вы заработаете</span><Money minor={earned} currency={currency} strong /></div>
      <p className="faint">{fee ? `${formatMoneyShort(fee, currency)} за выход` : ''}{fee && rate ? ' + ' : ''}{rate ? `${pctBp(rate)} от выручки` : ''}</p>
      <Field label="Комментарий">{(id) => <Input id={id} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Необязательно" />}</Field>
    </ConfirmDialog>
  );
}

export function StaffHome() {
  const { me } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  useTick(60_000);
  const q = useQuery({ queryKey: ['staff', 'home'], queryFn: () => staffHome(null), refetchInterval: 120_000 });
  const toRead = useQuery({ queryKey: ['kb', 'to-read'], queryFn: () => command<{ article_id: string; title: string }[]>('kb_to_read') });
  const [closing, setClosing] = useState<Shift | null>(null);
  const [result, setResult] = useState<{ earned: number; month: number | null } | null>(null);
  const open = useMutation({ mutationFn: shiftOpen, onSuccess: () => { toast('Смена открыта'); void qc.invalidateQueries({ queryKey: ['staff'] }); } });
  const cancel = useMutation({ mutationFn: shiftCancel, onSuccess: () => void qc.invalidateQueries({ queryKey: ['staff'] }) });
  const first = me?.user.full_name.split(' ')[0];

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-date">{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>{first ? `${first}, ` : ''}{q.data?.open_shift ? 'хорошей смены!' : 'привет!'}</h1>
      </header>
      <DataState query={q} skeleton={4}>
        {(d) => (
          <div className="home-body">
            {result && (
              <div className="earn-result" role="status">
                <span className="ok-icon"><Check size={18} aria-hidden /></span>
                <div>
                  <div>Смена закрыта. Вы заработали <strong>{formatMoneyShort(result.earned, d.currency)}</strong></div>
                  {result.month !== null
                    ? <div className="faint">За {monthLabel(d.month, false)} — {formatMoneyShort(result.month, d.currency)}</div>
                    : <div className="faint">Нет сети: запись сохранена на телефоне и отправится сама</div>}
                </div>
              </div>
            )}
            {d.open_shift ? (
              <section className="shift-card" aria-label="Открытая смена">
                <div className="shift-label"><span className="on-dot" />На смене · {d.open_shift.location_name}</div>
                <div className="shift-time"><Clock size={18} aria-hidden /> {since(d.open_shift.opened_at)}</div>
                <Button variant="primary" block className="btn-lg" onClick={() => setClosing({ ...d.open_shift!, location_name: d.open_shift!.location_name })}>
                  <Square size={18} aria-hidden />Закрыть смену и внести выручку
                </Button>
                <button type="button" className="link-btn" onClick={() => cancel.mutate(d.open_shift!.id)}>Открыл по ошибке — отменить</button>
              </section>
            ) : d.locations.length ? (
              <section className="stack">
                {d.locations.map((l) => l.my_today ? (
                  <button key={l.location_id} type="button" className="today-entered" onClick={() => setClosing({ ...l.my_today!, location_name: l.location_name })}>
                    <span className="ok-icon"><Check size={18} aria-hidden /></span>
                    <span>{l.location_name}: смена закрыта, заработано <strong>{formatMoneyShort(l.my_today.earned_minor ?? 0, l.currency)}</strong></span>
                    <span className="faint">исправить</span>
                  </button>
                ) : (
                  <Button key={l.location_id} variant="primary" block className="btn-lg" loading={open.isPending && open.variables === l.location_id} onClick={() => open.mutate(l.location_id)}>
                    <Play size={18} aria-hidden />Открыть смену{d.locations.length > 1 ? ` — ${l.location_name}` : ''}
                  </Button>
                ))}
                <ActionError error={open.error ?? cancel.error} />
              </section>
            ) : <EmptyState title="Вам пока не назначены точки" text="Попросите франчайзи добавить вас на точку." />}

            <section className="plan-card earn-card" aria-label="Заработок за месяц">
              <div className="plan-label">Заработано за {monthLabel(d.month, false)}</div>
              <div className="plan-fact">{formatMoneyShort(d.month_earned_minor, d.currency)}</div>
              <div className="plan-of">{d.month_shifts} {d.month_shifts % 10 === 1 && d.month_shifts % 100 !== 11 ? 'смена' : [2, 3, 4].includes(d.month_shifts % 10) && ![12, 13, 14].includes(d.month_shifts % 100) ? 'смены' : 'смен'} · выручка смен {formatMoneyShort(d.month_revenue_minor, d.currency)}</div>
              <div className="plan-foot"><span>{d.shift_fee_minor ? `${formatMoneyShort(d.shift_fee_minor, d.currency)} за выход` : ''}{d.shift_fee_minor && d.rate_bp ? ' + ' : ''}{d.rate_bp ? `${pctBp(d.rate_bp)} от выручки` : ''}</span></div>
            </section>

            {d.locations.filter((l) => l.plan_minor).map((l) => (
              <div key={l.location_id} className="mini-plan">
                <div className="row between"><strong>План точки · {l.location_name}</strong><span>{(l.pct ?? 0).toLocaleString('ru-RU')} %</span></div>
                <div className="progress" aria-hidden><span style={{ width: `${Math.min(100, l.pct ?? 0)}%` }} /></div>
                {l.need_per_day_minor ? <div className="faint">До плана — около {formatMoneyShort(l.need_per_day_minor, l.currency)} в день</div> : <div className="faint">План выполнен</div>}
              </div>
            ))}

            {Boolean(toRead.data?.length) && (
              <Link to="/kb" className="read-card">
                <span className="todo-icon"><BookOpen size={18} aria-hidden /></span>
                <span className="todo-main"><span className="todo-title">Нужно прочитать: {toRead.data!.length}</span>
                  <span className="todo-meta">{toRead.data!.map((a) => a.title).join(', ')}</span></span>
                <ChevronRight size={16} className="todo-chevron" aria-hidden />
              </Link>
            )}

            <section>
              <h2 className="section-title">Мои смены за {monthLabel(d.month, false)}</h2>
              {d.shifts.length ? (
                <ul className="day-list2">
                  {d.shifts.map((s) => (
                    <li key={s.id}>
                      <div className="day-row2" style={{ cursor: 'default' }}>
                        <span className="day-date2">{dayLabel(s.day)}</span>
                        <span className="day-sum2"><Money minor={s.earned_minor ?? 0} currency={d.currency} short />
                          <span className="day-split">{s.location_name} · выручка {formatMoneyShort(s.total_minor, d.currency)}</span></span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="faint">Закрытых смен в этом месяце пока нет.</p>}
            </section>
          </div>
        )}
      </DataState>
      {closing && q.data && (
        <CloseDialog shift={closing} currency={q.data.currency} rate={closing.rate_bp ?? q.data.rate_bp} fee={closing.shift_fee_minor ?? q.data.shift_fee_minor}
          onClose={() => setClosing(null)}
          onDone={(earned, month) => { setClosing(null); setResult({ earned, month }); void qc.invalidateQueries({ queryKey: ['staff'] }); }} />
      )}
    </div>
  );
}
