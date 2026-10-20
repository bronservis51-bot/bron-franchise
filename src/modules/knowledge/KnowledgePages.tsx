// База знаний: франчайзи читают и подтверждают ознакомление; Менеджер по франшизе пишет и сразу публикует.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Check, Edit3, FilePlus, FolderPlus, HelpCircle, MessageCircleQuestion, Search, SearchX } from 'lucide-react';
import { useSession } from '../../platform/session';
import { command, toAppError } from '../../platform/backend';
import { formatDate, formatDateTime } from '../../platform/dates';
import { ActionError, Alert, Badge, Button, Card, Checkbox, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, LinkButton, NoResults,
  PageHeader, Select, Tabs, Textarea } from '../../ui';
import { ARTICLE_STATUS, st } from '../../ui/status';
import { headings, Markdown } from '../../ui/markdown';
import { useToast } from '../../ui/toast';
import { ackStatus, articles, getArticle, getRevision, kbAnswer, kbAsk, kbCommands, kbMisses, kbQuestions, myAcks, revisionsOf, search, sections, toRead, TYPE_LABEL } from './api';

function Snippet({ html }: { html: string }) {
  // Подсветка от сервера приходит как «…»; превращаем в <mark> без вставки HTML
  const parts = html.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith('«') && p.endsWith('»') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

/** «Не нашли ответ? Спросите» — вопрос уходит менеджеру по франшизе, ответ придёт в «Мои вопросы». */
export function AskDialog({ initial = '', article = null, onClose }: { initial?: string; article?: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState(initial);
  const m = useMutation({ mutationFn: () => kbAsk(q, article), onSuccess: () => { toast('Вопрос отправлен. Ответ появится в «Мои вопросы»'); void qc.invalidateQueries({ queryKey: ['kb'] }); onClose(); } });
  return (
    <ConfirmDialog open title="Задать вопрос" confirmLabel="Отправить" busy={m.isPending} error={m.error} disabled={q.trim().length < 3} onClose={onClose} onConfirm={() => m.mutate()}>
      <p className="muted">Вопрос получит менеджер по франшизе. Частые вопросы становятся статьями — так база знаний пополняется ответами на то, что действительно нужно.</p>
      <Field label="Ваш вопрос" required>{(id) => <Textarea id={id} rows={4} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}</Field>
    </ConfirmDialog>
  );
}

export function KbHomePage() {
  const { can } = useSession();
  const editor = can('kb.edit');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [filter, setFilter] = useState<'published' | 'draft' | 'archived'>('published');
  const [creating, setCreating] = useState(false);
  const [newSection, setNewSection] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const inbox = useQuery({ queryKey: ['kb', 'inbox'], queryFn: () => command<{ unanswered: number; new_answers: number }>('kb_inbox') });
  const misses = useQuery({ queryKey: ['kb', 'misses'], enabled: editor, queryFn: kbMisses });
  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  useEffect(() => { setParams(debounced ? { q: debounced } : {}, { replace: true }); }, [debounced, setParams]);
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections, staleTime: 5 * 60_000 });
  const arts = useQuery({ queryKey: ['kb', 'articles'], queryFn: articles });
  const results = useQuery({ queryKey: ['kb', 'search', debounced, editor], enabled: debounced.length >= 2, queryFn: () => search(debounced, editor) });
  const reading = useQuery({ queryKey: ['kb', 'to-read'], enabled: !editor, queryFn: toRead });
  const list = (arts.data ?? []).filter((a) => !editor || a.status === filter);
  const drafts = (arts.data ?? []).filter((a) => a.status === 'draft').length;

  return (
    <>
      <PageHeader title="База знаний" sub="Инструкции, регламенты и ответы на частые вопросы"
        actions={editor ? (
          <>
            <LinkButton to="/kb/questions"><MessageCircleQuestion size={16} aria-hidden />Вопросы{inbox.data?.unanswered ? ` (${inbox.data.unanswered})` : ''}</LinkButton>
            <Button variant="primary" onClick={() => setCreating(true)}><FilePlus size={16} aria-hidden />Новая статья</Button>
            <Button onClick={() => setNewSection(true)}><FolderPlus size={16} aria-hidden />Раздел</Button>
          </>
        ) : (
          <>
            <LinkButton to="/kb/questions"><MessageCircleQuestion size={16} aria-hidden />Мои вопросы{inbox.data?.new_answers ? ` · новых ответов: ${inbox.data.new_answers}` : ''}</LinkButton>
            <Button onClick={() => setAsking('')}><HelpCircle size={16} aria-hidden />Задать вопрос</Button>
          </>
        )} />
      <div className="field kb-search">
        <label htmlFor="kb-q" className="sr-only">Найти в базе знаний</label>
        <div style={{ position: 'relative' }}>
          <Search size={18} aria-hidden style={{ position: 'absolute', left: 14, top: 13, color: 'var(--text-3)' }} />
          <Input id="kb-q" type="search" placeholder="Найти: пузыри после оклейки, лекало, гарантия" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 40 }} />
        </div>
      </div>
      {debounced.length >= 2 ? (
        <Card title={`Результаты: «${debounced}»`} bodyless>
          <DataState query={results} empty={(d) => (d.length ? null : <NoResults query={debounced}
            action={!editor && <Button variant="primary" onClick={() => setAsking(debounced)}><HelpCircle size={16} aria-hidden />Спросить менеджера</Button>} />)}>
            {(d) => (
              <ul className="list">
                {d.map((h) => (
                  <li key={h.article_id}>
                    <Link className="list-item" to={`/kb/articles/${h.article_id}`}>
                      <div className="main-col">
                        <div className="title">{h.title}</div>
                        <div className="muted" style={{ fontSize: 'var(--fs-s)', marginTop: 2 }}><Snippet html={h.snippet} /></div>
                        <div className="meta"><span>{TYPE_LABEL[h.type] ?? h.type}</span><span>{h.section_title}</span></div>
                      </div>
                      <div className="side">{h.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, h.status)[1]}>{st(ARTICLE_STATUS, h.status)[0]}</Badge>}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
          {!editor && Boolean(results.data?.length) && (
            <div className="card-body faint">Не то? <button type="button" className="link-btn" onClick={() => setAsking(debounced)}>Задайте вопрос менеджеру</button></div>
          )}
        </Card>
      ) : (
        <>
          {Boolean(reading.data?.length) && (
            <Card title="Нужно прочитать" bodyless className="to-read">
              <ul className="list">
                {reading.data!.map((a) => (
                  <li key={a.article_id}>
                    <Link className="list-item" to={`/kb/articles/${a.article_id}`}>
                      <div className="main-col"><div className="title">{a.title}</div>{a.summary && <div className="meta">{a.summary}</div>}</div>
                      <div className="side"><Badge tone={a.due_on < new Date().toISOString().slice(0, 10) ? 'danger' : 'warning'}>до {formatDate(a.due_on)}</Badge></div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {editor && Boolean(misses.data?.length) && (
            <Card title="Искали и не нашли" icon={<SearchX size={18} />}>
              <p className="faint">Запросы франчайзи и сотрудников без результатов за 60 дней — кандидаты на новые статьи или синонимы.</p>
              <div className="chips" style={{ marginBottom: 0 }}>{misses.data!.map((m) => <span key={m.query} className="chip" style={{ cursor: 'default' }}>{m.query}{m.times > 1 ? ` ×${m.times}` : ''}</span>)}</div>
            </Card>
          )}
          {editor && <Chips label="Статьи" value={filter} onChange={setFilter}
            options={[{ id: 'published', label: 'Опубликованные' }, { id: 'draft', label: `Черновики${drafts ? ` (${drafts})` : ''}` }, { id: 'archived', label: 'Архив' }]} />}
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
                                <div className="main-col"><div className="title">{a.published?.title ?? 'Черновик без публикации'}</div>
                                  <div className="meta"><span>{TYPE_LABEL[a.type]}</span>{a.required_ack && <span>обязательно к ознакомлению</span>}</div></div>
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
        </>
      )}
      {creating && <NewArticleDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/kb/articles/${id}/edit`)} />}
      {newSection && <SectionDialog onClose={() => setNewSection(false)} />}
      {asking !== null && <AskDialog initial={asking} onClose={() => setAsking(null)} />}
    </>
  );
}

function SectionDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const m = useMutation({ mutationFn: () => kbCommands.sectionSave(null, title, description || null, null), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kb'] }); onClose(); } });
  return (
    <ConfirmDialog open title="Новый раздел" confirmLabel="Создать" busy={m.isPending} error={m.error} disabled={!title.trim()} onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название" required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label="Описание">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

function NewArticleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections });
  const [title, setTitle] = useState('');
  const [section, setSection] = useState('');
  const [type, setType] = useState('instruction');
  const m = useMutation({ mutationFn: () => kbCommands.create(section, type, title), onSuccess: (r) => onCreated(r.article_id) });
  return (
    <ConfirmDialog open title="Новая статья" confirmLabel="Создать черновик" busy={m.isPending} error={m.error} disabled={!title.trim() || !section}
      onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название" required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Раздел" required>{(id) => <Select id={id} value={section} onChange={(e) => setSection(e.target.value)}><option value="">Выберите</option>{(secs.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</Select>}</Field>
        <Field label="Тип">{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
      </div>
    </ConfirmDialog>
  );
}

function AckStatusCard({ articleId }: { articleId: string }) {
  const q = useQuery({ queryKey: ['kb', 'ack-status', articleId], queryFn: () => ackStatus(articleId) });
  return (
    <Card title="Ознакомление франчайзи">
      <DataState query={q} empty={(d) => (d.length ? null : <p className="faint">Франчайзи с доступом пока нет.</p>)}>
        {(d) => (
          <>
            <p className="faint">{d.filter((x) => x.acknowledged_at).length} из {d.length} подтвердили актуальную редакцию.</p>
            {d.map((x) => (
              <div key={x.user_id} className="row between access-row">
                <span>{x.full_name}{x.partner && <span className="faint" style={{ display: 'block' }}>{x.partner}</span>}</span>
                {x.acknowledged_at ? <Badge tone="success">{formatDate(x.acknowledged_at)}</Badge> : <Badge tone="warning">не прочитал</Badge>}
              </div>
            ))}
          </>
        )}
      </DataState>
    </Card>
  );
}

export function ArticlePage() {
  const { id = '' } = useParams();
  const { me, can } = useSession();
  const editor = can('kb.edit');
  const qc = useQueryClient();
  const toast = useToast();
  const art = useQuery({ queryKey: ['kb', 'article', id], queryFn: () => getArticle(id) });
  const rev = useQuery({ queryKey: ['kb', 'rev', art.data?.published_revision_id], enabled: Boolean(art.data?.published_revision_id), queryFn: () => getRevision(art.data!.published_revision_id!) });
  const acks = useQuery({ queryKey: ['kb', 'my-ack', id], enabled: Boolean(art.data?.required_ack && !editor), queryFn: () => myAcks(id, me!.user.id) });
  const revs = useQuery({ queryKey: ['kb', 'revs', id], enabled: editor, queryFn: () => revisionsOf(id) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['kb'] });
  const acknowledge = useMutation({ mutationFn: () => kbCommands.acknowledge(id), onSuccess: () => { toast('Отмечено: вы ознакомились'); void refresh(); } });
  const archive = useMutation({ mutationFn: (v: boolean) => kbCommands.archive(id, v), onSuccess: (_, v) => { toast(v ? 'Статья в архиве' : 'Статья возвращена'); void refresh(); } });
  const toc = useMemo(() => headings(rev.data?.body ?? ''), [rev.data?.body]);
  const [ask, setAsk] = useState(false);

  return (
    <DataState query={art} empty={(a) => (a ? null : <EmptyState title="Статья не найдена" text="Материал снят с публикации или недоступен." />)}>
      {(a) => {
        if (!a) return null;
        const r = rev.data;
        const draft = revs.data?.find((x) => x.status === 'draft');
        const ack = acks.data?.find((x) => a.ack_rev_no !== null && x.rev_no >= a.ack_rev_no);
        return (
          <>
            <PageHeader back={{ to: '/kb', label: 'База знаний' }} title={r?.title ?? draft?.title ?? 'Черновик'}
              sub={<span className="row">
                <span>{TYPE_LABEL[a.type]}</span>{r && <span>обновлено {formatDate(r.published_at)}</span>}
                {a.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, a.status)[1]}>{st(ARTICLE_STATUS, a.status)[0]}</Badge>}
              </span>}
              actions={editor && (
                <>
                  <LinkButton to={`/kb/articles/${id}/edit`} variant={draft ? 'primary' : 'secondary'}><Edit3 size={16} aria-hidden />{draft && r ? 'Есть неопубликованные правки' : 'Редактировать'}</LinkButton>
                  {a.status === 'archived'
                    ? <Button variant="ghost" loading={archive.isPending} onClick={() => archive.mutate(false)}><ArchiveRestore size={16} aria-hidden />Вернуть из архива</Button>
                    : r && <Button variant="ghost" loading={archive.isPending} onClick={() => archive.mutate(true)}><Archive size={16} aria-hidden />В архив</Button>}
                </>
              )} />
            {a.required_ack && r && !editor && !acks.isLoading && (
              <div style={{ marginBottom: 16 }}>
                {ack ? <Alert tone="success">Вы ознакомились {formatDateTime(ack.at)}.</Alert>
                  : <Alert tone="warning" title="Обязательно к ознакомлению" action={<Button variant="primary" loading={acknowledge.isPending} onClick={() => acknowledge.mutate()}><Check size={16} aria-hidden />Ознакомлен</Button>}>
                      Прочитайте материал и подтвердите ознакомление.</Alert>}
                <ActionError error={acknowledge.error} />
              </div>
            )}
            <div className={editor || toc.length > 2 ? 'grid grid-main' : ''}>
              <Card>
                {r ? <Markdown source={r.body} /> : <EmptyState title="Статья ещё не опубликована" text="Откройте редактор, допишите и опубликуйте." />}
                {r && !editor && (
                  <div className="ask-footer"><span className="muted">Остался вопрос по статье?</span>
                    <Button size="sm" onClick={() => setAsk(true)}><HelpCircle size={15} aria-hidden />Спросить менеджера</Button></div>
                )}
              </Card>
              {(editor || toc.length > 2) && (
                <div className="stack">
                  {toc.length > 2 && (
                    <Card title="Содержание">
                      <nav aria-label="Содержание статьи">
                        {toc.map((h) => <div key={h.id} style={{ paddingLeft: h.level === 3 ? 14 : 0, padding: '3px 0' }}><a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' }); }}>{h.text}</a></div>)}
                      </nav>
                    </Card>
                  )}
                  {editor && a.required_ack && r && <AckStatusCard articleId={id} />}
                  {editor && Boolean(revs.data?.length) && (
                    <Card title="История редакций">
                      {revs.data!.map((x) => (
                        <div key={x.id} className="row between" style={{ padding: '4px 0' }}>
                          <span>№ {x.rev_no}{x.change_note && <span className="faint"> · {x.change_note}</span>}</span>
                          <span className="row"><Badge tone={st(ARTICLE_STATUS, x.status)[1]}>{st(ARTICLE_STATUS, x.status)[0]}</Badge><span className="faint">{formatDate(x.published_at ?? x.updated_at)}</span></span>
                        </div>
                      ))}
                    </Card>
                  )}
                </div>
              )}
            </div>
            {ask && <AskDialog article={id} initial={`По статье «${r?.title ?? ''}»: `} onClose={() => setAsk(false)} />}
          </>
        );
      }}
    </DataState>
  );
}

export function ArticleEditPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const art = useQuery({ queryKey: ['kb', 'article', id], queryFn: () => getArticle(id) });
  const revs = useQuery({ queryKey: ['kb', 'revs', id], queryFn: () => revisionsOf(id) });
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections });
  const latest = revs.data?.[0];
  const published = revs.data?.find((r) => r.status === 'published');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState('');
  const [reack, setReack] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [serverRev, setServerRev] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [meta, setMeta] = useState<{ section_id: string; type: string; required_ack: boolean } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (loaded || !latest) return;
    setTitle(latest.title); setSummary(latest.summary ?? ''); setBody(latest.body);
    setServerRev(latest.status === 'draft' ? latest.revision : null);
    setLoaded(true);
  }, [latest, loaded]);
  useEffect(() => { if (art.data && !meta) setMeta({ section_id: art.data.section_id, type: art.data.type, required_ack: art.data.required_ack }); }, [art.data, meta]);

  const save = useMutation({
    mutationFn: () => kbCommands.saveDraft(id, title, summary, body, serverRev),
    onSuccess: (r) => { setServerRev(r.revision); setSavedAt(r.updated_at); setConflict(false); void qc.invalidateQueries({ queryKey: ['kb', 'revs', id] }); },
    onError: (e) => { if (toAppError(e).code === 'version-conflict') setConflict(true); },
  });
  // Автосохранение черновика через 1,5 с после последней правки
  const dirty = loaded && latest && (title !== latest.title || summary !== (latest.summary ?? '') || body !== latest.body);
  useEffect(() => {
    if (!dirty || conflict) return;
    const h = setTimeout(() => save.mutate(), 1500);
    return () => clearTimeout(h);
  }, [title, summary, body]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = useMutation({
    mutationFn: async () => {
      const metaChanged = meta && art.data && (meta.section_id !== art.data.section_id || meta.type !== art.data.type || meta.required_ack !== art.data.required_ack);
      if (metaChanged) await kbCommands.updateMeta(id, { section: meta!.section_id, type: meta!.type, required_ack: meta!.required_ack, tags: null });
      // Текст не менялся после публикации — новую редакцию не создаём
      if (!dirty && latest?.status !== 'draft') return metaChanged ? 'Свойства статьи сохранены' : 'Изменений нет — статья уже опубликована';
      if (dirty) await save.mutateAsync();
      await kbCommands.publish(id, reack, note || null);
      return 'Статья опубликована';
    },
    onSuccess: (msg) => { toast(msg); void qc.invalidateQueries({ queryKey: ['kb'] }); navigate(`/kb/articles/${id}`); },
  });

  function wrap(prefix: string, suffix = '') {
    const el = textRef.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    setBody(body.slice(0, s) + prefix + body.slice(s, e) + suffix + body.slice(e));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(s + prefix.length, e + prefix.length); });
  }

  if (!can('kb.edit')) return <EmptyState title="Статьи пишет Менеджер по франшизе" />;
  return (
    <DataState query={revs}>
      {() => (
        <>
          <PageHeader back={{ to: `/kb/articles/${id}`, label: 'К статье' }} title="Редактирование"
            sub={<span className="faint" role="status">{save.isPending ? 'Сохранение…' : savedAt ? `Черновик сохранён ${formatDateTime(savedAt)}` : published ? 'Правки видны франчайзи только после публикации' : 'Черновик виден только вам'}</span>}
            actions={<Button variant="primary" loading={publish.isPending} disabled={conflict} onClick={() => publish.mutate()}>Опубликовать</Button>} />
          {conflict && <div style={{ marginBottom: 16 }}><Alert tone="danger" title="Черновик изменён в другой вкладке" action={<Button size="sm" onClick={() => { setLoaded(false); setConflict(false); void qc.invalidateQueries({ queryKey: ['kb', 'revs', id] }); }}>Загрузить актуальную версию</Button>}>Скопируйте нужный текст и загрузите актуальную версию.</Alert></div>}
          <ActionError error={publish.error ?? (conflict ? null : save.error)} />
          <div className="grid grid-main">
            <Card>
              <Field label="Название" required>{(fid) => <Input id={fid} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
              <Field label="Кратко, о чём статья" hint="Показывается в поиске и списках">{(fid) => <Input id={fid} value={summary} onChange={(e) => setSummary(e.target.value)} />}</Field>
              <Tabs label="Режим" value={view} onChange={setView} tabs={[{ id: 'edit', label: 'Текст' }, { id: 'preview', label: 'Как увидят франчайзи' }]} />
              {view === 'edit' ? (
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
                </>
              ) : <Markdown source={body} />}
            </Card>
            {meta && (
              <Card title="Публикация">
                <Field label="Раздел">{(fid) => <Select id={fid} value={meta.section_id} onChange={(e) => setMeta({ ...meta, section_id: e.target.value })}>{(secs.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</Select>}</Field>
                <Field label="Тип">{(fid) => <Select id={fid} value={meta.type} onChange={(e) => setMeta({ ...meta, type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
                <Checkbox label="Обязательно к ознакомлению" hint="Франчайзи увидят статью в «Нужно прочитать» и подтвердят" checked={meta.required_ack} onChange={(v) => setMeta({ ...meta, required_ack: v })} />
                {published && meta.required_ack && (
                  <Checkbox label="Попросить прочитать заново" hint="Для важных изменений. Опечатку так отмечать не нужно" checked={reack} onChange={setReack} />
                )}
                <Field label="Что изменилось" hint="Видно в истории редакций">{(fid) => <Input id={fid} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              </Card>
            )}
          </div>
        </>
      )}
    </DataState>
  );
}

export function QuestionsPage() {
  const { can } = useSession();
  const editor = can('kb.edit');
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['kb', 'questions'], queryFn: kbQuestions });
  useEffect(() => { if (q.isSuccess) void qc.invalidateQueries({ queryKey: ['kb', 'inbox'] }); }, [q.isSuccess, qc]);
  const answer = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => kbAnswer(id, text, null),
    onSuccess: (_, v) => { toast('Ответ отправлен'); setDrafts({ ...drafts, [v.id]: '' }); void qc.invalidateQueries({ queryKey: ['kb'] }); },
  });
  return (
    <div className="home" style={{ maxWidth: 820 }}>
      <PageHeader back={{ to: '/kb', label: 'База знаний' }} title={editor ? 'Вопросы франчайзи' : 'Мои вопросы'}
        sub={editor ? 'Ответьте здесь. Если вопрос повторяется — сделайте из ответа статью.' : 'Ответы менеджера по франшизе'}
        actions={!editor && <Button variant="primary" onClick={() => setAsking(true)}><HelpCircle size={16} aria-hidden />Задать вопрос</Button>} />
      <ActionError error={answer.error} />
      <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Вопросов пока нет" text={editor ? 'Когда франчайзи спросят, вопросы появятся здесь.' : 'Не нашли ответ в базе знаний — спросите, менеджер ответит.'} />)}>
        {(list) => (
          <div className="stack">
            {list.map((x) => (
              <Card key={x.id} className={x.unseen ? 'new-answer' : ''}>
                <div className="faint">{editor ? `${x.user_name}${x.partner_name ? ` · ${x.partner_name}` : ''} · ` : ''}{formatDateTime(x.created_at)}{x.article_id && <> · <Link to={`/kb/articles/${x.article_id}`}>к статье</Link></>}</div>
                <p style={{ margin: '6px 0', fontWeight: 600 }}>{x.question}</p>
                {x.answer ? (
                  <div className="answer"><div className="faint">Ответ{x.answered_at ? ` · ${formatDateTime(x.answered_at)}` : ''}{x.unseen ? ' · новый' : ''}</div><div style={{ whiteSpace: 'pre-wrap' }}>{x.answer}</div></div>
                ) : editor ? (
                  <div>
                    <Textarea rows={3} aria-label="Ответ" value={drafts[x.id] ?? ''} onChange={(e) => setDrafts({ ...drafts, [x.id]: e.target.value })} placeholder="Ответ франчайзи" />
                    <div className="row" style={{ marginTop: 8 }}>
                      <Button variant="primary" size="sm" loading={answer.isPending && answer.variables?.id === x.id} disabled={(drafts[x.id] ?? '').trim().length < 2}
                        onClick={() => answer.mutate({ id: x.id, text: drafts[x.id] })}>Ответить</Button>
                    </div>
                  </div>
                ) : <Badge tone="warning">ждёт ответа</Badge>}
              </Card>
            ))}
          </div>
        )}
      </DataState>
      {asking && <AskDialog onClose={() => setAsking(false)} />}
    </div>
  );
}
