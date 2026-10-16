// «Моя должность»: роль сотрудника и её должностная инструкция (статья базы знаний, привязанная к роли).
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileText, IdCard } from 'lucide-react';
import { command } from '../../platform/backend';
import { formatDate } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { DataState, PageHeader } from '../../ui';

interface MyRole { code: string; name: string; description: string | null; docs: { id: string; title: string; summary: string | null; published_at: string; acknowledged: boolean }[] }

export function MyRolePage() {
  const { t } = useT();
  const q = useQuery({ queryKey: ['my-role'], queryFn: () => command<MyRole[]>('my_role') });
  return (
    <div className="lead-page">
      <PageHeader title={t('Моя должность')} />
      <DataState query={q}>
        {(roles) => (
          <div className="stack">
            {roles.map((r) => (
              <section key={r.code} className="role-block">
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <span className="icon-tile dark"><IdCard size={18} /></span>
                  <div><h2 style={{ margin: 0, fontSize: 20 }}>{t(r.name)}</h2>{r.description && <div className="faint">{t(r.description)}</div>}</div>
                </div>
                {r.docs.length ? r.docs.map((d) => (
                  <Link key={d.id} to={`/kb/articles/${d.id}`} className="todo-item" style={{ marginTop: 12 }}>
                    <span className="todo-icon"><FileText size={18} /></span>
                    <span className="todo-main"><span className="todo-title">{t('Должностная инструкция')}: {d.title}</span>
                      <span className="todo-meta">{d.summary ?? `${t('редакция от')} ${formatDate(d.published_at, intlLocale())}`}</span></span>
                    <span className="todo-side">{d.acknowledged ? <span className="ok"><CheckCircle2 size={16} aria-hidden /> {t('ознакомлен')}</span> : <span className="due-late">{t('прочитать')}</span>}</span>
                  </Link>
                )) : <p className="faint" style={{ margin: '12px 0 0' }}>{t('Должностная инструкция для этой должности пока не загружена.')}</p>}
              </section>
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}
