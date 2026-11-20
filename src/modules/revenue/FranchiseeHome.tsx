// Главная франчайзи: план по точкам, выручка и статус дней месяца.
import { useEffect, useState } from 'react';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { CalendarX, Check, Download, Plus } from 'lucide-react';
import { dayLabel, formatDate, monthStart } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { ActionError, Button, DataState, EmptyState, Money } from '../../ui';
import { DayList, MonthNav, PlanCard } from './components';
import { revenueMonth, revenueOverview, type DayRow, type LocationMonth, type MonthDetail } from './api';
import { downloadMonthReport } from './monthReport';
import { RevenueDialog } from './RevenueDialog';

const LOC_KEY = 'bron.location';
const ALL = 'all';

/** «Все точки»: общий план и факт, каждая точка отдельной строкой, дни месяца — сумма по точкам. */
function AllPoints({ points, month, onPick, onEnter }: {
  points: LocationMonth[]; month: string; onPick: (id: string) => void; onEnter: (p: LocationMonth, d: MonthDetail, row?: DayRow) => void;
}) {
  const details = useQueries({ queries: points.map((p) => ({ queryKey: ['revenue', 'month', p.location_id, month], queryFn: () => revenueMonth(p.location_id, month) })) });
  const sameCurrency = points.every((p) => p.currency === points[0].currency);
  const currency = points[0].currency;
  const sum = (f: (p: LocationMonth) => number | null) => points.reduce((a, p) => a + Number(f(p) ?? 0), 0);
  const plan = points.every((p) => p.plan_minor !== null) ? sum((p) => p.plan_minor) : null;
  const fact = sum((p) => p.fact_minor);
  const total = {
    ...points[0], month, fact_minor: fact, plan_minor: plan, pct: plan ? Math.round((fact * 1000) / plan) / 10 : null,
    need_per_day_minor: plan && points[0].days_left > 0 ? Math.ceil(Math.max(0, plan - fact) / points[0].days_left) : null,
  } as unknown as MonthDetail;
  const ready = details.every((q) => q.data);
  const isCurrent = month === monthStart();
  // Дни месяца: сумма по точкам и кто сколько; день с пропуском хоть одной точки подсвечен
  type DaySummary = { total: number; parts: string[]; missing: string[]; daysOff: string[] };
  const days = new Map<string, DaySummary>();
  const daySummary = (day: string) => {
    const existing = days.get(day);
    if (existing) return existing;
    const result: DaySummary = { total: 0, parts: [], missing: [], daysOff: [] };
    days.set(day, result);
    return result;
  };
  if (ready) details.forEach((q, i) => {
    const d = q.data!; const short = points[i].location_name;
    for (const r of d.days) {
      const x = daySummary(r.day);
      x.total += Number(r.total_minor); x.parts.push(`${short} ${formatMoneyShort(r.total_minor, d.currency)}`);
    }
    for (const m of d.missing_days) daySummary(m).missing.push(short);
    for (const day of d.days_off ?? []) daySummary(day).daysOff.push(short);
  });
  const list = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  return (
    <>
      {sameCurrency && <PlanCard m={total} />}
      <section aria-label="Точки">
        <ul className="point-list">
          {points.map((p, i) => {
            const d = details[i].data;
            const today = d?.days.find((x) => x.day === d.today);
            const todayOff = d?.days_off?.includes(d.today);
            const pct = Number(p.pct ?? 0);
            return (
              <li key={p.location_id} className="point-row">
                <button type="button" className="point-main" onClick={() => onPick(p.location_id)}>
                  <span className="point-name">{p.location_name}{p.missing_days.length > 0 && <span className="chip-dot" aria-label="есть пропущенные дни" />}</span>
                  <span className="point-nums"><strong className="num">{formatMoneyShort(p.fact_minor, p.currency)}</strong>
                    <span className="faint">{p.plan_minor ? ` из ${formatMoneyShort(p.plan_minor, p.currency)} · ${pct.toLocaleString('ru-RU')} %` : ' · без плана'}</span></span>
                  {p.plan_minor ? <span className="point-bar" aria-hidden><span style={{ width: `${Math.min(100, pct)}%` }} /></span> : null}
                  {p.missing_days.length > 0 && <span className="point-miss"><CalendarX size={13} aria-hidden /> не внесено дней: {p.missing_days.length}</span>}
                </button>
                {isCurrent && d && (today
                  ? <button type="button" className="point-today ok" onClick={() => onEnter(p, d, today)}><Check size={15} aria-hidden />{formatMoneyShort(today.total_minor, p.currency)}</button>
                  : todayOff ? <Button size="sm" onClick={() => onEnter(p, d)}>Выходной</Button>
                  : <Button size="sm" variant="primary" onClick={() => onEnter(p, d)}><Plus size={15} aria-hidden />Внести</Button>)}
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2 className="section-title">Дни месяца по всем точкам</h2>
        {!ready ? <p className="faint">Загружаем…</p> : !list.length ? <EmptyState title="В этом месяце записей нет" /> : (
          <ul className="day-list2">
            {list.map(([day, x]) => (
              <li key={day}>
                <div className={`day-row2${x.missing.length ? ' missing' : ''}`}>
                  <span className="day-date2">{dayLabel(day)}</span>
                  <span className="day-sum2">
                    {x.total > 0 && sameCurrency && <Money minor={x.total} currency={currency} short />}
                    {x.parts.length > 0 && <span className="day-split">{x.parts.join(' · ')}</span>}
                    {x.daysOff.length > 0 && <span className="day-split">Выходной · {x.daysOff.join(', ')}</span>}
                    {x.missing.length > 0 && <span className="day-split"><CalendarX size={13} aria-hidden /> не внесено: {x.missing.join(', ')}</span>}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="faint" style={{ marginTop: 8 }}>Чтобы поправить день, откройте нужную точку.</p>
      </section>
    </>
  );
}

export function FranchiseeHome() {
  const [month, setMonth] = useState(monthStart());
  const [loc, setLoc] = useState<string | null>(() => { try { return localStorage.getItem(LOC_KEY); } catch { return null; } });
  const [edit, setEdit] = useState<{ day: string; row?: DayRow; dayOff?: boolean } | null>(null);
  const overview = useQuery({ queryKey: ['revenue', 'overview', month], queryFn: () => revenueOverview(month) });
  const points = overview.data?.rows ?? [];
  const all = points.length > 1 && (loc === ALL || loc === null);
  const current = all ? undefined : points.find((p) => p.location_id === loc) ?? points[0];
  useEffect(() => { if (!all && current && current.location_id !== loc) setLoc(current.location_id); }, [all, current, loc]);
  const detail = useQuery({ queryKey: ['revenue', 'month', current?.location_id, month], enabled: Boolean(current), queryFn: () => revenueMonth(current!.location_id, month) });
  const [enter, setEnter] = useState<{ p: LocationMonth; d: MonthDetail; row?: DayRow } | null>(null);
  const pick = (id: string) => { setLoc(id); try { localStorage.setItem(LOC_KEY, id); } catch { /* удобство */ } };
  const m = detail.data;
  const todayRow = m?.days.find((d) => d.day === m.today);
  const todayOff = m?.days_off?.includes(m.today);
  const isCurrent = month === monthStart();
  const report = useMutation({ mutationFn: (d: MonthDetail) => downloadMonthReport(d) });

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-date">{new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>Выручка</h1>
      </header>

      <DataState query={overview} skeleton={4} empty={(o) => (o.rows.length ? null : <EmptyState title="Точек пока нет" text="Менеджер по франшизе ещё не добавил ваши точки." />)}>
        {() => (
          <div className="home-body">
            {points.length > 1 && (
              <div className="chips point-chips" role="group" aria-label="Точка">
                <button type="button" className="chip" aria-pressed={all} onClick={() => pick(ALL)}>Все точки</button>
                {points.map((p) => (
                  <button key={p.location_id} type="button" className="chip" aria-pressed={!all && p.location_id === current?.location_id} onClick={() => pick(p.location_id)}>
                    {p.location_name}{p.missing_days.length > 0 && <span className="chip-dot" aria-label="есть пропущенные дни" />}
                  </button>
                ))}
              </div>
            )}
            <MonthNav month={month} onChange={setMonth} max={monthStart()} />
            {all ? <AllPoints points={points} month={month} onPick={pick} onEnter={(p, d, row) => setEnter({ p, d, row })} /> : (
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
                      : todayOff ? <Button block className="btn-lg" onClick={() => setEdit({ day: d.today, dayOff: true })}>Сегодня выходной</Button>
                      : <Button variant="primary" block className="btn-lg" onClick={() => setEdit({ day: d.today })}><Plus size={20} aria-hidden />Внести выручку за сегодня</Button>
                  )}
                  {d.missing_days.length > 0 && (
                    <div className="alert tone-warning" role="status">
                      <CalendarX size={18} aria-hidden />
                      <div className="alert-body">Не внесена выручка: {d.missing_days.slice(-5).map((x) => formatDate(x).slice(0, 5)).join(', ')}{d.missing_days.length > 5 ? ` и ещё ${d.missing_days.length - 5}` : ''}. Откройте день, чтобы внести выручку или отметить выходной.</div>
                    </div>
                  )}
                  <section>
                    <div className="row between" style={{ marginBottom: 8 }}>
                      <h2 className="section-title" style={{ margin: 0 }}>Дни месяца</h2>
                      <Button size="sm" variant="ghost" loading={report.isPending} onClick={() => report.mutate(d)}><Download size={15} aria-hidden />Отчёт за месяц</Button>
                    </div>
                    <ActionError error={report.error} />
                    <DayList m={d} onPick={(day, row) => setEdit({ day, row, dayOff: d.days_off?.includes(day) })} />
                  </section>
                </>
              )}
            </DataState>
            )}
          </div>
        )}
      </DataState>
      {enter && <RevenueDialog location={enter.p.location_id} locationName={enter.p.location_name} currency={enter.p.currency} day={enter.d.today} existing={enter.row} dayOff={enter.d.days_off?.includes(enter.d.today)} canMarkOff={enter.p.status === 'active' && (!enter.d.opened_on || enter.d.today >= enter.d.opened_on)} onClose={() => setEnter(null)} />}
      {edit && current && <RevenueDialog location={current.location_id} locationName={current.location_name} currency={current.currency} day={edit.day} existing={edit.row} dayOff={edit.dayOff} canMarkOff={current.status === 'active' && (!m?.opened_on || edit.day >= m.opened_on)} onClose={() => setEdit(null)} />}
    </div>
  );
}
