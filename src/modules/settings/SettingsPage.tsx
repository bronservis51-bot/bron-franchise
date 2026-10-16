// Настройки и интеграции (INT-04/05, CORE-07, AUTH-02, SEC-04): состояние обмена, восстановление, очереди, доступ, аудит.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RefreshCw } from 'lucide-react';
import { command, from, rows } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { config } from '../../platform/config';
import { formatDateTime } from '../../platform/dates';
import { intlLocale } from '../../platform/i18n';
import { ActionError, Badge, Button, Card, ConfirmDialog, DataState, EmptyState, Field, Input, KV, PageHeader, Select, Tabs, Textarea } from '../../ui';
import { OUTBOX_STATUS, st } from '../../ui/status';
import { useToast } from '../../ui/toast';
import { useLocations, usePartners, useRoles, useUserNames } from '../shared/lookups';

type Tab = 'integrations' | 'queues' | 'access' | 'audit' | 'about';

interface Connection { id: string; provider: string; title: string; mode: string; status: string; demo_behavior: string; last_success_at: string | null; last_error: string | null }
interface OutboxRow { id: string; topic: string; aggregate_type: string; aggregate_id: string; status: string; attempts: number; max_attempts: number; next_attempt_at: string; last_error: string | null; created_at: string; updated_at: string }

const TOPIC: Record<string, string> = { 'warehouse.create_order': 'Передача заказа на склад', 'warehouse.cancel_order': 'Отмена заказа на складе', 'drive.export_article': 'Копия статьи в Drive' };
const objLink = (type: string, id: string) => (type === 'sales_order' ? `/orders/${id}` : type === 'article' ? `/kb/articles/${id}` : '#');

function Integrations() {
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const conns = useQuery({ queryKey: ['int', 'conns'], queryFn: () => rows<Connection>(from('integration_connection').select('*').order('provider')) });
  const outbox = useQuery({ queryKey: ['int', 'outbox'], queryFn: () => rows<OutboxRow>(from('outbox').select('*').order('created_at', { ascending: false }).limit(50)) });
  const inbox = useQuery({ queryKey: ['int', 'inbox'], queryFn: () => rows<{ id: string; source: string; event_id: string; event_type: string; status: string; received_at: string; error: string | null }>(from('inbox').select('*').order('received_at', { ascending: false }).limit(20)) });
  const runs = useQuery({ queryKey: ['int', 'runs'], queryFn: () => rows<{ id: string; started_at: string; trigger: string; outbox_done: number; outbox_failed: number; inbox_processed: number; timers_fired: number }>(from('sync_run').select('*').order('started_at', { ascending: false }).limit(10)) });
  const [resolve, setResolve] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['int'] });
  const run = useMutation({
    mutationFn: () => command<{ done: number; failed: number; inbox: number; timers: number }>('run_integration_jobs'),
    onSuccess: (r) => { toast(`Обработано: выполнено ${r.done}, ошибок ${r.failed}, входящих ${r.inbox}, напоминаний ${r.timers}`); void refresh(); },
  });
  const act = useMutation({ mutationFn: async (fn: () => Promise<unknown>) => fn(), onSuccess: () => { void refresh(); setResolve(null); setReason(''); } });

  return (
    <div className="stack">
      <Card title="Подключения" actions={can('integration.operate') && <Button size="sm" variant="primary" loading={run.isPending} onClick={() => run.mutate()}><Play size={15} aria-hidden />Обработать очередь сейчас</Button>}>
        <p className="faint">Очередь обрабатывается автоматически; кнопка запускает обработку сразу.</p>
        <DataState query={conns}>
          {(cs) => (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Система</th><th>Состояние</th><th>Последний успех</th></tr></thead>
              <tbody>{cs.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.title}</strong>{c.last_error && c.status !== 'ok' && <div className="faint">{c.last_error}</div>}</td>
                  <td><Badge tone={c.status === 'ok' ? 'success' : c.status === 'degraded' ? 'warning' : 'danger'}>{{ ok: 'работает', degraded: 'сбои', down: 'недоступно', disabled: 'отключено' }[c.status]}</Badge></td>
                  <td>{formatDateTime(c.last_success_at, intlLocale())}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </DataState>
        <ActionError error={run.error ?? act.error} />
      </Card>
      <Card title="Исходящие команды" actions={<Button size="sm" variant="ghost" onClick={() => void refresh()}><RefreshCw size={15} aria-hidden />Обновить</Button>} bodyless>
        <DataState query={outbox} empty={(d) => (d.length ? null : <EmptyState title="Очередь пуста" />)}>
          {(d) => (
            <ul className="list">{d.map((o) => {
              const [label, tone] = st(OUTBOX_STATUS, o.status);
              return (
                <li key={o.id} className="list-item">
                  <div className="main-col">
                    <div className="title">{TOPIC[o.topic] ?? o.topic}</div>
                    <div className="meta"><Link to={objLink(o.aggregate_type, o.aggregate_id)}>бизнес-объект</Link><span>попыток {o.attempts}/{o.max_attempts}</span><span>создано {formatDateTime(o.created_at, intlLocale())}</span>{['failed', 'unknown'].includes(o.status) && <span>следующая попытка {formatDateTime(o.next_attempt_at, intlLocale())}</span>}</div>
                    {o.last_error && o.status !== 'done' && <div className="faint" style={{ color: 'var(--danger)' }}>{o.last_error}</div>}
                  </div>
                  <div className="side">
                    <Badge tone={tone}>{label}</Badge>
                    {can('integration.operate') && ['failed', 'dead', 'unknown'].includes(o.status) && <span className="row">
                      <Button size="sm" onClick={() => act.mutate(() => command('outbox_retry', { outbox: o.id }))}>{o.status === 'unknown' ? 'Сверить' : 'Повторить'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setResolve(o.id)}>Решено вручную</Button>
                    </span>}
                  </div>
                </li>
              );
            })}</ul>
          )}
        </DataState>
      </Card>
      <div className="grid grid-2">
        <Card title="Входящие события (inbox)" bodyless>
          <ul className="list">{(inbox.data ?? []).map((e) => (
            <li key={e.id} className="list-item"><div className="main-col"><div className="title">{e.source}: {e.event_type}</div><div className="meta mono">{e.event_id}</div>{e.error && <div className="faint">{e.error}</div>}</div>
              <div className="side"><Badge tone={e.status === 'processed' ? 'success' : e.status === 'failed' ? 'danger' : 'neutral'}>{{ received: 'получено', processed: 'обработано', duplicate: 'дубль', failed: 'ошибка', ignored: 'пропущено' }[e.status]}</Badge><span className="faint">{formatDateTime(e.received_at, intlLocale())}</span></div></li>
          ))}</ul>
        </Card>
        <Card title="Запуски обработки" bodyless>
          <ul className="list">{(runs.data ?? []).map((r) => (
            <li key={r.id} className="list-item"><div className="main-col"><div className="title">{r.trigger === 'cron' ? 'По расписанию' : 'Вручную'}</div><div className="meta">выполнено {r.outbox_done} · ошибок {r.outbox_failed} · входящих {r.inbox_processed} · напоминаний {r.timers_fired}</div></div><div className="side faint">{formatDateTime(r.started_at, intlLocale())}</div></li>
          ))}</ul>
        </Card>
      </div>
      <ConfirmDialog open={resolve !== null} title="Отметить решённым вручную" confirmLabel="Подтвердить" busy={act.isPending} error={act.error}
        onClose={() => setResolve(null)} onConfirm={() => act.mutate(() => command('outbox_resolve_manually', { outbox: resolve, reason }))}>
        <p className="muted">Используйте, если документ создан во внешней системе вручную или операция больше не нужна. Действие попадёт в аудит.</p>
        <Field label="Что сделано" required>{(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </div>
  );
}

function Queues() {
  const q = useQuery({ queryKey: ['queue-health'], queryFn: () => command<{ queue_role: string; queue_name: string; partner_name: string | null; location_name: string | null; open_items: number; members: number; backup_members: number }[]>('queue_health') });
  return (
    <Card title="Очереди и исполнители" bodyless>
      <div className="card-body faint">Процесс без доступного исполнителя и резерва — назначьте исполнителя в разделе «Доступ».</div>
      <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Открытой работы нет" />)}>
        {(d) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Очередь</th><th>Область</th><th className="r">Открыто</th><th className="r">Исполнителей</th><th className="r">Резерв</th><th>Состояние</th></tr></thead>
            <tbody>{d.map((r, i) => (
              <tr key={i}><td>{r.queue_name}</td><td>{r.location_name ?? r.partner_name ?? 'компания'}</td><td className="r">{r.open_items}</td><td className="r">{r.members}</td><td className="r">{r.backup_members}</td>
                <td>{r.members > 0 ? <Badge tone="success">есть исполнители</Badge> : r.backup_members > 0 ? <Badge tone="warning">только резерв</Badge> : <Badge tone="danger">нет исполнителей</Badge>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </DataState>
    </Card>
  );
}

interface AdminUser { id: string; full_name: string; email: string; status: string; is_demo: boolean; assignments: { id: string; role: string; scope_type: string; scope_id: string | null; valid_to: string | null }[] }

function Access() {
  const roles = useRoles();
  const partners = usePartners();
  const locs = useLocations();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => command<AdminUser[]>('admin_users') });
  const [assignFor, setAssignFor] = useState<AdminUser | null>(null);
  const [role, setRole] = useState('');
  const [scopeType, setScopeType] = useState('company');
  const [scopeId, setScopeId] = useState('');
  const [validTo, setValidTo] = useState('');
  const [revoke, setRevoke] = useState<{ id: string; label: string } | null>(null);
  const [offboard, setOffboard] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState('');
  const scopeName = (t: string, id: string | null) => t === 'company' ? 'вся компания' : t === 'partner' ? partners.data?.find((p) => p.id === id)?.name : t === 'location' ? locs.data?.find((l) => l.id === id)?.name : 'направление';
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { toast('Изменение доступа сохранено и записано в аудит'); setAssignFor(null); setRevoke(null); setOffboard(null); setReason(''); void qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });
  return (
    <>
      <Card title="Пользователи и назначения" bodyless>
        <div className="card-body faint">Нельзя менять собственные полномочия и выдавать разрешения, которых нет у вас. Отзыв сразу закрывает доступ к данным и возвращает задачи в очередь.</div>
        <DataState query={users}>
          {(us) => (
            <ul className="list">{us.map((u) => (
              <li key={u.id} className="list-item">
                <div className="main-col">
                  <div className="title">{u.full_name} {u.status !== 'active' && <Badge tone="neutral">{u.status === 'offboarded' ? 'отключён' : u.status}</Badge>}</div>
                  <div className="meta"><span>{u.email}</span></div>
                  <div className="row" style={{ marginTop: 6 }}>
                    {u.assignments.map((a) => (
                      <span key={a.id} className="badge tone-neutral">{roles.name(a.role)} · {scopeName(a.scope_type, a.scope_id)}{a.valid_to ? ` · до ${formatDateTime(a.valid_to, intlLocale())}` : ''}
                        <button type="button" className="btn-ghost" style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--danger)', padding: '0 0 0 4px' }} aria-label={`Отозвать ${roles.name(a.role)}`} onClick={() => setRevoke({ id: a.id, label: `${roles.name(a.role)} — ${u.full_name}` })}>×</button>
                      </span>
                    ))}
                  </div>
                </div>
                {u.status === 'active' && <div className="side"><Button size="sm" onClick={() => { setAssignFor(u); setRole(''); }}>Назначить роль</Button><Button size="sm" variant="ghost" onClick={() => setOffboard(u)}>Отключить</Button></div>}
              </li>
            ))}</ul>
          )}
        </DataState>
        <ActionError error={act.error} />
      </Card>
      <ConfirmDialog open={assignFor !== null} title={`Назначить роль: ${assignFor?.full_name ?? ''}`} confirmLabel="Назначить" busy={act.isPending} error={act.error}
        onClose={() => { setAssignFor(null); act.reset(); }}
        onConfirm={() => act.mutate(() => command('assign_role', { user: assignFor!.id, role, scope_type: scopeType, scope_id: scopeType === 'company' ? null : scopeId, valid_to: validTo ? new Date(validTo).toISOString() : null, delegated_from: null }))}>
        <Field label="Роль" required>{(fid) => <Select id={fid} value={role} onChange={(e) => setRole(e.target.value)}><option value="">Выберите</option>{roles.list.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select>}</Field>
        <Field label="Область" required>{(fid) => <Select id={fid} value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeId(''); }}><option value="company">Вся компания</option><option value="partner">Партнёр</option><option value="location">Точка</option></Select>}</Field>
        {scopeType === 'partner' && <Field label="Партнёр" required>{(fid) => <Select id={fid} value={scopeId} onChange={(e) => setScopeId(e.target.value)}><option value="">Выберите</option>{(partners.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}</Field>}
        {scopeType === 'location' && <Field label="Точка" required>{(fid) => <Select id={fid} value={scopeId} onChange={(e) => setScopeId(e.target.value)}><option value="">Выберите</option>{(locs.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>}
        <Field label="Действует до" hint="Для временной подмены или резерва">{(fid) => <Input id={fid} type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} />}</Field>
      </ConfirmDialog>
      <ConfirmDialog open={revoke !== null} title="Отозвать назначение" confirmLabel="Отозвать" danger busy={act.isPending} error={act.error}
        summary={revoke ? [['Назначение', revoke.label]] : undefined} onClose={() => setRevoke(null)} onConfirm={() => act.mutate(() => command('revoke_assignment', { assignment: revoke!.id, reason }))}>
        <Field label="Причина" required>{(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
      <ConfirmDialog open={offboard !== null} title={`Отключить пользователя: ${offboard?.full_name ?? ''}`} confirmLabel="Отключить" danger busy={act.isPending} error={act.error}
        onClose={() => setOffboard(null)} onConfirm={() => act.mutate(() => command('offboard_user', { user: offboard!.id, reason }))}>
        <p className="muted">Все назначения будут отозваны, незавершённые задачи вернутся в очереди ролей. История и авторство сохранятся. Активную сессию завершает администратор Supabase (runbook «Компрометация аккаунта»).</p>
        <Field label="Причина" required>{(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </>
  );
}

function Audit() {
  const names = useUserNames();
  const q = useQuery({ queryKey: ['audit'], queryFn: () => rows<{ id: number; at: string; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; diff: unknown; reason: string | null; correlation_id: string | null }>(from('audit_event').select('*').order('at', { ascending: false }).limit(100)) });
  return (
    <Card title="Журнал аудита" bodyless>
      <div className="card-body faint">Изменения доступа, договоров, отчётов, начислений, оплат, шаблонов, публикаций и обмена. Только добавление записей.</div>
      <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Записей нет" />)}>
        {(d) => (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Детали</th></tr></thead>
            <tbody>{d.map((e) => (
              <tr key={e.id}><td>{formatDateTime(e.at, intlLocale())}</td><td>{names(e.actor_id) ?? 'система'}</td><td className="mono">{e.action}</td><td>{e.entity_type}</td>
                <td><span className="faint mono" style={{ fontSize: 12 }}>{e.diff ? JSON.stringify(e.diff).slice(0, 140) : ''}</span>{e.reason && <div>{e.reason}</div>}{e.correlation_id && <div className="faint mono">req {e.correlation_id.slice(0, 8)}</div>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </DataState>
    </Card>
  );
}

function About() {
  const { me } = useSession();
  return (
    <Card title="О системе">
      <KV items={[
        ['Версия', config.version],
        ['Разделение обязанностей', me?.operator?.sod_policy === 'strict' ? 'строгое' : 'разрешено с журналом'],
      ]} />
    </Card>
  );
}

export function SettingsPage() {
  const { tab: param } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const tabs = [
    ...(can('integration.operate') ? [{ id: 'integrations' as Tab, label: 'Интеграции' }] : []),
    ...(can('metrics.read') || can('access.manage') ? [{ id: 'queues' as Tab, label: 'Очереди' }] : []),
    ...(can('access.manage') ? [{ id: 'access' as Tab, label: 'Доступ' }] : []),
    ...(can('audit.read') ? [{ id: 'audit' as Tab, label: 'Аудит' }] : []),
    { id: 'about' as Tab, label: 'О системе' },
  ];
  const tab = (tabs.find((t) => t.id === param)?.id ?? tabs[0].id) as Tab;
  return (
    <>
      <PageHeader title="Настройки" />
      <Tabs label="Разделы настроек" value={tab} onChange={(v) => navigate(`/settings/${v}`)} tabs={tabs} />
      {tab === 'integrations' && <Integrations />}
      {tab === 'queues' && <Queues />}
      {tab === 'access' && <Access />}
      {tab === 'audit' && <Audit />}
      {tab === 'about' && <About />}
    </>
  );
}
