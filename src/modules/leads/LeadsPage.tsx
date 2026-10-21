// Заявки на франшизу с сайта: простая CRM менеджера. Горячие — наверху; статус и заметка по каждой заявке.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, MessageCircle, Phone, Send } from 'lucide-react';
import { formatDateTime, plural } from '../../platform/dates';
import { ActionError, Badge, Button, Card, Chips, DataState, EmptyState, KV, PageHeader, Select, Textarea, type Tone } from '../../ui';
import { useToast } from '../../ui/toast';
import { ANSWERS, leadList, leadUpdate, STATUS, TIER, type Lead, type LeadStatus, type LeadTier } from './api';

type View = 'active' | 'new' | 'won' | 'lost' | 'all';
const VIEWS: { id: View; label: string }[] = [
  { id: 'active', label: 'В работе' }, { id: 'new', label: 'Новые' }, { id: 'won', label: 'Договор' },
  { id: 'lost', label: 'Отказ' }, { id: 'all', label: 'Все' },
];
const TIER_TONE: Record<LeadTier, Tone> = { hot: 'success', warm: 'warning', cold: 'neutral' };
const TIER_RANK: Record<LeadTier, number> = { hot: 0, warm: 1, cold: 2 };

function inView(l: Lead, v: View) {
  if (v === 'all') return true;
  if (v === 'active') return l.status !== 'won' && l.status !== 'lost';
  return l.status === v;
}

export function LeadsPage() {
  const [view, setView] = useState<View>('active');
  const q = useQuery({ queryKey: ['leads'], queryFn: leadList, refetchInterval: 60_000 });

  return (
    <>
      <PageHeader title="Заявки" sub="Анкеты с сайта франшизы. Горячие — те, у кого есть деньги и кто готов начать скоро: им звонить первыми." />
      <Chips label="Какие заявки показать" options={VIEWS} value={view} onChange={setView} />
      <DataState query={q} skeleton={5}
        empty={(all) => all.length ? null : <EmptyState icon={<Inbox size={28} aria-hidden />} title="Заявок пока нет" text="Анкеты с сайта франшизы появятся здесь сами." />}>
        {(all) => {
          const rows = all.filter((l) => inView(l, view))
            .sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1) || TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.created_at.localeCompare(a.created_at));
          const fresh = all.filter((l) => l.status === 'new').length;
          return (
            <>
              <div className="kpis">
                <div className={`kpi${fresh ? ' warn' : ''}`}><span className="v">{fresh}</span><span className="l">{plural(fresh, 'новая', 'новые', 'новых')}</span></div>
                <div className="kpi"><span className="v">{all.filter((l) => l.tier === 'hot' && l.status !== 'lost').length}</span><span className="l">горячих</span></div>
                <div className="kpi"><span className="v">{all.filter((l) => l.status === 'won').length}</span><span className="l">договоров</span></div>
              </div>
              {rows.length === 0 ? <p className="faint">В этом списке заявок нет.</p> : <div className="stack">{rows.map((l) => <LeadCard key={l.id} lead={l} />)}</div>}
            </>
          );
        }}
      </DataState>
    </>
  );
}

function LeadCard({ lead: l }: { lead: Lead }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<LeadStatus>(l.status);
  const [note, setNote] = useState(l.note ?? '');
  const dirty = status !== l.status || note.trim() !== (l.note ?? '');
  const save = useMutation({
    mutationFn: () => leadUpdate(l.id, status, note),
    onSuccess: () => { toast('Заявка сохранена'); void qc.invalidateQueries({ queryKey: ['leads'] }); },
  });
  const digits = l.phone.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');

  return (
    <Card title={<h2 className="card-title">{l.name} · {l.city}</h2>}
      actions={<><Badge tone={TIER_TONE[l.tier]}>{TIER[l.tier]}</Badge>{l.status === 'new' && <Badge tone="info">Новая</Badge>}</>}>
      <p className="faint" style={{ marginTop: 0 }}>{formatDateTime(l.created_at)} · просит связаться: {ANSWERS.contact_via[l.contact_via]}</p>
      <div className="row" style={{ marginBottom: 16 }}>
        <a className="btn btn-primary btn-sm" href={`tel:+${digits}`}><Phone size={16} aria-hidden />{l.phone}</a>
        <a className="btn btn-secondary btn-sm" href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer"><MessageCircle size={16} aria-hidden />WhatsApp</a>
        <a className="btn btn-secondary btn-sm" href={`https://t.me/+${digits}`} target="_blank" rel="noopener noreferrer"><Send size={16} aria-hidden />Telegram</a>
      </div>
      <KV items={[
        ['Бюджет', ANSWERS.budget[l.budget]],
        ['Когда открывать', ANSWERS.timing[l.timing]],
        ['Кто будет на точке', ANSWERS.manage[l.manage]],
        ['Опыт', ANSWERS.experience[l.experience]],
        ['Место', ANSWERS.place[l.place]],
        ...(l.comment ? [['Комментарий', l.comment] as [string, string]] : []),
      ]} />
      <div className="row" style={{ marginTop: 16, alignItems: 'flex-start' }}>
        <Select aria-label="Статус заявки" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)} style={{ maxWidth: 200 }}>
          {(Object.keys(STATUS) as LeadStatus[]).map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}
        </Select>
        <Textarea aria-label="Заметка" rows={2} placeholder="Заметка: о чём договорились, когда перезвонить" value={note} maxLength={2000}
          onChange={(e) => setNote(e.target.value)} style={{ flex: '1 1 240px', minHeight: 44 }} />
        <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Сохранить</Button>
      </div>
      <ActionError error={save.error} />
      {l.updated_by_name && l.status !== 'new' && <p className="faint" style={{ marginBottom: 0 }}>{STATUS[l.status]} · {l.updated_by_name}, {formatDateTime(l.updated_at)}</p>}
    </Card>
  );
}
