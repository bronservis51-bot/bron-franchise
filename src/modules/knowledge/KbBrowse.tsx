// Поиск, каталог тем и отдельные рабочие подборки. Редакторские действия собраны в управлении.
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, ArchiveRestore, BookOpen, Check, ChevronRight, ClipboardList, Clock, Edit3, FilePlus, FolderTree, GraduationCap, HelpCircle, Megaphone,
  MessageCircleQuestion, PlayCircle, Rocket, Scissors, Search, SearchX, Settings2, ShieldCheck, Smartphone, Star, ThumbsDown, ThumbsUp, Trash2, Users, Wallet, Wrench, X,
} from 'lucide-react';
import { command } from '../../platform/backend';
import { useLocale, type Language } from '../../platform/locale';
import { useSession } from '../../platform/session';
import { formatDate, formatDateTime } from '../../platform/dates';
import { ActionError, Alert, Badge, Button, Card, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, LinkButton, PageHeader, Select } from '../../ui';
import { ARTICLE_STATUS, st } from '../../ui/status';
import { headings, Markdown } from '../../ui/markdown';
import { useToast } from '../../ui/toast';
import {
  getArticle, getRevision, kbArticleOpen, kbCommands, kbHome, kbManage, kbMisses, kbRate, kbSectionPage, myAcks, revisionsOf, search, sectionTree, sections, toRead,
  TYPE_LABEL, type Card as ArticleCard, type KbHome, type SectionNode, type ToRead,
} from './api';
import { AckStatusCard, AskDialog } from './KnowledgePages';
import { KbJourneys } from './KbJourneys';
import './knowledge.css';

export const SECTION_ICON: Record<string, ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  book: BookOpen, rocket: Rocket, smartphone: Smartphone, scissors: Scissors, shield: ShieldCheck, users: Users, wallet: Wallet,
  megaphone: Megaphone, wrench: Wrench, graduation: GraduationCap, star: Star, clipboard: ClipboardList,
};
const ICON_LABEL: Record<string, string> = { book: 'Книга', rocket: 'Старт', smartphone: 'Смартфон', scissors: 'Резка', shield: 'Гарантия', users: 'Клиенты',
  wallet: 'Деньги', megaphone: 'Маркетинг', wrench: 'Оборудование', graduation: 'Обучение', star: 'Важное', clipboard: 'Регламенты' };

const TURKISH_TYPE: Record<string, string> = { article: 'Makale', instruction: 'Kılavuz', faq: 'Sık sorulan sorular', regulation: 'Prosedür', checklist: 'Kontrol listesi' };
function typeLabel(type: string, language: Language) {
  return (language === 'tr' ? TURKISH_TYPE[type] : TYPE_LABEL[type]) ?? type;
}

function SectionIcon({ icon, size = 20 }: { icon: string; size?: number }) {
  const I = SECTION_ICON[icon] ?? BookOpen;
  return <span className="kb-icon" aria-hidden><I size={size} aria-hidden /></span>;
}

function Snippet({ html }: { html: string }) {
  const parts = html.split(/(«[^»]*»)/g);
  return <>{parts.map((p, i) => (p.startsWith('«') && p.endsWith('»') ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

function Crumbs({ items }: { items: { to?: string; label: string }[] }) {
  const { t } = useLocale();
  return (
    <nav className="kb-crumbs" aria-label={t('Путь', 'İzlenen yol')}>
      {items.map((c, i) => (
        <span key={i}>{i > 0 && <ChevronRight size={14} aria-hidden />}{c.to ? <Link to={c.to}>{c.label}</Link> : <span>{c.label}</span>}</span>
      ))}
    </nav>
  );
}

/** Строка статьи в списках: название, суть, значки «обязательно», «видео», время чтения, прочитано. */
function ArticleItem({ a, editor, sectionTitle }: { a: ArticleCard; editor?: boolean; sectionTitle?: string }) {
  const { t, language } = useLocale();
  return (
    <li>
      <Link className="kb-item" to={`/kb/articles/${a.id}`}>
        <span className="kb-item-main">
          <span className="kb-item-title">{a.title}</span>
          {a.summary && <span className="kb-item-sum">{a.summary}</span>}
          <span className="kb-item-meta">
            <span>{typeLabel(a.type, language)}</span>
            {sectionTitle && <span>{sectionTitle}</span>}
            <span><Clock size={12} aria-hidden /> {a.minutes} {t('мин', 'dk')}</span>
            {a.has_video && <span className="kb-video"><PlayCircle size={12} aria-hidden /> {t('видео', 'video')}</span>}
            {a.required_ack && <span className="kb-required">{t('обязательно', 'okunması gerekiyor')}</span>}
            {editor && a.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, a.status)[1]}>{st(ARTICLE_STATUS, a.status)[0]}</Badge>}
            {editor && a.has_draft && a.status === 'published' && <span>{t('есть черновик', 'taslak var')}</span>}
            {editor && <span>{a.views_30} просм. за 30 дн.</span>}
          </span>
        </span>
        {!editor && a.read && <span className="kb-read" title={t('Вы открывали эту статью', 'Bu makaleyi daha önce açtınız')}><Check size={16} aria-hidden /></span>}
        <ChevronRight size={16} className="todo-chevron" aria-hidden />
      </Link>
    </li>
  );
}

/** The URL is the source of truth: a returned article preserves the query and filters. */
function KbSearch() {
  const { t, language } = useLocale();
  const { can } = useSession();
  const editor = can('kb.edit');
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const includeDrafts = editor && params.get('drafts') === '1';
  const requestedType = params.get('type') ?? 'all';
  const filter = Object.hasOwn(TYPE_LABEL, requestedType) ? requestedType : 'all';
  const [debounced, setDebounced] = useState(q.trim());
  const [asking, setAsking] = useState<string | null>(null);
  const active = q.trim().length >= 2;
  useEffect(() => { const h = setTimeout(() => setDebounced(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  const results = useQuery({ queryKey: ['kb', 'search', debounced, includeDrafts], enabled: active && debounced.length >= 2, queryFn: () => search(debounced, includeDrafts) });
  function update(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key === 'q') next.delete('type');
    setParams(next, { replace: true });
  }
  const waiting = q.trim() !== debounced;
  return (
    <>
      <section className="kb-search-panel" aria-label={t('Поиск по базе знаний', 'Bilgi bankasında ara')}>
        <label className="sr-only" htmlFor="kb-q">{t('Поиск по базе знаний', 'Bilgi bankasında ara')}</label>
        <div className="kb-search-box" role="search">
          <Search size={20} aria-hidden />
          <input id="kb-q" type="search" className="kb-search-input" placeholder={t('Найти статью', 'Makale ara')}
            value={q} onChange={(e) => update('q', e.target.value)} autoComplete="off" maxLength={200}
            aria-describedby={q.trim().length === 1 ? 'kb-search-hint' : undefined} aria-controls={active ? 'kb-search-results' : undefined} />
          {q && <button type="button" className="kb-search-clear" aria-label={t('Очистить поиск', 'Aramayı temizle')} title={t('Очистить поиск', 'Aramayı temizle')}
            onClick={() => { update('q', ''); document.getElementById('kb-q')?.focus(); }}><X size={18} aria-hidden /></button>}
        </div>
        {q.trim().length === 1 && <div id="kb-search-hint" className="kb-search-hint" role="status">{t('Введите ещё один символ', 'Bir karakter daha girin')}</div>}
      </section>
      {active && (
        <Card bodyless className="kb-results">
          <div className="kb-search-filters">
            <label>{t('Формат', 'Tür')} <Select aria-label={t('Формат результата', 'Sonuç türü')} value={filter} onChange={e => update('type', e.target.value === 'all' ? '' : e.target.value)}>
              <option value="all">{t('Все материалы', 'Tüm içerikler')}</option>{Object.keys(TYPE_LABEL).map(id => <option key={id} value={id}>{typeLabel(id, language)}</option>)}
            </Select></label>
            {editor && <label className="kb-draft-switch"><input type="checkbox" checked={includeDrafts} onChange={e => update('drafts', e.target.checked ? '1' : '')} />{t('Включая черновики', 'Taslaklar dahil')}</label>}
          </div>
          <div id="kb-search-results" aria-busy={waiting || results.isFetching}>
            {waiting ? <p className="card-body faint" role="status">{t('Ищем ответ…', 'Aranıyor…')}</p> : <DataState query={results}>
              {(all) => {
                const found = filter === 'all' ? all : all.filter(h => h.type === filter);
                return <>
                  <div className="kb-results-head faint" role="status">{all.length >= 100 ? t(`Первые 100 совпадений · показано ${found.length}. Уточните запрос, чтобы сузить поиск.`, `İlk 100 sonuçtan ${found.length} tanesi gösteriliyor. Daha ayrıntılı arayın.`) : t(`Найдено: ${found.length}`, `${found.length} sonuç`)}</div>
                  {found.length ? <ul className="kb-list">
                    {found.map((h) => (
                      <li key={h.article_id}>
                        <Link className="kb-item" to={`/kb/articles/${h.article_id}`}>
                          <span className="kb-item-main">
                            <span className="kb-item-title">{h.title}</span>
                            <span className="kb-item-sum kb-search-snippet"><Snippet html={h.snippet} /></span>
                            <span className="kb-item-meta"><span>{typeLabel(h.type, language)}</span><span>{h.section_title}</span>
                              {h.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, h.status)[1]}>{st(ARTICLE_STATUS, h.status)[0]}</Badge>}</span>
                          </span>
                          <ChevronRight size={16} className="todo-chevron" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul> : <EmptyState title={all.length ? t('В этом формате ничего нет', 'Bu türde sonuç yok') : t('Пока не нашли ответ', 'Sonuç bulunamadı')} icon={<SearchX size={22} aria-hidden />}
                    text={all.length ? t('Попробуйте показать все форматы материалов.', 'Tüm içerik türlerini göstermeyi deneyin.') : t('Попробуйте назвать проблему другими словами. Если материала ещё нет, отправьте вопрос менеджеру.', 'İçerikler yayımlandıkları dilde aranır. Başka sözcüklerle arayın veya yöneticinize sorun.')}
                    action={all.length ? <Button onClick={() => update('type', '')}>{t('Все форматы', 'Tüm türler')}</Button> : <Button variant="primary" onClick={() => setAsking(debounced)}><HelpCircle size={16} aria-hidden />{t('Задать вопрос', 'Soru sor')}</Button>} />}
                  {found.length > 0 && <div className="card-body faint">{t('Не нашли нужного?', 'Aradığınızı bulamadınız mı?')} <button type="button" className="link-btn" onClick={() => setAsking(debounced)}>{t('Задайте вопрос менеджеру', 'Yöneticinize sorun')}</button></div>}
                </>;
              }}
            </DataState>}
          </div>
        </Card>
      )}
      {asking !== null && <AskDialog initial={asking} onClose={() => setAsking(null)} />}
    </>
  );
}

function SectionTiles({ nodes, compact }: { nodes: (SectionNode & { children: SectionNode[] })[]; compact?: boolean }) {
  const { t } = useLocale();
  return (
    <div className={compact ? 'kb-tiles kb-tiles-compact' : 'kb-tiles'}>
      {nodes.map((s) => (
        <Link key={s.id} to={`/kb/s/${s.id}`} className="kb-tile">
          <SectionIcon icon={s.icon} size={22} />
          <span className="kb-tile-main">
            <span className="kb-tile-title">{s.title}</span>
            {!compact && (s.children.length > 0
              ? <span className="kb-tile-subs">{s.children.map((c) => c.title).join(', ')}</span>
              : s.description && <span className="kb-tile-desc">{s.description}</span>)}
          </span>
          <span className="kb-tile-count" aria-label={t(`Опубликовано материалов: ${s.count}`, `Yayımlanan içerik: ${s.count}`)}>{s.count || t('Пусто', 'Boş')}</span>
        </Link>
      ))}
    </div>
  );
}

const HOME_VIEWS = [
  { id: 'topics', title: 'Темы', tr: 'Konular', to: '/kb' },
  { id: 'tasks', title: 'Задачи', tr: 'Görevler', to: '/kb?view=tasks' },
  { id: 'reading', title: 'Подборки', tr: 'Derlemeler', to: '/kb?view=reading' },
] as const;

function KbCollections({ home, reading }: { home: KbHome; reading: ToRead[] }) {
  const { t, locale } = useLocale();
  const titleOf = (id: string) => home.sections.find((s) => s.id === id)?.title;
  return <div className="stack">
    {reading.length > 0 && (
      <Card title={t('Нужно прочитать', 'Okunması gerekenler')} bodyless className="to-read">
        <ul className="kb-list">
          {reading.map((a) => (
            <li key={a.article_id}>
              <Link className="kb-item" to={`/kb/articles/${a.article_id}`}>
                <span className="kb-item-main"><span className="kb-item-title">{a.title}</span>{a.summary && <span className="kb-item-sum">{a.summary}</span>}</span>
                <Badge tone={a.due_on < new Date().toISOString().slice(0, 10) ? 'danger' : 'warning'}>{t('до', 'Son tarih:')} {formatDate(a.due_on, locale)}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    )}
    {home.continue.length > 0 && (
      <Card title={t('Продолжить чтение', 'Okumaya devam et')} bodyless>
        <ul className="kb-list">{home.continue.map((a) => <ArticleItem key={a.id} a={a} sectionTitle={titleOf(a.section_id)} />)}</ul>
      </Card>
    )}
    <div className="grid grid-2">
      <Card title={t('Новое', 'Yeni içerikler')} bodyless>
        {home.recent.length ? <ul className="kb-list">{home.recent.map((a) => <ArticleItem key={a.id} a={a} sectionTitle={titleOf(a.section_id)} />)}</ul> : <div className="card-body faint">{t('Пока пусто', 'Henüz içerik yok')}</div>}
      </Card>
      <Card title={t('Популярное за месяц', 'Bu ayın popüler içerikleri')} bodyless>
        {home.popular.length ? <ul className="kb-list">{home.popular.map((a) => <ArticleItem key={a.id} a={a} sectionTitle={titleOf(a.section_id)} />)}</ul> : <div className="card-body faint">{t('Появится, когда статьи начнут читать', 'Makaleler okundukça burada görünür')}</div>}
      </Card>
    </div>
  </div>;
}

export function KbHomePage() {
  const { t } = useLocale();
  const { can } = useSession();
  const editor = can('kb.edit');
  const [params] = useSearchParams();
  const searching = (params.get('q') ?? '').trim().length >= 2;
  const requestedView = params.get('view');
  const view = requestedView === 'reading' ? 'reading' : requestedView === 'tasks' || params.has('path') ? 'tasks' : 'topics';
  const [asking, setAsking] = useState<string | null>(null);
  const home = useQuery({ queryKey: ['kb', 'home', editor], queryFn: kbHome, enabled: !searching });
  const reading = useQuery({ queryKey: ['kb', 'to-read'], enabled: !editor, queryFn: toRead });
  const inbox = useQuery({ queryKey: ['kb', 'inbox'], queryFn: () => command<{ unanswered: number; new_answers: number }>('kb_inbox') });
  const tree = useMemo(() => sectionTree(home.data?.sections ?? []), [home.data]);
  const required = editor ? 0 : reading.data?.length ?? 0;
  const questions = editor ? t('Вопросы', 'Sorular') : t('Мои вопросы', 'Sorularım');
  const notifications = (editor ? inbox.data?.unanswered : inbox.data?.new_answers) ?? 0;

  return (
    <div className="kb kb-home">
      <PageHeader title={t('База знаний', 'Bilgi bankası')} />
      <KbSearch />
      {!searching && (
        <>
          <div className="kb-home-links">
            <nav className="kb-home-views" aria-label={t('Материалы базы знаний', 'Bilgi bankası içerikleri')}>
              {HOME_VIEWS.map((item) => <Link key={item.id} to={item.to} className="kb-home-link"
                aria-current={view === item.id ? 'page' : undefined}>{t(item.title, item.tr)}</Link>)}
            </nav>
            <nav className="kb-home-actions" aria-label={t('Действия базы знаний', 'Bilgi bankası işlemleri')}>
              {view !== 'reading' && required > 0 && <Link className="kb-home-link kb-reading-link" to="/kb?view=reading">
                <ClipboardList size={16} aria-hidden />{t('Нужно прочитать', 'Okunması gerekenler')} <span className="kb-home-count">{required}</span>
              </Link>}
              <Link className="kb-home-link" to="/kb/questions"
                aria-label={notifications ? `${questions}. ${editor ? t('Без ответа', 'Yanıt bekleyen') : t('Новых ответов', 'Yeni yanıt')} ${notifications}` : undefined}>
                <MessageCircleQuestion size={16} aria-hidden />{questions}
                {notifications > 0 && <span className="kb-home-count" aria-hidden>{notifications}</span>}
              </Link>
              {editor && <Link className="kb-home-link" to="/kb/manage"><Settings2 size={16} aria-hidden />{t('Управление', 'Yönetim')}</Link>}
            </nav>
          </div>
          <DataState query={home} skeleton={3}>
            {(h) => {
              if (view === 'tasks') return <KbJourneys nodes={h.sections} onAsk={setAsking} />;
              if (view === 'reading') return <KbCollections home={h} reading={editor ? [] : reading.data ?? []} />;
              return <section aria-labelledby="kb-topics-title">
                <div className="kb-section-label"><h2 id="kb-topics-title">{t('Все темы', 'Tüm konular')}</h2></div>
                {tree.length ? <SectionTiles nodes={tree} compact /> : <EmptyState title={t('Разделов пока нет', 'Henüz bölüm yok')} />}
              </section>;
            }}
          </DataState>
        </>
      )}
      {asking !== null && <AskDialog initial={asking} onClose={() => setAsking(null)} />}
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
  const { t } = useLocale();
  const [title, setTitle] = useState('');
  const [section, setSection] = useState(initial);
  const [type, setType] = useState('instruction');
  const m = useMutation({ mutationFn: () => kbCommands.create(section, type, title), onSuccess: (r) => onCreated(r.article_id) });
  return (
    <ConfirmDialog open title="Новая статья" confirmLabel="Создать черновик" busy={m.isPending} error={m.error} disabled={!title.trim() || !section}
      onClose={onClose} onConfirm={() => m.mutate()}>
      <Field label="Название" required hint="Как франчайзи будет искать: «Как …», «Что делать, если …»">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label={t('Раздел', 'Bölüm')} required>{(id) => <SectionSelect id={id} value={section} onChange={setSection} />}</Field>
        <Field label="Тип">{(id) => <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
      </div>
    </ConfirmDialog>
  );
}

export function SectionPage() {
  const { t, language } = useLocale();
  const { id = '' } = useParams();
  const { can } = useSession();
  const editor = can('kb.edit');
  const navigate = useNavigate();
  const [type, setType] = useState('all');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [query, setQuery] = useState('');
  const q = useQuery({ queryKey: ['kb', 'section', id, editor], queryFn: () => kbSectionPage(id) });
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
              <Crumbs items={[{ to: '/kb', label: t('База знаний', 'Bilgi bankası') }, ...(p.parent ? [{ to: `/kb/s/${p.parent.id}`, label: p.parent.title }] : []), { label: p.section.title }]} />
              <header className="kb-section-head">
                <SectionIcon icon={p.section.icon} size={26} />
                <div className="kb-section-title"><h1>{p.section.title}</h1>{p.section.description && <div className="muted">{p.section.description}</div>}</div>
                {editor && <div className="row kb-section-actions">
                  <Button onClick={() => setEditing(true)}><Edit3 size={16} aria-hidden />{t('Раздел', 'Bölüm')}</Button>
                  <Button variant="primary" onClick={() => setCreating(true)}><FilePlus size={16} aria-hidden />{t('Статья', 'Makale')}</Button>
                </div>}
              </header>
              <form className="kb-section-search" role="search" onSubmit={e => { e.preventDefault(); if (query.trim().length >= 2) navigate(`/kb?q=${encodeURIComponent(query.trim())}`); }}>
                <Search size={18} aria-hidden />
                <Input aria-label={t('Поиск по всей базе знаний', 'Tüm bilgi bankasında ara')} value={query} onChange={e => setQuery(e.target.value)} placeholder={t('Найти ответ во всей базе', 'Tüm bilgi bankasında ara')} maxLength={200} />
                <Button type="submit" disabled={query.trim().length < 2}>{t('Найти', 'Ara')}</Button>
              </form>
              {p.children.length > 0 && <SectionTiles nodes={p.children.map((c) => ({ ...c, children: [] }))} />}
              {p.articles.length > 0 && (types.length > 1 || hasVideo) && (
                <Chips label={t('Тип статей', 'İçerik türü')} value={type} onChange={setType}
                  options={[{ id: 'all', label: t(`Все (${p.articles.length})`, `Tümü (${p.articles.length})`) }, ...types.map((t) => ({ id: t, label: typeLabel(t, language) })), ...(hasVideo ? [{ id: 'video', label: t('С видео', 'Videolu') }] : [])]} />
              )}
              {list.length > 0 ? (
                <Card bodyless><ul className="kb-list">{list.map((a) => <ArticleItem key={a.id} a={a} editor={editor} />)}</ul></Card>
              ) : p.children.length === 0 && <EmptyState title={t('В этом разделе пока нет материалов', 'Bu bölümde henüz içerik yok')}
                action={<Button onClick={() => setAsking(true)}>{t('Задать вопрос', 'Soru sor')}</Button>} />}
              {!editor && (list.length > 0 || p.children.length > 0) && <p className="faint" style={{ marginTop: 12 }}><button type="button" className="link-btn" onClick={() => setAsking(true)}>{t('Задать вопрос', 'Soru sor')} менеджеру</button></p>}
              {creating && <NewArticleDialog section={p.section.id} onClose={() => setCreating(false)} onCreated={(aid) => navigate(`/kb/articles/${aid}/edit`)} />}
              {editing && <SectionEditDialog section={p.section} onClose={() => setEditing(false)} onDeleted={() => navigate('/kb')} />}
              {asking && <AskDialog initial={`${p.section.title}: `} onClose={() => setAsking(false)} />}
            </>
          );
        }}
      </DataState>
    </div>
  );
}

/** «Помогла ли статья?» — сигнал менеджеру, какие статьи переписать. */
function RateBox({ articleId, mine }: { articleId: string; mine: boolean | null }) {
  const { t } = useLocale();
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
      {sent ? <span className="muted">{t('Спасибо!', 'Teşekkürler!')} {value ? t('Рады, что помогло.', 'Yardımcı olabildiğimize sevindik.') : t('Менеджер увидит, что поправить.', 'Yöneticiniz geri bildiriminizi görecek.')}</span> : (
        <>
          <span className="muted">{t('Статья помогла?', 'Makale işinize yaradı mı?')}</span>
          <Button size="sm" variant={value === true ? 'primary' : 'secondary'} onClick={() => m.mutate({ helpful: true, text: null })}><ThumbsUp size={15} aria-hidden />{t('Да', 'Evet')}</Button>
          <Button size="sm" variant={value === false ? 'primary' : 'secondary'} onClick={() => { setValue(false); m.mutate({ helpful: false, text: null }); }}><ThumbsDown size={15} aria-hidden />{t('Нет', 'Hayır')}</Button>
          {value === false && (
            <div className="kb-rate-more">
              <Input aria-label={t('Чего не хватило', 'Eksik olan neydi?')} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('Чего не хватило? Например: нет фото, непонятен шаг 3', 'Eksik olan neydi? Örneğin fotoğraf eksik veya 3. adım belirsiz.')} />
              <Button size="sm" disabled={!comment.trim()} loading={m.isPending} onClick={() => m.mutate({ helpful: false, text: comment })}>{t('Отправить', 'Gönder')}</Button>
            </div>
          )}
        </>
      )}
      <ActionError error={m.error} />
    </div>
  );
}

export function ArticlePage() {
  const { t, language, locale } = useLocale();
  const { id = '' } = useParams();
  const { me, can } = useSession();
  const editor = can('kb.edit');
  const qc = useQueryClient();
  const toast = useToast();
  const art = useQuery({ queryKey: ['kb', 'article', id, editor], queryFn: () => getArticle(id) });
  const open = useQuery({ queryKey: ['kb', 'open', id, editor], queryFn: () => kbArticleOpen(id), staleTime: 60_000 });
  const rev = useQuery({ queryKey: ['kb', 'rev', art.data?.published_revision_id], enabled: Boolean(art.data?.published_revision_id), queryFn: () => getRevision(art.data!.published_revision_id!) });
  const acks = useQuery({ queryKey: ['kb', 'my-ack', id], enabled: Boolean(art.data?.required_ack && !editor), queryFn: () => myAcks(id, me!.user.id) });
  const revs = useQuery({ queryKey: ['kb', 'revs', id, editor], enabled: editor, queryFn: () => revisionsOf(id) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['kb'] });
  const acknowledge = useMutation({ mutationFn: () => kbCommands.acknowledge(id), onSuccess: () => { toast(t('Отмечено: вы ознакомились', 'Okuduğunuz kaydedildi')); void refresh(); } });
  const archive = useMutation({ mutationFn: (v: boolean) => kbCommands.archive(id, v), onSuccess: (_, v) => { toast(v ? t('Статья в архиве', 'Makale arşivlendi') : t('Статья возвращена', 'Makale arşivden çıkarıldı')); void refresh(); } });
  const toc = useMemo(() => headings(rev.data?.body ?? ''), [rev.data?.body]);
  const [ask, setAsk] = useState(false);

  return (
    <DataState query={art} empty={(a) => (a ? null : <EmptyState title={t('Статья не найдена', 'Makale bulunamadı')} text={t('Материал снят с публикации или недоступен.', 'İçerik yayından kaldırılmış veya erişime kapalı.')} />)}>
      {(a) => {
        if (!a) return null;
        const r = rev.data;
        const o = open.data;
        const draft = editor ? revs.data?.find((x) => x.status === 'draft') : undefined;
        const ack = acks.data?.find((x) => a.ack_rev_no !== null && x.rev_no >= a.ack_rev_no);
        const minutes = Math.max(1, Math.round((r?.body.length ?? 0) / 1300));
        return (
          <div className="kb">
            <Crumbs items={[{ to: '/kb', label: t('База знаний', 'Bilgi bankası') }, ...(o?.parent ? [{ to: `/kb/s/${o.parent.id}`, label: o.parent.title }] : []),
              ...(o ? [{ to: `/kb/s/${o.section.id}`, label: o.section.title }] : [])]} />
            <PageHeader title={r?.title ?? draft?.title ?? t('Черновик', 'Taslak')}
              sub={<span className="row">
                <span>{typeLabel(a.type, language)}</span>{r && <span>{t('обновлено', 'Güncelleme:')} {formatDate(r.published_at, locale)}</span>}{r && <span><Clock size={13} aria-hidden /> {minutes} {t('мин', 'dk')}</span>}
                {a.status !== 'published' && <Badge tone={st(ARTICLE_STATUS, a.status)[1]}>{st(ARTICLE_STATUS, a.status)[0]}</Badge>}
              </span>}
              actions={editor && (
                <>
                  <LinkButton to={`/kb/articles/${id}/edit`} variant={draft ? 'primary' : 'secondary'}><Edit3 size={16} aria-hidden />{draft && r ? t('Есть неопубликованные правки', 'Yayımlanmamış değişiklikler var') : t('Редактировать', 'Düzenle')}</LinkButton>
                  {a.status === 'archived'
                    ? <Button variant="ghost" loading={archive.isPending} onClick={() => archive.mutate(false)}><ArchiveRestore size={16} aria-hidden />{t('Вернуть из архива', 'Arşivden çıkar')}</Button>
                    : r && <Button variant="ghost" loading={archive.isPending} onClick={() => archive.mutate(true)}><Archive size={16} aria-hidden />{t('В архив', 'Arşivle')}</Button>}
                </>
              )} />
            {toc.length > 2 && <details className="kb-mobile-toc">
              <summary>{t('Содержание статьи', 'Makale içindekiler')}</summary>
              <nav aria-label={t('Содержание статьи на телефоне', 'Makalenin içindekiler listesi')}>{toc.map(h => <a key={h.id} className={h.level === 3 ? 'sub' : undefined} href={`#${h.id}`} onClick={e => {
                e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' });
              }}>{h.text}</a>)}</nav>
            </details>}
            {a.required_ack && r && !editor && !acks.isLoading && (
              <div style={{ marginBottom: 16 }}>
                {ack ? <Alert tone="success">{t('Вы ознакомились', 'Okuma onayınız:')} {formatDateTime(ack.at, locale)}.</Alert>
                  : <Alert tone="warning" title={t('Обязательно к ознакомлению', 'Okumanız gerekiyor')} action={<Button variant="primary" loading={acknowledge.isPending} onClick={() => acknowledge.mutate()}><Check size={16} aria-hidden />{t('Ознакомлен', 'Okudum')}</Button>}>
                      Прочитайте материал и подтвердите ознакомление.</Alert>}
                <ActionError error={acknowledge.error} />
              </div>
            )}
            <div className="grid grid-main">
              <div className="stack">
                <Card>
                  {r ? <Markdown source={r.body} /> : <EmptyState title={t('Статья ещё не опубликована', 'Makale henüz yayımlanmadı')} text={t('Откройте редактор, допишите и опубликуйте.', 'Makaleyi düzenleyip yayımlayın.')} />}
                  {r && !editor && (
                    <div className="ask-footer">
                      {o && <RateBox articleId={id} mine={o.my_rating} />}
                      <Button size="sm" variant="ghost" onClick={() => setAsk(true)}><HelpCircle size={15} aria-hidden />{t('Остался вопрос', 'Bir sorum var')}</Button>
                    </div>
                  )}
                </Card>
                {Boolean(o?.related.length) && (
                  <Card title={t(`Ещё в разделе «${o!.section.title}»`, `«${o!.section.title}» bölümünden diğer içerikler`)} bodyless>
                    <ul className="kb-list">{o!.related.map((x) => <ArticleItem key={x.id} a={x} />)}</ul>
                  </Card>
                )}
              </div>
              <div className="stack kb-side">
                {toc.length > 2 && (
                  <Card title={t('Содержание', 'İçindekiler')} className="kb-desktop-toc">
                    <nav aria-label={t('Содержание статьи', 'Makale içindekiler')}>
                      {toc.map((h) => <div key={h.id} style={{ paddingLeft: h.level === 3 ? 14 : 0, padding: '3px 0' }}><a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth' }); }}>{h.text}</a></div>)}
                    </nav>
                  </Card>
                )}
                {editor && o?.stats && (
                  <Card title={t('Как читают', 'Okuma istatistikleri')}>
                    <div className="kpis" style={{ margin: 0 }}>
                      <div className="kpi"><span className="v">{o.stats.views_30}</span><span className="l">читателей за 30 дней</span></div>
                      <div className="kpi"><span className="v">{o.stats.helpful} / {o.stats.not_helpful}</span><span className="l">помогла / нет</span></div>
                    </div>
                    {o.stats.comments.map((c, i) => <p key={i} className="faint" style={{ marginTop: 8 }}>«{c.comment}» — {c.user}, {formatDate(c.at, locale)}</p>)}
                  </Card>
                )}
                {editor && a.required_ack && r && <AckStatusCard articleId={id} />}
                {editor && Boolean(revs.data?.length) && (
                  <Card title={t('История редакций', 'Sürüm geçmişi')}>
                    {revs.data!.map((x) => (
                      <div key={x.id} className="row between" style={{ padding: '4px 0' }}>
                        <span>№ {x.rev_no}{x.change_note && <span className="faint"> · {x.change_note}</span>}</span>
                        <span className="row"><Badge tone={st(ARTICLE_STATUS, x.status)[1]}>{st(ARTICLE_STATUS, x.status)[0]}</Badge><span className="faint">{formatDate(x.published_at ?? x.updated_at, locale)}</span></span>
                      </div>
                    ))}
                  </Card>
                )}
              </div>
            </div>
            {ask && <AskDialog article={id} initial={t(`По статье «${r?.title ?? ''}»: `, `«${r?.title ?? ''}» makalesi hakkında: `)} onClose={() => setAsk(false)} />}
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
  const editor = can('kb.edit');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = params.get('status') ?? 'all';
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'articles' | 'sections'>('articles');
  const [edit, setEdit] = useState<SectionNode | 'new' | null>(null);
  const [creating, setCreating] = useState(false);
  const [showMisses, setShowMisses] = useState(false);
  const rows = useQuery({ queryKey: ['kb', 'manage'], queryFn: kbManage, enabled: editor });
  const secs = useQuery({ queryKey: ['kb', 'home', true], queryFn: kbHome, enabled: editor });
  const misses = useQuery({ queryKey: ['kb', 'misses'], queryFn: kbMisses, enabled: editor && showMisses });
  const tree = useMemo(() => sectionTree(secs.data?.sections ?? []), [secs.data]);
  if (!editor) return <EmptyState title="Раздел для менеджера по франшизе" />;
  const drafts = secs.data?.drafts;
  const list = (rows.data ?? []).filter((a) =>
    (filter === 'all' || (filter === 'draft' ? a.status === 'draft' || a.has_draft : filter === 'required' ? a.required_ack : filter === 'low' ? a.not_helpful > a.helpful : a.status === filter))
    && (!q.trim() || a.title.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div className="kb">
      <Crumbs items={[{ to: '/kb', label: 'База знаний' }, { label: 'Управление' }]} />
      <PageHeader title="Управление базой знаний" actions={<>
        <LinkButton to="/learning/manage">Обучение сотрудников</LinkButton>
        <Button variant="primary" onClick={() => setCreating(true)}><FilePlus size={16} aria-hidden />Новая статья</Button>
      </>} />
      <details className="kb-search-misses" onToggle={e => setShowMisses(e.currentTarget.open)}>
        <summary>Поиск без результатов</summary>
        {showMisses && <div className="kb-search-misses-body"><DataState query={misses} skeleton={2}>{(items) => items.length ? <>
          <p className="faint">Запросы за последние 60 дней</p>
          <ul className="kb-missed-queries">{items.map((item) => <li key={item.query}>{item.query}{item.times > 1 && <span> ×{item.times}</span>}</li>)}</ul>
        </> : <p className="faint">Запросов без результатов за последние 60 дней нет.</p>}</DataState></div>}
      </details>
      <div className="tabs" role="tablist" aria-label="Управление">
        <button type="button" role="tab" aria-selected={tab === 'articles'} onClick={() => setTab('articles')}>Статьи</button>
        <button type="button" role="tab" aria-selected={tab === 'sections'} onClick={() => setTab('sections')}>Разделы</button>
      </div>
      {tab === 'articles' ? (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <Input aria-label="Найти статью" placeholder="Найти по названию" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
          </div>
          <Chips label="Фильтр" value={filter} onChange={(v) => setParams(v === 'all' ? {} : { status: v }, { replace: true })}
            options={[{ id: 'all', label: 'Все' }, { id: 'published', label: 'Опубликованы' }, { id: 'draft', label: drafts ? `Черновики и правки (${drafts})` : 'Черновики и правки' }, { id: 'archived', label: 'Архив' },
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
      {creating && <NewArticleDialog onClose={() => setCreating(false)} onCreated={(id) => navigate(`/kb/articles/${id}/edit`)} />}
    </div>
  );
}
