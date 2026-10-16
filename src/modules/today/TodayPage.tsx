// «Сегодня» (CORE-01, UX-02): спокойная страница без лишнего. Приветствие, один главный блок под должность
// (смена — менеджеру продаж, точки — франчайзи и управляющему, сеть — руководству) и единый список «Нужно сделать».
// Действия, которые нужны не всем (заказ, инструкции, обращение), живут в своих разделах меню.
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  AlertTriangle, Bell, CalendarX, Check, Contact, ChevronRight, ClipboardList, GraduationCap, Headset, Inbox, Landmark, Map as MapIcon, PackageCheck, Play, Rocket, Sparkles, Stamp,
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
  my_tasks: { id: string; number: string; title: string; status: string; due_at: string | null; priority: string; location_name: string | null; partner_name: string | null; status_reason: string | null }[];
  queue_tasks: { id: string; number: string; title: string; due_at: string | null; queue_name: string; location_name: string | null }[];
  tickets: { id: string; number: string; subject: string; status: string; urgency: string; resolve_due: string; location_name: string; relation: string }[];
  approvals: { kind: string; id: string; number: string; title: string; amount_minor: string | null; currency: string | null; at: string; link: string }[];
  acks: { id: string; article_id: string; due_on: string; title: string }[];
  drafts: { kind: string; id: string; title: string; updated_at: string; link: string; items: number | null }[];
  critical: { id: string; title: string; body: string | null; link: string | null; created_at: string }[];
  openings: { id: string; number: string; status: string; planned_open_on: string; location_name: string; done_tasks: number; total_tasks: number; critical_open: number; overdue_tasks: number; date_at_risk: boolean }[];
  balances: { accrual_id: string; number: string; period: string; currency: string; outstanding_minor: string; due_on: string; overdue: boolean }[];
  sales?: { my: MyEarnings | null; missing: { location_id: string; location_name: string; days: number }[] };
  points?: Point[];
  crm?: { due: { id: string; name: string; city: string | null; stage: string; next_action: string; next_action_at: string; phone: string | null }[]; no_step: number };
  reminders?: { id: string; location_id: string; location_name: string; body: string; remind_on: string }[];
  supply?: { new_items: { id: string; name: string }[]; waiting: { id: string; name: string; available: boolean; expected_on: string | null }[] };
}
interface NetworkPoint { status: string; currency: string; revenue_minor: number; revenue_rub_minor: number; missing_days: number; stopped_tickets: number; control: { risk: number } | null; debt: { overdue_minor: number } | null }

/** Строка списка «Нужно сделать»: всё, что требует действия, в одном месте и по важности. */
interface Item { key: string; rank: number; icon: ReactNode; tone?: 'danger' | 'warning'; title: string; meta?: ReactNode; side?: ReactNode; to: string; checkId?: string }

function collect(d: Today, t: (s: string, v?: Record<string, unknown>) => string, staff: boolean): Item[] {
  const items: Item[] = [];
  const now = Date.now();
  for (const c of d.crm?.due ?? []) {
    const late = new Date(c.next_action_at) < new Date() && new Date(c.next_action_at).toDateString() !== new Date().toDateString();
    items.push({ key: `crm${c.id}`, rank: late ? 0 : 1, tone: late ? 'warning' : undefined, icon: <Contact size={18} />, title: `${c.name}: ${c.next_action}`,
      meta: [c.city, late ? t('просрочено') : new Date(c.next_action_at).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · '), to: `/crm/${c.id}` });
  }
  if (d.crm?.no_step) items.push({ key: 'crm-nostep', rank: 1, tone: 'warning', icon: <Contact size={18} />, title: t('Лиды без следующего шага: {{n}}', { n: d.crm.no_step }),
    meta: t('Назначьте шаг, чтобы клиент не потерялся'), to: '/crm?focus=nostep' });
  for (const r of d.reminders ?? []) items.push({ key: `r${r.id}`, rank: 1, icon: <Bell size={18} />, title: r.body, meta: r.location_name, to: staff ? '/map' : `/sales?tab=location&location=${r.location_id}`, checkId: r.id,
    side: r.remind_on < new Date().toISOString().slice(0, 10) ? <span className="due-late">{formatDate(r.remind_on, intlLocale())}</span> : undefined });
  const dup = new Set(d.balances.map((b) => `/royalties/accruals/${b.accrual_id}`));
  for (const c of d.critical.filter((c) => !c.link || !dup.has(c.link))) items.push({ key: `c${c.id}`, rank: 0, tone: 'danger', icon: <AlertTriangle size={18} />, title: c.title, meta: c.body, to: c.link ?? '/notifications' });
  for (const a of d.approvals) items.push({ key: `a${a.kind}${a.id}`, rank: 1, icon: <Stamp size={18} />, title: a.title, meta: <span className="mono">{a.number}</span>,
    side: a.amount_minor && a.currency ? <Money minor={a.amount_minor} currency={a.currency} short /> : undefined, to: a.link });
  // Платит франчайзи; компании просроченный долг виден на карте и в контроле, а не как «дело»
  for (const b of staff ? [] : d.balances) items.push({ key: `b${b.accrual_id}`, rank: b.overdue ? 0 : 3, tone: b.overdue ? 'danger' : undefined, icon: <Landmark size={18} />,
    title: t('Оплатить роялти за {{p}}', { p: formatPeriod(b.period, intlLocale()).toLowerCase() }),
    meta: b.overdue ? t('Срок прошёл') : `${t('до')} ${formatDate(b.due_on, intlLocale())}`, side: <Money minor={b.outstanding_minor} currency={b.currency} short />, to: `/royalties/accruals/${b.accrual_id}` });
  for (const x of d.my_tasks) {
    const overdue = x.due_at && new Date(x.due_at).getTime() < now;
    items.push({ key: `t${x.id}`, rank: overdue ? 1 : 2, tone: overdue ? 'warning' : undefined, icon: <ClipboardList size={18} />, title: x.title,
      meta: x.location_name ?? x.partner_name ?? undefined, side: <Due at={x.due_at} />, to: `/tasks/${x.id}` });
  }
  for (const k of d.tickets) {
    const mine = k.status === 'waiting_partner' && k.relation === 'author';
    items.push({ key: `k${k.id}`, rank: k.urgency === 'stopped' ? 0 : mine ? 1 : 3, tone: k.urgency === 'stopped' ? 'danger' : undefined, icon: <Headset size={18} />,
      title: mine ? `${t('Ответьте')}: ${k.subject}` : k.subject, meta: k.location_name, side: !['resolved', 'closed'].includes(k.status) ? <Due at={k.resolve_due} /> : undefined, to: `/support/${k.id}` });
  }
  if (d.queue_tasks.length === 1) { const x = d.queue_tasks[0]; items.push({ key: `q${x.id}`, rank: 4, icon: <Inbox size={18} />, title: x.title, meta: `${t('Можно взять')} · ${x.queue_name}`, side: <Due at={x.due_at} />, to: `/tasks/${x.id}` }); }
  else if (d.queue_tasks.length > 1) items.push({ key: 'queue', rank: 4, icon: <Inbox size={18} />, title: t('Свободные задачи в очереди: {{n}}', { n: d.queue_tasks.length }), meta: t('Возьмите, чтобы не просрочить'), to: '/tasks' });
  for (const o of d.openings.filter((o) => o.date_at_risk || o.overdue_tasks > 0 || o.critical_open > 0))
    items.push({ key: `o${o.id}`, rank: 2, tone: 'warning', icon: <Rocket size={18} />, title: `${t('Открытие под угрозой')}: ${o.location_name}`,
      meta: `${t('План')} ${formatDate(o.planned_open_on, intlLocale())} · ${o.done_tasks}/${o.total_tasks}`, to: `/openings/${o.id}` });
  if (d.acks.length === 1) { const a = d.acks[0]; items.push({ key: `k${a.id}`, rank: 5, icon: <GraduationCap size={18} />, title: `${t('Прочитать')}: ${a.title}`, meta: `${t('до')} ${formatDate(a.due_on, intlLocale())}`, to: `/kb/articles/${a.article_id}` }); }
  else if (d.acks.length > 1) items.push({ key: 'acks', rank: 5, icon: <GraduationCap size={18} />, title: t('Прочитать инструкции: {{n}}', { n: d.acks.length }), meta: `${t('до')} ${formatDate(d.acks[0].due_on, intlLocale())}`, to: '/learning' });
  for (const w of d.supply?.waiting.filter((w) => w.available) ?? [])
    items.push({ key: `s${w.id}`, rank: 3, icon: <PackageCheck size={18} />, title: `${t('Поступило')}: ${w.name}`, meta: t('Вы ждали этот товар'), to: '/catalog' });
  if (d.supply?.new_items.length)
    items.push({ key: 'new', rank: 7, icon: <Sparkles size={18} />, title: `${t('Новинки в магазине')}: ${d.supply.new_items.slice(0, 3).map((n) => n.name).join(', ')}`, to: '/catalog' });
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

/** Руководство: сеть одной строкой и вход в карту. */
function NetworkCard() {
  const { t } = useT();
  const q = useQuery({ queryKey: ['network-map'], queryFn: () => command<{ locations: NetworkPoint[] }>('network_map'), staleTime: 60_000 });
  const list = q.data?.locations ?? [];
  const rub = list.reduce((a, l) => a + Number(l.revenue_rub_minor ?? 0), 0);
  const attention = list.filter((l) => l.stopped_tickets > 0 || (l.status === 'active' && l.missing_days > 2) || (l.control?.risk ?? 0) >= 3 || Number(l.debt?.overdue_minor ?? 0) > 0).length;
  return (
    <Link to="/map" className="points-card network-card">
      <div className="row between"><h2 className="section-title" style={{ margin: 0, color: 'inherit' }}>{t('Сеть')}</h2><span className="pill-link"><MapIcon size={14} aria-hidden /> {t('Открыть карту')}</span></div>
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
