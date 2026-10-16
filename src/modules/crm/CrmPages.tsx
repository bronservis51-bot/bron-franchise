// CRM: воронка будущих франчайзи. Главный экран — «кому и что сделать сегодня»; карточка лида — позвонить, записать касание
// и сразу назначить следующий шаг. Лид без следующего шага подсвечивается: так ни один клиент не теряется.
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Calendar, Check, Flag, Mail, MessageCircle, Phone, Plus, Search, Send, StickyNote, Trophy, Users, X } from 'lucide-react';
import { useSession } from '../../platform/session';
import { formatDateTime } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort, parseMoney } from '../../platform/money';
import { ActionError, Button, ConfirmDialog, DataState, EmptyState, Field, Input, PageHeader, Select, Textarea } from '../../ui';
import { useToast } from '../../ui/toast';
import { useUserNames } from '../shared/lookups';
import { ACTIVE, activities, crm, digits, dueState, lead as getLead, leads, myWeekTouches, SOURCES, STAGES, stageLabel, type Activity, type Lead, type Stage } from './api';

const WEEK_GOAL = 20;
const COUNTRIES = [['RU', 'Россия'], ['KZ', 'Казахстан'], ['TR', 'Турция']];
const daysAgo = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 864e5));

function when(at: string | null) {
  if (!at) return '';
  const d = new Date(at);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const time = d.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `сегодня ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `завтра ${time}`;
  return d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' }) + ` ${time}`;
}

function NextStep({ l }: { l: Lead }) {
  const { t } = useT();
  const s = dueState(l.next_action_at);
  if (l.stage === 'won' || l.stage === 'lost') return null;
  if (!l.next_action) return <span className="crm-next none"><Flag size={13} aria-hidden /> {t('Нет следующего шага')}</span>;
  return <span className={`crm-next ${s}`}><Calendar size={13} aria-hidden /> {l.next_action} · {t(when(l.next_action_at))}</span>;
}

function LeadCard({ l, onDragStart }: { l: Lead; onDragStart?: (e: DragEvent, id: string) => void }) {
  const { t } = useT();
  return (
    <Link to={`/crm/${l.id}`} className={`crm-card ${dueState(l.next_action_at)}${!l.next_action && ACTIVE.includes(l.stage) ? ' nostep' : ''}`}
      draggable={Boolean(onDragStart)} onDragStart={onDragStart ? (e) => onDragStart(e, l.id) : undefined}>
      <span className="crm-card-top">
        <span className="crm-name">{l.name}</span>
        {l.phone && <a className="crm-call" href={`tel:${l.phone}`} aria-label={`${t('Позвонить')} ${l.name}`} onClick={(e) => e.stopPropagation()}><Phone size={15} /></a>}
      </span>
      <span className="crm-meta">{[l.city, t(SOURCES[l.source] ?? l.source), l.investment_minor ? formatMoneyShort(l.investment_minor, 'RUB', intlLocale()) : null].filter(Boolean).join(' · ')}</span>
      <NextStep l={l} />
      {ACTIVE.includes(l.stage) && <span className="crm-age">{t('на этапе')} {daysAgo(l.stage_changed_at)} {t('дн.')}</span>}
    </Link>
  );
}

function NewLeadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', phone: '', city: '', country: 'RU', source: 'site', comment: '' });
  const create = useMutation({
    mutationFn: () => crm.create({ name: f.name, phone: f.phone, city: f.city || null, country: f.country || null, source: f.source, comment: f.comment || null }),
    onSuccess: (l) => { void qc.invalidateQueries({ queryKey: ['crm'] }); setF({ name: '', phone: '', city: '', country: 'RU', source: 'site', comment: '' }); onClose(); navigate(`/crm/${l.id}`); },
  });
  return (
    <ConfirmDialog open={open} title="Новый лид" confirmLabel="Добавить" busy={create.isPending} error={create.error} disabled={!f.name.trim() || !f.phone.trim()}
      onClose={onClose} onConfirm={() => create.mutate()}>
      <div className="grid grid-2">
        <Field label="Имя" required>{(id) => <Input id={id} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Телефон" required>{(id) => <Input id={id} type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+7…" />}</Field>
        <Field label="Город">{(id) => <Input id={id} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
        <Field label="Страна">{(id) => <Select id={id} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select>}</Field>
      </div>
      <Field label="Откуда узнал">{() => (
        <div className="chips" role="group">{Object.entries(SOURCES).map(([k, v]) => <button key={k} type="button" className="chip" aria-pressed={f.source === k} onClick={() => setF({ ...f, source: k })}>{t(v)}</button>)}</div>
      )}</Field>
      <Field label="Комментарий" hint="Что уже известно: бюджет, помещение, сроки">{(id) => <Textarea id={id} rows={2} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />}</Field>
      <p className="faint" style={{ margin: 0 }}>{t('Первый шаг «позвонить и познакомиться» назначится сам — на ближайшие 2 часа.')}</p>
    </ConfirmDialog>
  );
}

type Focus = 'all' | 'today' | 'late' | 'nostep';

export function CrmPage() {
  const { t } = useT();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['crm', 'leads'], queryFn: leads });
  const touches = useQuery({ queryKey: ['crm', 'week', me?.user.id], enabled: Boolean(me) && can('crm.manage'), queryFn: () => myWeekTouches(me!.user.id) });
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const focus = (params.get('focus') ?? 'all') as Focus;
  const stage = (params.get('stage') ?? 'active') as Stage | 'active';
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const manage = can('crm.manage');
  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: Stage }) => crm.stage(id, to, null, null),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['crm'] }),
  });
  const [dragId, setDragId] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="Лиды франшизы" sub="Будущие франчайзи: кому и что сделать, чтобы довести до договора"
        actions={manage && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />{t('Новый лид')}</Button>} />
      <DataState query={q}>
        {(all) => {
          const active = all.filter((l) => ACTIVE.includes(l.stage));
          const late = active.filter((l) => dueState(l.next_action_at) === 'late');
          const today = active.filter((l) => dueState(l.next_action_at) === 'today');
          const nostep = active.filter((l) => !l.next_action);
          const s = search.trim().toLowerCase();
          const sd = digits(search);
          const base = (focus === 'today' ? today : focus === 'late' ? late : focus === 'nostep' ? nostep : all)
            .filter((l) => !s || `${l.name} ${l.company ?? ''} ${l.city ?? ''}`.toLowerCase().includes(s) || (sd.length >= 3 && digits(l.phone).includes(sd)));
          const won90 = all.filter((l) => l.stage === 'won' && daysAgo(l.stage_changed_at) <= 90).length;
          const closed90 = all.filter((l) => ['won', 'lost'].includes(l.stage) && daysAgo(l.stage_changed_at) <= 90).length;
          const potential = active.reduce((a, l) => a + Number(l.investment_minor ?? 0), 0);
          const weekDone = touches.data?.length ?? 0;
          const byStage = (st: Stage) => base.filter((l) => l.stage === st);
          const listForMobile = stage === 'active' ? base.filter((l) => ACTIVE.includes(l.stage)) : byStage(stage);
          return (
            <div className="stack">
              <div className="crm-focus">
                <button type="button" className={`crm-tile${focus === 'today' ? ' on' : ''}`} onClick={() => set('focus', focus === 'today' ? null : 'today')}>
                  <span className="v">{today.length}</span><span className="l">{t('на сегодня')}</span></button>
                <button type="button" className={`crm-tile late${focus === 'late' ? ' on' : ''}`} onClick={() => set('focus', focus === 'late' ? null : 'late')}>
                  <span className="v">{late.length}</span><span className="l">{t('просрочено')}</span></button>
                <button type="button" className={`crm-tile warn${focus === 'nostep' ? ' on' : ''}`} onClick={() => set('focus', focus === 'nostep' ? null : 'nostep')}>
                  <span className="v">{nostep.length}</span><span className="l">{t('без шага')}</span></button>
                {manage ? (
                  <div className="crm-tile goal-tile">
                    <span className="l">{weekDone >= WEEK_GOAL ? `🏆 ${t('Цель недели взята')}` : `🎯 ${t('Касаний за неделю')}`}</span>
                    <span className="v">{weekDone}<small>/{WEEK_GOAL}</small></span>
                    <span className="goal-bar"><span style={{ width: `${Math.min(100, (weekDone / WEEK_GOAL) * 100)}%` }} className={weekDone >= WEEK_GOAL ? 'won' : ''} /></span>
                  </div>
                ) : (
                  <div className="crm-tile"><span className="v">{closed90 ? Math.round((won90 / closed90) * 100) : 0}%</span><span className="l">{t('конверсия за 90 дней')}</span></div>
                )}
              </div>
              <div className="crm-summary faint">
                {t('В работе')}: <strong>{active.length}</strong> · {t('потенциал')}: <strong>{formatMoneyShort(potential, 'RUB', intlLocale())}</strong> · {t('партнёров за 90 дней')}: <strong>{won90}</strong>
              </div>
              <div className="net-search"><Search size={16} aria-hidden /><Input type="search" aria-label={t('Поиск')} placeholder={t('Имя, город или телефон')} value={search} onChange={(e) => setSearch(e.target.value)} /></div>

              {/* Телефон: этапы вкладками */}
              <div className="crm-mobile">
                <div className="shop-cats crm-stage-tabs" role="group" aria-label={t('Этап')}>
                  <button type="button" aria-pressed={stage === 'active'} onClick={() => set('stage', null)}>{t('В работе')} {base.filter((l) => ACTIVE.includes(l.stage)).length}</button>
                  {STAGES.map((st) => <button key={st.id} type="button" aria-pressed={stage === st.id} onClick={() => set('stage', st.id)}>{t(st.label)} {byStage(st.id).length}</button>)}
                </div>
                {listForMobile.length ? <div className="crm-col-list">{listForMobile.map((l) => <LeadCard key={l.id} l={l} />)}</div>
                  : <EmptyState title="Пусто" text={focus === 'all' ? 'Здесь появятся лиды этого этапа.' : 'По этому фильтру ничего — отлично!'} />}
              </div>

              {/* Компьютер: колонки воронки с перетаскиванием */}
              <div className="crm-board">
                {ACTIVE.map((st) => {
                  const col = byStage(st);
                  return (
                    <section key={st} className={`crm-col${dragId ? ' drop' : ''}`} onDragOver={(e) => manage && e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); setDragId(null); if (id && manage) move.mutate({ id, to: st }); }}>
                      <h3>{t(stageLabel(st))} <span className="count-pill">{col.length}</span></h3>
                      <div className="crm-col-list">
                        {col.map((l) => <LeadCard key={l.id} l={l} onDragStart={manage ? (e, id) => { e.dataTransfer.setData('text/plain', id); setDragId(id); } : undefined} />)}
                      </div>
                    </section>
                  );
                })}
              </div>
              <ActionError error={move.error} />
              <details className="card fold">
                <summary className="card-body"><strong>{t('Партнёры и отказы')}</strong><span className="faint">{byStage('won').length} · {byStage('lost').length}</span></summary>
                <div className="card-body crm-col-list">{[...byStage('won'), ...byStage('lost')].map((l) => <LeadCard key={l.id} l={l} />)}</div>
              </details>
            </div>
          );
        }}
      </DataState>
      <NewLeadDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

const KIND: Record<Activity['kind'], { label: string; icon: ReactNode }> = {
  call: { label: 'Звонок', icon: <Phone size={14} /> }, meeting: { label: 'Встреча', icon: <Users size={14} /> },
  message: { label: 'Сообщение', icon: <MessageCircle size={14} /> }, note: { label: 'Заметка', icon: <StickyNote size={14} /> },
  stage: { label: 'Этап', icon: <Flag size={14} /> }, created: { label: 'Создан', icon: <Plus size={14} /> },
};
const atDay = (n: number, hour = 11) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(hour, 0, 0, 0); return d; };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function TouchForm({ l, onDone }: { l: Lead; onDone: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [kind, setKind] = useState<'call' | 'meeting' | 'message' | 'note'>('call');
  const [body, setBody] = useState('');
  const [next, setNext] = useState('');
  const [at, setAt] = useState(localInput(atDay(1)));
  const active = ACTIVE.includes(l.stage);
  const save = useMutation({
    mutationFn: () => crm.touch(l.id, kind, body || null, active && next ? next : null, active && next ? new Date(at).toISOString() : null),
    onSuccess: () => { toast(next ? `Записано. Следующий шаг: ${when(new Date(at).toISOString())}` : 'Записано'); setBody(''); setNext(''); onDone(); },
  });
  return (
    <section className="touch">
      <div className="touch-kinds" role="group" aria-label={t('Что было')}>
        {(['call', 'meeting', 'message', 'note'] as const).map((k) => (
          <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND[k].icon} {t(KIND[k].label)}</button>
        ))}
      </div>
      <Textarea rows={2} aria-label={t('Чем закончилось')} placeholder={t(kind === 'note' ? 'Заметка' : 'Чем закончилось? Например: интересно, просит финмодель')} value={body} onChange={(e) => setBody(e.target.value)} />
      {active && (
        <>
          <Input aria-label={t('Что дальше')} placeholder={t('Что дальше? Например: отправить презентацию')} value={next} onChange={(e) => setNext(e.target.value)} />
          {next && (
            <div className="touch-when">
              {[['Сегодня', atDay(0, Math.min(20, new Date().getHours() + 2))], ['Завтра', atDay(1)], ['Через 3 дня', atDay(3)], ['Через неделю', atDay(7)]].map(([lbl, d]) => (
                <button key={String(lbl)} type="button" className="chip" aria-pressed={at === localInput(d as Date)} onClick={() => setAt(localInput(d as Date))}>{t(String(lbl))}</button>
              ))}
              <input type="datetime-local" className="input touch-dt" aria-label={t('Когда')} value={at} onChange={(e) => setAt(e.target.value)} />
            </div>
          )}
        </>
      )}
      <Button variant="primary" block disabled={!body.trim() && !next.trim()} loading={save.isPending} onClick={() => save.mutate()}><Check size={16} aria-hidden />{t('Записать')}</Button>
      <ActionError error={save.error} />
    </section>
  );
}

function Details({ l, onSaved }: { l: Lead; onSaved: () => void }) {
  const { t } = useT();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(() => ({ company: l.company ?? '', phone: l.phone ?? '', email: l.email ?? '', city: l.city ?? '', country: l.country ?? 'RU', source: l.source,
    investment: l.investment_minor ? String(Number(l.investment_minor) / 100) : '', points: l.points_planned ? String(l.points_planned) : '' }));
  const save = useMutation({
    mutationFn: () => crm.update(l.id, { company: f.company, phone: f.phone, email: f.email, city: f.city, country: f.country, source: f.source,
      investment_minor: f.investment ? String(parseMoney(f.investment, 'RUB') ?? 0) : null, points_planned: f.points ? Number(f.points) : null }, l.revision),
    onSuccess: () => { setEdit(false); onSaved(); },
  });
  if (!edit) {
    const rows: [string, ReactNode][] = [['Компания', l.company], ['Телефон', l.phone], ['Email', l.email], ['Город', [l.city, COUNTRIES.find((c) => c[0] === l.country)?.[1]].filter(Boolean).join(', ')],
      ['Источник', t(SOURCES[l.source] ?? l.source)], ['Готов вложить', l.investment_minor ? formatMoneyShort(l.investment_minor, 'RUB', intlLocale()) : null], ['Сколько точек', l.points_planned]];
    return (
      <section className="crm-details">
        <dl>{rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{t(k)}</dt><dd>{v}</dd></div>)}</dl>
        <button type="button" className="link-btn dark" onClick={() => setEdit(true)}>{t('Изменить данные')}</button>
      </section>
    );
  }
  return (
    <section className="crm-details">
      <div className="grid grid-2">
        <Field label="Компания">{(id) => <Input id={id} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />}</Field>
        <Field label="Телефон">{(id) => <Input id={id} type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>
        <Field label="Город">{(id) => <Input id={id} value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />}</Field>
        <Field label="Страна">{(id) => <Select id={id} value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{t(n)}</option>)}</Select>}</Field>
        <Field label="Источник">{(id) => <Select id={id} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select>}</Field>
        <Field label="Готов вложить, ₽">{(id) => <Input id={id} inputMode="decimal" value={f.investment} onChange={(e) => setF({ ...f, investment: e.target.value })} />}</Field>
        <Field label="Сколько точек">{(id) => <Input id={id} inputMode="numeric" value={f.points} onChange={(e) => setF({ ...f, points: e.target.value.replace(/\D/g, '') })} />}</Field>
      </div>
      <div className="row" style={{ gap: 8 }}><Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>{t('Сохранить')}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(false)}>{t('Отмена')}</Button></div>
      <ActionError error={save.error} />
    </section>
  );
}

export function LeadPage() {
  const { id = '' } = useParams();
  const { t } = useT();
  const { can } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const names = useUserNames();
  const q = useQuery({ queryKey: ['crm', 'lead', id], queryFn: () => getLead(id) });
  const acts = useQuery({ queryKey: ['crm', 'acts', id], queryFn: () => activities(id) });
  const [dialog, setDialog] = useState<null | 'won' | 'lost'>(null);
  const [reason, setReason] = useState('');
  const [planned, setPlanned] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 45); return d.toISOString().slice(0, 10); });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['crm'] }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  const manage = can('crm.manage');
  const stage = useMutation({
    mutationFn: ({ to, why, open }: { to: Stage; why?: string; open?: string }) => crm.stage(id, to, why ?? null, open ?? null),
    onSuccess: (r, v) => {
      refresh(); setDialog(null);
      if (v.to === 'won') { toast('🎉 Новый партнёр! Создан проект открытия точки'); if (r.opening_id) navigate(`/openings/${r.opening_id}`); }
    },
  });
  const sorted = useMemo(() => acts.data ?? [], [acts.data]);

  return (
    <DataState query={q} empty={(l) => (l ? null : <EmptyState title="Лид не найден" />)}>
      {(l) => l && (
        <div className="lead-page">
          <Link to="/crm" className="back-link"><ArrowLeft size={16} aria-hidden /> {t('Лиды франшизы')}</Link>
          <header className="lead-head">
            <div>
              <h1>{l.name}</h1>
              <div className="faint">{[l.company, l.city, l.number].filter(Boolean).join(' · ')}</div>
            </div>
            {l.stage === 'won' && <span className="lead-won"><Trophy size={16} aria-hidden /> {t('Партнёр')}</span>}
            {l.stage === 'lost' && <span className="lead-lost"><X size={16} aria-hidden /> {t('Отказ')}</span>}
          </header>

          {l.phone && (
            <div className="lead-contacts">
              <a className="btn btn-silver" href={`tel:${l.phone}`}><Phone size={16} aria-hidden />{t('Позвонить')}</a>
              <a className="btn btn-secondary" href={`https://wa.me/${digits(l.phone)}`} target="_blank" rel="noreferrer"><MessageCircle size={16} aria-hidden />WhatsApp</a>
              <a className="btn btn-secondary" href={`https://t.me/+${digits(l.phone)}`} target="_blank" rel="noreferrer"><Send size={16} aria-hidden />Telegram</a>
              {l.email && <a className="btn btn-secondary" href={`mailto:${l.email}`}><Mail size={16} aria-hidden />Email</a>}
            </div>
          )}

          <div className="lead-stepper" role="group" aria-label={t('Этап')}>
            {STAGES.filter((s) => ACTIVE.includes(s.id)).map((s, i) => {
              const cur = ACTIVE.indexOf(l.stage as Stage);
              const state = l.stage === 'won' || i < cur ? 'done' : i === cur ? 'cur' : '';
              return (
                <button key={s.id} type="button" className={`step ${state}`} disabled={!manage || ['won', 'lost'].includes(l.stage) || stage.isPending}
                  onClick={() => stage.mutate({ to: s.id })}>{state === 'done' ? <Check size={13} aria-hidden /> : null}{t(s.label)}</button>
              );
            })}
          </div>

          {ACTIVE.includes(l.stage) && (
            <div className={`lead-next ${dueState(l.next_action_at)}${l.next_action ? '' : ' none'}`}>
              <span className="l">{t('Следующий шаг')}</span>
              <span className="v">{l.next_action ?? t('Не назначен — запишите ниже, что дальше')}</span>
              {l.next_action_at && <span className="s"><Calendar size={13} aria-hidden /> {t(when(l.next_action_at))}{dueState(l.next_action_at) === 'late' ? ` · ${t('просрочено')}` : ''}</span>}
            </div>
          )}

          {manage && <TouchForm l={l} onDone={refresh} />}

          {manage && ACTIVE.includes(l.stage) && (
            <div className="lead-finish">
              <Button variant="primary" onClick={() => setDialog('won')}><Trophy size={16} aria-hidden />{t('Стал партнёром')}</Button>
              <Button variant="ghost" onClick={() => setDialog('lost')}>{t('Отказ')}</Button>
            </div>
          )}
          {l.stage === 'won' && l.opening_id && <Link className="btn btn-silver" to={`/openings/${l.opening_id}`}>{t('Проект открытия точки')}</Link>}
          {l.stage === 'lost' && l.lost_reason && <p className="faint">{t('Причина')}: {l.lost_reason}</p>}

          <Details key={l.revision} l={l} onSaved={refresh} />

          <section>
            <h2 className="section-title">{t('История')}</h2>
            <ul className="lead-timeline">
              {sorted.map((a) => (
                <li key={a.id}>
                  <span className={`tl-icon ${a.kind}`}>{KIND[a.kind].icon}</span>
                  <div><div className="tl-body">{a.body ?? t(KIND[a.kind].label)}</div>
                    <div className="faint tl-meta">{t(KIND[a.kind].label)} · {names(a.actor_id)} · {formatDateTime(a.at, intlLocale())}</div></div>
                </li>
              ))}
            </ul>
          </section>

          <ConfirmDialog open={dialog === 'won'} title="Стал партнёром" confirmLabel="Создать партнёра и проект открытия" busy={stage.isPending} error={stage.error}
            onClose={() => setDialog(null)} onConfirm={() => stage.mutate({ to: 'won', open: planned })}>
            <p style={{ marginTop: 0 }}>{t('Создадим карточку франчайзи и проект открытия точки по стандартному плану: задачи сразу появятся у нужных сотрудников.')}</p>
            <Field label="Плановая дата открытия" required>{(fid) => <Input id={fid} type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} />}</Field>
          </ConfirmDialog>
          <ConfirmDialog open={dialog === 'lost'} title="Отказ" confirmLabel="Отметить отказ" danger busy={stage.isPending} error={stage.error} disabled={!reason.trim()}
            onClose={() => setDialog(null)} onConfirm={() => stage.mutate({ to: 'lost', why: reason })}>
            <div className="chips" role="group" style={{ marginBottom: 8 }}>
              {['Не хватает бюджета', 'Нет подходящего помещения', 'Выбрал другую франшизу', 'Пропал, не отвечает', 'Не устроили условия'].map((r) => (
                <button key={r} type="button" className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>{t(r)}</button>
              ))}
            </div>
            <Field label="Причина" required>{(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          </ConfirmDialog>
        </div>
      )}
    </DataState>
  );
}
