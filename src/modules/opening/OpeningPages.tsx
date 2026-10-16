// Открытие точки (OPEN-01…05): дорожная карта, блокеры вместо абстрактного процента, перенос даты, разрешение.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Lock, Plus } from 'lucide-react';
import { useSession } from '../../platform/session';
import { addDays, formatDate, formatDateTime, isoDate } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { toAppError } from '../../platform/backend';
import { ActionError, Alert, Badge, Button, Card, Chips, ConfirmDialog, DataState, Due, EmptyState, Field, Input, KV, LinkButton,
  PageHeader, Select, Textarea, Timeline } from '../../ui';
import { OPENING_STATUS, st, TASK_STATUS } from '../../ui/status';
import { useToast } from '../../ui/toast';
import { useLocations, usePartners, useRoles, useUserNames } from '../shared/lookups';
import { blockers, EVENT_LABEL, events, getOpening, getProgress, listOpenings, notes, openingCommands, progressAll, steps, templateVersion, type StepTask } from './api';

export function OpeningsPage() {
  const { can } = useSession();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<'active' | 'risk' | 'all'>(params.get('risk') ? 'risk' : 'active');
  const list = useQuery({ queryKey: ['openings'], queryFn: listOpenings });
  const prog = useQuery({ queryKey: ['openings', 'progress'], queryFn: progressAll });
  const locs = useLocations();
  const partners = usePartners();
  const p = (id: string) => prog.data?.find((x) => x.project_id === id);
  const data = (list.data ?? []).filter((o) => {
    const g = p(o.id);
    if (filter === 'active') return ['active', 'approved', 'opened'].includes(o.status);
    if (filter === 'risk') return o.status === 'active' && (g?.date_at_risk || (g?.overdue_tasks ?? 0) > 0);
    return true;
  });
  return (
    <>
      <PageHeader title="Открытия" sub="Проекты запуска франшизных точек"
        actions={can('opening.manage') && <LinkButton to="/openings/new" variant="primary"><Plus size={16} aria-hidden />Новый проект</LinkButton>} />
      <Chips label="Фильтр" value={filter} onChange={setFilter} options={[{ id: 'active', label: 'Активные' }, { id: 'risk', label: 'С риском даты' }, { id: 'all', label: 'Все' }]} />
      <Card bodyless>
        <DataState query={list} empty={() => (data.length ? null : <EmptyState title="Проектов нет" text={filter === 'risk' ? 'Нет проектов с риском даты.' : 'Создайте проект или дождитесь сделки из CRM.'} />)}>
          {() => (
            <ul className="list">
              {data.map((o) => {
                const g = p(o.id);
                const [label, tone] = st(OPENING_STATUS, o.status);
                const risk = o.status === 'active' && (g?.date_at_risk || (g?.overdue_tasks ?? 0) > 0);
                return (
                  <li key={o.id}>
                    <Link className="list-item" to={`/openings/${o.id}`}>
                      <div className="main-col">
                        <div className="title">{locs.data?.find((l) => l.id === o.location_id)?.name ?? o.city}</div>
                        <div className="meta">
                          <span className="mono">{o.number}</span><span>{partners.data?.find((x) => x.id === o.partner_id)?.name}</span>
                          <span>План: {formatDate(o.planned_open_on, intlLocale())}</span>
                          {g && <span>Задач: {g.done_tasks}/{g.total_tasks}</span>}
                          {o.crm_deal_ref && <span>Сделка {o.crm_deal_ref}</span>}
                        </div>
                      </div>
                      <div className="side">
                        <Badge tone={tone}>{label}</Badge>
                        {risk && <Badge tone="danger">риск даты</Badge>}
                        {(g?.critical_open ?? 0) > 0 && o.status === 'active' && <span className="faint">{g!.critical_open} критич. открыто</span>}
                      </div>
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

export function NewOpeningPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const partners = usePartners();
  const locs = useLocations();
  const [partner, setPartner] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [location, setLocation] = useState('');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [format, setFormat] = useState('');
  const [planned, setPlanned] = useState(addDays(isoDate(), 45));
  const create = useMutation({
    mutationFn: () => openingCommands.create({ partner, location: mode === 'existing' ? location : null, location_name: mode === 'new' ? name : null,
      city: mode === 'new' ? city : null, address: address || null, format: format || null, planned_open: planned, contract: null }),
    onSuccess: (id) => { toast('Проект открытия создан по шаблону'); navigate(`/openings/${id}`); },
  });
  const err = toAppError(create.error);
  const fieldErr = (f: string) => create.error && err.field === f ? err.detail : null;
  const candidates = (locs.data ?? []).filter((l) => l.partner_id === partner && ['planned', 'opening'].includes(l.status));
  function submit(e: FormEvent) { e.preventDefault(); create.mutate(); }
  return (
    <>
      <PageHeader back={{ to: '/openings', label: 'Открытия' }} title="Новый проект открытия" sub="Задачи и сроки создаются по опубликованному шаблону; шаблон фиксируется за проектом" />
      <form onSubmit={submit} className="grid grid-main">
        <Card>
          <Field label="Партнёр" required>
            {(id) => (
              <Select id={id} value={partner} onChange={(e) => setPartner(e.target.value)} required>
                <option value="">Выберите партнёра</option>
                {(partners.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            )}
          </Field>
          <Chips label="Точка" value={mode} onChange={setMode} options={[{ id: 'new', label: 'Новая точка' }, { id: 'existing', label: 'Существующая' }]} />
          {mode === 'existing' ? (
            <Field label="Точка" required hint="Точки партнёра в статусе «планируется» или «открывается»" error={fieldErr('location_id')}>
              {(id) => (
                <Select id={id} value={location} onChange={(e) => setLocation(e.target.value)}>
                  <option value="">Выберите точку</option>
                  {candidates.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
              )}
            </Field>
          ) : (
            <div className="grid grid-2">
              <Field label="Название точки" required error={fieldErr('location')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
              <Field label="Город" required>{(id) => <Input id={id} value={city} onChange={(e) => setCity(e.target.value)} />}</Field>
            </div>
          )}
          <Field label="Адрес" hint="Можно указать позже">{(id) => <Input id={id} value={address} onChange={(e) => setAddress(e.target.value)} />}</Field>
          <div className="grid grid-2">
            <Field label="Формат">{(id) => <Input id={id} placeholder="Островок 2×2 м" value={format} onChange={(e) => setFormat(e.target.value)} />}</Field>
            <Field label="Плановая дата открытия" required error={fieldErr('planned_open_on')}>
              {(id) => <Input id={id} type="date" min={isoDate()} value={planned} onChange={(e) => setPlanned(e.target.value)} />}
            </Field>
          </div>
          <ActionError error={create.error} />
          <div className="form-actions">
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!partner || !planned || (mode === 'new' ? !name || !city : !location)}>Создать проект</Button>
          </div>
        </Card>
      </form>
    </>
  );
}

function StageBlock({ stage, tasks, mySide, roles }: { stage: string; tasks: StepTask[]; mySide: 'partner' | 'company'; roles: ReturnType<typeof useRoles> }) {
  const { t } = useT();
  const done = tasks.every((x) => ['done', 'cancelled'].includes(x.status));
  const blocked = tasks.some((x) => x.status === 'blocked' || (x.is_critical && x.due_at && new Date(x.due_at) < new Date() && !['done', 'cancelled'].includes(x.status)));
  const n = tasks[0]?.stage_order;
  return (
    <details className={`stage${done ? ' done' : blocked ? ' blocked' : ''}`} open={!done}>
      <summary>
        <span className="stage-num" aria-hidden>{done ? <CheckCircle2 size={16} /> : n}</span>
        <span style={{ flex: 1, fontWeight: 650 }}>{stage}</span>
        <span className="faint">{tasks.filter((x) => x.status === 'done').length}/{tasks.length}</span>
      </summary>
      <ul className="list">
        {tasks.map((x) => {
          const [label, tone] = st(TASK_STATUS, x.status);
          const ours = x.side === mySide;
          return (
            <li key={x.id}>
              <Link className="list-item" to={`/tasks/${x.id}`}>
                <div className="main-col">
                  <div className="title">{x.is_gate && <Lock size={14} aria-hidden />} {x.title}</div>
                  <div className="meta">
                    <span>{x.side === 'partner' ? (mySide === 'partner' ? 'Ваш шаг' : 'Шаг партнёра') : roles.name(x.queue_role)}</span>
                    {x.is_critical && <span>обязательное условие</span>}
                    {x.status_reason && ['blocked', 'waiting_external'].includes(x.status) && <span>Мешает: {x.status_reason}</span>}
                  </div>
                </div>
                <div className="side">
                  <Badge tone={tone}>{t(label)}</Badge>
                  {!['done', 'cancelled'].includes(x.status) && <Due at={x.due_at} />}
                  {ours && ['ready', 'in_progress'].includes(x.status) && <span className="faint">нужно действие</span>}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function OpeningPage() {
  const { id = '' } = useParams();
  const { can, isStaff } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const names = useUserNames();
  const roles = useRoles();
  const locs = useLocations();
  const partners = usePartners();
  const project = useQuery({ queryKey: ['opening', id], queryFn: () => getOpening(id) });
  const prog = useQuery({ queryKey: ['opening', id, 'progress'], queryFn: () => getProgress(id) });
  const tasks = useQuery({ queryKey: ['opening', id, 'tasks'], enabled: Boolean(project.data?.instance_id), queryFn: () => steps(project.data!.instance_id) });
  const block = useQuery({ queryKey: ['opening', id, 'blockers'], queryFn: () => blockers(id) });
  const ev = useQuery({ queryKey: ['opening', id, 'events'], queryFn: () => events(id) });
  const nt = useQuery({ queryKey: ['opening', id, 'notes'], enabled: isStaff, queryFn: () => notes(id) });
  const tpl = useQuery({ queryKey: ['opening', id, 'tpl'], enabled: Boolean(project.data?.template_version_id), queryFn: () => templateVersion(project.data!.template_version_id) });
  const [dialog, setDialog] = useState<null | 'date' | 'approve' | 'opened' | 'cancel'>(null);
  const [newDate, setNewDate] = useState('');
  const [reason, setReason] = useState('');
  const [actual, setActual] = useState(isoDate());
  const [note, setNote] = useState('');
  const [changed, setChanged] = useState<{ number: string; title: string; old_due: string | null; new_due: string }[] | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['opening', id] }).then(() => qc.invalidateQueries({ queryKey: ['openings'] }));
  const act = useMutation({
    mutationFn: async () => {
      if (dialog === 'date') { const r = await openingCommands.changeDate(id, newDate, reason); setChanged(r.changed); return 'Плановая дата перенесена'; }
      if (dialog === 'approve') { await openingCommands.approve(id, reason || null); return 'Разрешение на открытие выдано'; }
      if (dialog === 'opened') { await openingCommands.markOpened(id, actual, reason || null); return 'Открытие зафиксировано, запущены задачи стабилизации'; }
      if (dialog === 'cancel') { await openingCommands.cancel(id, reason); return 'Проект отменён; финансам создана задача по обязательствам'; }
      return '';
    },
    onSuccess: (msg) => { toast(msg); setDialog(null); setReason(''); void refresh(); },
  });
  const addNote = useMutation({ mutationFn: () => openingCommands.addNote(id, note), onSuccess: () => { setNote(''); void qc.invalidateQueries({ queryKey: ['opening', id, 'notes'] }); } });

  return (
    <DataState query={project} empty={(p) => (p ? null : <EmptyState title="Проект не найден" />)}>
      {(p) => {
        if (!p) return null;
        const loc = locs.data?.find((l) => l.id === p.location_id);
        const [label, tone] = st(OPENING_STATUS, p.status);
        const g = prog.data;
        const stages = new Map<string, StepTask[]>();
        for (const x of tasks.data ?? []) stages.set(x.stage_title, [...(stages.get(x.stage_title) ?? []), x]);
        const mySide = isStaff ? 'company' : 'partner';
        const myActions = (tasks.data ?? []).filter((x) => x.side === 'partner' && ['ready', 'in_progress'].includes(x.status));
        const companyWaiting = (tasks.data ?? []).filter((x) => x.side === 'company' && ['ready', 'in_progress', 'waiting_external', 'blocked'].includes(x.status));
        const risk = g && (g.date_at_risk || g.overdue_tasks > 0);
        return (
          <>
            <PageHeader back={{ to: '/openings', label: 'Открытия' }}
              title={loc?.name ?? p.city}
              sub={<span className="row"><span className="mono">{p.number}</span><span>{partners.data?.find((x) => x.id === p.partner_id)?.name}</span><Badge tone={tone}>{label}</Badge>{risk && p.status === 'active' && <Badge tone="danger">риск даты</Badge>}</span>}
              actions={can('opening.manage') && (
                <>
                  {['active', 'approved'].includes(p.status) && <Button onClick={() => { setNewDate(p.planned_open_on); setDialog('date'); }}>Перенести дату</Button>}
                  {p.status === 'active' && can('opening.approve') && <Button variant="primary" onClick={() => setDialog('approve')}>Выдать разрешение</Button>}
                  {p.status === 'approved' && <Button variant="primary" onClick={() => setDialog('opened')}>Зафиксировать открытие</Button>}
                  {p.status === 'opened' && <Button onClick={() => { setDialog(null); act.reset(); void openingCommands.complete(id).then(() => { toast('Проект завершён'); void refresh(); }, (e) => toast(toAppError(e).detail, 'danger')); }}>Завершить проект</Button>}
                  {['active', 'approved'].includes(p.status) && <Button variant="danger" onClick={() => setDialog('cancel')}>Отменить</Button>}
                </>
              )}
            />
            {changed && (
              <div style={{ marginBottom: 16 }}>
                <Alert tone="info" title={`Пересчитаны сроки: ${changed.length} задач`} action={<Button size="sm" variant="ghost" onClick={() => setChanged(null)}>Скрыть</Button>}>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {changed.map((c) => <li key={c.number}>{c.title}: {formatDate(c.old_due, intlLocale())} → {formatDate(c.new_due, intlLocale())}</li>)}
                  </ul>
                  <div className="faint">Завершённые задачи и сроки, заданные вручную, не изменялись.</div>
                </Alert>
              </div>
            )}
            <div className="grid grid-main">
              <div className="stack">
                {p.status === 'active' && (
                  <Card title={<h2 className="row">{block.data?.length ? <AlertTriangle size={18} color="var(--danger)" aria-hidden /> : <CheckCircle2 size={18} color="var(--success)" aria-hidden />}Что блокирует открытие</h2>}>
                    {block.data?.length ? (
                      <>
                        <p className="muted">Разрешение на открытие нельзя выдать, пока не выполнены обязательные условия:</p>
                        <ul className="list">
                          {block.data.map((b) => (
                            <li key={b.task_id} className="row between" style={{ padding: '6px 0' }}>
                              <Link to={`/tasks/${b.task_id}`}>{b.title}</Link>
                              <span className="row"><span className="faint">{b.stage_title} · {roles.name(b.queue_role)}</span><Due at={b.due_at} /></span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : <p>Обязательные условия выполнены. Можно выдавать разрешение на открытие.</p>}
                  </Card>
                )}
                {!isStaff && (myActions.length > 0 || companyWaiting.length > 0) && (
                  <div className="grid grid-2">
                    <Card title="Ваши действия">
                      {myActions.length ? myActions.map((x) => <div key={x.id} className="row between" style={{ padding: '4px 0' }}><Link to={`/tasks/${x.id}`}>{x.title}</Link><Due at={x.due_at} /></div>) : <span className="muted">Сейчас ничего не требуется</span>}
                    </Card>
                    <Card title="Ожидаем от компании">
                      {companyWaiting.length ? companyWaiting.slice(0, 6).map((x) => <div key={x.id} className="row between" style={{ padding: '4px 0' }}><span>{x.title}</span><Due at={x.due_at} /></div>) : <span className="muted">Нет открытых шагов компании</span>}
                    </Card>
                  </div>
                )}
                <Card title="Дорожная карта" bodyless>
                  <div className="card-body">
                    <DataState query={tasks}>
                      {() => <div className="stages">{[...stages.entries()].map(([s, xs]) => <StageBlock key={s} stage={s} tasks={xs} mySide={mySide} roles={roles} />)}</div>}
                    </DataState>
                  </div>
                </Card>
              </div>
              <div className="stack">
                <Card title="Проект">
                  <KV items={[
                    ['Плановое открытие', formatDate(p.planned_open_on, intlLocale())],
                    ['Фактическое', p.actual_open_on ? formatDate(p.actual_open_on, intlLocale()) : '—'],
                    ['Город', p.city], ['Адрес', p.address], ['Формат', p.format],
                    ['Менеджер', names(p.manager_id)],
                    ['Шаблон', tpl.data ? `версия ${tpl.data.version}` : '—'],
                    ...(p.crm_deal_ref ? [['Сделка CRM', p.crm_deal_ref] as [string, string]] : []),
                    ...(p.status_reason ? [['Причина', p.status_reason] as [string, string]] : []),
                  ]} />
                  {g && (
                    <div style={{ marginTop: 16 }}>
                      <div className="faint" style={{ marginBottom: 4 }}>Прогресс по задачам — вспомогательный показатель</div>
                      <div className="progress" aria-hidden><span style={{ width: `${g.total_tasks ? Math.round((g.done_tasks / g.total_tasks) * 100) : 0}%` }} /></div>
                      <div className="faint" style={{ marginTop: 4 }}>{g.done_tasks} из {g.total_tasks} · критических открыто: {g.critical_open} · просрочено: {g.overdue_tasks}</div>
                    </div>
                  )}
                </Card>
                {isStaff && (
                  <Card title="Внутренние заметки" actions={<Badge tone="warning">не видны партнёру</Badge>}>
                    {(nt.data ?? []).map((n) => (
                      <div key={n.id} className="message internal" style={{ marginBottom: 8 }}>
                        <div className="who"><span>{names(n.author_id)}</span><span className="faint">{formatDateTime(n.created_at, intlLocale())}</span></div>
                        <div>{n.body}</div>
                      </div>
                    ))}
                    <Field label="Заметка">{(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                    <Button size="sm" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Добавить</Button>
                    <ActionError error={addNote.error} />
                  </Card>
                )}
                <Card title="История проекта">
                  <Timeline items={(ev.data ?? []).map((e) => ({
                    at: e.at, who: names(e.actor_id) ?? 'Система (CRM)',
                    text: <>{EVENT_LABEL[e.action] ?? e.action}{e.action === 'date_changed' && e.detail ? `: ${formatDate(String(e.detail.from), intlLocale())} → ${formatDate(String(e.detail.to), intlLocale())}` : ''}</>,
                    comment: e.comment,
                  }))} />
                </Card>
              </div>
            </div>
            <ConfirmDialog
              open={dialog !== null}
              title={{ date: 'Перенести плановую дату', approve: 'Разрешение на открытие', opened: 'Зафиксировать открытие', cancel: 'Отменить проект открытия' }[dialog ?? 'date']}
              confirmLabel={{ date: 'Перенести', approve: 'Выдать разрешение', opened: 'Зафиксировать', cancel: 'Отменить проект' }[dialog ?? 'date']}
              danger={dialog === 'cancel'}
              busy={act.isPending}
              error={act.error}
              summary={dialog === 'approve' ? [['Точка', loc?.name ?? ''], ['Плановая дата', formatDate(p.planned_open_on, intlLocale())], ['Обязательных условий не выполнено', String(block.data?.length ?? 0)]] : undefined}
              onClose={() => { setDialog(null); act.reset(); }}
              onConfirm={() => act.mutate()}
            >
              {dialog === 'date' && (
                <>
                  <Field label="Новая плановая дата" required>{(fid) => <Input id={fid} type="date" value={newDate} min={isoDate()} onChange={(e) => setNewDate(e.target.value)} />}</Field>
                  <Field label="Причина переноса" required hint="Пересчитаются только незавершённые сроки, заданные относительно даты открытия">{(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                </>
              )}
              {dialog === 'opened' && <Field label="Фактическая дата открытия" required>{(fid) => <Input id={fid} type="date" max={isoDate()} value={actual} onChange={(e) => setActual(e.target.value)} />}</Field>}
              {(dialog === 'cancel' || dialog === 'approve' || dialog === 'opened') && (
                <Field label={dialog === 'cancel' ? 'Причина отмены' : 'Комментарий'} required={dialog === 'cancel'} hint={dialog === 'cancel' ? 'Будущие задачи закроются; документы и обязательства сохранятся' : undefined}>
                  {(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}
                </Field>
              )}
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}
