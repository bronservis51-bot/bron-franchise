// Главная франчайзи: план месяца по точке, ввод выручки за сегодня, сравнение с прошлым месяцем, роялти сейчас, дни месяца.
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpen, CalendarX, Check, ChevronLeft, ChevronRight, Download, Landmark, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import { command } from '../../platform/backend';
import { dayLabel, formatDate, monthLabel, monthStart, shiftMonth } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Button, DataState, EmptyState, Money } from '../../ui';
import { BrandPattern } from '../../ui/brand';
import { revenueMonth, revenueOverview, WEEKDAY, type DayRow, type MonthDetail } from './api';
import { downloadMonthReport } from './monthReport';
import { RevenueDialog } from './RevenueDialog';

const LOC_KEY = 'bron.location';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
}

export function MonthNav({ month, onChange, max }: { month: string; onChange: (m: string) => void; max?: string }) {
  return (
    <div className="month-nav">
      <button type="button" className="icon-btn" aria-label="Предыдущий месяц" onClick={() => onChange(shiftMonth(month, -1))}><ChevronLeft size={20} /></button>
      <span className="month-nav-label">{monthLabel(month)}</span>
      <button type="button" className="icon-btn" aria-label="Следующий месяц" disabled={Boolean(max && month >= max)} onClick={() => onChange(shiftMonth(month, 1))}><ChevronRight size={20} /></button>
    </div>
  );
}

/** Карточка плана месяца: факт, план, выполнение, сколько нужно в день. */
export function PlanCard({ m }: { m: MonthDetail }) {
  const pct = m.pct ?? 0;
  const isCurrent = m.today.slice(0, 7) === m.month.slice(0, 7);
  return (
    <section className="plan-card" aria-label="План месяца">
      <BrandPattern className="plan-pattern" rows={2} cols={4} />
      <div className="plan-label">Выручка за {monthLabel(m.month, false)}</div>
      <div className="plan-fact">{formatMoneyShort(m.fact_minor, m.currency)}</div>
      {m.plan_minor ? (
        <>
          <div className="plan-of">из плана {formatMoneyShort(m.plan_minor, m.currency)}</div>
          <div className="plan-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Выполнение плана">
            <span style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="plan-foot">
            <strong>{pct.toLocaleString('ru-RU')} %</strong>
            {pct >= 100 ? <span>План выполнен</span>
              : isCurrent && m.need_per_day_minor ? <span>до плана — около {formatMoneyShort(m.need_per_day_minor, m.currency)} в день</span>
              : !isCurrent ? <span>не хватило {formatMoneyShort(m.plan_minor - m.fact_minor, m.currency)}</span> : null}
          </div>
        </>
      ) : <div className="plan-of">План на этот месяц пока не поставлен</div>}
    </section>
  );
}

export function DayList({ m, onPick }: { m: MonthDetail; onPick: (day: string, row?: DayRow) => void }) {
  const byDay = new Map(m.days.map((d) => [d.day, d]));
  const missing = new Set(m.missing_days);
  const monthEnd = shiftDay(m.month, m.days_in_month - 1);
  const last = m.today < monthEnd ? m.today : monthEnd;
  // Все дни месяца до сегодня: внесённые и пропущенные, новые сверху
  const days: string[] = [];
  for (let d = last; d >= m.month; d = shiftDay(d, -1)) days.push(d);
  const editable = (d: string) => !m.editable_from || d >= m.editable_from;
  if (!days.length) return <EmptyState title="В этом месяце записей нет" />;
  return (
    <ul className="day-list2">
      {days.map((d) => {
        const r = byDay.get(d);
        const miss = missing.has(d);
        if (!r && !miss && d !== m.today) return null;
        const can = editable(d);
        return (
          <li key={d}>
            <button type="button" className={`day-row2${miss ? ' missing' : ''}`} disabled={!can} onClick={() => onPick(d, r)}>
              <span className="day-date2">{dayLabel(d)}</span>
              {r ? (
                <span className="day-sum2">
                  <Money minor={r.total_minor} currency={m.currency} short />
                  <span className="day-split">{r.entries.some((e) => e.employee_id)
                    ? r.entries.map((e) => `${e.employee_name ?? 'вы'} ${formatMoneyShort(e.total_minor, m.currency)}`).join(' · ')
                    : `нал. ${formatMoneyShort(r.cash_minor, m.currency)} · карта ${formatMoneyShort(r.card_minor, m.currency)}`}</span>
                  {r.comment && <span className="day-split">{r.comment}</span>}
                </span>
              ) : <span className="day-sum2 day-empty">{miss ? <><CalendarX size={14} aria-hidden /> не внесено</> : 'сегодня — ещё не внесено'}</span>}
              {can && <ChevronRight size={16} className="day-chev" aria-hidden />}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function shiftDay(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Как идёт месяц: к тому же периоду прошлого месяца и сильные дни недели. */
function Insights({ m }: { m: MonthDetail }) {
  const prev = Number(m.prev_same_period_minor);
  const cur = Number(m.same_period_minor);
  const delta = prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
  const wd = [...m.weekday_avg].sort((a, b) => Number(b.avg_minor) - Number(a.avg_minor));
  if (delta === null && wd.length < 7) return null;
  return (
    <div className="insights">
      {delta !== null && (
        <div className={`insight ${delta >= 0 ? 'up' : 'down'}`}>
          {delta >= 0 ? <TrendingUp size={18} aria-hidden /> : <TrendingDown size={18} aria-hidden />}
          <span><strong>{delta > 0 ? '+' : ''}{delta.toLocaleString('ru-RU')} %</strong> к тому же периоду прошлого месяца</span>
        </div>
      )}
      {wd.length === 7 && (
        <div className="insight">
          <span>Сильный день — <strong>{WEEKDAY[wd[0].dow]}</strong> (в среднем {formatMoneyShort(Math.round(Number(wd[0].avg_minor) / 100) * 100, m.currency)}), слабый — {WEEKDAY[wd[6].dow]}</span>
        </div>
      )}
    </div>
  );
}

interface RoyaltyLive { currency: string; rate_bp: number; debt_minor: number; live: { month: string; accrued_minor: number; projected_accrual_minor: number } }

function RoyaltyCard() {
  const q = useQuery({ queryKey: ['royalty', 'my'], queryFn: () => command<RoyaltyLive>('royalty_my'), refetchInterval: 120_000 });
  if (!q.data) return null;
  const r = q.data;
  return (
    <Link to="/finance" className="read-card royalty-live">
      <span className="todo-icon"><Landmark size={18} aria-hidden /></span>
      <span className="todo-main">
        <span className="todo-title">Роялти за {monthLabel(r.live.month, false)}: {formatMoneyShort(r.live.accrued_minor, r.currency)} сейчас</span>
        <span className="todo-meta">{(r.rate_bp / 100).toLocaleString('ru-RU')} % от выручки · к концу месяца ≈ {formatMoneyShort(Math.round(Number(r.live.projected_accrual_minor) / 100) * 100, r.currency)}{Number(r.debt_minor) > 0 ? ` · долг ${formatMoneyShort(r.debt_minor, r.currency)}` : ' · долга нет'}</span>
      </span>
      <ChevronRight size={16} className="todo-chevron" aria-hidden />
    </Link>
  );
}

export function FranchiseeHome() {
  const { me } = useSession();
  const [month, setMonth] = useState(monthStart());
  const [loc, setLoc] = useState<string | null>(() => { try { return localStorage.getItem(LOC_KEY); } catch { return null; } });
  const [edit, setEdit] = useState<{ day: string; row?: DayRow } | null>(null);
  const overview = useQuery({ queryKey: ['revenue', 'overview', month], queryFn: () => revenueOverview(month) });
  const points = overview.data?.rows ?? [];
  const current = points.find((p) => p.location_id === loc) ?? points[0];
  useEffect(() => { if (current && current.location_id !== loc) setLoc(current.location_id); }, [current, loc]);
  const detail = useQuery({ queryKey: ['revenue', 'month', current?.location_id, month], enabled: Boolean(current), queryFn: () => revenueMonth(current!.location_id, month) });
  const toRead = useQuery({ queryKey: ['kb', 'to-read'], queryFn: () => command<{ article_id: string; title: string; due_on: string }[]>('kb_to_read') });
  const pick = (id: string) => { setLoc(id); try { localStorage.setItem(LOC_KEY, id); } catch { /* удобство */ } };
  const m = detail.data;
  const todayRow = m?.days.find((d) => d.day === m.today);
  const isCurrent = month === monthStart();
  const report = useMutation({ mutationFn: (d: MonthDetail) => downloadMonthReport(d) });

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-date">{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>{greeting()}{me ? `, ${me.user.full_name.split(' ')[0]}` : ''}</h1>
      </header>

      <DataState query={overview} skeleton={4} empty={(o) => (o.rows.length ? null : <EmptyState title="Точек пока нет" text="Менеджер по франшизе ещё не добавил ваши точки." />)}>
        {() => (
          <div className="home-body">
            {points.length > 1 && (
              <div className="chips point-chips" role="group" aria-label="Точка">
                {points.map((p) => (
                  <button key={p.location_id} type="button" className="chip" aria-pressed={p.location_id === current?.location_id} onClick={() => pick(p.location_id)}>
                    {p.location_name}{p.missing_days.length > 0 && <span className="chip-dot" aria-label="есть пропущенные дни" />}
                  </button>
                ))}
              </div>
            )}
            <MonthNav month={month} onChange={setMonth} max={monthStart()} />
            <DataState query={detail} skeleton={3}>
              {(d) => (
                <>
                  <PlanCard m={d} />
                  {isCurrent && (
                    todayRow
                      ? <button type="button" className="today-entered" onClick={() => setEdit({ day: d.today, row: todayRow })}>
                          <span className="ok-icon"><Check size={18} aria-hidden /></span>
                          <span>Сегодня внесено: <strong><Money minor={todayRow.total_minor} currency={d.currency} short /></strong></span>
                          <span className="faint">изменить</span>
                        </button>
                      : <Button variant="primary" block className="btn-lg" onClick={() => setEdit({ day: d.today })}><Plus size={20} aria-hidden />Внести выручку за сегодня</Button>
                  )}
                  {d.missing_days.length > 0 && (
                    <div className="alert tone-warning" role="status">
                      <CalendarX size={18} aria-hidden />
                      <div className="alert-body">Не внесена выручка: {d.missing_days.slice(-5).map((x) => formatDate(x).slice(0, 5)).join(', ')}{d.missing_days.length > 5 ? ` и ещё ${d.missing_days.length - 5}` : ''}. Нажмите на день ниже, чтобы внести.</div>
                    </div>
                  )}
                  <Insights m={d} />
                  <RoyaltyCard />
                  <section>
                    <div className="row between" style={{ marginBottom: 8 }}>
                      <h2 className="section-title" style={{ margin: 0 }}>Дни месяца</h2>
                      <Button size="sm" variant="ghost" loading={report.isPending} onClick={() => report.mutate(d)}><Download size={15} aria-hidden />Отчёт за месяц</Button>
                    </div>
                    <ActionError error={report.error} />
                    <DayList m={d} onPick={(day, row) => setEdit({ day, row })} />
                  </section>
                </>
              )}
            </DataState>
            {Boolean(toRead.data?.length) && (
              <Link to="/kb" className="read-card">
                <span className="todo-icon"><BookOpen size={18} aria-hidden /></span>
                <span className="todo-main">
                  <span className="todo-title">Нужно прочитать: {toRead.data!.length}</span>
                  <span className="todo-meta">{toRead.data!.map((a) => a.title).join(', ')}</span>
                </span>
                <ChevronRight size={16} className="todo-chevron" aria-hidden />
              </Link>
            )}
          </div>
        )}
      </DataState>
      {edit && current && <RevenueDialog location={current.location_id} currency={current.currency} day={edit.day} existing={edit.row} staff={m?.staff} onClose={() => setEdit(null)} />}
    </div>
  );
}
