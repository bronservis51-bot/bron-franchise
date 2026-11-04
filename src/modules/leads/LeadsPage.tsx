import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Banknote, Building2, Check, ChevronLeft, ChevronRight, Clock3, GripVertical, MessageCircle, Phone, RefreshCw, Search, Send } from 'lucide-react';
import { AppError } from '../../platform/backend';
import { formatDateTime } from '../../platform/dates';
import { Badge, Button, Checkbox, ConfirmDialog, DataState, Input, KV, PageHeader, Select, Textarea, ActionError } from '../../ui';
import { useToast } from '../../ui/toast';
import { ANSWERS, leadList, leadUpdate, STATUS, type Lead, type LeadStatus } from './api';
import { COLUMNS, columnFor, groupLeads, readiness, type Readiness } from './pipeline';

const FACTORS = [
  { key: 'money', title: 'Деньги', icon: Banknote },
  { key: 'place', title: 'Помещение', icon: Building2 },
  { key: 'now', title: 'Сейчас', icon: Clock3 },
] as const;
const phoneDigits = (phone: string) => phone.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
function Factors({ value }: { value: Readiness }) {
  return <div className="lead-factors">{FACTORS.map(f => <span key={f.key} className={value[f.key] ? 'yes' : 'no'}
    title={`${f.title}: ${value[f.key] ? 'да' : 'не подтверждено'}`}><f.icon size={13} aria-hidden />{f.title}<span className="sr-only">: {value[f.key] ? 'да' : 'не подтверждено'}</span>{value[f.key] && <Check size={11} aria-hidden />}</span>)}</div>;
}

export function LeadsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['leads'], queryFn: leadList, staleTime: 60_000, refetchInterval: 60_000 });
  useEffect(() => { if (q.data) qc.setQueryData(['leads', 'inbox'], q.data.filter(l => l.status === 'new').length); }, [q.data, qc]);
  const groups = useMemo(() => groupLeads(q.data ?? [], search, onlyNew), [q.data, search, onlyNew]);
  const fresh = q.data?.filter(l => l.status === 'new').length ?? 0;
  const ready = q.data?.filter(l => columnFor(l) === '111').length ?? 0;
  const visible = [...groups.values()].reduce((n, list) => n + list.length, 0);
  const move = useMutation({
    mutationFn: ({ lead, status }: { lead: Lead; status: LeadStatus }) => leadUpdate(lead.id, status, lead.note ?? ''),
    onSuccess: (_, { lead, status }) => {
      qc.setQueryData<Lead[]>(['leads'], all => all?.map(l => l.id === lead.id ? { ...l, status } : l));
      toast(`Заявка: ${STATUS[status]}`);
      void qc.invalidateQueries({ queryKey: ['leads'] });
    },
  });
  const jump = (id: string) => {
    const el = document.getElementById(`lead-column-${id}`);
    if (el && board.current) board.current.scrollTo({ left: el.offsetLeft, behavior: 'auto' });
  };
  return <div className="leads-workspace">
    <PageHeader title="Заявки" sub="Воронка франшизы · от первого интереса до открытия"
      actions={<Button onClick={() => void q.refetch()} loading={q.isFetching}><RefreshCw size={16} aria-hidden />Обновить</Button>} />
    <div className="pipeline-overview">
      <div><span className="pipeline-eyebrow">КВАЛИФИКАЦИЯ ЗАЯВОК</span><h2>Три условия для старта</h2><p>Деньги, помещение и готовность открыться в ближайший месяц.</p></div>
      <div className="pipeline-numbers"><div><strong>{fresh}</strong><span>новых</span></div><div><strong>{ready}</strong><span>готовы к открытию</span></div><div><strong>{q.data?.length ?? '—'}</strong><span>всего заявок</span></div></div>
    </div>
    <div className="pipeline-tools">
      <label className="pipeline-search"><Search size={18} aria-hidden /><Input aria-label="Поиск заявок" placeholder="Имя, город или телефон" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <Checkbox label="Только новые" checked={onlyNew} onChange={setOnlyNew} />
      <div className="pipeline-jump"><Select aria-label="Перейти к колонке" defaultValue="" onChange={e => { jump(e.target.value); e.target.value = ''; }}>
        <option value="" disabled>К колонке…</option>{COLUMNS.map(c => <option key={c.id} value={c.id}>{c.title} ({groups.get(c.id)!.length})</option>)}
      </Select></div>
      <div className="row"><button className="icon-btn" aria-label="Прокрутить воронку влево" onClick={() => board.current?.scrollBy({ left: -300 })}><ChevronLeft size={19} /></button><button className="icon-btn" aria-label="Прокрутить воронку вправо" onClick={() => board.current?.scrollBy({ left: 300 })}><ChevronRight size={19} /></button></div>
    </div>
    <p className="pipeline-help">Новые анкеты распределяются автоматически: слева направо — больше выполненных условий. Откройте карточку или перетащите её в «В работе», «Договор», «Отказ».</p>
    <ActionError error={move.error} />
    <DataState query={q} skeleton={5}>
      {all => <>
        {!all.length && <p className="faint">Заявок пока нет. Анкеты с сайта появятся здесь автоматически.</p>}
        {all.length > 0 && !visible && <p role="status" className="faint">По выбранным условиям заявок нет.</p>}
        <div className="pipeline-board" ref={board} role="region" aria-label="Канбан заявок. Прокручивается горизонтально" tabIndex={0}>
          {COLUMNS.map((column, index) => <section key={column.id} id={`lead-column-${column.id}`}
            className={`pipeline-column${column.id === '111' ? ' ready' : ''}${column.status ? ` stage-${column.id}` : ''}${over === column.id ? ' drag-over' : ''}`}
            aria-labelledby={`lead-heading-${column.id}`}
            onDragOver={e => { if (dragId && column.status && !move.isPending) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(column.id); } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); }}
            onDrop={e => {
              e.preventDefault();
              const lead = all.find(l => l.id === dragId);
              if (lead && column.status && lead.status !== column.status && !move.isPending) move.mutate({ lead, status: column.status });
              setDragId(null); setOver(null);
            }}>
            <header className="pipeline-column-head"><div><span className="pipeline-step">{String(index + 1).padStart(2, '0')}</span><h2 id={`lead-heading-${column.id}`}>{column.title}</h2><span className="pipeline-count">{groups.get(column.id)!.length}</span></div>
              <p>{column.hint}</p>{column.factors && <Factors value={column.factors} />}
            </header>
            <div className="pipeline-cards">{groups.get(column.id)!.map(l => {
              const pending = move.isPending && move.variables.lead.id === l.id;
              return <article key={l.id} className={`lead-tile${pending ? ' pending' : ''}`} draggable={!move.isPending} aria-busy={pending}
                onDragStart={e => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; setDragId(l.id); move.reset(); }} onDragEnd={() => { setDragId(null); setOver(null); }}>
                <div className="lead-tile-top"><span>{l.city}</span><GripVertical size={15} aria-hidden /></div>
                <button className="lead-open" onClick={() => setSelected(l)} disabled={pending}><strong>{l.name}</strong><ArrowRight size={16} aria-hidden /></button>
                <Factors value={readiness(l)} />
                <div className="lead-tile-foot"><a href={`tel:+${phoneDigits(l.phone)}`}><Phone size={13} aria-hidden />{l.phone}</a><span>{formatDateTime(l.created_at)}</span></div>
                {(l.status !== 'new' || pending) && <Badge tone={l.status === 'lost' ? 'neutral' : 'info'}>{pending ? 'Сохраняется…' : STATUS[l.status]}</Badge>}
                {l.note && <p className="lead-note">{l.note}</p>}
              </article>;
            })}
              {!groups.get(column.id)!.length && <div className="pipeline-empty">{column.status && dragId ? 'Перетащите сюда' : 'Пока нет заявок'}</div>}
            </div>
          </section>)}
        </div>
      </>}
    </DataState>
    {selected && <LeadDialog lead={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function LeadDialog({ lead: l, onClose }: { lead: Lead; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<LeadStatus>(l.status);
  const [note, setNote] = useState(l.note ?? '');
  const dirty = status !== l.status || note.trim() !== (l.note ?? '');
  const save = useMutation({
    mutationFn: async () => {
      const latest = qc.getQueryData<Lead[]>(['leads'])?.find(row => row.id === l.id);
      if (latest && latest.updated_at !== l.updated_at) throw new AppError('version-conflict', 'Заявка изменилась. Скопируйте заметку и откройте карточку заново.', '', '');
      await leadUpdate(l.id, status, note);
    },
    onSuccess: () => { toast('Заявка сохранена'); void qc.invalidateQueries({ queryKey: ['leads'] }); onClose(); },
  });
  const digits = phoneDigits(l.phone);
  const blocker = useBlocker(dirty || save.isPending);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (!save.isPending && window.confirm('Уйти со страницы без сохранения заявки?')) blocker.proceed();
    else blocker.reset();
  }, [blocker, save.isPending]);
  useBeforeUnload(useCallback((event) => {
    if (dirty || save.isPending) { event.preventDefault(); event.returnValue = ''; }
  }, [dirty, save.isPending]));
  const close = () => { if (!save.isPending && (!dirty || window.confirm('Закрыть карточку без сохранения изменений?'))) onClose(); };
  return <ConfirmDialog open title={`${l.name} · ${l.city}`} confirmLabel="Сохранить" busy={save.isPending} error={save.error} disabled={!dirty} onClose={close} onConfirm={() => save.mutate()}>
    <div data-unsaved={dirty || undefined}>
      <p className="faint">{formatDateTime(l.created_at)} · Связаться: {ANSWERS.contact_via[l.contact_via]}</p>
      <Factors value={readiness(l)} />
      <div className="row" style={{ margin: '16px 0' }}>
        <a className="btn btn-primary btn-sm" href={`tel:+${digits}`}><Phone size={15} aria-hidden />{l.phone}</a>
        <a className="btn btn-secondary btn-sm" href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer"><MessageCircle size={15} aria-hidden />WhatsApp</a>
        <a className="btn btn-secondary btn-sm" href={`https://t.me/+${digits}`} target="_blank" rel="noopener noreferrer"><Send size={15} aria-hidden />Telegram</a>
      </div>
      <KV items={[
        ['Бюджет', ANSWERS.budget[l.budget]], ['Когда открывать', ANSWERS.timing[l.timing]], ['Место', ANSWERS.place[l.place]],
        ['Кто будет на точке', ANSWERS.manage[l.manage]], ['Опыт', ANSWERS.experience[l.experience]],
        ...(l.comment ? [['Комментарий', l.comment] as [string, string]] : []),
      ]} />
      <label className="field"><span>Статус заявки</span><Select value={status} onChange={e => setStatus(e.target.value as LeadStatus)}>
        {(Object.keys(STATUS) as LeadStatus[]).map(s => <option key={s} value={s}>{s === 'new' ? 'По анкете — автоматически' : STATUS[s]}</option>)}
      </Select></label>
      <label className="field"><span>Заметка менеджера</span><Textarea rows={3} placeholder="О чём договорились, когда перезвонить" value={note} maxLength={2000} onChange={e => setNote(e.target.value)} /></label>
      {l.updated_by_name && <p className="faint">{l.updated_by_name} · {formatDateTime(l.updated_at)}</p>}
    </div>
  </ConfirmDialog>;
}
