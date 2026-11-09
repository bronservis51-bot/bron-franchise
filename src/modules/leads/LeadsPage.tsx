import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Banknote, Building2, Check, Clock3, GripVertical, AtSign, MessageCircle, Phone, Plus, RefreshCw, Search, Send, Trash2 } from 'lucide-react';
import { formatDateTime } from '../../platform/dates';
import { ActionError, Button, Checkbox, ConfirmDialog, DataState, Field, Input, KV, PageHeader, Select, Textarea } from '../../ui';
import { useToast } from '../../ui/toast';
import { ANSWERS, leadList, leadMove, leadSave, leadTrashList, leadSetDeleted, type Lead } from './api';
import { COLUMNS, columnFor, groupLeads, readiness, type Readiness } from './pipeline';
import { parseLeadContact } from './contact';

const FACTORS = [{ key: 'money', title: 'Деньги', icon: Banknote }, { key: 'place', title: 'Помещение', icon: Building2 }, { key: 'now', title: 'Сейчас', icon: Clock3 }] as const;
const digits = (phone: string) => phone.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
function Factors({ value }: { value: Readiness }) {
  return <div className="lead-factors">{FACTORS.map(f => <span key={f.key} className={value[f.key] ? 'yes' : 'no'} title={`${f.title}: ${value[f.key] ? 'да' : 'не подтверждено'}`}>
    <f.icon size={13} aria-hidden />{f.title}{value[f.key] && <Check size={11} aria-hidden />}<span className="sr-only">: {value[f.key] ? 'да' : 'не подтверждено'}</span>
  </span>)}</div>;
}
function shownFactors(l: Lead): Readiness { return COLUMNS.find(c => c.id === l.pipeline_column)?.factors ?? readiness(l); }
function StageOptions({ auto = false }: { auto?: boolean }) { return <>
  {auto && <option value="auto">По анкете — автоматически</option>}
  {COLUMNS.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
  <option value="call_back">Перезвонить</option><option value="meeting">Встреча</option>
</>; }
function stageValue(l: Lead) { return l.status === 'call_back' || l.status === 'meeting' ? l.status : columnFor(l); }

export function LeadsPage() {
  const qc = useQueryClient(); const toast = useToast();
  const [search, setSearch] = useState(''); const [onlyNew, setOnlyNew] = useState(false);
  const [editor, setEditor] = useState<{ lead?: Lead; column: string } | null>(null);
  const [trash, setTrash] = useState(false); const [restore, setRestore] = useState<Lead | null>(null);
  const [dragId, setDragId] = useState<string | null>(null); const [over, setOver] = useState<string | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['leads'], queryFn: leadList, staleTime: 60_000, refetchInterval: 60_000 });
  const tq = useQuery({ queryKey: ['leads', 'trash'], queryFn: leadTrashList, enabled: trash });
  const restored = useMutation({ mutationFn: (l: Lead) => leadSetDeleted(l, false), onSuccess: row => {
    qc.setQueryData<Lead[]>(['leads', 'trash'], all => all?.filter(l => l.id !== row.id));
    qc.setQueryData<Lead[]>(['leads'], (all = []) => [row, ...all.filter(l => l.id !== row.id)]);
    void qc.invalidateQueries({queryKey:['leads']});
    setRestore(null); toast('Заявка восстановлена');
  }});
  useEffect(() => { if (q.data) qc.setQueryData(['leads', 'inbox'], q.data.filter(l => l.status === 'new').length); }, [q.data, qc]);
  const groups = useMemo(() => groupLeads(q.data ?? [], search, onlyNew), [q.data, search, onlyNew]);
  const moved = useMutation({
    mutationFn: ({ lead, column }: { lead: Lead; column: string }) => leadMove(lead, column),
    onSuccess: row => { qc.setQueryData<Lead[]>(['leads'], all => all?.map(l => l.id === row.id ? row : l)); toast('Заявка перемещена'); },
  });
  const jump = (id: string) => { const el = document.getElementById(`lead-column-${id}`); if (el && board.current) board.current.scrollTo({ left: el.offsetLeft }); };
  return <div className="leads-workspace">
    <PageHeader title={trash ? 'Корзина заявок' : 'Заявки'} actions={<>
      <Button onClick={() => { setTrash(v => !v); setRestore(null); }}>{trash ? 'К заявкам' : <><Trash2 size={17} aria-hidden />Корзина</>}</Button>
      <Button aria-label="Обновить заявки" title="Обновить" onClick={() => void (trash ? tq : q).refetch()} loading={trash ? tq.isFetching : q.isFetching}><RefreshCw size={17} aria-hidden /></Button>
      {!trash && <Button variant="primary" onClick={() => setEditor({ column: '000' })}><Plus size={17} aria-hidden />Добавить</Button>}
    </>} />
    {trash ? <DataState query={tq}>{all => <>
      {!all.length && <p className="faint">В корзине нет заявок.</p>}
      {all.map(l => <div className="card" key={l.id}><div className="card-body row" style={{justifyContent:'space-between',flexWrap:'wrap',marginBottom:12}}>
        <div style={{minWidth:0,overflowWrap:'anywhere'}}><strong>{l.name}</strong><div className="faint">Удалена {l.deleted_at && formatDateTime(l.deleted_at)}</div>{l.note && <p>{l.note}</p>}</div>
        <Button onClick={() => { restored.reset(); setRestore(l); }}>Восстановить</Button>
      </div></div>)}
    </>}</DataState> : <><div className="pipeline-tools">
      <label className="pipeline-search"><Search size={18} aria-hidden /><Input aria-label="Поиск заявок" placeholder="Instagram, имя, город, телефон" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <Checkbox label="Только новые" checked={onlyNew} onChange={setOnlyNew} />
      <div className="pipeline-jump"><Select aria-label="Перейти к колонке" disabled={!q.data} defaultValue="" onChange={e => { jump(e.target.value); e.target.value = ''; }}>
        <option value="" disabled>К колонке…</option>{COLUMNS.map(c => <option key={c.id} value={c.id}>{c.title} ({groups.get(c.id)!.length})</option>)}
      </Select></div>
    </div>
    <ActionError error={moved.error} />
    <DataState query={q} skeleton={5}>{all => <>
      {!all.length && <p className="faint">Добавьте заявку по нику Instagram или имени. Анкеты с сайта появятся автоматически.</p>}
      {all.length > 0 && ![...groups.values()].some(list => list.length) && <p role="status" className="faint">По выбранным условиям заявок нет.</p>}
      <div className="pipeline-board" ref={board} role="region" aria-label="Канбан заявок. Прокручивается горизонтально" tabIndex={0}>
        {COLUMNS.map(column => <section key={column.id} id={`lead-column-${column.id}`} aria-labelledby={`lead-heading-${column.id}`}
          className={`pipeline-column${column.id === '111' ? ' ready' : ''}${column.status ? ` stage-${column.id}` : ''}${over === column.id ? ' drag-over' : ''}`}
          onDragOver={e => { if (!moved.isPending && (dragId || e.dataTransfer.types.includes('text/plain'))) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(column.id); } }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
          onDrop={e => {
            e.preventDefault(); const id = e.dataTransfer.getData('text/plain') || dragId; const lead = all.find(l => l.id === id);
            if (lead && columnFor(lead) !== column.id && !moved.isPending) moved.mutate({ lead, column: column.id });
            setDragId(null); setOver(null);
          }}>
          <header className="pipeline-column-head"><div><h2 id={`lead-heading-${column.id}`}>{column.title}</h2><span className="pipeline-count">{groups.get(column.id)!.length}</span>
            <button type="button" className="lead-add-column" aria-label={`Добавить заявку: ${column.title}`} onClick={() => setEditor({ column: column.id })}><Plus size={16} /></button>
          </div>{column.factors && <Factors value={column.factors} />}</header>
          <div className="pipeline-cards">{groups.get(column.id)!.map(l => {
            const pending = moved.isPending && moved.variables.lead.id === l.id;
            return <article key={l.id} className={`lead-tile${pending ? ' pending' : ''}`} draggable={!moved.isPending} aria-busy={pending}
              onDragStart={e => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; setDragId(l.id); moved.reset(); }} onDragEnd={() => { setDragId(null); setOver(null); }}>
              <div className="lead-tile-top"><span>{l.city}</span><GripVertical size={15} aria-hidden /></div>
              <button className="lead-open" onClick={() => setEditor({ lead: l, column: stageValue(l) })} disabled={pending}><strong>{l.name}</strong><ArrowRight size={16} aria-hidden /></button>
              <Factors value={shownFactors(l)} />
              <div className="lead-tile-foot">
                {l.instagram && <a href={`https://www.instagram.com/${l.instagram}/`} target="_blank" rel="noopener noreferrer" aria-label={`Открыть Instagram ${l.instagram}`}><AtSign size={14} aria-hidden />Открыть профиль</a>}
                {l.phone && <a href={`tel:+${digits(l.phone)}`}><Phone size={13} aria-hidden />{l.phone}</a>}
                <span>{formatDateTime(l.created_at)}</span>
              </div>
              {l.note && <p className="lead-note">{l.note}</p>}
              <Select className="lead-stage-select" aria-label={`Переместить заявку ${l.name}`} value={stageValue(l)} disabled={moved.isPending} onChange={e => moved.mutate({ lead: l, column: e.target.value })}><StageOptions auto /></Select>
              {pending && <span className="faint" role="status">Сохраняется…</span>}
            </article>;
          })}{!groups.get(column.id)!.length && <div className="pipeline-empty">{dragId ? 'Перетащите сюда' : 'Нет заявок'}</div>}</div>
        </section>)}
      </div>
    </>}</DataState>
    </>}
    {restore && <ConfirmDialog open title="Восстановить заявку?" confirmLabel="Восстановить" busy={restored.isPending} error={restored.error} onClose={() => { if (!restored.isPending) setRestore(null); }} onConfirm={() => restored.mutate(restore)}><p>{restore.name}</p><p>Заявка вернётся в свою прежнюю колонку.</p></ConfirmDialog>}
    {editor && <LeadEditor lead={editor.lead} initialColumn={editor.column} onClose={() => setEditor(null)} onDeleted={id => {
      qc.setQueryData<Lead[]>(['leads'], all => all?.filter(l => l.id !== id));
      void qc.invalidateQueries({queryKey:['leads']}); setEditor(null);
    }} onSaved={row => {
      qc.setQueryData<Lead[]>(['leads'], (all = []) => all.some(l => l.id === row.id) ? all.map(l => l.id === row.id ? row : l) : [row, ...all]);
      setEditor(null); setSearch(''); setOnlyNew(false); requestAnimationFrame(() => jump(columnFor(row)));
    }} />}
  </div>;
}

function LeadEditor({ lead: l, initialColumn, onClose, onSaved, onDeleted }: { lead?: Lead; initialColumn: string; onClose: () => void; onSaved: (row: Lead) => void; onDeleted: (id: string) => void }) {
  const toast = useToast(); const initial = l?.instagram ? `@${l.instagram}` : l?.name ?? '';
  const [contact, setContact] = useState(initial); const [phone, setPhone] = useState(l?.phone ?? ''); const [city, setCity] = useState(l?.city ?? '');
  const [note, setNote] = useState(l?.note ?? ''); const [column, setColumn] = useState(initialColumn); const [operation] = useState(() => crypto.randomUUID());
  const [deleting, setDeleting] = useState(false);
  const removed = useMutation({mutationFn: () => leadSetDeleted(l!, true), onSuccess: row => { toast('Заявка удалена. Её можно восстановить из корзины'); onDeleted(row.id); }});
  const dirty = contact !== initial || phone !== (l?.phone ?? '') || city !== (l?.city ?? '') || note !== (l?.note ?? '') || column !== initialColumn;
  const save = useMutation({ mutationFn: () => { const parsed = parseLeadContact(contact); return leadSave({ id: l?.id, ...parsed, name: contact === initial && l ? l.name : parsed.name, phone, city, note, column }, l?.updated_at ?? null, operation); },
    onSuccess: row => { toast(l ? 'Заявка сохранена' : 'Заявка добавлена'); onSaved(row); } });
  const busy = save.isPending || removed.isPending;
  const blocker = useBlocker(dirty || busy);
  useEffect(() => { if (blocker.state === 'blocked') { if (!busy && window.confirm('Уйти без сохранения заявки?')) blocker.proceed(); else blocker.reset(); } }, [blocker, busy]);
  useBeforeUnload(useCallback(e => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } }, [dirty, busy]));
  const close = () => { if (busy) return; if (deleting) { setDeleting(false); return; } if (!dirty || window.confirm('Закрыть без сохранения изменений?')) onClose(); };
  const details: [string, string][] = l ? [
    ...(l.budget ? [['Бюджет', ANSWERS.budget[l.budget]] as [string,string]] : []), ...(l.timing ? [['Открытие', ANSWERS.timing[l.timing]] as [string,string]] : []),
    ...(l.place ? [['Место', ANSWERS.place[l.place]] as [string,string]] : []), ...(l.manage ? [['Управление', ANSWERS.manage[l.manage]] as [string,string]] : []),
    ...(l.experience ? [['Опыт', ANSWERS.experience[l.experience]] as [string,string]] : []), ...(l.comment ? [['Комментарий', l.comment] as [string,string]] : []),
  ] : [];
  return <ConfirmDialog open title={deleting ? 'Удалить заявку?' : l ? 'Заявка' : 'Новая заявка'} confirmLabel={deleting ? 'Удалить' : l ? 'Сохранить' : 'Добавить'} danger={deleting} busy={busy} error={deleting ? removed.error : save.error} disabled={!deleting && (!contact.trim() || !!l && !dirty)} onClose={close} onConfirm={() => deleting ? removed.mutate() : save.mutate()}>
    {deleting ? <><p><strong>{l?.name}</strong></p><p>Заявка исчезнет из канбана. Восстановить её можно через «Корзина».</p>{dirty && <p>Несохранённые изменения будут отменены.</p>}</> : <div className="lead-editor" data-unsaved={dirty || undefined}>
      <Field label="Instagram или имя" required>{id => <Input id={id} autoFocus value={contact} maxLength={100} placeholder="@nik или имя" autoCapitalize="none" spellCheck={false} onChange={e => setContact(e.target.value)} />}</Field>
      {l?.instagram && <a className="lead-contact-link" href={`https://www.instagram.com/${l.instagram}/`} target="_blank" rel="noopener noreferrer"><AtSign size={17} aria-hidden />Открыть Instagram</a>}
      {l?.phone && <div className="row">
        <a className="btn btn-sm" href={`tel:+${digits(l.phone)}`}><Phone size={15} aria-hidden />Позвонить</a>
        <a className="btn btn-sm" href={`https://wa.me/${digits(l.phone)}`} target="_blank" rel="noopener noreferrer"><MessageCircle size={15} aria-hidden />WhatsApp</a>
        <a className="btn btn-sm" href={`https://t.me/+${digits(l.phone)}`} target="_blank" rel="noopener noreferrer"><Send size={15} aria-hidden />Telegram</a>
      </div>}
      <Field label="Колонка">{id => <Select id={id} value={column} onChange={e => setColumn(e.target.value)}><StageOptions auto={!!l} /></Select>}</Field>
      <Field label="Заметка">{id => <Textarea id={id} rows={2} value={note} maxLength={2000} placeholder="О чём договорились" onChange={e => setNote(e.target.value)} />}</Field>
      <details className="lead-extra"><summary>Дополнительно</summary>
        <Field label="Телефон">{id => <Input id={id} type="tel" value={phone} maxLength={30} placeholder="Необязательно" onChange={e => setPhone(e.target.value)} />}</Field>
        <Field label="Город">{id => <Input id={id} value={city} maxLength={80} placeholder="Необязательно" onChange={e => setCity(e.target.value)} />}</Field>
        {details.length > 0 && <><h3>Ответы анкеты</h3><KV items={details} /></>}
        {l && <p className="faint">{formatDateTime(l.created_at)}{l.updated_by_name ? ` · ${l.updated_by_name}` : ''}</p>}
      </details>
      {l && <Button variant="danger" disabled={busy} onClick={() => { removed.reset(); setDeleting(true); }}><Trash2 size={16} aria-hidden />Удалить заявку</Button>}
    </div>}
  </ConfirmDialog>;
}
