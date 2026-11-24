// Главная франчайзи: выручка за сегодня, план и пропущенные дни.
import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { formatDate, monthStart } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { formatMoneyShort } from '../../platform/money';
import { useSession } from '../../platform/session';
import { Alert, Button, DataState, EmptyState, ErrorState, PageHeader, Skeleton } from '../../ui';
import { MissingRevenue } from '../../ui/MissingRevenue';
import { MonthNav, PlanCard } from './components';
import { LaunchChecklist, usePartnerLaunch } from './LaunchChecklist';
import { canEditRevenueDay, revenueMonth, revenueOverview, type DayRow, type LocationMonth, type MonthDetail } from './api';
import { FRANCHISEE_CARD_AMBIGUITY, franchiseePartnerCards, isPartnerReadOnly, usePartnerLifecycle } from './partnerLifecycle';
import { RevenueDialog } from './RevenueDialog';
import './franchisee-home.css';

const LOC_KEY = 'bron.location';
const ALL = 'all';
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;

function financeDays(month: string, location?: string, day?: string) {
  const params = new URLSearchParams({ section: 'days', month });
  if (location) params.set('location', location);
  if (day) params.set('day', day);
  return `/finance?${params}`;
}

function RevenueReminders({ points, month, showLocation }: {
  points: Pick<LocationMonth, 'location_id' | 'location_name' | 'missing_days'>[];
  month: string;
  showLocation: boolean;
}) {
  const { t, locale } = useLocale();
  return <MissingRevenue points={points.map(point => {
    const count = point.missing_days.length;
    const dates = point.missing_days.slice(-5).reverse().map(day => ({
      label: formatDate(day, locale).slice(0, 5), to: financeDays(month, point.location_id, day),
    }));
    if (count > 5) dates.push({ label: t(`Ещё ${count - 5}`, `${count - 5} gün daha`), to: financeDays(month, point.location_id) });
    return { id: point.location_id, name: showLocation ? point.location_name : undefined, count, dates };
  })} />;
}

function AllPoints({ points, month, readOnly, onPick, onEnter }: {
  points: LocationMonth[]; month: string; readOnly: boolean; onPick: (id: string) => void;
  onEnter: (point: LocationMonth, detail: MonthDetail, day: string, row?: DayRow) => void;
}) {
  const { t, locale } = useLocale();
  const details = useQueries({ queries: points.map((p) => ({
    queryKey: ['revenue', 'month', p.location_id, month],
    queryFn: () => revenueMonth(p.location_id, month),
    enabled: !readOnly && p.status === 'active' && monthOf(p.today) === month,
  })) });
  const sameCurrency = points.every((p) => p.currency === points[0].currency);
  const sameDay = points.every((p) => p.today === points[0].today);
  const sum = (f: (p: LocationMonth) => number | null) => points.reduce((a, p) => a + Number(f(p) ?? 0), 0);
  const plan = points.every((p) => p.plan_minor !== null) ? sum((p) => p.plan_minor) : null;
  const fact = sum((p) => p.fact_minor);
  const total = {
    ...points[0], month, today: points.find(p => monthOf(p.today) === month)?.today ?? points[0].today,
    fact_minor: fact, plan_minor: plan, pct: plan ? Math.round((fact * 1000) / plan) / 10 : null,
    need_per_day_minor: sameDay && plan && points[0].days_left > 0 ? Math.ceil(Math.max(0, plan - fact) / points[0].days_left) : null,
  };
  return (
    <>
      {sameCurrency && <PlanCard m={total} />}
      <section aria-label={t('Точки', 'Şubeler')}>
        <ul className="point-list">
          {points.map((point, index) => {
            const detail = details[index].data;
            const today = detail?.days.find((row) => row.day === detail.today);
            const todayOff = detail?.days_off?.includes(detail.today);
            const pct = Number(point.pct ?? 0);
            return (
              <li key={point.location_id} className="point-row">
                <button type="button" className="point-main" onClick={() => onPick(point.location_id)}>
                  <span className="point-name">{point.location_name}</span>
                  <span className="point-nums"><strong className="num">{formatMoneyShort(point.fact_minor, point.currency, locale)}</strong>
                    <span className="faint">{point.plan_minor ? ` / ${formatMoneyShort(point.plan_minor, point.currency, locale)} · ${pct.toLocaleString(locale)} %` : ''}</span></span>
                  {point.plan_minor ? <span className="point-bar" aria-hidden><span style={{ width: `${Math.min(100, pct)}%` }} /></span> : null}
                </button>
                {!readOnly && point.status === 'active' && detail && canEditRevenueDay(detail, detail.today) && monthOf(detail.today) === month && (today
                  ? <button type="button" className="point-today ok" onClick={() => onEnter(point, detail, detail.today, today)}><Check size={15} aria-hidden />{formatMoneyShort(today.total_minor, point.currency, locale)}</button>
                  : todayOff ? <Button size="sm" onClick={() => onEnter(point, detail, detail.today)}>{t('Выходной', 'Kapalı gün')}</Button>
                  : <Button size="sm" variant="primary" onClick={() => onEnter(point, detail, detail.today)}><Plus size={15} aria-hidden />{t('Внести', 'Gelir gir')}</Button>)}
              </li>
            );
          })}
        </ul>
      </section>
      {!readOnly && <RevenueReminders points={points} month={month} showLocation />}
    </>
  );
}

export function FranchiseeHome() {
  const { me, can } = useSession();
  const { t, locale } = useLocale();
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
      <PageHeader title={t('Главная', 'Ana sayfa')} /><ErrorState error={launch.error} onRetry={() => void launch.refetch()} />
    </div>;
  }

  if (!canReadRevenue) return <div className="home">
    <PageHeader title={t('Главная', 'Ana sayfa')} />
    <EmptyState title={t('Нет доступа к выручке', 'Gelir verilerine erişim yok')} />
    {inLaunchHistory && <Button onClick={() => { setHistoryCycle(null); setEdit(null); setEnter(null); }}>{t('К подготовке открытия', 'Açılış hazırlığına dön')}</Button>}
  </div>;

  return (
    <div className="home">
      <header className="home-head">
        {headerDay && <div className="home-date">{new Date(`${headerDay}T12:00:00Z`).toLocaleDateString(locale,
          { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</div>}
        <h1>{t('Выручка', 'Satış geliri')}</h1>
        {points.length === 1 && <p className="faint">{points[0].location_name}</p>}
      </header>

      {partnerPaused && <Alert tone="warning" title={status === 'terminated'
        ? t('Сотрудничество завершено', 'İş birliği sona erdi')
        : t('Работа франчайзи приостановлена', 'Bayinin faaliyetleri askıya alındı')} />}
      {ownedPartners.length > 1 && <Alert title={t('Уточните доступ к карточке франчайзи', 'Bayi erişimini kontrol edin')}>
        {t(FRANCHISEE_CARD_AMBIGUITY, 'Birden fazla bayi atanmış. Franchise yöneticinize başvurun.')}
      </Alert>}
      {!partnerPaused && readOnly && <Alert title={t('Только просмотр', 'Salt okunur')} />}
      {!partnerPaused && inLaunchHistory && <Button size="sm" onClick={() => setHistoryCycle(null)}>{t('К подготовке открытия', 'Açılış hazırlığına dön')}</Button>}
      {!partnerPaused && noActivePoints && !inLaunchHistory && <Alert title={t('Нет действующих точек', 'Aktif şube yok')} />}
      <MonthNav month={month} onChange={(next) => setPeriod({ month: next, followCurrent: next === currentMonth })} max={currentMonth} />
      <DataState query={overview} skeleton={4} empty={(o) => (o.rows.length ? null : <EmptyState title={t('В этом месяце записей нет', 'Bu ay kayıt yok')} />)}>
        {() => (
          <div className="home-body">
            {points.length > 1 && (
              <div className="chips point-chips" role="group" aria-label={t('Точка', 'Şube')}>
                <button type="button" className="chip" aria-pressed={all} onClick={() => pick(ALL)}>{t('Все точки', 'Tüm şubeler')}</button>
                {points.map((p) => (
                  <button key={p.location_id} type="button" className="chip" aria-pressed={!all && p.location_id === current?.location_id} onClick={() => pick(p.location_id)}>
                    {p.location_name}
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
                          <span>{t('Сегодня внесено', 'Bugün kaydedildi')} <strong>{formatMoneyShort(todayRow.total_minor, d.currency, locale)}</strong></span>
                          <span className="faint">{t('Изменить', 'Düzenle')}</span>
                        </button>
                      : todayOff ? <Button block className="btn-lg" onClick={() => setEdit({ day: d.today, dayOff: true })}>{t('Сегодня выходной', 'Bugün kapalı')}</Button>
                      : <Button variant="primary" block className="btn-lg" data-tour-target="revenue-entry" onClick={() => setEdit({ day: d.today })}><Plus size={20} aria-hidden />{t('Внести выручку за сегодня', 'Bugünün gelirini gir')}</Button>
                  )}
                  {!readOnly && current && <RevenueReminders points={[{ ...current, missing_days: d.missing_days }]} month={month} showLocation={false} />}
                </>
              )}
            </DataState>
            )}
            <Link className="home-finance-link" to={financeDays(month, current?.location_id)}>
              {t('Выручка по дням', 'Günlük satış geliri')}<ArrowUpRight size={16} aria-hidden />
            </Link>
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
