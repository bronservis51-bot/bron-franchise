// Полная карточка франчайзи у менеджера: контакты, юрлицо, договор, заметки, точки, документы (договор, допсоглашения, акты).
// Данные карточки и документы видит только менеджер.
import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Edit3, ExternalLink, FileText, Link2, ShoppingCart, Trash2, Upload } from 'lucide-react';
import { command, storage } from '../../platform/backend';
import { formatDate } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { ActionError, Button, Card, ConfirmDialog, DataState, Field, Input, KV, MoneyInput, Select, Textarea } from '../../ui';
import { useToast } from '../../ui/toast';
import type { Partner } from './api';

export interface Profile {
  owner_name: string | null; phone2: string | null; telegram: string | null; whatsapp: string | null; contact_notes: string | null;
  legal_form: string | null; legal_name: string | null; inn: string | null; ogrn: string | null; legal_address: string | null; bank_details: string | null;
  contract_number: string | null; contract_date: string | null; contract_until: string | null; franchise_fee_minor: number | null;
  started_on: string | null; territory: string | null; notes: string | null; updated_at: string;
}
export interface Doc { id: string; kind: string; title: string; path: string; size_bytes: number | null; mime: string | null; signed_on: string | null; created_at: string; uploaded_by: string | null }
export interface CardData {
  partner: Partner; profile: Profile | null; updated_by_name: string | null;
  locations: { id: string; name: string; city: string; address: string | null; status: string; opened_on: string | null; first_day: string | null; last_day: string | null }[];
  documents: Doc[];
  stats: { opened_on: string | null; revenue_12m_minor: number; rate_bp: number; users: number; staff: number };
}

export const partnerCard = (partner: string) => command<CardData>('partner_card', { partner });

const DOC_KIND: Record<string, string> = { contract: 'Договор', addendum: 'Допсоглашение', act: 'Акт', passport: 'Паспорт / документы владельца', other: 'Другое' };
const LEGAL_FORMS = ['ИП', 'ООО', 'Самозанятый', 'Другое'];

/** «1 год 4 мес.» от даты до сегодня. */
function since(iso: string | null) {
  if (!iso) return null;
  const a = new Date(`${iso}T12:00:00Z`); const b = new Date();
  let m = (b.getFullYear() - a.getUTCFullYear()) * 12 + (b.getMonth() - a.getUTCMonth());
  if (b.getDate() < a.getUTCDate()) m -= 1;
  if (m < 1) return 'меньше месяца';
  const y = Math.floor(m / 12); const r = m % 12;
  return [y ? `${y} ${y % 10 === 1 && y % 100 !== 11 ? 'год' : y % 10 >= 2 && y % 10 <= 4 && (y % 100 < 10 || y % 100 >= 20) ? 'года' : 'лет'}` : '', r ? `${r} мес.` : ''].filter(Boolean).join(' ');
}

const daysTo = (iso: string) => Math.round((new Date(`${iso}T12:00:00Z`).getTime() - Date.now()) / 86_400_000);
const or = (v: ReactNode) => (v === null || v === undefined || v === '' ? <span className="faint">—</span> : v);

function ProfileDialog({ partnerId, currency, profile, onClose }: { partnerId: string; currency: string; profile: Profile | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const init = (k: keyof Profile) => (profile?.[k] ?? '') as string;
  const keys = ['owner_name', 'phone2', 'telegram', 'whatsapp', 'contact_notes', 'legal_form', 'legal_name', 'inn', 'ogrn', 'legal_address',
    'bank_details', 'contract_number', 'contract_date', 'contract_until', 'started_on', 'territory', 'notes'] as const;
  const [f, setF] = useState<Record<string, string>>(() => ({
    ...Object.fromEntries(keys.map((k) => [k, init(k)])), franchise_fee_minor: profile?.franchise_fee_minor ? String(profile.franchise_fee_minor) : '',
  }));
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => command('partner_profile_save', { partner: partnerId, data: f }),
    onSuccess: () => { toast('Карточка сохранена'); void qc.invalidateQueries({ queryKey: ['partner-card', partnerId] }); onClose(); },
  });
  const text = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label}>{(id) => <Input id={id} value={f[k]} onChange={set(k)} {...props} />}</Field>
  );
  return (
    <ConfirmDialog open title="Карточка франчайзи" confirmLabel="Сохранить карточку" cancelLabel="Закрыть" busy={m.isPending} error={m.error}
      onClose={onClose} onConfirm={() => m.mutate()}>
      <h3 className="section-title">Владелец и связь</h3>
      {text('owner_name', 'Владелец (ФИО)')}
      <div className="grid grid-2" style={{ gap: 12 }}>
        {text('phone2', 'Второй телефон', { type: 'tel' })}
        {text('telegram', 'Telegram', { placeholder: '@имя или телефон' })}
        {text('whatsapp', 'WhatsApp', { type: 'tel' })}
      </div>
      {text('contact_notes', 'Как удобнее связаться', { placeholder: 'Например: звонить после 18:00' })}

      <h3 className="section-title">Юрлицо и реквизиты</h3>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Форма">{(id) => (
          <Select id={id} value={f.legal_form} onChange={set('legal_form')}>
            <option value="">—</option>{LEGAL_FORMS.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        )}</Field>
        {text('legal_name', 'Название', { placeholder: 'ИП Иванов В. В.' })}
        {text('inn', 'ИНН / БИН', { inputMode: 'numeric' })}
        {text('ogrn', 'ОГРН / ОГРНИП', { inputMode: 'numeric' })}
      </div>
      {text('legal_address', 'Юридический адрес')}
      <Field label="Банковские реквизиты">{(id) => <Textarea id={id} rows={3} value={f.bank_details} onChange={set('bank_details')} />}</Field>

      <h3 className="section-title">Договор</h3>
      <div className="grid grid-2" style={{ gap: 12 }}>
        {text('contract_number', 'Номер договора')}
        {text('contract_date', 'Дата договора', { type: 'date' })}
        {text('contract_until', 'Действует до', { type: 'date' })}
        {text('started_on', 'Начало работы по франшизе', { type: 'date' })}
        <Field label={`Паушальный взнос, ${currency}`}>{(id) => <MoneyInput id={id} value={f.franchise_fee_minor} onChange={(v) => setF((x) => ({ ...x, franchise_fee_minor: v === '0' ? '' : v }))} currency={currency} />}</Field>
        {text('territory', 'Территория', { placeholder: 'Город / ТЦ, эксклюзив' })}
      </div>

      <h3 className="section-title">Заметки менеджера</h3>
      <Field label="Заметки" hint="Видит только менеджер по франшизе">{(id) => <Textarea id={id} rows={4} value={f.notes} onChange={set('notes')} />}</Field>
    </ConfirmDialog>
  );
}

function UploadDialog({ partnerId, file, onClose }: { partnerId: string; file: File; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState('contract');
  const [title, setTitle] = useState(file.name.replace(/\.[^.]+$/, ''));
  const [signed, setSigned] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      // В хранилище — только латиница (ключи с кириллицей Storage не принимает); исходное имя остаётся в названии документа
      const ext = (/\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1] ?? 'bin').toLowerCase();
      const path = `partner/${partnerId}/${crypto.randomUUID()}.${ext}`;
      await storage.upload(path, file);
      return command<string>('partner_document_add', { partner: partnerId, kind, title, path, size: file.size, mime: file.type || null, signed_on: signed || null });
    },
    onSuccess: () => { toast('Документ загружен'); void qc.invalidateQueries({ queryKey: ['partner-card', partnerId] }); onClose(); },
  });
  return (
    <ConfirmDialog open title="Загрузить документ" confirmLabel="Загрузить" cancelLabel="Закрыть" busy={m.isPending} error={m.error}
      disabled={!title.trim()} onClose={onClose} onConfirm={() => m.mutate()}>
      <p className="muted">{file.name} · {(file.size / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ</p>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <Field label="Тип">{(id) => (
          <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(DOC_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        )}</Field>
        <Field label="Дата подписания">{(id) => <Input id={id} type="date" value={signed} onChange={(e) => setSigned(e.target.value)} />}</Field>
      </div>
      <Field label="Название" required>{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />}</Field>
    </ConfirmDialog>
  );
}

function DocumentsCard({ partnerId, docs }: { partnerId: string; docs: Doc[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [del, setDel] = useState<Doc | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const open = useMutation({ mutationFn: async (d: Doc) => { const url = await storage.signedUrl(d.path, 300); window.open(url, '_blank', 'noopener'); } });
  const remove = useMutation({
    mutationFn: async (d: Doc) => { const path = await command<string>('partner_document_delete', { id: d.id }); await storage.remove(path).catch(() => undefined); },
    onSuccess: () => { toast('Документ удалён'); setDel(null); void qc.invalidateQueries({ queryKey: ['partner-card', partnerId] }); },
  });
  return (
    <Card title="Документы" actions={<Button size="sm" onClick={() => input.current?.click()}><Upload size={15} aria-hidden />Загрузить</Button>}>
      <input ref={input} type="file" hidden accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xlsx,.xls"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (f.size > 20 * 1024 * 1024) { setTooBig(true); return; } setTooBig(false); setFile(f); }} />
      {tooBig && <p className="danger-text">Файл больше 20 МБ — сожмите его или загрузите по частям.</p>}
      {docs.length ? docs.map((d) => (
        <div key={d.id} className="row between access-row" style={{ flexWrap: 'nowrap' }}>
          <button type="button" className="doc-link" onClick={() => open.mutate(d)}>
            <FileText size={18} aria-hidden />
            <span><strong>{d.title}</strong>
              <span className="faint" style={{ display: 'block' }}>{DOC_KIND[d.kind] ?? d.kind}{d.signed_on ? ` · подписан ${formatDate(d.signed_on)}` : ''} · загружен {formatDate(d.created_at)}</span></span>
          </button>
          <span className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
            <button type="button" className="icon-btn" aria-label={`Открыть ${d.title}`} onClick={() => open.mutate(d)}><Download size={16} /></button>
            <button type="button" className="icon-btn" aria-label={`Удалить ${d.title}`} onClick={() => setDel(d)}><Trash2 size={16} /></button>
          </span>
        </div>
      )) : <p className="faint">Договор, допсоглашения, акты сверки — загрузите сюда, чтобы всё было в одном месте. PDF, Word, Excel или фото, до 20 МБ.</p>}
      <ActionError error={open.error} />
      {file && <UploadDialog partnerId={partnerId} file={file} onClose={() => setFile(null)} />}
      {del && (
        <ConfirmDialog open danger title="Удалить документ?" confirmLabel="Удалить" cancelLabel="Не удалять" busy={remove.isPending} error={remove.error}
          onClose={() => setDel(null)} onConfirm={() => remove.mutate(del)} summary={[['Документ', del.title], ['Тип', DOC_KIND[del.kind] ?? del.kind]]}>
          <p className="muted">Файл будет удалён без возможности восстановления.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

/** Ссылка контрагента в МойСклад: по ней франчайзи открывает заказ материалов из своего кабинета. */
function OrderLinkCard({ partnerId, url }: { partnerId: string; url: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState(url ?? '');
  const bad = value.trim() !== '' && !/^https:\/\/\S+$/.test(value.trim());
  const m = useMutation({
    mutationFn: (v: string) => command('partner_order_url_set', { partner: partnerId, url: v }),
    onSuccess: (_, v) => {
      toast(v.trim() ? 'Ссылка для заказа сохранена — у франчайзи появилась кнопка «Заказать материалы»' : 'Ссылка для заказа убрана');
      void qc.invalidateQueries({ queryKey: ['partner-card', partnerId] });
      void qc.invalidateQueries({ queryKey: ['partners'] });
      setEdit(false);
    },
  });
  return (
    <Card title="Заказ материалов" icon={<ShoppingCart size={16} aria-hidden />}
      actions={<Button size="sm" onClick={() => { setValue(url ?? ''); setEdit(true); }}><Link2 size={15} aria-hidden />{url ? 'Изменить' : 'Добавить ссылку'}</Button>}>
      {url ? (
        <>
          <a className="order-url" href={url} target="_blank" rel="noopener noreferrer">{url}<ExternalLink size={13} aria-hidden /></a>
          <p className="faint" style={{ marginTop: 6 }}>Франчайзи видит кнопку «Заказать материалы» — она открывает эту ссылку в МойСклад.
            При первом переходе он подтверждает, что ссылка персональная и делиться ею нельзя. Если ссылка попала к посторонним — смените её в МойСклад и вставьте новую.</p>
        </>
      ) : <p className="faint">Ссылки нет — кнопка заказа у франчайзи неактивна. Вставьте ссылку контрагента из МойСклад.</p>}
      {edit && (
        <ConfirmDialog open title="Ссылка для заказа в МойСклад" confirmLabel="Сохранить ссылку" cancelLabel="Закрыть" busy={m.isPending} error={m.error}
          disabled={bad || value.trim() === (url ?? '')} onClose={() => setEdit(false)} onConfirm={() => m.mutate(value)}>
          <p className="muted">Скопируйте из МойСклад ссылку, по которой этот франчайзи (контрагент) оформляет заказ, и вставьте сюда.
            По ней откроется МойСклад, когда франчайзи нажмёт «Заказать материалы».</p>
          <Field label="Ссылка" hint="Полная ссылка, начинается с https://. Пусто — убрать кнопку заказа" error={bad ? 'Ссылка должна начинаться с https://' : null}>
            {(id) => <Input id={id} type="url" inputMode="url" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://…" autoFocus />}
          </Field>
          {value.trim() && !bad && <a className="order-url" href={value.trim()} target="_blank" rel="noopener noreferrer">Проверить ссылку<ExternalLink size={13} aria-hidden /></a>}
        </ConfirmDialog>
      )}
    </Card>
  );
}

/** Правая колонка карточки франчайзи: данные, договор, точки, документы. */
export function PartnerCardPanel({ partner }: { partner: Partner }) {
  const [edit, setEdit] = useState(false);
  const q = useQuery({ queryKey: ['partner-card', partner.id], queryFn: () => partnerCard(partner.id) });
  return (
    <DataState query={q} skeleton={6}>
      {(c) => {
        const p = c.profile;
        const until = p?.contract_until ? daysTo(p.contract_until) : null;
        const cur = partner.currency;
        return (
          <div className="stack">
            {until !== null && until <= 60 && (
              <div className={`alert tone-${until < 0 ? 'danger' : 'warning'}`} role="status">
                <AlertTriangle size={18} aria-hidden />
                <div className="alert-body">{until < 0 ? `Договор истёк ${formatDate(p!.contract_until)}` : `Договор заканчивается ${formatDate(p!.contract_until)} — через ${until} дн.`}</div>
              </div>
            )}
            <Card title="Карточка франчайзи" actions={<Button size="sm" onClick={() => setEdit(true)}><Edit3 size={15} aria-hidden />{p ? 'Изменить' : 'Заполнить'}</Button>}>
              <KV items={[
                ['Работает с', or(c.stats.opened_on ? `${formatDate(c.stats.opened_on)} · ${since(c.stats.opened_on)}` : null)],
                ['Выручка за 12 мес.', formatMoneyShort(c.stats.revenue_12m_minor, cur)],
                ['Роялти', `${(c.stats.rate_bp / 100).toLocaleString('ru-RU')} %`],
                ['Вход в кабинет', c.stats.users ? `${c.stats.users} чел.` : <span className="faint">не выдан</span>],
                ['Сотрудников', String(c.stats.staff)],
              ]} />
              <h3 className="section-title" style={{ marginTop: 14 }}>Владелец и связь</h3>
              <KV items={[
                ['Владелец', or(p?.owner_name ?? partner.contact_name)],
                ['Телефон', or(partner.contact_phone && <a href={`tel:${partner.contact_phone}`}>{partner.contact_phone}</a>)],
                ...(p?.phone2 ? [['Второй телефон', <a key="p2" href={`tel:${p.phone2}`}>{p.phone2}</a>] as [string, ReactNode]] : []),
                ['Email', or(partner.contact_email && <a href={`mailto:${partner.contact_email}`}>{partner.contact_email}</a>)],
                ['Telegram', or(p?.telegram)], ['WhatsApp', or(p?.whatsapp)],
                ...(p?.contact_notes ? [['Связь', p.contact_notes] as [string, ReactNode]] : []),
              ]} />
              <h3 className="section-title" style={{ marginTop: 14 }}>Юрлицо</h3>
              <KV items={[
                ['Форма и название', or([p?.legal_form, p?.legal_name].filter(Boolean).join(' · '))],
                ['ИНН / БИН', or(p?.inn)], ['ОГРН', or(p?.ogrn)], ['Адрес', or(p?.legal_address)],
                ...(p?.bank_details ? [['Реквизиты', <span key="b" style={{ whiteSpace: 'pre-line' }}>{p.bank_details}</span>] as [string, ReactNode]] : []),
              ]} />
              <h3 className="section-title" style={{ marginTop: 14 }}>Договор</h3>
              <KV items={[
                ['Номер и дата', or([p?.contract_number && `№ ${p.contract_number}`, p?.contract_date && `от ${formatDate(p.contract_date)}`].filter(Boolean).join(' '))],
                ['Действует до', or(p?.contract_until && formatDate(p.contract_until))],
                ['Начало работы', or(p?.started_on && formatDate(p.started_on))],
                ['Паушальный взнос', or(p?.franchise_fee_minor ? formatMoneyShort(p.franchise_fee_minor, cur) : null)],
                ['Территория', or(p?.territory)],
              ]} />
              {p?.notes && <><h3 className="section-title" style={{ marginTop: 14 }}>Заметки</h3><p style={{ whiteSpace: 'pre-line', margin: 0 }}>{p.notes}</p></>}
              {p && <p className="faint" style={{ marginTop: 10 }}>Обновлено {formatDate(p.updated_at)}{c.updated_by_name ? ` · ${c.updated_by_name}` : ''}</p>}
            </Card>
            <Card title="Точки">
              {c.locations.map((l) => (
                <div key={l.id} className="access-row">
                  <strong>{l.name}</strong>{l.status !== 'active' && <span className="faint"> · закрыта</span>}
                  <span className="faint" style={{ display: 'block' }}>{[l.city, l.address].filter(Boolean).join(', ')}</span>
                  <span className="faint" style={{ display: 'block' }}>открыта {l.opened_on ? formatDate(l.opened_on) : '—'}{l.last_day ? ` · последняя выручка ${formatDate(l.last_day)}` : ' · выручки ещё нет'}</span>
                </div>
              ))}
            </Card>
            <OrderLinkCard partnerId={partner.id} url={c.partner.order_url} />
            <DocumentsCard partnerId={partner.id} docs={c.documents} />
            {edit && <ProfileDialog partnerId={partner.id} currency={cur} profile={p} onClose={() => setEdit(false)} />}
          </div>
        );
      }}
    </DataState>
  );
}
