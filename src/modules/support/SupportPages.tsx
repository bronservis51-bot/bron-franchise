// Поддержка (SUP-02…04, SUP-08): обращение с очередью компетенции, двумя таймерами SLA и связью с базой знаний.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Languages, Plus, Send } from 'lucide-react';
import { useScopeFilter, useSession } from '../../platform/session';
import { formatDateTime } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { toAppError } from '../../platform/backend';
import { drafts, opQueue, type QueuedOperation } from '../../platform/offline';
import { ActionError, Alert, Badge, Button, Card, Checkbox, Chips, ConfirmDialog, DataState, Due, EmptyState, Field, Input, KV, LinkButton,
  PageHeader, Select, Textarea, Timeline } from '../../ui';
import { st, TICKET_STATUS, URGENCY } from '../../ui/status';
import { FileAttach, FileList } from '../../ui/files';
import { useToast } from '../../ui/toast';
import { useLocations, useLocationsWith, useRoles, useUserNames } from '../shared/lookups';
import { getTicket, kbForCategory, listTickets, messages, routing, TICKET_EVENT, ticketCommands, ticketEvents, type NewTicket, type TicketFilter } from './api';
import { flushQueue, queueTicket } from './offlineQueue';

export function TicketsPage() {
  const { me, isStaff } = useSession();
  const { t } = useT();
  const [params] = useSearchParams();
  const { partnerId, locationId } = useScopeFilter();
  const [filter, setFilter] = useState<TicketFilter>(params.get('sla') ? 'sla' : 'mine');
  const locs = useLocations();
  const q = useQuery({ queryKey: ['tickets', filter, partnerId, locationId], queryFn: () => listTickets(filter, me!.user.id, partnerId, locationId) });
  const queued = useQuery({ queryKey: ['opqueue', me?.user.id], queryFn: () => opQueue.list(me!.user.id) });
  const qc = useQueryClient();
  const flush = useMutation({
    mutationFn: () => flushQueue(me!.user.id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['opqueue'] }); void qc.invalidateQueries({ queryKey: ['tickets'] }); },
  });
  return (
    <>
      <PageHeader title={t('Поддержка')} sub="Обращения с ответственными, сроками реакции и решения"
        actions={<LinkButton to="/support/new" variant="primary"><Plus size={16} aria-hidden />{t('Новое обращение')}</LinkButton>} />
      {Boolean(queued.data?.length) && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone="warning" title={`Не отправлено: ${queued.data!.length}`} action={<Button size="sm" loading={flush.isPending} onClick={() => flush.mutate()}>{t('Отправить')}</Button>}>
            {queued.data!.map((op: QueuedOperation) => (
              <div key={op.clientOpId}>«{String(op.payload.subject)}» — сохранено на устройстве {formatDateTime(op.createdAt, intlLocale())}{op.lastError ? `. Сервер отказал: ${op.lastError}` : ''}</div>
            ))}
          </Alert>
        </div>
      )}
      <Chips label="Фильтр обращений" value={filter} onChange={setFilter} options={[
        { id: 'mine', label: 'Мои' }, ...(isStaff ? [{ id: 'queue' as const, label: 'Новые в очереди' }] : []),
        { id: 'open', label: 'Все открытые' }, ...(isStaff ? [{ id: 'sla' as const, label: 'Вне SLA' }] : []), { id: 'closed', label: 'Решённые' },
      ]} />
      <Card bodyless>
        <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Обращений нет" text="Создайте обращение — оно не потеряется и получит ответственного." />)}>
          {(d) => (
            <ul className="list">
              {d.map((k) => {
                const [label, tone] = st(TICKET_STATUS, k.status);
                const [ul, ut] = st(URGENCY, k.urgency);
                const open = !['resolved', 'closed'].includes(k.status);
                return (
                  <li key={k.id}>
                    <Link className="list-item" to={`/support/${k.id}`}>
                      <div className="main-col">
                        <div className="title">{k.subject}</div>
                        <div className="meta"><span className="mono">{k.number}</span><span>{locs.data?.find((l) => l.id === k.location_id)?.name}</span>{k.urgency !== 'normal' && <Badge tone={ut}>{t(ul)}</Badge>}</div>
                      </div>
                      <div className="side"><Badge tone={tone}>{t(label)}</Badge>{open && k.status !== 'waiting_partner' && <Due at={k.first_response_at ? k.resolve_due : k.first_response_due} />}</div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      </Card>
    </>
  );
}

const EMPTY: NewTicket = { location: '', category: '', urgency: 'normal', urgency_reason: null, subject: '', description: '', equipment_model: null, details: {} };

export function NewTicketPage() {
  const { me, context } = useSession();
  const { t, locale } = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const locs = useLocationsWith('ticket.create');
  const routes = useQuery({ queryKey: ['routing'], queryFn: routing, staleTime: 10 * 60_000 });
  const [form, setForm] = useState<NewTicket>({ ...EMPTY, subject: params.get('q') ?? '', description: params.get('q') ? `Не нашёл в базе знаний: ${params.get('q')}` : '' });
  const [clientKey] = useState(() => crypto.randomUUID());
  const [restored, setRestored] = useState(false);
  const route = routes.data?.find((r) => r.category === form.category);
  const kb = useQuery({ queryKey: ['kb-context', form.category], enabled: Boolean(form.category), queryFn: () => kbForCategory(form.category) });
  const draftKey = 'ticket-new';

  // Восстановление и автосохранение черновика на устройстве (UX-06)
  useEffect(() => {
    if (!me) return;
    void drafts.load<NewTicket>(me.user.id, draftKey).then((d) => {
      if (d?.value && !params.get('q')) { setForm(d.value); setRestored(true); }
    });
  }, [me, params]);
  useEffect(() => {
    if (!me || form === EMPTY) return;
    const id = setTimeout(() => void drafts.save(me.user.id, draftKey, form), 600);
    return () => clearTimeout(id);
  }, [form, me]);
  useEffect(() => {
    if (form.location || !locs.data.length) return;
    const fromCtx = context?.scope_type === 'location' ? context.scope_id : null;
    setForm((f) => ({ ...f, location: fromCtx ?? (locs.data.length === 1 ? locs.data[0].id : '') }));
  }, [locs.data, context, form.location]);

  const create = useMutation({
    mutationFn: async () => {
      if (!navigator.onLine) {
        await queueTicket(me!.user.id, form, clientKey);
        return null;
      }
      return ticketCommands.create(form, clientKey);
    },
    onSuccess: async (tk) => {
      await drafts.remove(me!.user.id, draftKey);
      if (!tk) {
        toast('Нет сети: обращение сохранено на устройстве и отправится при появлении связи', 'info');
        navigate('/support');
      } else {
        toast(`Обращение ${tk.number} создано и передано в очередь`);
        navigate(`/support/${tk.id}`);
      }
    },
  });
  const err = create.error ? toAppError(create.error) : null;
  const fe = (f: string) => (err?.field === f ? err.detail : null);
  const set = <K extends keyof NewTicket>(k: K, v: NewTicket[K]) => setForm((f) => ({ ...f, [k]: v }));
  const needsModel = route?.required_fields.includes('equipment_model');
  const valid = form.location && form.category && form.subject.trim() && form.description.trim() &&
    (form.urgency === 'normal' || form.urgency_reason?.trim()) && (!needsModel || form.equipment_model?.trim());

  function submit(e: FormEvent) { e.preventDefault(); create.mutate(); }

  return (
    <>
      <PageHeader back={{ to: '/support', label: t('Поддержка') }} title={t('Новое обращение')} sub="Обращение получит ответственного и срок первой реакции" />
      {restored && <div style={{ marginBottom: 16 }}><Alert tone="info" action={<Button size="sm" variant="ghost" onClick={() => { setForm(EMPTY); setRestored(false); void drafts.remove(me!.user.id, draftKey); }}>Очистить</Button>}>{t('Восстановлен несохранённый черновик.')}</Alert></div>}
      <form onSubmit={submit} className="grid grid-main" noValidate>
        <Card>
          <div className="grid grid-2">
            <Field label={t('Точка')} required error={fe('location')}>
              {(id) => (
                <Select id={id} value={form.location} onChange={(e) => set('location', e.target.value)}>
                  <option value="">Выберите точку</option>
                  {locs.data.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label={t('Категория')} required error={fe('category')} hint={route ? `Ответит очередь: ${route.title}` : undefined}>
              {(id) => (
                <Select id={id} value={form.category} onChange={(e) => set('category', e.target.value)}>
                  <option value="">Выберите категорию</option>
                  {(routes.data ?? []).map((r) => <option key={r.category} value={r.category}>{t(r.title)}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label={t('Срочность')} required>
            {() => (
              <Chips label={t('Срочность')} value={form.urgency} onChange={(v) => set('urgency', v)} options={[
                { id: 'normal', label: t('обычная') }, { id: 'high', label: t('высокая') }, { id: 'stopped', label: t('точка не работает') },
              ]} />
            )}
          </Field>
          {form.urgency !== 'normal' && (
            <Field label={t('Почему срочно')} required error={fe('urgency_reason')} hint={form.urgency === 'stopped' ? 'Руководитель получит срочное уведомление' : undefined}>
              {(id) => <Input id={id} value={form.urgency_reason ?? ''} onChange={(e) => set('urgency_reason', e.target.value)} />}
            </Field>
          )}
          <Field label={t('Тема')} required error={fe('subject')}>{(id) => <Input id={id} maxLength={200} value={form.subject} onChange={(e) => set('subject', e.target.value)} />}</Field>
          <Field label={t('Описание')} required error={fe('description')} hint="Что произошло, когда, что уже пробовали. Фото и видео — после создания.">
            {(id) => <Textarea id={id} rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} />}
          </Field>
          {(needsModel || form.category === 'quality_warranty') && (
            <Field label={t('Устройство или модель')} required={needsModel} error={fe('equipment_model')} hint="Точная модель или код — по настройкам устройства">
              {(id) => <Input id={id} value={form.equipment_model ?? ''} onChange={(e) => set('equipment_model', e.target.value)} />}
            </Field>
          )}
          <ActionError error={err && !err.field ? err : null} />
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!valid}><Send size={16} aria-hidden />{t('Отправить')}</Button>
          </div>
          <p className="faint">Черновик сохраняется на этом устройстве{locale === 'tr' ? '' : ''}. Без сети обращение встанет в очередь отправки.</p>
        </Card>
        <div className="stack">
          {form.category && (
            <Card title="Возможно, поможет">
              {kb.data?.length ? kb.data.map((a) => (
                <div key={a.article_id} style={{ marginBottom: 8 }}><Link to={`/kb/articles/${a.article_id}`}>{a.title}</Link>{a.summary && <div className="faint">{a.summary}</div>}</div>
              )) : <span className="muted">Инструкций к этой категории пока нет.</span>}
            </Card>
          )}
        </div>
      </form>
    </>
  );
}

function TranslateButton({ messageId, target }: { messageId: string; target: string }) {
  const { t } = useT();
  const [res, setRes] = useState<{ translated: string | null; available: boolean } | null>(null);
  const m = useMutation({ mutationFn: () => ticketCommands.translate(messageId, target), onSuccess: setRes });
  if (res) {
    return (
      <div style={{ marginTop: 8, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
        <div className="faint">{t('Перевод')}</div>
        <div>{res.available ? res.translated : t('Для этого сообщения перевода нет.')}</div>
      </div>
    );
  }
  return <Button size="sm" variant="ghost" loading={m.isPending} onClick={() => m.mutate()}><Languages size={15} aria-hidden />{t('Показать перевод')}</Button>;
}

export function TicketPage() {
  const { id = '' } = useParams();
  const { me, isStaff, can } = useSession();
  const { t, locale } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const names = useUserNames();
  const roles = useRoles();
  const locs = useLocations();
  const tk = useQuery({ queryKey: ['ticket', id], queryFn: () => getTicket(id) });
  const msgs = useQuery({ queryKey: ['ticket', id, 'msgs'], queryFn: () => messages(id), refetchInterval: 30_000 });
  const ev = useQuery({ queryKey: ['ticket', id, 'events'], queryFn: () => ticketEvents(id) });
  const routes = useQuery({ queryKey: ['routing'], queryFn: routing, staleTime: 10 * 60_000 });
  const kb = useQuery({ queryKey: ['kb-context', tk.data?.category], enabled: Boolean(tk.data?.category), queryFn: () => kbForCategory(tk.data!.category) });
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [dialog, setDialog] = useState<null | 'waiting_partner' | 'waiting_vendor' | 'resolve' | 'reopen'>(null);
  const [text, setText] = useState('');
  const [kbArticle, setKbArticle] = useState('');

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ticket', id] }); void qc.invalidateQueries({ queryKey: ['tickets'] }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  const act = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: () => { refresh(); setDialog(null); setText(''); } });
  const reply = useMutation({
    mutationFn: () => ticketCommands.reply(id, body.trim(), internal, locale),
    onSuccess: () => { setBody(''); setInternal(false); refresh(); },
  });

  const timeline = useMemo(() => (ev.data ?? []).filter((e) => !['message', 'internal_note'].includes(e.action)), [ev.data]);

  return (
    <DataState query={tk} empty={(d) => (d ? null : <EmptyState title="Обращение не найдено" />)}>
      {(k) => {
        if (!k) return null;
        const [label, tone] = st(TICKET_STATUS, k.status);
        const [ul, ut] = st(URGENCY, k.urgency);
        const isAuthor = k.created_by === me?.user.id;
        const worker = isStaff && (k.assignee_id === me?.user.id || can('ticket.work'));
        const open = !['resolved', 'closed'].includes(k.status);
        const loc = locs.data?.find((l) => l.id === k.location_id);
        const category = routes.data?.find((r) => r.category === k.category);
        return (
          <>
            <PageHeader back={{ to: '/support', label: t('Поддержка') }} title={k.subject}
              sub={<span className="row"><span className="mono">{k.number}</span><Badge tone={tone}>{t(label)}</Badge>{k.urgency !== 'normal' && <Badge tone={ut}>{t(ul)}</Badge>}</span>}
              actions={
                <>
                  {worker && open && !k.assignee_id && <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(() => ticketCommands.take(k.id))}>{t('Взять в работу')}</Button>}
                  {worker && open && k.assignee_id && <>
                    {k.status !== 'waiting_partner' && <Button onClick={() => setDialog('waiting_partner')}>Ждём партнёра</Button>}
                    {k.status !== 'waiting_vendor' && <Button onClick={() => setDialog('waiting_vendor')}>Ждём поставщика</Button>}
                    {k.status !== 'new' && <Button variant="primary" onClick={() => setDialog('resolve')}>Решить</Button>}
                  </>}
                  {isAuthor && k.status === 'resolved' && <>
                    <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(async () => { await ticketCommands.confirm(k.id); toast('Спасибо! Обращение закрыто'); })}>{t('Подтвердить решение')}</Button>
                    <Button onClick={() => setDialog('reopen')}>{t('Переоткрыть')}</Button>
                  </>}
                </>
              } />
            <ActionError error={act.error} />
            <div className="grid grid-main">
              <div className="stack">
                {k.status === 'waiting_partner' && isAuthor && <Alert tone="warning" title="Нужен ваш ответ">{t('Ответьте в переписке — таймер решения приостановлен до вашего ответа.')}</Alert>}
                {k.status === 'waiting_vendor' && <Alert tone="warning" title="Ожидаем внешнего поставщика">{t('Срок решения продолжает идти; ответственный держит обращение на контроле.')}</Alert>}
                {k.status === 'resolved' && (
                  <Alert tone="success" title="Решение">
                    {k.resolution_reason}
                    {k.kb_article_id && <div><Link to={`/kb/articles/${k.kb_article_id}`}>{t('Инструкция по решению')}</Link></div>}
                    {isAuthor && k.reopen_until && <div className="faint">{t('Переоткрыть можно до')} {formatDateTime(k.reopen_until, intlLocale())}</div>}
                  </Alert>
                )}
                <Card title="Переписка">
                  <div className="message" style={{ marginBottom: 12 }}>
                    <div className="who"><span>{names(k.created_by)}</span><span className="faint">{formatDateTime(k.created_at, intlLocale())}</span></div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{k.description}</div>
                    {k.urgency_reason && <div className="faint">{t('Срочность')}: {k.urgency_reason}</div>}
                  </div>
                  {(msgs.data ?? []).map((m) => (
                    <div key={m.id} className={`message${m.author_id === me?.user.id ? ' mine' : ''}${m.internal ? ' internal' : ''}`} style={{ marginBottom: 12 }}>
                      <div className="who">
                        <span>{names(m.author_id)}{m.internal && <> · <Badge tone="warning">внутренняя заметка</Badge></>}</span>
                        <span className="faint">{formatDateTime(m.created_at, intlLocale())}</span>
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                      {m.author_id !== me?.user.id && !m.internal && <TranslateButton messageId={m.id} target={locale === 'tr' ? 'tr' : 'ru'} />}
                    </div>
                  ))}
                  {k.status !== 'closed' && (
                    <form onSubmit={(e) => { e.preventDefault(); reply.mutate(); }}>
                      <Field label={t('Ответить')}>{(fid) => <Textarea id={fid} rows={3} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
                      {isStaff && worker && <Checkbox label="Внутренняя заметка" hint="Партнёр её не увидит" checked={internal} onChange={setInternal} />}
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <Button type="submit" variant="primary" disabled={!body.trim()} loading={reply.isPending}><Send size={15} aria-hidden />{t('Отправить')}</Button>
                      </div>
                      <ActionError error={reply.error} />
                    </form>
                  )}
                </Card>
                <Card title="Фото и файлы">
                  <FileList entityType="ticket" entityId={k.id} />
                  {k.status !== 'closed' && <div style={{ marginTop: 12 }} className="row">
                    <FileAttach entityType="ticket" entityId={k.id} prepare={(f) => ticketCommands.attachPrepare(k.id, false, f)} />
                    {isStaff && worker && <FileAttach label="Внутренний файл" entityType="ticket" entityId={k.id} prepare={(f) => ticketCommands.attachPrepare(k.id, true, f)} />}
                  </div>}
                </Card>
              </div>
              <div className="stack">
                <Card title="Обращение">
                  <KV items={[
                    [t('Точка'), loc?.name], [t('Категория'), t(category?.title ?? k.category)], ['Очередь', roles.name(k.queue_role)],
                    ['Ответственный', names(k.assignee_id) ?? <span className="muted">{t('ещё не назначен')}</span>],
                    ...(k.equipment_model ? [[t('Устройство или модель'), k.equipment_model] as [string, string]] : []),
                    [t('Первая реакция до'), k.first_response_at ? <span key="f">{t('дана')} {formatDateTime(k.first_response_at, intlLocale())}</span> : <Due key="f" at={k.first_response_due} />],
                    [t('Решение до'), open ? (k.status === 'waiting_partner' ? <span key="r">{t('таймер на паузе')}</span> : <Due key="r" at={k.resolve_due} />) : formatDateTime(k.resolved_at, intlLocale())],
                    ...(k.sla_paused_minutes ? [['Пауза SLA', `${k.sla_paused_minutes} мин (ожидание партнёра)`] as [string, string]] : []),
                    ...(k.reopen_count ? [['Переоткрыто', String(k.reopen_count)] as [string, string]] : []),
                  ]} />
                </Card>
                <Card title="Инструкции по теме">
                  {kb.data?.length ? kb.data.map((a) => <div key={a.article_id} style={{ marginBottom: 6 }}><Link to={`/kb/articles/${a.article_id}`}>{a.title}</Link></div>) : <span className="muted">{t('Нет привязанных статей')}</span>}
                </Card>
                <Card title="История">
                  <Timeline items={timeline.map((e) => ({ at: e.at, who: names(e.actor_id) ?? t('Система'), text: TICKET_EVENT[e.action] ?? e.action, comment: e.comment }))} />
                </Card>
              </div>
            </div>
            <ConfirmDialog
              open={dialog !== null}
              title={{ waiting_partner: 'Ждём ответа партнёра', waiting_vendor: 'Ждём внешнего поставщика', resolve: 'Решить обращение', reopen: 'Переоткрыть обращение' }[dialog ?? 'resolve']}
              confirmLabel={dialog === 'resolve' ? 'Отметить решённым' : 'Подтвердить'}
              busy={act.isPending} error={act.error}
              onClose={() => { setDialog(null); act.reset(); }}
              onConfirm={() => act.mutate(() => {
                if (dialog === 'resolve') return ticketCommands.resolve(k.id, text, kbArticle || null);
                if (dialog === 'reopen') return ticketCommands.reopen(k.id, text);
                return ticketCommands.setStatus(k.id, dialog!, text, k.revision);
              })}
            >
              <Field label={dialog === 'resolve' ? 'Причина и решение' : dialog === 'reopen' ? 'Что не решено' : 'Чего ждём'} required
                hint={dialog === 'waiting_partner' ? 'Таймер решения встанет на паузу до ответа партнёра' : dialog === 'waiting_vendor' ? 'Таймер не останавливается' : undefined}>
                {(fid) => <Textarea id={fid} rows={3} value={text} onChange={(e) => setText(e.target.value)} />}
              </Field>
              {dialog === 'resolve' && (
                <Field label="Инструкция по решению" hint="Если решение описано в базе знаний — свяжите его">
                  {(fid) => (
                    <Select id={fid} value={kbArticle} onChange={(e) => setKbArticle(e.target.value)}>
                      <option value="">Без статьи</option>
                      {(kb.data ?? []).map((a) => <option key={a.article_id} value={a.article_id}>{a.title}</option>)}
                    </Select>
                  )}
                </Field>
              )}
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}
