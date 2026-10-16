// Уведомления (NOTIF-01, UX-07): ведут к объекту; «прочитано» не означает «выполнено».
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command, from, rows } from '../../platform/backend';
import { formatDateTime } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { Badge, Button, Card, DataState, EmptyState, PageHeader } from '../../ui';

interface Notification { id: string; kind: string; title: string; body: string | null; link: string | null; critical: boolean; created_at: string; read_at: string | null }

export function NotificationsPage() {
  const { t } = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => rows<Notification>(from('notification').select('*').order('created_at', { ascending: false }).limit(100)) });
  const mark = useMutation({
    mutationFn: (ids: string[]) => command<number>('notification_mark_read', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = (q.data ?? []).filter((n) => !n.read_at);
  return (
    <>
      <PageHeader title={t('Уведомления')} sub="Прочтение уведомления не завершает задачу — работа остаётся в «Сегодня»"
        actions={unread.length > 0 && <Button onClick={() => mark.mutate(unread.map((n) => n.id))} loading={mark.isPending}>Отметить все прочитанными</Button>} />
      <Card bodyless>
        <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Уведомлений нет" />)}>
          {(d) => (
            <ul className="list">
              {d.map((n) => (
                <li key={n.id}>
                  <Link className="list-item" to={n.link ?? '/'} onClick={() => !n.read_at && mark.mutate([n.id])} style={n.read_at ? { opacity: 0.75 } : undefined}>
                    <div className="main-col">
                      <div className="title">{!n.read_at && <span className="sr-only">Новое: </span>}{n.title}</div>
                      {n.body && <div className="meta">{n.body}</div>}
                    </div>
                    <div className="side">
                      {n.critical && <Badge tone="danger">важно</Badge>}
                      {!n.read_at && <Badge tone="info">новое</Badge>}
                      <span className="faint">{formatDateTime(n.created_at, intlLocale())}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </Card>
    </>
  );
}
