// База знаний: редактор статьи, вопросы и ответы, ознакомление. Просмотр (главная, разделы, статья) — в KbBrowse.tsx.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle } from 'lucide-react';
import { useLocale, type Language } from '../../platform/locale';
import { useSession } from '../../platform/session';
import { command, toAppError } from '../../platform/backend';
import { formatDate, formatDateTime } from '../../platform/dates';
import { ActionError, Alert, Badge, Button, Card, Checkbox, ConfirmDialog, DataState, EmptyState, Field, Input, PageHeader, Select, Tabs, Textarea } from '../../ui';
import { Markdown } from '../../ui/markdown';
import { useToast } from '../../ui/toast';
import { ackStatus, getArticle, kbAnswer, kbAsk, kbCommands, kbManage, kbQuestions, revisionsOf, TYPE_LABEL, QUESTION_CATEGORIES } from './api';
import { LearningEditor } from '../learning/Learning';
import { SupportAccounts } from '../staff/SupportAccounts';
import { SectionSelect } from './KbBrowse';

const TURKISH_CATEGORIES: Record<string, string> = {
  films: 'Filmler ve kaplama', equipment: 'Ekipman', app: 'Uygulama ve erişim', orders: 'Sipariş ve ön sipariş',
  finance: 'Finans ve royalti', team: 'Ekip ve yönetim', other: 'Diğer',
};
const questionCategory = (category: string, language: Language) => language === 'tr'
  ? TURKISH_CATEGORIES[category] ?? TURKISH_CATEGORIES.other : QUESTION_CATEGORIES[category] ?? QUESTION_CATEGORIES.other;

/** «Не нашли ответ? Спросите» — вопрос уходит менеджеру по франшизе, ответ придёт в «Мои вопросы». */
export function AskDialog({ initial = '', article = null, onClose }: { initial?: string; article?: string | null; onClose: () => void }) {
  const { t, language } = useLocale();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [category,setCategory]=useState('');
  const m = useMutation({ mutationFn: () => kbAsk(q, category, article), onSuccess: () => { toast(t('Вопрос отправлен. Ответ появится в «Мои вопросы»', 'Soru gönderildi. Yanıt, «Sorularım» bölümünde görünecek.')); void qc.invalidateQueries({ queryKey: ['kb'] }); onClose(); } });
  return (
    <ConfirmDialog open title={t('Задать вопрос', 'Soru sor')} confirmLabel={t('Отправить', 'Gönder')} busy={m.isPending} error={m.error} disabled={!category || q.trim().length < 3} onClose={onClose} onConfirm={() => m.mutate()}>
      <p className="muted">{t('Ответит менеджер по франшизе или технический специалист — в зависимости от категории вопроса.', 'Kategoriye göre franchise yöneticisi veya teknik uzman yanıt verecek.')}</p>
      {initial.trim() && <p className="faint">{t('Тема:', 'Konu:')} {initial.replace(/: $/, '')}</p>}
      <Field label={t('Категория вопроса', 'Soru kategorisi')} required>{id=><Select id={id} value={category} onChange={e=>setCategory(e.target.value)}><option value="">{t('Выберите категорию', 'Kategori seçin')}</option>{Object.keys(QUESTION_CATEGORIES).map(k=><option key={k} value={k}>{questionCategory(k, language)}</option>)}</Select>}</Field>
      <Field label={t('Ваш вопрос', 'Sorunuz')} required>{(id) => <Textarea id={id} rows={4} value={q} onChange={(e) => setQ(e.target.value)} maxLength={2000} />}</Field>
    </ConfirmDialog>
  );
}

export function AckStatusCard({ articleId }: { articleId: string }) {
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

export function ArticleEditPage() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const art = useQuery({ queryKey: ['kb', 'article', id, true], queryFn: () => getArticle(id) });
  const revs = useQuery({ queryKey: ['kb', 'revs', id, true], queryFn: () => revisionsOf(id) });
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
                <Field label="Раздел">{(fid) => <SectionSelect id={fid} value={meta.section_id} onChange={(v: string) => v && setMeta({ ...meta, section_id: v })} />}</Field>
                <Field label="Тип">{(fid) => <Select id={fid} value={meta.type} onChange={(e) => setMeta({ ...meta, type: e.target.value })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
                <Checkbox label="Обязательно к ознакомлению" hint="Франчайзи увидят статью в «Нужно прочитать» и подтвердят" checked={meta.required_ack} onChange={(v) => setMeta({ ...meta, required_ack: v })} />
                {published && meta.required_ack && (
                  <Checkbox label="Попросить прочитать заново" hint="Для важных изменений. Опечатку так отмечать не нужно" checked={reack} onChange={setReack} />
                )}
                <Field label="Что изменилось" hint="Видно в истории редакций">{(fid) => <Input id={fid} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              </Card>
            )}
          </div>
          <LearningEditor article={id} revision={art.data?.published_revision_id ?? null} />
        </>
      )}
    </DataState>
  );
}

export function QuestionsPage({ home = false }: { home?: boolean }) {
  const { t, language, locale } = useLocale();
  const { can } = useSession();
  const editor = can('kb.edit');
  const qc = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { text?: string; article?: string }>>({});
  const q = useQuery({ queryKey: ['kb', 'questions', editor], queryFn: kbQuestions });
  const materials = useQuery({ queryKey: ['kb', 'manage'], queryFn: kbManage, enabled: editor && Boolean(q.data?.some(x => !x.answer && !x.article_id)) });
  const published = (materials.data ?? []).filter(a => a.status === 'published').sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  useEffect(() => { if (q.isSuccess) void qc.invalidateQueries({ queryKey: ['kb', 'inbox'] }); }, [q.isSuccess, qc]);
  const answer = useMutation({
    mutationFn: ({ id, text, article }: { id: string; text: string; article: string | null }) => kbAnswer(id, text, article),
    onSuccess: (_, v) => { toast('Ответ отправлен'); setDrafts(current => ({ ...current, [v.id]: {} })); void qc.invalidateQueries({ queryKey: ['kb'] }); },
  });
  return (
    <div className="home" style={{ maxWidth: 820 }}>
      <PageHeader back={home ? undefined : { to: '/kb', label: t('База знаний', 'Bilgi bankası') }} title={editor ? t('Вопросы франчайзи', 'Franchise işletmecilerinin soruları') : t('Мои вопросы', 'Sorularım')}
        sub={home ? undefined : editor ? t('Ответьте здесь. Если вопрос повторяется — сделайте из ответа статью.', 'Buradan yanıtlayın. Sık sorulan konular için makale oluşturun.') : t('Ответы менеджера по франшизе и технического специалиста', 'Franchise yöneticisinin ve teknik uzmanın yanıtları')}
        actions={!editor && <Button variant="primary" onClick={() => setAsking(true)}><HelpCircle size={16} aria-hidden />{t('Задать вопрос', 'Soru sor')}</Button>} />
      <SupportAccounts /><ActionError error={answer.error} />
      <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title={t('Вопросов пока нет', 'Henüz soru yok')} text={editor ? t('Когда франчайзи спросят, вопросы появятся здесь.', 'Franchise işletmecilerinin soruları burada görünür.') : t('Не нашли ответ в базе знаний — спросите, менеджер по франшизе или технический специалист ответит.', 'Bilgi bankasında yanıt yoksa sorun. Franchise yöneticisi veya teknik uzman yanıt verecek.')} />)}>
        {(list) => (
          <div className="stack">
            {(editor ? list : [...list].sort((a, b) => Number(b.unseen) - Number(a.unseen))).map((x) => {
              const draft = drafts[x.id];
              const text = draft?.text ?? '';
              const selectedArticle = x.article_id ? undefined : published.find(a => a.id === draft?.article);
              const reply = text.trim() || (selectedArticle ? `Смотрите материал «${selectedArticle.title}».` : '');
              return (
                <Card key={x.id} className={x.unseen ? 'new-answer' : ''}>
                  <div className="faint">{editor ? `${x.user_name}${x.partner_name ? ` · ${x.partner_name}` : ''} · ` : ''}{formatDateTime(x.created_at, locale)}{!x.answer && x.article_id && <> · <Link to={`/kb/articles/${x.article_id}`}>{t('к статье', 'makaleye git')}</Link></>}</div>
                  <div className="row"><Badge>{questionCategory(x.category, language)}</Badge><span className="faint">{x.route==='technical'?t('Технический специалист', 'Teknik uzman'):t('Менеджер по франшизе', 'Franchise yöneticisi')}</span>{editor && !x.answer && <Button size="sm" onClick={()=>void command('kb_question_route',{question:x.id,route:x.route==='technical'?'franchise':'technical'}).then(()=>qc.invalidateQueries({queryKey:['kb']})).catch(e=>toast(String(e)))}>Передать {x.route==='technical'?'менеджеру':'специалисту'}</Button>}</div>
                  <p style={{ margin: '6px 0', fontWeight: 600 }}>{x.question}</p>
                  {x.answer ? (
                    <div className="answer">
                      <div className="faint">{t('Ответ', 'Yanıt')}{x.answered_at ? ` · ${formatDateTime(x.answered_at, locale)}` : ''}{x.unseen ? t(' · новый', ' · yeni') : ''}</div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{x.answer}</div>
                      {x.article_id && <Link to={`/kb/articles/${x.article_id}`}>{t('Открыть материал', 'İçeriği aç')}</Link>}
                    </div>
                  ) : editor ? (
                    <div>
                      <Textarea rows={3} aria-label={t('Ответ', 'Yanıt')} value={text} onChange={(e) => {
                        const text = e.target.value;
                        setDrafts(current => ({ ...current, [x.id]: { ...current[x.id], text } }));
                      }} placeholder="Ответ франчайзи" />
                      {!x.article_id && published.length > 0 && (
                        <Field label="Материал базы знаний (необязательно)">{id => (
                          <Select id={id} value={selectedArticle?.id ?? ''} onChange={e => {
                            const article = e.target.value;
                            setDrafts(current => ({ ...current, [x.id]: { ...current[x.id], article } }));
                          }}>
                            <option value="">Без материала</option>
                            {published.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
                          </Select>
                        )}</Field>
                      )}
                      {selectedArticle && <div style={{ overflowWrap: 'anywhere' }}>
                        <Link to={`/kb/articles/${selectedArticle.id}`} target="_blank" rel="noopener noreferrer">{selectedArticle.title}</Link>
                      </div>}
                      <div className="row" style={{ marginTop: 8 }}>
                        <Button variant="primary" size="sm" loading={answer.isPending && answer.variables?.id === x.id} disabled={reply.length < 2}
                          onClick={() => answer.mutate({ id: x.id, text: reply, article: selectedArticle?.id ?? null })}>Ответить</Button>
                      </div>
                    </div>
                  ) : <Badge tone="warning">{t('ждёт ответа', 'yanıt bekliyor')}</Badge>}
                </Card>
              );
            })}
          </div>
        )}
      </DataState>
      {asking && <AskDialog onClose={() => setAsking(false)} />}
    </div>
  );
}
