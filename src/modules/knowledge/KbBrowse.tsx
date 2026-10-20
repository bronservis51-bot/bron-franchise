// База знаний, устроенная под рост: поиск → разделы (два уровня) → статья. Плюс «Нужно прочитать», «Продолжить», «Новое», «Популярное».
// Менеджеру — экран управления: все статьи с просмотрами и оценками, редактор разделов.
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, ArchiveRestore, BookOpen, Check, ChevronRight, ClipboardList, Clock, Edit3, FilePlus, FolderTree, GraduationCap, HelpCircle, Megaphone,
  MessageCircleQuestion, PlayCircle, Rocket, Scissors, Search, SearchX, Settings2, ShieldCheck, Smartphone, Star, ThumbsDown, ThumbsUp, Trash2, Users, Wallet, Wrench,
} from 'lucide-react';
import { command } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { formatDate, formatDateTime } from '../../platform/dates';
import { ActionError, Alert, Badge, Button, Card, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, LinkButton, NoResults, PageHeader, Select } from '../../ui';
import { ARTICLE_STATUS, st } from '../../ui/status';
import { headings, Markdown } from '../../ui/markdown';
import { useToast } from '../../ui/toast';
import {
  getArticle, getRevision, kbArticleOpen, kbCommands, kbHome, kbManage, kbMisses, kbRate, kbSectionPage, myAcks, revisionsOf, search, sectionTree, sections, toRead,
  TYPE_LABEL, type Card as ArticleCard, type SectionNode,
} from './api';
import { AckStatusCard, AskDialog } from './KnowledgePages';

export const SECTION_ICON: Record<string, ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  book: BookOpen, rocket: Rocket, smartphone: Smartphone, scissors: Scissors, shield: ShieldCheck, users: Users, wallet: Wallet,
  megaphone: Megaphone, wrench: Wrench, graduation: GraduationCap, star: Star, clipboard: ClipboardList,
};
const ICON_LABEL: Record<string, string> = { book: 'Книга', rocket: 'Старт', smartphone: 'Смартфон', scissors: 'Резка', shield: 'Гарантия', users: 'Клиенты',
  wallet: 'Деньги', megaphone: 'Маркетинг', wrench: 'Оборудование', graduation: 'Обучение', star: 'Важное', clipboard: 'Регламенты' };

function SectionIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  const I = SECTION_ICON[icon] ?? BookOpen;
  return <span className="kb-icon" aria-hidden><I size={size} aria-hidden /></span>;
}

function Snippet({ html }: { html: string }) {
  const parts = html.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith('«') && p.endsWith('»') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

function Crumbs({ items }: { items: { to?: string; label: string }[] }) {
  return (
    <nav className="kb-crumbs" aria-label="Путь">
      {items.map((c, i) => (
        <span key={i}>{i > 0 && <ChevronRight size={14} aria-hidden />}{c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}</span>
      ))}
    </nav>
  );
}

/** Строка статьи в списках: название, суть, значки «обязательно», «видео», время чтения, прочитано. */
function ArticleItem({ a, editor, sectionTitle }: { a: ArticleCard; editor?: boolean; sectionTitle?: string }) {
  return (
    <li>
      <Link className="kb-item" to={`/kb/articles/${a.id}`}>
        <span className="kb-item-main">
          <span className="kb-item-title">{a.title}</span>
          {a.summary && <span className="kb-item-sum">{a.summary}</span>}
          <span className="kb-item-meta">
            <span>{TYPE_LABEL[a.type] ?? a.type}</span>
            {sectionTitle && <span>{sectionTitle}</span>}
            <span><Clock size={12} aria-hidden /> {a.minutes} мин</span>
            {a.has_video && <span className="kb-video"><PlayCircle size={12} aria-hidden /> видео</span>}
            {a.required_ack && <span className="kb-required">обязательно</span>}
            {editor && a.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, a.status)[1]}>{st(ARTICLE_STATUS, a.status)[0]}</Badge>}
            {editor && a.has_draft && a.status === 'published' && <span>есть черновик</span>}
            {editor && <span>{a.views_30} просм. за 30 дн.</span>}
          </span>
        </span>
        {!editor && a.read && <span className="kb-read" title="Вы открывали эту статью"><Check size={16} aria-hidden /></span>}
        <ChevronRight size={16} className="todo-chevron" aria-hidden />
      </Link>
    </li>
  );
}

/** Поиск по всей базе: подсказки появляются по мере ввода. */
function KbSearch({ onResults }: { onResults: (active: boolean) => void }) {
  const { can } = useSession();
  const editor = can('kb.edit');
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const [asking, setAsking] = useState<string | null>(null);
  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(h); }, [q]);
  useEffect(() => { setParams(debounced ? { q: debounced } : {}, { replace: true }); onResults(debounced.length >= 2); }, [debounced, setParams, onResults]);
  const results = useQuery({ queryKey: ['kb', 'search', debounced, editor], enabled: debounced.length >= 2, queryFn: () => search(debounced, editor) });
  return (
    <>
      <div className="kb-search-box">
        <Search size={20} aria-hidden />
        <label htmlFor="kb-q" className="sr-only">Найти в базе знаний</label>
        <input id="kb-q" type="search" className="kb-search-input" placeholder="Что ищете? Например: пузыри после оклейки, нож плоттера, гарантия"
          value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        {q && <button type="button" className="link-btn" onClick={() => setQ('')}>Очистить</button>}
      </div>
      {debounced.length >= 2 && (
        <Card bodyless className="kb-results">
          <DataState query={results} empty={(d) => (d.length ? null : (
            <NoResults query={debounced} action={!editor && <Button variant="primary" onClick={() => setAsking(debounced)}><HelpCircle size={16} aria-hidden />Спросить менеджера</Button>} />
          ))}>
            {(d) => (
              <>
                <div className="kb-results-head faint">Найдено: {d.length}</div>
                <ul className="kb-list">
                  {d.map((h) => (
                    <li key={h.article_id}>
                      <Link className="kb-item" to={`/kb/articles/${h.article_id}`}>
                        <span className="kb-item-main">
                          <span className="kb-item-title">{h.title}</span>
                          <span className="kb-item-sum"><Snippet html={h.snippet} /></span>
                          <span className="kb-item-meta"><span>{TYPE_LABEL[h.type] ?? h.type}</span><span>{h.section_title}</span>
                            {h.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, h.status)[1]}>{st(ARTICLE_STATUS, h.status)[0]}</Badge>}</span>
                        </span>
                        <ChevronRight size={16} className="todo-chevron" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
                {!editor && <div className="card-body faint">Не то? <button type="button" className="link-btn" onClick={() => setAsking(debounced)}>Задайте вопрос менеджеру</button></div>}
              </>
            )}
          </DataState>
        </Card>
      )}
      {asking !== null && <AskDialog initial={asking} onClose={() => setAsking(null)} />}
    </>
  );
}

function SectionTiles({ nodes }: { nodes: (SectionNode & { children: SectionNode[] })[] }) {
  return (
    <div className="kb-tiles">
      {nodes.map((s) => (
        <Link key={s.id} to={`/kb/s/${s.id}`} className="kb-tile">
          <SectionIcon icon={s.icon} size={22} />
          <span className="kb-tile-main">
            <span className="kb-tile-title">{s.title}</span>
            {s.description && <span className="kb-tile-desc">{s.description}</span>}
            {s.children.length > 0 && <span className="kb-tile-subs">{s.children.map((c) => c.title).join(' · ')}</span>}
          </span>
          <span className="kb-tile-count">{s.count}</span>
        </Link>
      ))}
    </div>
  );
}

export function KbHomePage() {
  const { can } = useSession();
  const editor = can('kb.edit');
  const navigate = useNavigate();
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [asking, setAsking] = useState(false);
  const home = useQuery({ queryKey: ['kb', 'home'], queryFn: kbHome });
  const reading = useQuery({ queryKey: ['kb', 'to-read'], enabled: !editor, queryFn: toRead });
  const inbox = useQuery({ queryKey: ['kb', 'inbox'], queryFn: () => command<{ unanswered: number; new_answers: number }>('kb_inbox') });
  const misses = useQuery({ queryKey: ['kb', 'misses'], enabled: editor, queryFn: kbMisses });
  const tree = useMemo(() => sectionTree(home.data?.sections ?? []), [home.data]);
  const titleOf = (id: string) => home.data?.sections.find((s) => s.id === id)?.title;

  return (
    <div className="kb">
      <PageHeader title="База знаний" sub={home.data ? `${home.data.total} статей: инструкции, регламенты, ответы на вопросы и видео` : 'Инструкции, регламенты, ответы на вопросы и видео'}
        actions={editor ? (
          <>
            <LinkButton to="/kb/questions"><MessageCircleQuestion size={16} aria-hidden />Вопросы{inbox.data?.unanswered ? ` (${inbox.data.unanswered})` : ''}</LinkButton>
            <LinkButton to="/kb/manage"><Settings2 size={16} aria-hidden />Управление</LinkButton>
            <Button variant="primary" onClick={() => setCreating(true)}><FilePlus size={16} aria-hidden />Новая статья</Button>
          </>
        ) : (
          <>
            <LinkButton to="/kb/questions"><MessageCircleQuestion size={16} aria-hidden />Мои вопросы{inbox.data?.new_answers ? ` · новых ответов: ${inbox.data.new_answers}` : ''}</LinkButton>
            <Button onClick={() => setAsking(true)}><HelpCircle size={16} aria-hidden />Задать вопрос</Button>
          </>
        )} />
      <KbSearch onResults={setSearching} />
      {!searching && (
        <DataState query={home} skeleton={6}>
          {(h) => (
            <div className="stack">
              {Boolean(reading.data?.length) && (
                <Card title="Нужно прочитать" bodyless className="to-read">
                  <ul className="kb-list">
                    {reading.data!.map((a) => (
                      <li key={a.article_id}>
                        <Link className="kb-item" to={`/kb/articles/${a.article_id}`}>
                          <span className="kb-item-main"><span className="kb-item-title">{a.title}</span>{a.summary && <span className="kb-item-sum">{a.summary}</span>}</span>
                          <Badge tone={a.due_on < new Date().toISOString().slice(0, 10) ? 'danger' : 'warning'}>до {formatDate(a.due_on)}</Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {editor && Boolean(h.drafts) && <Alert tone="info" title={`Черновиков: ${h.drafts}`} action={<LinkButton size="sm" to="/kb/manage?status=draft">Открыть</LinkButton>}>Франчайзи их не видят, пока вы не опубликуете.</Alert>}
              {h.continue.length > 0 && (
                <section>
                  <h2 className="section-title">Продолжить чтение</h2>
                  <div className="kb-continue">{h.continue.map((a) => (
                    <Link key={a.id} to={`/kb/articles/${a.id}`} className="kb-chip-card"><span className="kb-item-title">{a.title}</span><span className="faint">{titleOf(a.section_id)}</span></Link>
                  ))}</div>
                </section>
              )}
              <section>
                <h2 className="section-title">Разделы</h2>
                {tree.length ? <SectionTiles nodes={tree} /> : <EmptyState title="Разделов пока нет" />}
              </section>
              <div className="grid grid-2">
                <Card title="Новое" bodyless>
                  {h.recent.length ? <ul className="kb-list">{h.recent.map((a) => <ArticleItem key={a.id} a={a} sectionTitle={titleOf(a.section_id)} />)}</ul> : <div className="card-body faint">Пока пусто</div>}
                </Card>
                <Card title="Популярное за месяц" bodyless>
                  {h.popular.length ? <ul className="kb-list">{h.popular.map((a) => <ArticleItem key={a.id} a={a} sectionTitle={titleOf(a.section_id)} />)}</ul> : <div className="card-body faint">Появится, когда статьи начнут читать</div>}
                </Card>
              </div>
              {editor && Boolean(misses.data?.length) && (
                <Card title="Искали и не нашли" icon={<SearchX size={18} />}>
                  <p className="faint">Запросы франчайзи и сотрудников без результатов за 60 дней — темы для новых статей.</p>
                  <div className="chips" style={{ marginBottom: 0 }}>{misses.data!.map((m) => <span key={m.query} className="chip" style={{ cursor: 'default' }}>{m.query}{m.times > 1 ? ` ×${m.times}` : ''}</span>)}</div>
                </Card>
              )}
            </div>
          )}
        </DataState>
      )}
      {creating && <NewArticleDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/kb/articles/${id}/edit`)} />}
      {asking && <AskDialog onClose={() => setAsking(false)} />}
    </div>
  );
}

/** Выбор раздела с вложенностью: «Оклейка › Экран». */
export function SectionSelect({ id, value, onChange, topOnly, allowNone }: { id: string; value: string; onChange: (v: string) => void; topOnly?: boolean; allowNone?: string }) {
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections, staleTime: 60_000 });
  const tree = sectionTree(secs.data ?? []);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{allowNone ?? 'Выберите раздел'}</option>
      {tree.map((s) => topOnly ? <option key={s.id} value={s.id}>{s.title}</option> : (
        <optgroup key={s.id} label={s.title}>
          <option value={s.id}>{s.title} (весь раздел)</option>
          {s.children.map((c) => <option key={c.id} value={c.id}>{s.title} › {c.title}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

function NewArticleDialog({ onClose, onCreated, section: initial = '' }: { onClose: () => void; onCreated: (id: string) => void; section?: string }) {
  const [title, setTitle] = useState('');
  const [section, setSection] = useState(initial);
  const [type, setType] = useState('instruction');
  const m = useMutation({ mutationFn: () => kbCommands.create(section, type, title), onSuccess: (r) => onCreated(r.article_id) });
  return (
    <ConfirmDialog open title="Новая статья" confirmLabel="Создать черновик" busy={m.isPending} error={m.error} disabled={!title.trim() || !section}
      onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название" required hint="Как франчайзи будет искать: «Как …», «Что делать, если …»">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Раздел" required>{(id) => <SectionSelect id={id} value={section} onChange={setSection} />}</Field>
        <Field label="Тип">{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
      </div>
    </ConfirmDialog>
  );
}

export function SectionPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const editor = can('kb.edit');
  const navigate = useNavigate();
  const [type, setType] = useState('all');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const q = useQuery({ queryKey: ['kb', 'section', id], queryFn: () => kbSectionPage(id) });
  useEffect(() => setType('all'), [id]);
  return (
    <div className="kb">
      <DataState query={q} skeleton={5}>
        {(p) => {
          const types = [...new Set(p.articles.map((a) => a.type))];
          const hasVideo = p.articles.some((a) => a.has_video);
          const list = p.articles.filter((a) => type === 'all' || (type === 'video' ? a.has_video : a.type === type));
          return (
            <>
              <Crumbs items={[{ to: '/kb', label: 'База знаний' }, ...(p.parent ? [{ to: `/kb/s/${p.parent.id}`, label: p.parent.title }] : []), { label: p.section.title }]} />
              <header className="kb-section-head">
                <SectionIcon icon={p.section.icon} size={26} />
                <div style={{ flex: 1, minWidth: 0 }}><h1>{p.section.title}</h1>{p.section.description && <div className="muted">{p.section.description}</div>}</div>
                {editor && <div className="row">
                  <Button onClick={() => setEditing(true)}><Edit3 size={16} aria-hidden />Раздел</Button>
                  <Button variant="primary" onClick={() => setCreating(true)}><FilePlus size={16} aria-hidden />Статья</Button>
                </div>}
              </header>
              {p.children.length > 0 && <SectionTiles nodes={p.children.map((c) => ({ ...c, children: [] }))} />}
              {p.articles.length > 0 && (types.length > 1 || hasVideo) && (
                <Chips label="Тип статей" value={type} onChange={setType}
                  options={[{ id: 'all', label: `Все (${p.articles.length})` }, ...types.map((t) => ({ id: t, label: TYPE_LABEL[t] ?? t })), ...(hasVideo ? [{ id: 'video', label: 'С видео' }] : [])]} />
              )}
              {list.length > 0 ? (
                <Card bodyless><ul className="kb-list">{list.map((a) => <ArticleItem key={a.id} a={a} editor={editor} />)}</ul></Card>
              ) : p.children.length === 0 && <EmptyState title="В разделе пока нет статей" />}
              {!editor && <p className="faint" style={{ marginTop: 12 }}>Не нашли нужное? <button type="button" className="link-btn" onClick={() => setAsking(true)}>Задайте вопрос менеджеру</button></p>}
              {creating && <NewArticleDialog section={p.section.id} onClose={() => setCreating(false)} onCreated={(aid) => navigate(`/kb/articles/${aid}/edit`)} />}
              {editing && <SectionEditDialog section={p.section} onClose={() => setEditing(false)} onDeleted={() => navigate('/kb')} />}
              {asking && <AskDialog onClose={() => setAsking(false)} />}
            </>
          );
        }}
      </DataState>
    </div>
  );
}

/** «Помогла ли статья?» — сигнал менеджеру, какие статьи переписать. */
function RateBox({ articleId, mine }: { articleId: string; mine: boolean | null }) {
  const qc = useQueryClient();
  const [value, setValue] = useState<boolean | null>(mine);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const m = useMutation({
    mutationFn: ({ helpful, text }: { helpful: boolean; text: string | null }) => kbRate(articleId, helpful, text),
    onSuccess: (_, v) => { setValue(v.helpful); if (v.helpful || v.text) setSent(true); void qc.invalidateQueries({ queryKey: ['kb', 'open', articleId] }); },
  });
  return (
    <div className="kb-rate">
      {sent ? <span className="muted">Спасибо! {value ? 'Рады, что помогло.' : 'Менеджер увидит, что поправить.'}</span> : (
        <>
          <span className="muted">Статья помогла?</span>
          <Button size="sm" variant={value === true ? 'primary' : 'secondary'} onClick={() => m.mutate({ helpful: true, text: null })}><ThumbsUp size={15} aria-hidden />Да</Button>
          <Button size="sm" variant={value === false ? 'primary' : 'secondary'} onClick={() => { setValue(false); m.mutate({ helpful: false, text: null }); }}><ThumbsDown size={15} aria-hidden />Нет</Button>
          {value === false && (
            <div className="kb-rate-more">
              <Input aria-label="Чего не хватило" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Чего не хватило? Например: нет фото, непонятен шаг 3" />
              <Button size="sm" disabled={!comment.trim()} loading={m.isPending} onClick={() => m.mutate({ helpful: false, text: comment })}>Отправить</Button>
            </div>
          )}
        </>
      )}
      <ActionError error={m.error} />
    </div>
  );
}

export function ArticlePage() {
  const { id = '' } = useParams();
  const { me, can } = useSession();
  const editor = can('kb.edit');
  const qc = useQueryClient();
  const toast = useToast();
  const art = useQuery({ queryKey: ['kb', 'article', id], queryFn: () => getArticle(id) });
  const open = useQuery({ queryKey: ['kb', 'open', id], queryFn: () => kbArticleOpen(id), staleTime: 60_000 });
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
        const o = open.data;
        const draft = revs.data?.find((x) => x.status === 'draft');
        const ack = acks.data?.find((x) => a.ack_rev_no !== null && x.rev_no >= a.ack_rev_no);
        const minutes = Math.max(1, Math.round((r?.body.length ?? 0) / 1300));
        return (
          <div className="kb">
            <Crumbs items={[{ to: '/kb', label: 'База знаний' }, ...(o?.parent ? [{ to: `/kb/s/${o.parent.id}`, label: o.parent.title }] : []),
              ...(o ? [{ to: `/kb/s/${o.section.id}`, label: o.section.title }] : [])]} />
            <PageHeader title={r?.title ?? draft?.title ?? 'Черновик'}
              sub={<span className="row">
                <span>{TYPE_LABEL[a.type]}</span>{r && <span>обновлено {formatDate(r.published_at)}</span>}{r && <span><Clock size={13} aria-hidden /> {minutes} мин</span>}
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
            <div className="grid grid-main">
              <div className="stack">
                <Card>
                  {r ? <Markdown source={r.body} /> : <EmptyState title="Статья ещё не опубликована" text="Откройте редактор, допишите и опубликуйте." />}
                  {r && !editor && (
                    <div className="ask-footer">
                      {o && <RateBox articleId={id} mine={o.my_rating} />}
                      <Button size="sm" variant="ghost" onClick={() => setAsk(true)}><HelpCircle size={15} aria-hidden />Остался вопрос</Button>
                    </div>
                  )}
                </Card>
                {Boolean(o?.related.length) && (
                  <Card title={`Ещё в разделе «${o!.section.title}»`} bodyless>
                    <ul className="kb-list">{o!.related.map((x) => <ArticleItem key={x.id} a={x} />)}</ul>
                  </Card>
                )}
              </div>
              <div className="stack kb-side">
                {toc.length > 2 && (
                  <Card title="Содержание">
                    <nav aria-label="Содержание статьи">
                      {toc.map((h) => <div key={h.id} style={{ paddingLeft: h.level === 3 ? 14 : 0, padding: '3px 0' }}><a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' }); }}>{h.text}</a></div>)}
                    </nav>
                  </Card>
                )}
                {editor && o?.stats && (
                  <Card title="Как читают">
                    <div className="kpis" style={{ margin: 0 }}>
                      <div className="kpi"><span className="v">{o.stats.views_30}</span><span className="l">читателей за 30 дней</span></div>
                      <div className="kpi"><span className="v">{o.stats.helpful} / {o.stats.not_helpful}</span><span className="l">помогла / нет</span></div>
                    </div>
                    {o.stats.comments.map((c, i) => <p key={i} className="faint" style={{ marginTop: 8 }}>«{c.comment}» — {c.user}, {formatDate(c.at)}</p>)}
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
            </div>
            {ask && <AskDialog article={id} initial={`По статье «${r?.title ?? ''}»: `} onClose={() => setAsk(false)} />}
          </div>
        );
      }}
    </DataState>
  );
}

function SectionEditDialog({ section, onClose, onDeleted }: { section?: { id: string; title: string; description: string | null; sort: number; parent_id: string | null; icon: string }; onClose: () => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(section?.title ?? '');
  const [description, setDescription] = useState(section?.description ?? '');
  const [parent, setParent] = useState(section?.parent_id ?? '');
  const [icon, setIcon] = useState(section?.icon ?? 'book');
  const [sort, setSort] = useState(String(section?.sort ?? 100));
  const save = useMutation({
    mutationFn: () => kbCommands.sectionSave({ id: section?.id ?? null, parent: parent || null, title, description: description || null, sort: Number(sort) || 100, icon }),
    onSuccess: () => { toast('Раздел сохранён'); void qc.invalidateQueries({ queryKey: ['kb'] }); onClose(); },
  });
  const del = useMutation({ mutationFn: () => kbCommands.sectionDelete(section!.id), onSuccess: () => { toast('Раздел удалён'); void qc.invalidateQueries({ queryKey: ['kb'] }); onClose(); onDeleted?.(); } });
  return (
    <ConfirmDialog open title={section ? 'Раздел' : 'Новый раздел'} confirmLabel="Сохранить" cancelLabel="Закрыть" busy={save.isPending} error={save.error ?? del.error}
      disabled={!title.trim()} onClose={onClose} onConfirm={() => save.mutate()}>
      <Field label="Название" required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label="Описание" hint="Одна строка: что внутри">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Входит в раздел" hint="Пусто — раздел верхнего уровня">{(id) => <SectionSelect id={id} value={parent} onChange={setParent} topOnly allowNone="Верхний уровень" />}</Field>
        <Field label="Порядок" hint="Меньше — выше">{(id) => <Input id={id} inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />}</Field>
      </div>
      <Field label="Значок">{() => (
        <div className="icon-pick" role="radiogroup" aria-label="Значок">
          {Object.keys(SECTION_ICON).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={icon === k} title={ICON_LABEL[k]} className="icon-pick-btn" onClick={() => setIcon(k)}><SectionIcon icon={k} size={18} /></button>
          ))}
        </div>
      )}</Field>
      {section && <Button size="sm" variant="ghost" loading={del.isPending} onClick={() => del.mutate()}><Trash2 size={14} aria-hidden />Удалить раздел</Button>}
    </ConfirmDialog>
  );
}

/** Менеджеру: все статьи одной таблицей и структура разделов. */
export function KbManagePage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState(params.get('status') ?? 'all');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'articles' | 'sections'>('articles');
  const [edit, setEdit] = useState<SectionNode | 'new' | null>(null);
  const rows = useQuery({ queryKey: ['kb', 'manage'], queryFn: kbManage });
  const secs = useQuery({ queryKey: ['kb', 'home'], queryFn: kbHome });
  const tree = useMemo(() => sectionTree(secs.data?.sections ?? []), [secs.data]);
  if (!can('kb.edit')) return <EmptyState title="Раздел для менеджера по франшизе" />;
  const list = (rows.data ?? []).filter((a) =>
    (filter === 'all' || (filter === 'draft' ? a.status === 'draft' || a.has_draft : filter === 'required' ? a.required_ack : filter === 'low' ? a.not_helpful > a.helpful : a.status === filter))
    && (!q.trim() || a.title.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div className="kb">
      <Crumbs items={[{ to: '/kb', label: 'База знаний' }, { label: 'Управление' }]} />
      <PageHeader title="Управление базой знаний" sub="Все статьи, их читаемость и оценки; структура разделов" />
      <div className="tabs" role="tablist" aria-label="Управление">
        <button type="button" role="tab" aria-selected={tab === 'articles'} onClick={() => setTab('articles')}>Статьи</button>
        <button type="button" role="tab" aria-selected={tab === 'sections'} onClick={() => setTab('sections')}>Разделы</button>
      </div>
      {tab === 'articles' ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <Input aria-label="Найти статью" placeholder="Найти по названию" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
          </div>
          <Chips label="Фильтр" value={filter} onChange={(v) => { setFilter(v); setParams(v === 'all' ? {} : { status: v }, { replace: true }); }}
            options={[{ id: 'all', label: 'Все' }, { id: 'published', label: 'Опубликованы' }, { id: 'draft', label: 'Черновики и правки' }, { id: 'archived', label: 'Архив' },
              { id: 'required', label: 'Обязательные' }, { id: 'low', label: 'Плохие оценки' }]} />
          <DataState query={rows} empty={() => (list.length ? null : <EmptyState title="Ничего не найдено" />)}>
            {() => (
              <div className="table-wrap card">
                <table className="table">
                  <thead><tr><th>Статья</th><th>Раздел</th><th>Статус</th><th className="r">Читателей 30 дн.</th><th className="r">Помогла / нет</th><th className="r">Ознакомились</th><th>Обновлена</th></tr></thead>
                  <tbody>{list.map((a) => (
                    <tr key={a.id}>
                      <td><Link to={`/kb/articles/${a.id}`}><strong>{a.title}</strong></Link>{a.has_video && <span className="kb-video"> · <PlayCircle size={12} aria-hidden /> видео</span>}</td>
                      <td className="faint">{a.parent_title ? `${a.parent_title} › ` : ''}{a.section_title}</td>
                      <td><Badge tone={st(ARTICLE_STATUS, a.status)[1]}>{st(ARTICLE_STATUS, a.status)[0]}</Badge>{a.has_draft && a.status === 'published' && <div className="faint">есть черновик</div>}</td>
                      <td className="r num">{a.views_30}</td>
                      <td className={`r num${a.not_helpful > a.helpful ? ' danger-text' : ''}`}>{a.helpful} / {a.not_helpful}</td>
                      <td className="r num">{a.ack_total ? `${a.ack_done}/${a.ack_total}` : '—'}</td>
                      <td className="faint">{formatDate(a.updated_at)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </DataState>
        </>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}><Button variant="primary" onClick={() => setEdit('new')}><FolderTree size={16} aria-hidden />Новый раздел</Button></div>
          <p className="faint">Два уровня: раздел и подраздел. Хорошая структура — 5–9 разделов верхнего уровня по задачам франчайзи («Оклейка», «Оборудование», «Клиенты»), а не по отделам компании.</p>
          <DataState query={secs}>
            {() => (
              <Card bodyless>
                <ul className="kb-list">
                  {tree.map((s) => (
                    <li key={s.id}>
                      <div className="kb-tree-row">
                        <SectionIcon icon={s.icon} size={18} /><Link to={`/kb/s/${s.id}`}><strong>{s.title}</strong></Link><span className="faint">{s.count} ст.</span>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(s)}><Edit3 size={14} aria-hidden />Изменить</Button>
                      </div>
                      {s.children.map((c) => (
                        <div key={c.id} className="kb-tree-row sub">
                          <span className="faint">└</span><Link to={`/kb/s/${c.id}`}>{c.title}</Link><span className="faint">{c.count} ст.</span>
                          <Button size="sm" variant="ghost" onClick={() => setEdit(c)}><Edit3 size={14} aria-hidden />Изменить</Button>
                        </div>
                      ))}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </DataState>
          {edit && <SectionEditDialog section={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
        </>
      )}
    </div>
  );
}
