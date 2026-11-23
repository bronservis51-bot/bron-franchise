// Главная франчайзи: план по точкам, выручка и статус дней месяца.
import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { CalendarX, Check, Plus } from 'lucide-react';
import { dayLabel, formatDate, monthStart } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { useSession } from '../../platform/session';
import { Alert, Button, DataState, EmptyState, ErrorState, Money, PageHeader, Skeleton } from '../../ui';
import { DayList, MonthNav, PlanCard } from './components';
import { LaunchChecklist, usePartnerLaunch } from './LaunchChecklist';
import { canEditRevenueDay, revenueMonth, revenueOverview, type DayRow, type LocationMonth, type MonthDetail } from './api';
import { FRANCHISEE_CARD_AMBIGUITY, franchiseePartnerCards, isPartnerReadOnly, usePartnerLifecycle } from './partnerLifecycle';
import { hasRevenueDiscrepancy, RevenueDialog } from './RevenueDialog';

const LOC_KEY = 'bron.location';
const ALL = 'all';
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;

/** «Все точки»: общий план и факт, каждая точка отдельной строкой, дни месяца — сумма по точкам. */
function AllPoints({ points, month, readOnly, onPick, onEnter }: {
  points: LocationMonth[]; month: string; readOnly: boolean; onPick: (id: string) => void;
  onEnter: (point: LocationMonth, detail: MonthDetail, day: string, row?: DayRow) => void;
}) {
  const details = useQueries({ queries: points.map((p) => ({ queryKey: ['revenue', 'month', p.location_id, month], queryFn: () => revenueMonth(p.location_id, month) })) });
  const sameCurrency = points.every((p) => p.currency === points[0].currency);
  const sameDay = points.every((p) => p.today === points[0].today);
  const currency = points[0].currency;
  const sum = (f: (p: LocationMonth) => number | null) => points.reduce((a, p) => a + Number(f(p) ?? 0), 0);
  const plan = points.every((p) => p.plan_minor !== null) ? sum((p) => p.plan_minor) : null;
  const fact = sum((p) => p.fact_minor);
  const total = {
    ...points[0], month, today: points.find(p => monthOf(p.today) === month)?.today ?? points[0].today,
    fact_minor: fact, plan_minor: plan, pct: plan ? Math.round((fact * 1000) / plan) / 10 : null,
    need_per_day_minor: sameDay && plan && points[0].days_left > 0 ? Math.ceil(Math.max(0, plan - fact) / points[0].days_left) : null,
  } as unknown as MonthDetail;
  const ready = details.every((q) => q.data);
  const failed = details.flatMap((query, i) => query.isError ? [{ query, name: points[i].location_name }] : []);
  const loading = details.some(query => !query.data && !query.isError);
  // Дни месяца: сумма по точкам и кто сколько; день с пропуском хоть одной точки подсвечен
  type DaySummary = {
    total: number; parts: string[]; missing: string[]; daysOff: string[];
    discrepancies: { point: LocationMonth; detail: MonthDetail; row: DayRow }[];
  };
  const days = new Map<string, DaySummary>();
  const daySummary = (day: string) => {
    const existing = days.get(day);
    if (existing) return existing;
    const result: DaySummary = { total: 0, parts: [], missing: [], daysOff: [], discrepancies: [] };
    days.set(day, result);
    return result;
  };
  details.forEach((q, i) => {
    if (!q.data) return;
    const d = q.data; const point = points[i];
    for (const r of d.days) {
      const x = daySummary(r.day);
      x.total += Number(r.total_minor); x.parts.push(`${point.location_name} ${formatMoneyShort(r.total_minor, d.currency)}`);
      if (hasRevenueDiscrepancy(r)) x.discrepancies.push({ point, detail: d, row: r });
    }
    if (!readOnly) for (const m of d.missing_days) daySummary(m).missing.push(point.location_name);
    for (const day of d.days_off ?? []) daySummary(day).daysOff.push(point.location_name);
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
                  <span className="point-name">{p.location_name}{!readOnly && p.missing_days.length > 0 && <span className="chip-dot" aria-label="есть пропущенные дни" />}</span>
                  <span className="point-nums"><strong className="num">{formatMoneyShort(p.fact_minor, p.currency)}</strong>
                    <span className="faint">{p.plan_minor ? ` из ${formatMoneyShort(p.plan_minor, p.currency)} · ${pct.toLocaleString('ru-RU')} %` : ' · без плана'}</span></span>
                  {p.plan_minor ? <span className="point-bar" aria-hidden><span style={{ width: `${Math.min(100, pct)}%` }} /></span> : null}
                  {!readOnly && p.missing_days.length > 0 && <span className="point-miss"><CalendarX size={13} aria-hidden /> не внесено дней: {p.missing_days.length}</span>}
                </button>
                {!readOnly && p.status === 'active' && d && canEditRevenueDay(d, d.today) && monthOf(d.today) === month && (today
                  ? <button type="button" className="point-today ok" onClick={() => onEnter(p, d, d.today, today)}><Check size={15} aria-hidden />{formatMoneyShort(today.total_minor, p.currency)}</button>
                  : todayOff ? <Button size="sm" onClick={() => onEnter(p, d, d.today)}>Выходной</Button>
                  : <Button size="sm" variant="primary" onClick={() => onEnter(p, d, d.today)}><Plus size={15} aria-hidden />Внести</Button>)}
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2 className="section-title">Дни месяца по всем точкам</h2>
        {failed.length > 0 && <Alert tone="warning" title="Не удалось обновить данные по точкам"
          action={<Button size="sm" onClick={() => void Promise.all(failed.map(({ query }) => query.refetch()))}>Повторить</Button>}>
          {failed.map(({ name }) => name).join(', ')}. Показаны загруженные данные.
        </Alert>}
        {loading && <p className="faint" role="status">Загружаем дни по точкам…</p>}
        {ready && !list.length && <EmptyState title="В этом месяце записей нет" />}
        {list.length > 0 && (
          <ul className="day-list2">
            {list.map(([day, x]) => (
              <li key={day}>
                <div className={`day-row2${x.missing.length ? ' missing' : ''}`}>
                  <span className="day-date2">{dayLabel(day)}</span>
                  <span className="day-sum2">
                    {ready && sameCurrency && x.parts.length > 0 && <Money minor={x.total} currency={currency} short />}
                    {x.parts.length > 0 && <span className="day-split">{x.parts.join(' · ')}</span>}
                    {x.daysOff.length > 0 && <span className="day-split">Выходной · {x.daysOff.join(', ')}</span>}
                    {x.missing.length > 0 && <span className="day-split"><CalendarX size={13} aria-hidden /> не внесено: {x.missing.join(', ')}</span>}
                    {x.discrepancies.map(({ point, detail, row }) => (
                      <button key={point.location_id} type="button" className="link-btn" style={{ textAlign: 'left', overflowWrap: 'anywhere' }}
                        onClick={() => onEnter(point, detail, day, row)}>
                        Сумма смен больше итога · {point.location_name}
                      </button>
                    ))}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="faint" style={{ marginTop: 8 }}>
          {readOnly ? 'Для просмотра записи откройте нужную точку.' : 'Чтобы поправить день, откройте нужную точку.'}
        </p>
      </section>
    </>
  );
}

export function FranchiseeHome() {
  const { me, can } = useSession();
  const ownedPartners = franchiseePartnerCards(me);
  const partner = ownedPartners.length === 1 ? ownedPartners[0] : undefined;
  const launch = usePartnerLaunch(partner);
  const lifecycle = usePartnerLifecycle(partner);
  const status = lifecycle.data?.status;
  const partnerPaused = isPartnerReadOnly(status);
  const canReadRevenue = can('revenue.read');
  const readOnly = partnerPaused || !can('revenue.enter');
  const [historyCycle, setHistoryCycle] = useState<number | null>(null);
  const launchCycle = launch.data?.cycle ?? 0;
  const inLaunchHistory = launchCycle > 0 && historyCycle === launchCycle;
  const [{ month, followCurrent }, setPeriod] = useState(() => ({ month: monthStart(), followCurrent: true }));
  const [loc, setLoc] = useState<string | null>(() => { try { return localStorage.getItem(LOC_KEY); } catch { return null; } });
  const [edit, setEdit] = useState<{ day: string; row?: DayRow; dayOff?: boolean } | null>(null);
  const overview = useQuery({ queryKey: ['revenue', 'overview', month], enabled: canReadRevenue, queryFn: () => revenueOverview(month) });
  const points = (canReadRevenue ? overview.data?.rows : undefined) ?? [];
  const all = points.length > 1 && (loc === ALL || loc === null);
  const current = all ? undefined : points.find((p) => p.location_id === loc) ?? points[0];
  useEffect(() => { if (!all && current && current.location_id !== loc) setLoc(current.location_id); }, [all, current, loc]);
  const detail = useQuery({ queryKey: ['revenue', 'month', current?.location_id, month], enabled: Boolean(current), queryFn: () => revenueMonth(current!.location_id, month) });
  const [enter, setEnter] = useState<{ point: LocationMonth; detail: MonthDetail; day: string; row?: DayRow } | null>(null);
  const pick = (id: string) => { setLoc(id); try { localStorage.setItem(LOC_KEY, id); } catch { /* удобство */ } };
  const m = detail.data;
  const todayRow = m?.days.find((d) => d.day === m.today);
  const todayOff = m?.days_off?.includes(m.today);
  const latestDay = current?.today ?? points.reduce((latest, point) => point.today > latest ? point.today : latest, '');
  const currentMonth = latestDay ? monthOf(latestDay) : monthStart();
  const headerDay = current?.today ?? (points.every(point => point.today === latestDay) ? latestDay : '');
  const noActivePoints = overview.isSuccess && !points.some(point => point.status === 'active');
  useEffect(() => {
    if (!edit && !enter && currentMonth !== month && (followCurrent || month > currentMonth)) {
      setPeriod({ month: currentMonth, followCurrent: true });
    }
  }, [currentMonth, month, followCurrent, edit, enter]);

  // A launch refresh must not unmount a revenue form with unsaved input.
  if (!edit && !enter) {
    if (partner && !partnerPaused && launch.data && !launch.isError && !inLaunchHistory) {
      return <LaunchChecklist partner={partner} launch={launch.data}
        onHistory={launchCycle > 0 ? () => setHistoryCycle(launchCycle) : undefined} />;
    }
    if (launch.isLoading) return <div className="home"><Skeleton lines={4} /></div>;
    if (launch.isError && overview.isSuccess && !points.length) return <div className="home">
      <PageHeader title="Главная" /><ErrorState error={launch.error} onRetry={() => void launch.refetch()} />
    </div>;
  }

  if (!canReadRevenue) return <div className="home">
    <PageHeader title="Главная" />
    <EmptyState title="Выручка недоступна с вашими текущими правами" />
    {inLaunchHistory && <Button onClick={() => { setHistoryCycle(null); setEdit(null); setEnter(null); }}>К подготовке открытия</Button>}
  </div>;

  return (
    <div className="home">
      <header className="home-head">
        {headerDay && <div className="home-date">{new Date(`${headerDay}T12:00:00Z`).toLocaleDateString('ru-RU',
          { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</div>}
        <h1>Выручка</h1>
        {points.length === 1 && <p className="faint">{points[0].location_name}</p>}
      </header>

      {partnerPaused && <Alert tone="warning" title={status === 'terminated' ? 'Сотрудничество завершено' : 'Работа франчайзи приостановлена'}>
        История и отчёты доступны для просмотра.
      </Alert>}
      {ownedPartners.length > 1 && <Alert title="Уточните доступ к карточке франчайзи">{FRANCHISEE_CARD_AMBIGUITY}</Alert>}
      {!partnerPaused && readOnly && <Alert title="Выручка доступна для просмотра">Внести или изменить выручку может пользователь с правом редактирования.</Alert>}
      {!partnerPaused && inLaunchHistory && <Button size="sm" onClick={() => setHistoryCycle(null)}>К подготовке открытия</Button>}
      {!partnerPaused && noActivePoints && !inLaunchHistory && <Alert title="Нет действующих точек">
        История и отчёты доступны.
      </Alert>}
      <MonthNav month={month} onChange={(next) => setPeriod({ month: next, followCurrent: next === currentMonth })} max={currentMonth} />
      <DataState query={overview} skeleton={4} empty={(o) => (o.rows.length ? null : <EmptyState title="В этом месяце записей нет" />)}>
        {() => (
          <div className="home-body">
            {points.length > 1 && (
              <div className="chips point-chips" role="group" aria-label="Точка">
                <button type="button" className="chip" aria-pressed={all} onClick={() => pick(ALL)}>Все точки</button>
                {points.map((p) => (
                  <button key={p.location_id} type="button" className="chip" aria-pressed={!all && p.location_id === current?.location_id} onClick={() => pick(p.location_id)}>
                    {p.location_name}{!readOnly && p.missing_days.length > 0 && <span className="chip-dot" aria-label="есть пропущенные дни" />}
                  </button>
                ))}
              </div>
            )}
            {all ? <AllPoints points={points} month={month} readOnly={readOnly} onPick={pick} onEnter={(point, detail, day, row) => setEnter({ point, detail, day, row })} /> : (
            <DataState query={detail} skeleton={3}>
              {(d) => (
                <>
                  <PlanCard m={d} />
                  {!readOnly && current?.status === 'active' && canEditRevenueDay(d, d.today) && monthOf(d.today) === month && (
                    todayRow
                      ? <button type="button" className="today-entered" onClick={() => setEdit({ day: d.today, row: todayRow })}>
                          <span className="ok-icon"><Check size={18} aria-hidden /></span>
                          <span>Сегодня внесено: <strong><Money minor={todayRow.total_minor} currency={d.currency} short /></strong></span>
                          <span className="faint">изменить</span>
                        </button>
                      : todayOff ? <Button block className="btn-lg" onClick={() => setEdit({ day: d.today, dayOff: true })}>Сегодня выходной</Button>
                      : <Button variant="primary" block className="btn-lg" data-tour-target="revenue-entry" onClick={() => setEdit({ day: d.today })}><Plus size={20} aria-hidden />Внести выручку за сегодня</Button>
                  )}
                  {!readOnly && d.missing_days.length > 0 && (
                    <div className="alert tone-warning" role="status">
                      <CalendarX size={18} aria-hidden />
                      <div className="alert-body">Не внесена выручка: {d.missing_days.slice(-5).map((x) => formatDate(x).slice(0, 5)).join(', ')}{d.missing_days.length > 5 ? ` и ещё ${d.missing_days.length - 5}` : ''}. Откройте день, чтобы внести выручку или отметить выходной.</div>
                    </div>
                  )}
                  <section>
                    <h2 className="section-title">Дни месяца</h2>
                    <DayList m={d} readOnly={readOnly} onPick={(day, row) => setEdit({ day, row, dayOff: d.days_off?.includes(day) })} />
                  </section>
                </>
              )}
            </DataState>
            )}
          </div>
        )}
      </DataState>
      {enter && <RevenueDialog location={enter.point.location_id} locationName={enter.point.location_name} currency={enter.point.currency}
        day={enter.day} existing={enter.row} dayOff={enter.detail.days_off?.includes(enter.day)}
        readOnly={readOnly || !canEditRevenueDay(enter.detail, enter.day)}
        canMarkOff={enter.point.status === 'active' && (!enter.detail.opened_on || enter.day >= enter.detail.opened_on)} onClose={() => setEnter(null)} />}
      {edit && current && <RevenueDialog location={current.location_id} locationName={current.location_name} currency={current.currency}
        day={edit.day} existing={edit.row} dayOff={edit.dayOff}
        readOnly={readOnly || !m || !canEditRevenueDay(m, edit.day)}
        canMarkOff={current.status === 'active' && (!m?.opened_on || edit.day >= m.opened_on)} onClose={() => setEdit(null)} />}
    </div>
  );
}
