import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { formatDate } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { formatMoney, groupByCurrency } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Button, Card, DataState, Field, Input, Select } from '../../ui';

const kinds = ['demand', 'salesreturn', 'supply', 'purchasereturn'] as const;
type Kind = typeof kinds[number];
interface Position {
  kind: Kind; document_id: string; id: string; name: string; day: string; product: string; quantity: number;
  price_minor?: string; discount?: number; amount_minor: string; currency: string; cost_minor?: string | null; cost_currency?: string | null;
  counterparty?: string; counterparty_name?: string; partner_id?: string | null;
}
interface Partner { id: string; name: string; locations: { id: string; name: string }[] }
interface Snapshot { fetched_at: string | null; rows: Position[]; partners?: Partner[] }

function DocumentMapping({ rows, partners }: { rows: Position[]; partners: Partner[] }) {
  const [counterparty, setCounterparty] = useState('');
  const [partner, setPartner] = useState('');
  const [location, setLocation] = useState('');
  const [day, setDay] = useState('');
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => command('manager_purchase_mapping', { counterparty, partner, location: location || null, effective_from: day }),
    onSuccess: async () => { setCounterparty(''); await qc.invalidateQueries({ queryKey: ['purchase-documents'] }); },
  });
  const accounts = new Map(rows.filter(r => r.kind === 'demand' || r.kind === 'salesreturn').map(r => [r.counterparty, r.counterparty_name]));
  if (!accounts.size) return null;
  return <Card><details><summary>Подтвердить привязку контрагента</summary>
    <form className="stack" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
      <Field label="Контрагент МойСклад">{id => <Select id={id} required value={counterparty} onChange={e => setCounterparty(e.target.value)}>
        <option value="">Выберите контрагента</option>
        {[...accounts].map(([key, name]) => <option key={key} value={key}>{name} · {key}</option>)}
      </Select>}</Field>
      <Field label="Франчайзи">{id => <Select id={id} required value={partner} onChange={e => { setPartner(e.target.value); setLocation(''); }}>
        <option value="">Выберите франчайзи</option>{partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>}</Field>
      <Field label="Точка">{id => <Select id={id} value={location} onChange={e => setLocation(e.target.value)}>
        <option value="">Без привязки к точке</option>
        {partners.find(p => p.id === partner)?.locations.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>}</Field>
      <Field label="Дата начала привязки">{id => <Input id={id} type="date" required value={day} onChange={e => setDay(e.target.value)} />}</Field>
      <Button type="submit" loading={mutation.isPending}>Подтвердить</Button>
      <ActionError error={mutation.error} />
      {mutation.isSuccess && <p role="status">Привязка сохранена.</p>}
    </form>
  </details></Card>;
}

export function PurchaseDocuments({ month, location = null, manager = false }: { month: string; location?: string | null; manager?: boolean }) {
  const { me } = useSession();
  const { t, locale } = useLocale();
  const query = useQuery({ queryKey: ['purchase-documents', manager, me?.user.id, month, location],
    queryFn: () => manager ? command<Snapshot>('manager_purchase_documents', { month })
      : command<Snapshot>('purchase_documents_my', { month, location }), refetchInterval: 120_000 });
  const labels = { demand: t('Отгрузки франчайзи', 'Bayilere sevkiyatlar'), salesreturn: t('Возвраты от франчайзи', 'Bayilerden iadeler'),
    supply: 'Приёмки от поставщиков', purchasereturn: 'Возвраты поставщикам' };
  return <DataState query={query}>{snapshot => <div className="stack purchase-documents">
    <Card>
      {snapshot.fetched_at ? <p>{t('Снимок МойСклад', 'MoySklad verileri')} · {new Date(snapshot.fetched_at).toLocaleString(locale, {timeZone:'Europe/Moscow'})} МСК</p>
        : <p>{t('За этот месяц снимок МойСклад ещё не загружен.', 'Bu ay için MoySklad verileri henüz yüklenmedi.')}</p>}
      {snapshot.fetched_at && !snapshot.rows.length && <p>{t('Нет документов для выбранного периода и точки.', 'Seçilen dönem ve satış noktası için belge yok.')}</p>}
    </Card>
    {kinds.map(kind => {
      const rows = snapshot.rows.filter(row => row.kind === kind);
      if (!rows.length) return null;
      const totals = groupByCurrency(rows, r => r.currency, r => r.amount_minor);
      const showCost = manager && (kind === 'demand' || kind === 'salesreturn');
      const costsComplete = rows.every(r => r.cost_minor != null && r.cost_currency != null);
      const costs = showCost && costsComplete ? groupByCurrency(rows, r => r.cost_currency!, r => r.cost_minor) : null;
      return <Card key={kind} title={labels[kind]}>
        <p>{t('Сумма по документам', 'Belge toplamı')} · {[...totals].map(([code, sum]) => formatMoney(sum, code, locale)).join(' · ')}</p>
        {showCost && <p>Себестоимость · {costs ? [...costs].map(([code,sum]) => formatMoney(sum,code,locale)).join(' · ') : 'Есть позиции без подтверждённой себестоимости'}</p>}
        <div className="table-wrap" role="region" tabIndex={0} aria-label={labels[kind]}><table className="table">
          <thead><tr><th>{t('Документ', 'Belge')}</th>{manager && <th>Контрагент</th>}<th>{t('Товар', 'Ürün')}</th>
            <th>{t('Количество', 'Miktar')}</th><th>{t('Сумма', 'Tutar')}</th>{showCost && <th>Себестоимость</th>}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.document_id + row.id}>
            <td>{formatDate(row.day, locale)} · {row.name}</td>{manager && <td>{row.counterparty_name}
              {showCost && <small>{snapshot.partners?.find(p => p.id === row.partner_id)?.name ?? 'Без привязки'}</small>}</td>}
            <td>{row.product}{row.price_minor != null && <small>
              {t('Цена', 'Fiyat')} · {new Intl.NumberFormat(locale, { style: 'currency', currency: row.currency,
                minimumFractionDigits: 2, maximumFractionDigits: 8 }).format(Number(row.price_minor) / 100)}
              {Boolean(row.discount) && ' · ' + t('Скидка', 'İndirim') + ' ' + row.discount + '%'}
            </small>}</td><td>{row.quantity.toLocaleString(locale)}</td><td>{formatMoney(row.amount_minor,row.currency,locale)}</td>
            {showCost && <td>{row.cost_minor != null && row.cost_currency ? formatMoney(row.cost_minor,row.cost_currency,locale) : 'Неизвестна'}</td>}
          </tr>)}</tbody>
        </table></div>
      </Card>;
    })}
    {manager && <DocumentMapping rows={snapshot.rows} partners={snapshot.partners ?? []} />}
  </div>}</DataState>;
}
