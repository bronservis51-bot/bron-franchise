// «Сегодня» (CORE-01, UX-02): спокойная страница без лишнего. Приветствие, один главный блок под должность
// (смена — менеджеру продаж, точки — франчайзи и управляющему, сеть — руководству) и единый список «Нужно сделать».
// В приложении франчайзи список собирает только базу знаний и отчётность; сервер по-прежнему отдаёт и другие разделы.
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  AlertTriangle, Bell, CalendarX, Check, ChevronRight, ClipboardList, GraduationCap, Landmark, Play, Stamp, TrendingUp,
} from 'lucide-react';
import { command } from '../../platform/backend';
import { snapshot, useScopeFilter, useSession } from '../../platform/session';
import { formatDate, formatPeriod } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort } from '../../platform/money';
import { DataState, Due, Money } from '../../ui';
import { BrandPattern } from '../../ui/brand';
import type { MyEarnings } from '../sales/api';
import { ShiftPanel } from '../sales/ShiftPanel';

interface Point { id: string; name: string; status: string; currency: string; revenue_minor: number; today_minor: number; days_passed: number; missing: number; on_shift: string[] }
interface Today {
  my_tasks: { id: string; number: string; title: string; status: string; due_at: string | null; priority: string; kind: string; subject_type: string | null; subject_id: string | null; location_name: string | null; partner_name: string | null; status_reason: string | null }[];
  approvals: { kind: string; id: string; number: string; title: string; amount_minor: string | null; currency: string | null; at: string; link: string }[];
  acks: { id: string; article_id: string; due_on: string; title: string }[];
  drafts: { kind: string; id: string; title: string; updated_at: string; link: string; items: number | null }[];
  critical: { id: string; title: string; body: string | null; link: string | null; created_at: string }[];
  balances: { accrual_id: string; number: string; period: string; currency: string; outstanding_minor: string; due_on: string; overdue: boolean }[];
  sales?: { my: MyEarnings | null; missing: { location_id: string; location_name: string; days: number }[] };
  points?: Point[];
  reminders?: { id: string; location_id: string; location_name: string; body: string; remind_on: string }[];
}
interface NetworkPoint { status: string; currency: string; revenue_minor: number; revenue_rub_minor: number; missing_days: number; control: { risk: number } | null; debt: { overdue_minor: number } | null }

/** Разделы, которых нет в приложении франчайзи: уведомления и согласования с такими ссылками не показываем. */
const REMOVED = /^\/(support|orders|catalog|supply|crm|openings|map)(\/|\?|$)/;
const kept = (link: string | null | undefined) => !link || !REMOVED.test(link);

/** Задача ведёт прямо к своему предмету: статье или отчёту; остальное — карточка задачи. */
function taskLink(x: Today['my_tasks'][number]): string {
  if (x.subject_type === 'article' && x.subject_id) return `/kb/articles/${x.subject_id}`;
  if (x.subject_type === 'revenue_report' && x.subject_id) return `/royalties/reports/${x.subject_id}`;
  if (x.kind === 'report_due') return '/royalties';
  return `/tasks/${x.id}`;
}

/** Строка списка «Нужно сделать»: всё, что требует действия, в одном месте и по важности. */
interface Item { key: string; rank: number; icon: ReactNode; tone?: 'danger' | 'warning'; title: string; meta?: ReactNode; side?: ReactNode; to: string; checkId?: string }

function collect(d: Today, t: (s: string, v?: Record<string, unknown>) => string, staff: boolean): Item[] {
  const items: Item[] = [];
  const now = Date.now();
  for (const r of d.reminders ?? []) items.push({ key: `r${r.id}`, rank: 1, icon: <Bell size={18} />, title: r.body, meta: r.location_name, to: staff ? `/partners` : `/sales?tab=location&location=${r.location_id}`, checkId: r.id,
    side: r.remind_on < new Date().toISOString().slice(0, 10) ? <span className="due-late">{formatDate(r.remind_on, intlLocale())}</span> : undefined });
  const dup = new Set(d.balances.map((b) => `/royalties/accruals/${b.accrual_id}`));
  for (const c of d.critical.filter((c) => kept(c.link) && (!c.link || !dup.has(c.link)))) items.push({ key: `c${c.id}`, rank: 0, tone: 'danger', icon: <AlertTriangle size={18} />, title: c.title, meta: c.body, to: c.link ?? '/notifications' });
  for (const a of d.approvals.filter((a) => kept(a.link))) items.push({ key: `a${a.kind}${a.id}`, rank: 1, icon: <Stamp size={18} />, title: a.title, meta: <span className="mono">{a.number}</span>,
    side: a.amount_minor && a.currency ? <Money minor={a.amount_minor} currency={a.currency} short /> : undefined, to: a.link });
  // Платит франчайзи; компании просроченный долг виден на карте и в контроле, а не как «дело»
  for (const b of staff ? [] : d.balances) items.push({ key: `b${b.accrual_id}`, rank: b.overdue ? 0 : 3, tone: b.overdue ? 'danger' : undefined, icon: <Landmark size={18} />,
    title: t('Оплатить роялти за {{p}}', { p: formatPeriod(b.period, intlLocale()).toLowerCase() }),
    meta: b.overdue ? t('Срок прошёл') : `${t('до')} ${formatDate(b.due_on, intlLocale())}`, side: <Money minor={b.outstanding_minor} currency={b.currency} short />, to: `/royalties/accruals/${b.accrual_id}` });
  for (const x of d.my_tasks.filter((x) => !['opening_project', 'sales_order', 'ticket'].includes(x.subject_type ?? ''))) {
    const overdue = x.due_at && new Date(x.due_at).getTime() < now;
    items.push({ key: `t${x.id}`, rank: overdue ? 1 : 2, tone: overdue ? 'warning' : undefined, icon: <ClipboardList size={18} />, title: x.title,
      meta: x.location_name ?? x.partner_name ?? undefined, side: <Due at={x.due_at} />, to: taskLink(x) });
  }
  if (d.acks.length === 1) { const a = d.acks[0]; items.push({ key: `k${a.id}`, rank: 5, icon: <GraduationCap size={18} />, title: `${t('Прочитать')}: ${a.title}`, meta: `${t('до')} ${formatDate(a.due_on, intlLocale())}`, to: `/kb/articles/${a.article_id}` }); }
  else if (d.acks.length > 1) items.push({ key: 'acks', rank: 5, icon: <GraduationCap size={18} />, title: t('Прочитать инструкции: {{n}}', { n: d.acks.length }), meta: `${t('до')} ${formatDate(d.acks[0].due_on, intlLocale())}`, to: '/learning' });
  return items.sort((a, b) => a.rank - b.rank);
}

function TodoList({ items }: { items: Item[] }) {
  const { t } = useT();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const done = useMutation({
    mutationFn: (id: string) => command('location_note_done', { note: id, done: true }),
    onMutate: (id) => setChecked((s) => new Set(s).add(id)),
    onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['today'] }), 700),
  });
  const shown = all ? items : items.slice(0, 6);
  if (!items.length) {
    return (
      <div className="todo-done">
        <span className="todo-done-icon"><Check size={22} /></span>
        <div><strong>{t('Всё сделано')}</strong><div className="faint">{t('Новые задачи и решения появятся здесь.')}</div></div>
      </div>
    );
  }
  return (
    <section className="todo" aria-labelledby="todo-title">
      <h2 id="todo-title" className="section-title">{t('Нужно сделать')} <span className="count-pill">{items.length}</span></h2>
      <ul className="todo-list">
        {shown.map((i) => (
          <li key={i.key}>
            <Link to={i.to} className={`todo-item${i.tone ? ` ${i.tone}` : ''}${i.checkId && checked.has(i.checkId) ? ' checked' : ''}`}>
              {i.checkId
                ? <button type="button" className="todo-check" aria-label={t('Отметить сделанным')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); done.mutate(i.checkId!); }}><Check size={16} aria-hidden /></button>
                : <span className="todo-icon">{i.icon}</span>}
              <span className="todo-main"><span className="todo-title">{i.title}</span>{i.meta && <span className="todo-meta">{i.meta}</span>}</span>
              {i.side && <span className="todo-side">{i.side}</span>}
              <ChevronRight size={16} className="todo-chevron" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      {items.length > 6 && <button type="button" className="show-more" onClick={() => setAll((x) => !x)}>{all ? t('Свернуть') : `${t('Показать все')} (${items.length})`}</button>}
    </section>
  );
}

/** Франчайзи и управляющий: свои точки — выручка месяца и сколько дней не заполнено. */
function PointsCard({ points, canSell }: { points: Point[]; canSell: boolean }) {
  const { t } = useT();
  return (
    <section className="points-card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <h2 className="section-title" style={{ margin: 0, color: 'inherit' }}>{points.length > 1 ? t('Мои точки') : t('Моя точка')}</h2>
        {canSell && <Link to="/sales" className="pill-link"><Play size={14} aria-hidden /> {t('Начать свою смену')}</Link>}
      </div>
      <ul className="points-list">
        {points.map((p) => {
          const filled = Math.max(0, p.days_passed - p.missing);
          return (
            <li key={p.id}>
              <Link to={`/sales?tab=location&location=${p.id}${p.missing ? '&only=missing' : ''}`} className="point-row">
                <span className="point-main">
                  <span className="point-name">{p.name}</span>
                  <span className="point-meta">
                    {p.status !== 'active' ? t('открывается')
                      : p.on_shift.length ? <><span className="on-shift-dot" />{p.on_shift.join(', ')} {t('на смене')}</> : t('никто не на смене')}
                  </span>
                </span>
                {p.status === 'active' && (
                  <span className="point-side">
                    <span className="point-sum">{formatMoneyShort(p.revenue_minor, p.currency, intlLocale())}</span>
                    {p.missing > 0
                      ? <span className="point-missing"><CalendarX size={13} aria-hidden /> {t('не внесено')} {p.missing} {t('дн.')}</span>
                      : <span className="point-ok"><Check size={13} aria-hidden /> {filled}/{p.days_passed} {t('дн.')}</span>}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Руководство: сеть одной строкой и вход в выручку сети. */
function NetworkCard() {
  const { t } = useT();
  const q = useQuery({ queryKey: ['network-map'], queryFn: () => command<{ locations: NetworkPoint[] }>('network_map'), staleTime: 60_000 });
  const list = q.data?.locations ?? [];
  const rub = list.reduce((a, l) => a + Number(l.revenue_rub_minor ?? 0), 0);
  const attention = list.filter((l) => (l.status === 'active' && l.missing_days > 2) || (l.control?.risk ?? 0) >= 3 || Number(l.debt?.overdue_minor ?? 0) > 0).length;
  return (
    <Link to="/network-sales" className="points-card network-card">
      <div className="row between"><h2 className="section-title" style={{ margin: 0, color: 'inherit' }}>{t('Сеть')}</h2><span className="pill-link"><TrendingUp size={14} aria-hidden /> {t('Выручка сети')}</span></div>
      {q.isLoading ? <div className="faint" style={{ marginTop: 10 }}>{t('Загрузка…')}</div> : (
        <div className="network-kpis">
          <div><span className="v">{list.length}</span><span className="l">{t('точек')}</span></div>
          <div className={attention ? 'alert' : ''}><span className="v">{attention}</span><span className="l">{t('требуют внимания')}</span></div>
          <div className="wide"><span className="v">{formatMoneyShort(Math.round(rub / 100) * 100, 'RUB', intlLocale())}</span><span className="l">{t('выручка сети за месяц, в рублях')}</span></div>
        </div>
      )}
    </Link>
  );
}

export function TodayPage() {
  const { me, can, isStaff } = useSession();
  const { partnerId, locationId } = useScopeFilter();
  const { t } = useT();
  // Последний ответ показывается сразу при открытии, свежий подменяет его без мигания
  const cacheKey = `today.${me?.user.id}.${partnerId}.${locationId}`;
  const q = useQuery({
    queryKey: ['today', partnerId, locationId],
    queryFn: async () => {
      const d = await command<Today>('today', { partner: partnerId, location: locationId });
      snapshot.set(cacheKey, d);
      return d;
    },
    initialData: () => snapshot.get<Today>(cacheKey) ?? undefined,
    initialDataUpdatedAt: 0,
    refetchInterval: 120_000,
  });
  const first = me?.user.full_name.split(' ')[0];
  const date = new Date().toLocaleDateString(intlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  return (
    <div className="today">
      <header className="today-head">
        <BrandPattern className="today-pattern" rows={2} cols={5} />
        <div className="today-date">{date}</div>
        <h1>{t(hello)}{first ? `, ${first}` : ''}</h1>
      </header>
      <DataState query={q} skeleton={4}>
        {(d) => {
          const my = d.sales?.my;
          const points = d.points ?? [];
          const seller = Boolean(my && (my.locations.length || my.open_shift));
          return (
            <div className="today-body">
              {/* Главный блок под должность */}
              {seller && (!points.length || my?.open_shift) && <ShiftPanel data={my!} onChanged={() => void q.refetch()} compact />}
              {points.length > 0 && <PointsCard points={points} canSell={seller && !my?.open_shift} />}
              {isStaff && can('metrics.read') && <NetworkCard />}
              <TodoList items={collect(d, t, isStaff)} />
            </div>
          );
        }}
      </DataState>
    </div>
  );
}
