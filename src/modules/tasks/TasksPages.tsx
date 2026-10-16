import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useScopeFilter, useSession } from '../../platform/session';
import { useT } from '../../platform/i18n';
import { ActionError, Alert, Badge, Button, Card, Chips, ConfirmDialog, DataState, Due, EmptyState, Field, KV, PageHeader, Textarea, Timeline } from '../../ui';
import { st, TASK_STATUS } from '../../ui/status';
import { FileAttach, FileList } from '../../ui/files';
import { useToast } from '../../ui/toast';
import { useLocations, useRoles, useUserNames } from '../shared/lookups';
import { ACTION_LABEL, articleBySlug, getTask, listTasks, taskCommands, taskDeps, taskEvents, type TaskFilter } from './api';

export function TasksPage() {
  const { me, can } = useSession();
  const { partnerId, locationId } = useScopeFilter();
  const { t } = useT();
  const [filter, setFilter] = useState<TaskFilter>('mine');
  const roles = useRoles();
  const locs = useLocations();
  const q = useQuery({ queryKey: ['tasks', filter, partnerId, locationId], queryFn: () => listTasks(filter, me!.user.id, partnerId, locationId) });
  const locName = (id: string | null) => locs.data?.find((l) => l.id === id)?.name;
  return (
    <>
      <PageHeader title={t('Моя работа')} sub="Личные задачи и очереди ваших ролей" />
      <Chips label="Фильтр задач" value={filter} onChange={setFilter} options={[
        { id: 'mine', label: 'Мои' }, { id: 'queue', label: 'Очередь' },
        ...(can('task.manage') ? [{ id: 'review' as const, label: 'На проверке' }] : []),
        { id: 'all', label: 'Все открытые' }, { id: 'done', label: 'Завершённые' },
      ]} />
      <Card bodyless>
        <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Задач нет" text={filter === 'queue' ? 'В очередях ваших ролей нет свободных задач.' : 'Здесь появятся задачи с назначенным вам исполнением.'} />)}>
          {(d) => (
            <ul className="list">
              {d.map((x) => {
                const [label, tone] = st(TASK_STATUS, x.status);
                return (
                  <li key={x.id}>
                    <Link className="list-item" to={`/tasks/${x.id}`}>
                      <div className="main-col">
                        <div className="title">{x.is_critical && <Badge tone="danger">критично</Badge>} {x.title}</div>
                        <div className="meta"><span className="mono">{x.number}</span><span>{roles.name(x.queue_role)}</span>{locName(x.location_id) && <span>{locName(x.location_id)}</span>}</div>
                      </div>
                      <div className="side"><Badge tone={tone}>{t(label)}</Badge><Due at={x.due_at} done={['done', 'cancelled'].includes(x.status)} /></div>
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

function subjectLink(type: string | null, id: string | null): [string, string] | null {
  if (!type || !id) return null;
  const map: Record<string, [string, string]> = {
    opening_project: [`/openings/${id}`, 'Проект открытия'],
    sales_order: [`/orders/${id}`, 'Заказ'],
    article: [`/kb/articles/${id}`, 'Статья'],
    revenue_report: [`/royalties/reports/${id}`, 'Отчёт'],
    contract: ['/royalties', 'Договор и отчётность'],
    payment: [`/royalties/payments/${id}`, 'Оплата'],
  };
  return map[type] ?? null;
}

export function TaskPage() {
  const { id = '' } = useParams();
  const { me, can, isStaff } = useSession();
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const names = useUserNames();
  const roles = useRoles();
  const locs = useLocations();
  const task = useQuery({ queryKey: ['task', id], queryFn: () => getTask(id) });
  const events = useQuery({ queryKey: ['task', id, 'events'], queryFn: () => taskEvents(id) });
  const deps = useQuery({ queryKey: ['task', id, 'deps'], queryFn: () => taskDeps(id) });
  const article = useQuery({ queryKey: ['article-slug', task.data?.kb_article_slug], enabled: Boolean(task.data?.kb_article_slug), queryFn: () => articleBySlug(task.data!.kb_article_slug!) });
  const [result, setResult] = useState('');
  const [comment, setComment] = useState('');
  const [reasonFor, setReasonFor] = useState<null | 'waiting_external' | 'blocked' | 'return' | 'reopen' | 'cancel'>(null);
  const [reason, setReason] = useState('');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['task', id] });
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['today'] });
  };
  const run = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { refresh(); setReasonFor(null); setReason(''); },
  });

  return (
    <DataState query={task} empty={(d) => (d ? null : <EmptyState title="Задача не найдена" text="Возможно, у вас нет к ней доступа." />)}>
      {(x) => {
        if (!x) return null;
        const [label, tone] = st(TASK_STATUS, x.status);
        const mine = x.assignee_id === me?.user.id;
        const open = !['done', 'cancelled'].includes(x.status);
        const subj = subjectLink(x.subject_type, x.subject_id);
        const loc = locs.data?.find((l) => l.id === x.location_id);
        const isReviewer = x.status === 'in_review' && can('task.manage') && !mine;
        return (
          <>
            <PageHeader
              back={{ to: '/tasks', label: 'Моя работа' }}
              title={x.title}
              sub={<span className="row"><span className="mono">{x.number}</span><Badge tone={tone}>{t(label)}</Badge>{x.is_critical && <Badge tone="danger">критическая</Badge>}</span>}
            />
            <div className="grid grid-main">
              <div className="stack">
                {x.status_reason && ['blocked', 'waiting_external'].includes(x.status) && (
                  <Alert tone="warning" title="Что мешает">{x.status_reason}</Alert>
                )}
                <Card title="Что сделать">
                  {x.description ? <p>{x.description}</p> : <p className="muted">Описание шага — в названии задачи и связанной инструкции.</p>}
                  {article.data && <p><Link to={`/kb/articles/${article.data.id}`}>Открыть инструкцию к шагу</Link></p>}
                  {x.requires_evidence && <Alert tone="info">Для завершения нужно приложить доказательство (фото, скан, документ).</Alert>}
                  {x.result && <><h3 style={{ marginTop: 16 }}>Результат</h3><p>{x.result}</p></>}

                  {open && (
                    <div style={{ marginTop: 16 }}>
                      {(x.status === 'ready' || (x.status === 'in_progress' && !x.assignee_id)) && !mine && (
                        <Button variant="primary" loading={run.isPending} onClick={() => run.mutate(() => taskCommands.take(x.id, x.revision))}>{t('Взять в работу')}</Button>
                      )}
                      {(mine || isReviewer || (x.status === 'ready' && can('task.work'))) && ['in_progress', 'ready', 'in_review'].includes(x.status) && (mine || isReviewer) && (
                        <>
                          <Field label={isReviewer ? 'Заключение проверки' : 'Результат'} required hint="Комментарий сам по себе не завершает задачу: опишите, что сделано.">
                            {(fid) => <Textarea id={fid} value={result} onChange={(e) => setResult(e.target.value)} rows={3} />}
                          </Field>
                          <div className="row">
                            <Button variant="primary" loading={run.isPending} disabled={!result.trim() && !x.result}
                              onClick={() => run.mutate(async () => {
                                const r = await taskCommands.complete(x.id, result.trim() || x.result || '', x.revision);
                                toast(r.status === 'in_review' ? 'Задача отправлена на проверку' : 'Задача завершена');
                                setResult('');
                              })}>
                              {x.requires_review && !isReviewer ? 'Отправить на проверку' : t('Завершить')}
                            </Button>
                            {mine && x.status === 'in_progress' && <Button onClick={() => setReasonFor('waiting_external')}>Ждём ответа</Button>}
                            {mine && x.status === 'in_progress' && <Button onClick={() => setReasonFor('blocked')}>Заблокирована</Button>}
                            {isReviewer && <Button onClick={() => setReasonFor('return')}>Вернуть исполнителю</Button>}
                            {mine && <Button variant="ghost" onClick={() => run.mutate(() => taskCommands.returnToQueue(x.id, x.revision))}>Вернуть в очередь</Button>}
                          </div>
                        </>
                      )}
                      {mine && ['waiting_external', 'blocked'].includes(x.status) && (
                        <Button variant="primary" onClick={() => run.mutate(() => taskCommands.transition(x.id, 'in_progress', null, x.revision))}>Продолжить работу</Button>
                      )}
                    </div>
                  )}
                  {!open && can('task.manage') && x.status === 'done' && (
                    <div style={{ marginTop: 12 }}><Button onClick={() => setReasonFor('reopen')}>Переоткрыть</Button></div>
                  )}
                  <ActionError error={run.error} />
                </Card>

                <Card title="Доказательства и файлы">
                  <FileList entityType="task" entityId={x.id} />
                  {open && (mine || can('task.manage')) && (
                    <div style={{ marginTop: 12 }}>
                      <FileAttach entityType="task" entityId={x.id} prepare={(f) => taskCommands.attachPrepare(x.id, f)} />
                    </div>
                  )}
                </Card>

                <Card title="История">
                  <Timeline items={(events.data ?? []).map((e) => ({
                    at: e.at, who: names(e.actor_id) ?? 'Система',
                    text: <>{ACTION_LABEL[e.action] ?? e.action}{e.to_status && e.from_status !== e.to_status ? <> → {t(st(TASK_STATUS, e.to_status)[0])}</> : null}</>,
                    comment: e.comment,
                  }))} />
                  <Field label="Комментарий">
                    {(fid) => <Textarea id={fid} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}
                  </Field>
                  <Button size="sm" disabled={!comment.trim()} loading={run.isPending}
                    onClick={() => run.mutate(async () => { await taskCommands.comment(x.id, comment.trim()); setComment(''); })}>Добавить комментарий</Button>
                </Card>
              </div>
              <div className="stack">
                <Card title="Карточка">
                  <KV items={[
                    ['Срок', <Due key="d" at={x.due_at} done={!open} timeZone={loc?.timezone} />],
                    ['Исполнитель', names(x.assignee_id) ?? <span className="muted">в очереди</span>],
                    ['Очередь', roles.name(x.queue_role)],
                    ['Резерв', x.backup_role ? roles.name(x.backup_role) : '—'],
                    ['Точка', loc?.name ?? '—'],
                    ['Этап', x.stage_title ?? '—'],
                    ['Чья сторона', x.side === 'partner' ? 'партнёр' : 'компания'],
                    ...(subj ? [['Объект', <Link key="s" to={subj[0]}>{subj[1]}</Link>] as [string, React.ReactNode]] : []),
                    ...(isStaff ? [['Видна партнёру', x.partner_visible ? 'да' : 'нет'] as [string, React.ReactNode]] : []),
                  ]} />
                </Card>
                {Boolean(deps.data?.length) && (
                  <Card title="Зависит от" bodyless>
                    <ul className="list">
                      {deps.data!.map((d) => (
                        <li key={d.id}><Link className="list-item" to={`/tasks/${d.id}`}><div className="main-col"><div className="title">{d.title}</div></div><div className="side"><Badge tone={st(TASK_STATUS, d.status)[1]}>{t(st(TASK_STATUS, d.status)[0])}</Badge></div></Link></li>
                      ))}
                    </ul>
                  </Card>
                )}
                {open && can('task.manage') && <Button variant="danger" onClick={() => setReasonFor('cancel')}>Отменить задачу</Button>}
              </div>
            </div>
            <ConfirmDialog
              open={reasonFor !== null}
              title={{ waiting_external: 'Ждём внешнего ответа', blocked: 'Задача заблокирована', return: 'Вернуть исполнителю', reopen: 'Переоткрыть задачу', cancel: 'Отменить задачу' }[reasonFor ?? 'blocked']}
              confirmLabel="Подтвердить"
              danger={reasonFor === 'cancel'}
              busy={run.isPending}
              error={run.error}
              onClose={() => { setReasonFor(null); run.reset(); }}
              onConfirm={() => run.mutate(() => {
                if (reasonFor === 'reopen') return taskCommands.reopen(x.id, reason);
                if (reasonFor === 'cancel') return taskCommands.cancel(x.id, reason);
                return taskCommands.transition(x.id, reasonFor === 'return' ? 'in_progress' : reasonFor!, reason, x.revision);
              })}
            >
              <Field label="Причина" required hint="Её увидят все участники процесса">
                {(fid) => <Textarea id={fid} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}
