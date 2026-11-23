import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toAppError } from '../../platform/backend';
import { Button, ConfirmDialog, DataState, Field, Input, Select } from '../../ui';
import { PartnerDialog } from '../manager/PartnerDialog';
import { partners } from '../manager/api';
import { leadLinkPartner, type Lead } from './api';
import { canonicalLeadPhone, leadPhoneCountry } from './contact';

export function LeadPartnerDialog({ lead, onClose, onLinked }: { lead: Lead; onClose: () => void; onLinked: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'choose' | 'link' | 'create'>('choose');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState('');
  const [operation] = useState(() => crypto.randomUUID());
  const all = useQuery({ queryKey: ['partners'], queryFn: partners, enabled: mode === 'link' });
  const link = useMutation({
    mutationFn: () => leadLinkPartner(lead, selected, null, operation),
    onSuccess: () => { onLinked(); onClose(); },
    onError: error => {
      if (['version-conflict', 'transition-not-allowed'].includes(toAppError(error).code)) {
        void qc.invalidateQueries({ queryKey: ['leads'] });
      }
    },
  });
  const close = () => { if (!link.isPending) onClose(); };
  const preferred = canonicalLeadPhone(lead.phone);
  const query = search.trim().toLocaleLowerCase('ru');
  const phoneQuery = /^[\d\s+().-]+$/.test(query) ? canonicalLeadPhone(query) : '';
  const items = (all.data ?? []).filter(p => [p.name, p.code, p.contact_name, p.contact_city, p.contact_phone]
    .some(value => value?.toLocaleLowerCase('ru').includes(query))
    || Boolean(phoneQuery && canonicalLeadPhone(p.contact_phone ?? '').includes(phoneQuery)));
  if (preferred) {
    items.sort((a, b) => Number(canonicalLeadPhone(b.contact_phone ?? '') === preferred) - Number(canonicalLeadPhone(a.contact_phone ?? '') === preferred));
  }

  if (mode === 'create') return <PartnerDialog onClose={close} onSaved={onLinked} fromLead={{
    initial: {
      name: lead.name, country: leadPhoneCountry(lead.phone), contact_name: lead.name, contact_phone: lead.phone,
      contact_city: lead.city, contact_instagram: lead.instagram ?? '', preparation_stage: 'contract_signed',
    },
    create: (fields, key) => leadLinkPartner(lead, null, fields, key),
  }} />;
  if (mode === 'link') return <ConfirmDialog open title="Связать с франчайзи" confirmLabel="Связать" busy={link.isPending} error={link.error}
    onClose={close} onConfirm={() => link.mutate()} disabled={!selected || !items.some(p => p.id === selected)}>
    <p>Заявка «{lead.name}»</p>
    <Field label="Поиск франчайзи">{id => <Input id={id} value={search} onChange={e => { setSearch(e.target.value); setSelected(''); }} />}</Field>
    <DataState query={all}>{() => items.length ? <Field label="Франчайзи" required>{id => <Select id={id} value={selected} onChange={e => setSelected(e.target.value)}>
      <option value="">Выберите франчайзи</option>
      {items.map(p => <option key={p.id} value={p.id}>{[p.name, p.contact_phone, p.code].filter(Boolean).join(' · ')}</option>)}
    </Select>}</Field> : <p className="faint">Франчайзи не найдены.</p>}</DataState>
  </ConfirmDialog>;

  return <ConfirmDialog open title="Франчайзи по заявке" cancelLabel="Отмена" onClose={close}>
    <p>{[lead.name, lead.city, lead.phone].filter(Boolean).join(' · ')}</p>
    <div className="row">
      <Button variant="primary" onClick={() => setMode('create')}>Создать нового франчайзи</Button>
      <Button onClick={() => setMode('link')}>Связать с существующим</Button>
    </div>
  </ConfirmDialog>;
}
