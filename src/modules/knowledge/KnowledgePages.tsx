// База знаний и обучение (KB-01…19): поиск без утечки, неизменные опубликованные редакции, ознакомления по версии.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, Edit3, Eye, FilePlus, Search, ThumbsDown, ThumbsUp, Upload } from 'lucide-react';
import { useSession } from '../../platform/session';
import { toAppError } from '../../platform/backend';
import { formatDate, formatDateTime } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { ActionError, Alert, Badge, Button, Card, Checkbox, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, KV, LinkButton, NoResults,
  PageHeader, Select, Tabs, Textarea } from '../../ui';
import { ARTICLE_STATUS, EXPORT_STATUS, st } from '../../ui/status';
import { headings, Markdown } from '../../ui/markdown';
import { useToast } from '../../ui/toast';
import { useRoles, useUserNames } from '../shared/lookups';
import { allAcks, articles, bindings, getArticle, getRevision, kbCommands, myAck, myAcks, revisionsOf, search, searchLog, sections, sourceLink, TYPE_LABEL, type ArticleRow } from './api';

function Snippet({ html }: { html: string }) {
  // Подсветка от сервера приходит как «…»; превращаем в <mark> без вставки HTML
  const parts = html.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith('«') && p.endsWith('»') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

function download(name: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function KbHomePage() {
  const { can } = useSession();
  const { t } = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const editor = can('kb.edit') || can('kb.publish');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [drafts, setDrafts] = useState(false);
  const [filter, setFilter] = useState<'all' | 'drafts' | 'review'>(params.get('status') === 'needs_review' ? 'review' : 'all');
  const [creating, setCreating] = useState(false);
  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  useEffect(() => { setParams(debounced ? { q: debounced } : {}, { replace: true }); }, [debounced, setParams]);
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections, staleTime: 5 * 60_000 });
  const arts = useQuery({ queryKey: ['kb', 'articles'], queryFn: articles });
  const results = useQuery({ queryKey: ['kb', 'search', debounced, drafts], enabled: debounced.length >= 2, queryFn: () => search(debounced, drafts) });
  const zero = useQuery({ queryKey: ['kb', 'zero'], enabled: editor, queryFn: searchLog });
  const exp = useMutation({
    mutationFn: kbCommands.exportAll,
    onSuccess: (data) => {
      download(`baza-znaniy-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
      const md = ((data.articles as { slug: string; revisions?: { title: string; body: string; rev_no: number; status: string }[] }[]) ?? [])
        .map((a) => { const r = a.revisions?.find((x) => x.status === 'published') ?? a.revisions?.[a.revisions.length - 1]; return r ? `# ${r.title}\n\n<!-- slug: ${a.slug}, редакция ${r.rev_no} -->\n\n${r.body}` : ''; })
        .filter(Boolean).join('\n\n---\n\n');
      download(`baza-znaniy-${new Date().toISOString().slice(0, 10)}.md`, md, 'text/markdown');
      toast('Экспорт сохранён на устройство: JSON (полный) и Markdown (читаемый)');
    },
  });
  const imp = useMutation({
    mutationFn: async (file: File) => kbCommands.importAll(JSON.parse(await file.text())),
    onSuccess: (r) => toast(`Импортировано статей: ${r.imported}, пропущено существующих: ${r.skipped}`),
  });
  const importInput = useRef<HTMLInputElement>(null);

  const list = (arts.data ?? []).filter((a) => filter === 'all' ? ['published', 'needs_review'].includes(a.status) || !editor
    : filter === 'drafts' ? a.status === 'draft' : a.status === 'needs_review' || a.status === 'suspended' || (a.review_due !== null && a.review_due < new Date().toISOString().slice(0, 10)));

  return (
    <>
      <PageHeader title={t('База знаний')} sub="Инструкции, регламенты и ответы — актуальные опубликованные версии"
        actions={editor && (
          <>
            {can('kb.edit') && <Button variant="primary" onClick={() => setCreating(true)}><FilePlus size={16} aria-hidden />Новая статья</Button>}
            <Button loading={exp.isPending} onClick={() => exp.mutate()}><Download size={16} aria-hidden />Экспорт</Button>
            {can('kb.publish') && <><Button onClick={() => importInput.current?.click()} loading={imp.isPending}><Upload size={16} aria-hidden />Восстановить</Button>
              <input ref={importInput} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) imp.mutate(f); e.target.value = ''; }} /></>}
          </>
        )} />
      <ActionError error={exp.error ?? imp.error} />
      <div className="field" style={{ maxWidth: 640 }}>
        <label htmlFor="kb-q" className="sr-only">{t('Найти инструкцию')}</label>
        <div style={{ position: 'relative' }}>
          <Search size={18} aria-hidden style={{ position: 'absolute', left: 12, top: 13, color: 'var(--text-3)' }} />
          <Input id="kb-q" type="search" autoFocus placeholder="Например: пузыри после оклейки, лекало, сдать отчёт" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 38 }} />
        </div>
        {editor && <Checkbox label="Искать также в черновиках и архиве" checked={drafts} onChange={setDrafts} />}
      </div>
      {debounced.length >= 2 ? (
        <Card title={`Результаты: «${debounced}»`} bodyless>
          <DataState query={results} empty={(d) => (d.length ? null : (
            <NoResults query={debounced} action={can('ticket.create') && <LinkButton to={`/support/new?q=${encodeURIComponent(debounced)}`}>Задать вопрос в поддержку</LinkButton>} />
          ))}>
            {(d) => (
              <ul className="list">
                {d.map((h) => (
                  <li key={h.revision_id}>
                    <Link className="list-item" to={`/kb/articles/${h.article_id}`}>
                      <div className="main-col">
                        <div className="title">{h.title}</div>
                        <div className="muted" style={{ fontSize: 'var(--fs-s)', marginTop: 2 }}><Snippet html={h.snippet} /></div>
                        <div className="meta"><span>{TYPE_LABEL[h.type] ?? h.type}</span><span>{h.section_title}</span><span>редакция {h.rev_no}</span>{h.published_at && <span>от {formatDate(h.published_at, intlLocale())}</span>}</div>
                      </div>
                      <div className="side">{h.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, h.status)[1]}>{st(ARTICLE_STATUS, h.status)[0]}</Badge>}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </Card>
      ) : (
        <>
          {editor && <Chips label="Статьи" value={filter} onChange={setFilter} options={[{ id: 'all', label: 'Опубликованные' }, { id: 'drafts', label: 'Черновики' }, { id: 'review', label: 'Требуют пересмотра' }]} />}
          <DataState query={secs}>
            {(ss) => (
              <div className="grid grid-2">
                {ss.map((s) => {
                  const inSec = list.filter((a) => a.section_id === s.id);
                  if (!inSec.length && !editor) return null;
                  return (
                    <Card key={s.id} title={s.title} bodyless>
                      {inSec.length ? (
                        <ul className="list">
                          {inSec.map((a) => (
                            <li key={a.id}>
                              <Link className="list-item" to={`/kb/articles/${a.id}`}>
                                <div className="main-col"><div className="title">{a.published?.title ?? 'Черновик без публикации'}</div><div className="meta"><span>{TYPE_LABEL[a.type]}</span>{a.required_ack && <span>обязательно к ознакомлению</span>}</div></div>
                                <div className="side">{a.audience === 'staff' && <Badge tone="info">только сотрудники</Badge>}{a.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, a.status)[1]}>{st(ARTICLE_STATUS, a.status)[0]}</Badge>}</div>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : <div className="card-body faint">Пока пусто</div>}
                    </Card>
                  );
                })}
              </div>
            )}
          </DataState>
          {editor && Boolean(zero.data?.length) && (
            <Card title="Безрезультатные запросы" className="" >
              <p className="faint">Чего не нашли сотрудники и партнёры — кандидаты на новые статьи.</p>
              {zero.data!.map((z, i) => <div key={i} className="row between"><span>«{z.query}»</span><span className="faint">{formatDateTime(z.at, intlLocale())}</span></div>)}
            </Card>
          )}
        </>
      )}
      {creating && <NewArticleDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/kb/articles/${id}/edit`)} />}
    </>
  );
}

function NewArticleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections });
  const [title, setTitle] = useState('');
  const [section, setSection] = useState('');
  const [type, setType] = useState('instruction');
  const [audience, setAudience] = useState('all');
  const m = useMutation({ mutationFn: () => kbCommands.create(section, type, title, audience), onSuccess: (r) => onCreated(r.article_id) });
  return (
    <ConfirmDialog open title="Новая статья" confirmLabel="Создать черновик" busy={m.isPending} error={m.error} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название" required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label="Раздел" required>{(id) => <Select id={id} value={section} onChange={(e) => setSection(e.target.value)}><option value="">Выберите</option>{(secs.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</Select>}</Field>
      <div className="grid grid-2">
        <Field label="Тип">{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
        <Field label="Аудитория">{(id) => <Select id={id} value={audience} onChange={(e) => setAudience(e.target.value)}><option value="all">Все (сотрудники и партнёры)</option><option value="staff">Только сотрудники компании</option></Select>}</Field>
      </div>
    </ConfirmDialog>
  );
}

export function ArticlePage() {
  const { id = '' } = useParams();
  const { me, can } = useSession();
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const names = useUserNames();
  const roles = useRoles();
  const art = useQuery({ queryKey: ['kb', 'article', id], queryFn: () => getArticle(id) });
  const rev = useQuery({ queryKey: ['kb', 'rev', art.data?.published_revision_id], enabled: Boolean(art.data?.published_revision_id), queryFn: () => getRevision(art.data!.published_revision_id!) });
  const ack = useQuery({ queryKey: ['kb', 'ack', art.data?.published_revision_id], enabled: Boolean(art.data?.published_revision_id && art.data?.required_ack), queryFn: () => myAck(art.data!.published_revision_id!, me!.user.id) });
  const binds = useQuery({ queryKey: ['kb', 'binds', id], queryFn: () => bindings(id) });
  const editor = can('kb.edit') || can('kb.publish');
  const revs = useQuery({ queryKey: ['kb', 'revs', id], enabled: editor, queryFn: () => revisionsOf(id) });
  const src = useQuery({ queryKey: ['kb', 'src', id], enabled: editor && art.data?.source_mode === 'drive_document', queryFn: () => sourceLink(id) });
  const [fb, setFb] = useState<null | 'outdated' | 'suggestion'>(null);
  const [fbText, setFbText] = useState('');
  const [archive, setArchive] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['kb'] });
  const acknowledge = useMutation({ mutationFn: () => kbCommands.acknowledge(art.data!.published_revision_id!), onSuccess: () => { toast('Ознакомление зафиксировано для этой редакции'); void refresh(); void qc.invalidateQueries({ queryKey: ['today'] }); } });
  const feedback = useMutation({ mutationFn: ({ kind, comment }: { kind: string; comment: string | null }) => kbCommands.feedback(id, kind, comment), onSuccess: () => { toast('Спасибо, отзыв учтён'); setFb(null); setFbText(''); } });
  const doArchive = useMutation({ mutationFn: () => kbCommands.archive(id, reason), onSuccess: () => { toast('Статья в архиве; история и ознакомления сохранены'); setArchive(false); void refresh(); } });
  const drive = useMutation({
    mutationFn: async (action: 'change' | 'revoke' | 'restore') => {
      if (action === 'change') await kbCommands.driveChange(id, `${rev.data?.body ?? ''}\n\n## Обновление из исходного документа\n\nДобавлен шаг проверки калибровки (демо-изменение в Drive).`, `v${Date.now() % 1000}`);
      else await kbCommands.driveAccess(id, action === 'restore');
    },
    onSuccess: () => { toast('Доступ восстановлен'); void refresh(); },
  });
  const toc = useMemo(() => headings(rev.data?.body ?? ''), [rev.data?.body]);

  return (
    <DataState query={art} empty={(a) => (a ? null : <EmptyState title="Статья не найдена" text="Материал недоступен вашей роли или снят с публикации." />)}>
      {(a) => {
        if (!a) return null;
        const r = rev.data;
        const draft = revs.data?.find((x) => ['draft', 'in_review', 'rejected'].includes(x.status));
        return (
          <>
            <PageHeader back={{ to: '/kb', label: t('База знаний') }} title={r?.title ?? a.published?.title ?? 'Черновик'}
              sub={<span className="row">
                <span>{TYPE_LABEL[a.type]}</span>{r && <span>редакция {r.rev_no} от {formatDate(r.published_at, intlLocale())}</span>}
                {a.audience === 'staff' && <Badge tone="info">только сотрудники</Badge>}
                {a.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, a.status)[1]}>{st(ARTICLE_STATUS, a.status)[0]}</Badge>}
                {a.review_due && <span className="faint">пересмотр до {formatDate(a.review_due, intlLocale())}</span>}
              </span>}
              actions={editor && (
                <>
                  {can('kb.edit') && <LinkButton to={`/kb/articles/${id}/edit`}><Edit3 size={16} aria-hidden />{draft ? 'Продолжить черновик' : 'Редактировать'}</LinkButton>}
                  {draft?.status === 'in_review' && can('kb.publish') && <LinkButton to={`/kb/articles/${id}/review`} variant="primary"><Eye size={16} aria-hidden />Согласовать</LinkButton>}
                  {can('kb.publish') && a.status !== 'archived' && <Button variant="ghost" onClick={() => setArchive(true)}><Archive size={16} aria-hidden />В архив</Button>}
                </>
              )} />
            {a.required_ack && r && !ack.isLoading && (
              <div style={{ marginBottom: 16 }}>
                {ack.data ? <Alert tone="success">Вы ознакомились с этой редакцией {formatDateTime(ack.data.at, intlLocale())}.</Alert>
                  : <Alert tone="warning" title="Обязательно к ознакомлению" action={<Button variant="primary" loading={acknowledge.isPending} onClick={() => acknowledge.mutate()}>{t('Ознакомлен')}</Button>}>Прочитайте материал и подтвердите ознакомление с редакцией {r.rev_no}.</Alert>}
              </div>
            )}
            {a.status === 'needs_review' && <div style={{ marginBottom: 16 }}><Alert tone="warning">Статья ожидает пересмотра владельцем. Пользуйтесь осторожно: возможны изменения процесса.</Alert></div>}
            <div className="grid grid-main">
              <Card>
                {r ? <Markdown source={r.body} /> : <EmptyState title="Статья ещё не опубликована" text="Черновик доступен редакторам." />}
                {r && (
                  <div className="row" style={{ marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                    <span className="muted">Это помогло?</span>
                    <Button size="sm" onClick={() => feedback.mutate({ kind: 'helpful', comment: null })}><ThumbsUp size={15} aria-hidden />{t('Помогло')}</Button>
                    <Button size="sm" onClick={() => feedback.mutate({ kind: 'not_helpful', comment: null })}><ThumbsDown size={15} aria-hidden />{t('Не помогло')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setFb('outdated')}>{t('Сообщить об устаревании')}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setFb('suggestion')}>Предложить исправление</Button>
                  </div>
                )}
                <ActionError error={feedback.error} />
              </Card>
              <div className="stack">
                {toc.length > 1 && (
                  <Card title="Содержание">
                    <nav aria-label="Содержание статьи">
                      {toc.map((h) => <div key={h.id} style={{ paddingLeft: h.level === 3 ? 14 : 0, padding: '3px 0' }}><a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.focus(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' }); }}>{h.text}</a></div>)}
                    </nav>
                  </Card>
                )}
                <Card title="О материале">
                  <KV items={[
                    ['Владелец знания', names(a.owner_id)], ['Утвердил', names(r?.approved_by)],
                    ['Аудитория', a.audience === 'staff' ? 'сотрудники компании' : 'все'],
                    ...(a.audience_roles?.length ? [['Роли', a.audience_roles.map(roles.name).join(', ')] as [string, string]] : []),
                    ['Постоянная ссылка', <span key="l" className="mono">#/kb/articles/{a.id.slice(0, 8)}…</span>],
                    ...(editor ? [['Корпоративная копия', <Badge key="e" tone={st(EXPORT_STATUS, a.export_status)[1]}>{st(EXPORT_STATUS, a.export_status)[0]}</Badge>] as [string, React.ReactNode]] : []),
                  ]} />
                  {editor && a.export_error && <div className="faint" style={{ marginTop: 6 }}>{a.export_error}</div>}
                  {Boolean(binds.data?.length) && <div className="faint" style={{ marginTop: 8 }}>Показывается в контексте: {binds.data!.map((b) => b.target_key).join(', ')}</div>}
                </Card>
                {editor && a.source_mode === 'drive_document' && (
                  <Card title="Исходник в Google Drive">
                    {src.data && <KV items={[['Файл', <span key="f" className="mono">{src.data.external_id}</span>], ['Версия', src.data.external_version], ['Статус обмена', src.data.sync_status], ['Последняя копия', formatDateTime(src.data.last_synced_at, intlLocale())]]} />}
                    {src.data?.error && <Alert tone="danger">{src.data.error}</Alert>}
                    <p className="faint" style={{ marginTop: 8 }}>Изменение исходника создаёт кандидатную редакцию; опубликованная остаётся действующей до согласования.</p>
                    {a.status === 'suspended' && <div className="row"><Button size="sm" loading={drive.isPending} onClick={() => drive.mutate('restore')}>Восстановить доступ</Button></div>}
                    <ActionError error={drive.error} />
                  </Card>
                )}
                {editor && Boolean(revs.data?.length) && (
                  <Card title="Редакции">
                    {revs.data!.map((x) => (
                      <div key={x.id} className="row between" style={{ padding: '4px 0' }}>
                        <span>№ {x.rev_no} {x.source === 'drive' && <Badge tone="info">из Drive</Badge>}</span>
                        <span className="row"><Badge tone={st(ARTICLE_STATUS, x.status)[1]}>{st(ARTICLE_STATUS, x.status)[0]}</Badge><span className="faint">{formatDate(x.published_at ?? x.updated_at, intlLocale())}</span></span>
                      </div>
                    ))}
                  </Card>
                )}
              </div>
            </div>
            <ConfirmDialog open={fb !== null} title={fb === 'outdated' ? 'Что устарело?' : 'Предложить исправление'} confirmLabel="Отправить"
              busy={feedback.isPending} error={feedback.error} onClose={() => setFb(null)} onConfirm={() => feedback.mutate({ kind: fb!, comment: fbText })}>
              <Field label="Описание" required hint="Редактор получит задачу проверки">{(fid) => <Textarea id={fid} rows={3} value={fbText} onChange={(e) => setFbText(e.target.value)} />}</Field>
            </ConfirmDialog>
            <ConfirmDialog open={archive} title="Перенести статью в архив" confirmLabel="В архив" danger busy={doArchive.isPending} error={doArchive.error}
              onClose={() => setArchive(false)} onConfirm={() => doArchive.mutate()}>
              <p className="muted">Статья исчезнет из поиска. Редакции, ознакомления и связи с задачами сохраняются.</p>
              <Field label="Причина" required>{(fid) => <Textarea id={fid} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}

/** Простое построчное сравнение редакций для согласующего. */
function LineDiff({ before, after }: { before: string; after: string }) {
  const a = before.split('\n');
  const b = after.split('\n');
  const setA = new Set(a);
  const setB = new Set(b);
  return (
    <div className="mono" style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
      {a.filter((l) => !setB.has(l) && l.trim()).map((l, i) => <div key={`d${i}`} style={{ background: 'var(--danger-weak)' }}>− {l}</div>)}
      {b.map((l, i) => <div key={`a${i}`} style={setA.has(l) ? { color: 'var(--text-3)' } : { background: 'var(--success-weak)' }}>{setA.has(l) ? '  ' : '+ '}{l}</div>)}
    </div>
  );
}

export function ArticleEditPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const roles = useRoles();
  const art = useQuery({ queryKey: ['kb', 'article', id], queryFn: () => getArticle(id) });
  const revs = useQuery({ queryKey: ['kb', 'revs', id], queryFn: () => revisionsOf(id) });
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections });
  const latest = revs.data?.[0];
  const published = revs.data?.find((r) => r.status === 'published');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<'edit' | 'preview' | 'diff'>('edit');
  const [serverRev, setServerRev] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [meta, setMeta] = useState<Partial<ArticleRow> | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (loaded || !latest) return;
    setTitle(latest.title); setSummary(latest.summary ?? ''); setBody(latest.body);
    setServerRev(['draft', 'rejected'].includes(latest.status) ? latest.revision : null);
    setLoaded(true);
  }, [latest, loaded]);
  useEffect(() => { if (art.data && !meta) setMeta(art.data); }, [art.data, meta]);

  const save = useMutation({
    mutationFn: () => kbCommands.saveDraft(id, title, summary, body, serverRev, changeNote || null),
    onSuccess: (r) => { setServerRev(r.revision); setSavedAt(r.updated_at); setConflict(false); void qc.invalidateQueries({ queryKey: ['kb', 'revs', id] }); },
    onError: (e) => { if (toAppError(e).code === 'version-conflict') setConflict(true); },
  });
  // Автосохранение черновика (KB-03): через 1,5 с после последней правки
  const dirty = loaded && latest && (title !== latest.title || summary !== (latest.summary ?? '') || body !== latest.body);
  useEffect(() => {
    if (!dirty || conflict || latest?.status === 'in_review') return;
    const h = setTimeout(() => save.mutate(), 1500);
    return () => clearTimeout(h);
  }, [title, summary, body]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = useMutation({
    mutationFn: async () => { if (dirty) await save.mutateAsync(); return kbCommands.submit(id); },
    onSuccess: () => { toast('Редакция отправлена на согласование'); navigate(`/kb/articles/${id}`); },
  });
  const saveMeta = useMutation({
    mutationFn: () => kbCommands.updateMeta(id, { section: meta!.section_id ?? null, type: meta!.type ?? null, audience: meta!.audience ?? null,
      audience_roles: meta!.audience_roles?.length ? meta!.audience_roles : null, owner: null, tags: meta!.tags ?? null, review_due: meta!.review_due ?? null, required_ack: meta!.required_ack ?? null }),
    onSuccess: () => { toast('Свойства статьи сохранены'); void qc.invalidateQueries({ queryKey: ['kb'] }); },
  });

  function wrap(prefix: string, suffix = '') {
    const el = textRef.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    setBody(body.slice(0, s) + prefix + body.slice(s, e) + suffix + body.slice(e));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + prefix.length, e + prefix.length); });
  }

  if (!can('kb.edit')) return <EmptyState title="Нет прав на редактирование" />;
  return (
    <DataState query={revs}>
      {() => (
        <>
          <PageHeader back={{ to: `/kb/articles/${id}`, label: 'К статье' }} title="Редактирование"
            sub={<span className="row">{latest && <Badge tone={st(ARTICLE_STATUS, latest.status)[1]}>редакция {latest.rev_no}: {st(ARTICLE_STATUS, latest.status)[0]}</Badge>}
              <span className="faint" role="status">{save.isPending ? 'Сохранение…' : savedAt ? `Черновик сохранён ${formatDateTime(savedAt, intlLocale())}` : published ? 'Правки создадут новую редакцию; опубликованная не меняется' : ''}</span></span>}
            actions={<Button variant="primary" loading={submit.isPending} disabled={latest?.status === 'in_review'} onClick={() => submit.mutate()}>Отправить на согласование</Button>} />
          {latest?.status === 'in_review' && <div style={{ marginBottom: 16 }}><Alert tone="info">Редакция на согласовании. Новые правки — после решения согласующего.</Alert></div>}
          {latest?.status === 'rejected' && latest.reject_reason && <div style={{ marginBottom: 16 }}><Alert tone="danger" title="Замечания согласующего">{latest.reject_reason}</Alert></div>}
          {conflict && <div style={{ marginBottom: 16 }}><Alert tone="danger" title="Черновик изменил другой редактор" action={<Button size="sm" onClick={() => { setLoaded(false); setConflict(false); void qc.invalidateQueries({ queryKey: ['kb', 'revs', id] }); }}>Загрузить актуальную версию</Button>}>Ваши правки не перезаписали чужие. Скопируйте нужный текст и загрузите актуальную версию.</Alert></div>}
          <ActionError error={submit.error ?? (conflict ? null : save.error)} />
          <div className="grid grid-main">
            <Card>
              <Field label="Название" required>{(fid) => <Input id={fid} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
              <Field label="Краткое описание" hint="Показывается в поиске">{(fid) => <Input id={fid} value={summary} onChange={(e) => setSummary(e.target.value)} />}</Field>
              <Tabs label="Режим" value={view} onChange={setView} tabs={[{ id: 'edit', label: 'Текст' }, { id: 'preview', label: 'Предпросмотр' }, ...(published ? [{ id: 'diff' as const, label: 'Сравнить с опубликованной' }] : [])]} />
              {view === 'edit' && (
                <>
                  <div className="row" style={{ marginBottom: 8 }} role="toolbar" aria-label="Форматирование">
                    <Button size="sm" variant="ghost" onClick={() => wrap('\n## ')}>Заголовок</Button>
                    <Button size="sm" variant="ghost" onClick={() => wrap('**', '**')}>Жирный</Button>
                    <Button size="sm" variant="ghost" onClick={() => wrap('\n- ')}>Список</Button>
                    <Button size="sm" variant="ghost" onClick={() => wrap('\n1. ')}>Нумерация</Button>
                    <Button size="sm" variant="ghost" onClick={() => wrap('\n| Колонка | Колонка |\n| --- | --- |\n| ', ' |  |\n')}>Таблица</Button>
                    <Button size="sm" variant="ghost" onClick={() => wrap('[', '](https://)')}>Ссылка</Button>
                  </div>
                  <label htmlFor="kb-body" className="sr-only">Текст статьи</label>
                  <Textarea id="kb-body" ref={textRef} value={body} onChange={(e) => setBody(e.target.value)} style={{ minHeight: 420, fontFamily: 'var(--mono)', fontSize: 14 }} />
                  <div className="faint">Формат: Markdown без HTML. Опасное содержимое удаляется при показе.</div>
                </>
              )}
              {view === 'preview' && <Markdown source={body} />}
              {view === 'diff' && published && <LineDiff before={published.body} after={body} />}
              <Field label="Что изменено" hint="Увидит согласующий">{(fid) => <Input id={fid} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} />}</Field>
            </Card>
            {meta && can('kb.publish') && (
              <Card title="Свойства">
                <Field label="Раздел">{(fid) => <Select id={fid} value={meta.section_id} onChange={(e) => setMeta({ ...meta, section_id: e.target.value })}>{(secs.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</Select>}</Field>
                <Field label="Тип">{(fid) => <Select id={fid} value={meta.type} onChange={(e) => setMeta({ ...meta, type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
                <Field label="Аудитория">{(fid) => <Select id={fid} value={meta.audience} onChange={(e) => setMeta({ ...meta, audience: e.target.value })}><option value="all">Все</option><option value="staff">Только сотрудники</option></Select>}</Field>
                <Field label="Только для ролей" hint="Пусто — вся аудитория">{(fid) => (
                  <Select id={fid} multiple value={meta.audience_roles ?? []} onChange={(e) => setMeta({ ...meta, audience_roles: Array.from(e.target.selectedOptions).map((o) => o.value) })} style={{ minHeight: 120 }}>
                    {roles.list.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                  </Select>
                )}</Field>
                <Field label="Пересмотреть до">{(fid) => <Input id={fid} type="date" value={meta.review_due ?? ''} onChange={(e) => setMeta({ ...meta, review_due: e.target.value || null })} />}</Field>
                <Checkbox label="Обязательно к ознакомлению" checked={Boolean(meta.required_ack)} onChange={(v) => setMeta({ ...meta, required_ack: v })} />
                <Button size="sm" loading={saveMeta.isPending} onClick={() => saveMeta.mutate()}>Сохранить свойства</Button>
                <ActionError error={saveMeta.error} />
              </Card>
            )}
          </div>
        </>
      )}
    </DataState>
  );
}

export function ArticleReviewPage() {
  const { id = '' } = useParams();
  const { me, can } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const names = useUserNames();
  const art = useQuery({ queryKey: ['kb', 'article', id], queryFn: () => getArticle(id) });
  const revs = useQuery({ queryKey: ['kb', 'revs', id], queryFn: () => revisionsOf(id) });
  const cand = revs.data?.find((r) => r.status === 'in_review');
  const pub = revs.data?.find((r) => r.status === 'published');
  const [reack, setReack] = useState(false);
  const [note, setNote] = useState('');
  const [reject, setReject] = useState(false);
  const [reason, setReason] = useState('');
  const [view, setView] = useState<'diff' | 'preview'>('diff');
  const publish = useMutation({
    mutationFn: () => kbCommands.publish(cand!.id, reack, art.data?.review_due ?? null, note || null),
    onSuccess: (r) => { toast(`Опубликована редакция ${r.rev_no}${r.ack_assigned ? `; назначено ознакомлений: ${r.ack_assigned}` : ''}`); navigate(`/kb/articles/${id}`); },
  });
  const rej = useMutation({ mutationFn: () => kbCommands.reject(cand!.id, reason), onSuccess: () => { toast('Редакция возвращена автору'); navigate(`/kb/articles/${id}`); } });
  if (!can('kb.publish')) return <EmptyState title="Нет прав на согласование" />;
  return (
    <DataState query={revs} empty={() => (cand ? null : <EmptyState title="Нет редакции на согласовании" action={<LinkButton to={`/kb/articles/${id}`}>К статье</LinkButton>} />)}>
      {() => cand && (
        <>
          <PageHeader back={{ to: `/kb/articles/${id}`, label: 'К статье' }} title={`Согласование: ${cand.title}`}
            sub={<span className="row"><span>Редакция {cand.rev_no}</span><span>автор {names(cand.author_id)}</span>{cand.source === 'drive' && <Badge tone="info">из исходника Drive</Badge>}</span>} />
          {cand.author_id === me?.user.id && <div style={{ marginBottom: 16 }}><Alert tone="warning">Вы автор этой редакции: публикует другой согласующий (разделение обязанностей).</Alert></div>}
          <div className="grid grid-main">
            <Card>
              <Tabs label="Режим" value={view} onChange={setView} tabs={[{ id: 'diff', label: pub ? 'Изменения' : 'Текст' }, { id: 'preview', label: 'Как увидит читатель' }]} />
              {view === 'diff' ? (pub ? <LineDiff before={pub.body} after={cand.body} /> : <div className="mono" style={{ whiteSpace: 'pre-wrap' }}>{cand.body}</div>) : <Markdown source={cand.body} />}
            </Card>
            <Card title="Решение">
              {cand.change_note && <p><strong>Что изменено:</strong> {cand.change_note}</p>}
              {art.data?.required_ack && (
                <Checkbox label="Требуется повторное ознакомление" hint="Отметьте для содержательных изменений. Косметическая правка не должна заставлять всех читать заново."
                  checked={reack} onChange={setReack} />
              )}
              <Field label="Комментарий к публикации">{(fid) => <Input id={fid} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <ActionError error={publish.error ?? rej.error} />
              <div className="form-actions">
                <Button onClick={() => setReject(true)}>Вернуть автору</Button>
                <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate()}>Опубликовать редакцию {cand.rev_no}</Button>
              </div>
            </Card>
          </div>
          <ConfirmDialog open={reject} title="Вернуть автору" confirmLabel="Вернуть" busy={rej.isPending} error={rej.error} onClose={() => setReject(false)} onConfirm={() => rej.mutate()}>
            <Field label="Замечания" required>{(fid) => <Textarea id={fid} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          </ConfirmDialog>
        </>
      )}
    </DataState>
  );
}

export function LearningPage() {
  const { me, can } = useSession();
  const { t } = useT();
  const [params] = useSearchParams();
  const mine = useQuery({ queryKey: ['learning', 'mine'], queryFn: () => myAcks(me!.user.id) });
  const arts = useQuery({ queryKey: ['kb', 'articles'], queryFn: articles });
  const all = useQuery({ queryKey: ['learning', 'all'], enabled: can('kb.publish') || can('metrics.read'), queryFn: allAcks });
  const title = (aid: string) => arts.data?.find((a) => a.id === aid)?.published?.title ?? 'Материал';
  const current = (aid: string, rid: string) => arts.data?.find((a) => a.id === aid)?.published_revision_id === rid;
  const stats = useMemo(() => {
    const m = new Map<string, { done: number; total: number }>();
    for (const a of all.data ?? []) {
      if (!current(a.article_id, a.revision_id)) continue;
      const s = m.get(a.article_id) ?? { done: 0, total: 0 };
      s.total++; if (a.completed_at) s.done++;
      m.set(a.article_id, s);
    }
    return [...m.entries()];
  }, [all.data, arts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = (mine.data ?? []).filter((x) => !x.completed_at && current(x.article_id, x.revision_id));
  const done = (mine.data ?? []).filter((x) => x.completed_at);
  return (
    <>
      <PageHeader title={t('Обучение')} sub="Обязательные материалы и подтверждения ознакомления" />
      <div className="grid grid-main">
        <div className="stack">
          <Card title="Нужно изучить" bodyless>
            <DataState query={mine} empty={() => (pending.length ? null : <EmptyState title="Всё изучено" text="Новые обязательные материалы появятся здесь и на экране «Сегодня»." />)}>
              {() => (
                <ul className="list">{pending.map((x) => (
                  <li key={x.id}><Link className="list-item" to={`/kb/articles/${x.article_id}`}><div className="main-col"><div className="title">{title(x.article_id)}</div><div className="meta">назначено {formatDate(x.created_at, intlLocale())}</div></div><div className="side"><Badge tone={x.due_on < new Date().toISOString().slice(0, 10) ? 'danger' : 'warning'}>до {formatDate(x.due_on, intlLocale())}</Badge></div></Link></li>
                ))}</ul>
              )}
            </DataState>
          </Card>
          {done.length > 0 && (
            <Card title="Изучено" bodyless>
              <ul className="list">{done.map((x) => (
                <li key={x.id}><Link className="list-item" to={`/kb/articles/${x.article_id}`}><div className="main-col"><div className="title">{title(x.article_id)}</div></div><div className="side"><Badge tone="success">{formatDate(x.completed_at, intlLocale())}</Badge>{!current(x.article_id, x.revision_id) && <span className="faint">есть новая редакция</span>}</div></Link></li>
              ))}</ul>
            </Card>
          )}
        </div>
        {(params.get('all') || can('kb.publish')) && stats.length > 0 && (
          <Card title="Ознакомление по материалам">
            <p className="faint">Завершённые назначения актуальных обязательных редакций. Просмотры статьи не считаются.</p>
            {stats.map(([aid, s]) => (
              <div key={aid} style={{ marginBottom: 12 }}>
                <div className="row between"><Link to={`/kb/articles/${aid}`}>{title(aid)}</Link><span className="num">{s.done}/{s.total}</span></div>
                <div className="progress" aria-hidden><span style={{ width: `${Math.round((s.done / s.total) * 100)}%` }} /></div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </>
  );
}
