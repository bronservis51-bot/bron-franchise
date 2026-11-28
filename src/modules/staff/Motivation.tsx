import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command, toAppError } from '../../platform/backend';
import { formatDate } from '../../platform/dates';
import { formatMoneyShort, parseMoney } from '../../platform/money';
import { ActionError, Button, Card, DataState, Field, Input, MoneyInput, Select } from '../../ui';
import { currencySymbol } from './CustomPayFields';
import { pctBp } from './api';
import { PayCatalogue, PayDraftFields, usePayDraft } from './PaySchemes';
import { useLocale } from '../../platform/locale';
import './pay-settings.css';

type PayTier = { from_minor: number; rate_bp: number; bonus_minor: number };
export type AutomaticPaySettings = { location_id: string; currency: 'RUB'; source?: 'history' | 'starter'; staffing: Partial<Record<2 | 3, PayTier[]>> };
export type PayPolicy = { floor_minor: number; tiers: PayTier[]; automatic?: AutomaticPaySettings };
export type ShiftPolicy = (PayPolicy | { mode: 'legacy'; rate_bp: number; fee_minor: number }) & { additional_point?: boolean; name?:string };
type DatedPolicy<P = ShiftPolicy> = { effective_from: string; policy: P };
type Motivation = { version: number; policy: ShiftPolicy; currency: string; today?: string;
  baseline?: ShiftPolicy; history?: DatedPolicy[]; scheduled?: DatedPolicy[] };

export function teamPolicyForDate<P extends ShiftPolicy>(terms: {policy:P;baseline?:P;history?:DatedPolicy<P>[];scheduled?:DatedPolicy<P>[]}, date: string) {
  if (!date) return terms.policy;
  const versions = [...(terms.history ?? []), ...(terms.scheduled ?? [])];
  return versions.reverse().find(v => v.effective_from <= date)?.policy ?? terms.baseline ?? terms.policy;
}

function reachedTier(policy: PayPolicy, total: bigint) {
  return [...policy.tiers].reverse().find(t => BigInt(t.from_minor) <= total);
}

export function calculatePay(total: bigint, rate: number, fee: number, policy?: ShiftPolicy | null): bigint {
  if (!policy) return BigInt(fee) + (total * BigInt(rate) + 5000n) / 10000n;
  if ('mode' in policy) return BigInt(policy.fee_minor) + (total * BigInt(policy.rate_bp) + 5000n) / 10000n;
  const tier = reachedTier(policy, total);
  if (!tier) return 0n;
  const percentage = (total * BigInt(tier.rate_bp) + 5000n) / 10000n;
  return (percentage > BigInt(policy.floor_minor) ? percentage : BigInt(policy.floor_minor)) + BigInt(tier.bonus_minor);
}

export function useMotivation(partner: string, enabled = true) {
  return useQuery({ queryKey: ['motivation', partner], enabled, queryFn: () => command<Motivation>('motivation_get', { partner }) });
}

function ExampleResult({ policy, total, currency, label }: { policy: ShiftPolicy; total: bigint; currency: string; label: string }) {
  const {t,locale}=useLocale();
  const tier = 'tiers' in policy ? reachedTier(policy, total) : null;
  const terms = 'mode' in policy
    ? `${formatMoneyShort(policy.fee_minor, currency,locale)} ${t('за выход','vardiya ücreti')} + ${pctBp(policy.rate_bp)} ${t('от выручки','ciro payı')}`
    : tier && `${pctBp(tier.rate_bp)} ${t('от выручки, гарантия','ciro payı, garanti')} ${formatMoneyShort(policy.floor_minor, currency,locale)}, ${t('премия','prim')} ${formatMoneyShort(tier.bonus_minor, currency,locale)}`;
  return <div className="pay-result">
    <span>{label}</span>
    <strong className="num">{formatMoneyShort(calculatePay(total, 0, 0, policy), currency,locale)}</strong>
    <small>{terms}</small>
  </div>;
}

export function PayExample({ currency, policy, traineePolicy }: { currency: string; policy: ShiftPolicy | null; traineePolicy?: ShiftPolicy | null }) {
  const {t}=useLocale();
  const [revenue, setRevenue] = useState(() => String(parseMoney('10000', currency)));
  const [valid, setValid] = useState(true);
  const [staffCount, setStaffCount] = useState<1 | 2 | 3>(1);
  const automatic = policy && 'tiers' in policy ? policy.automatic : undefined;
  const staffTiers = automatic && staffCount !== 1 ? automatic.staffing[staffCount] : undefined;
  const examplePolicy: ShiftPolicy | null = staffTiers && policy && 'tiers' in policy ? { ...policy, tiers: staffTiers } : policy;
  return <section className="pay-example" aria-label={t('Пример расчёта','Hesaplama örneği')}>
    <h4>{t('Пример расчёта','Hesaplama örneği')}</h4>
    {automatic && Object.keys(automatic.staffing).length > 0 && <Field label={t('Сотрудников на точке','Mağazadaki çalışan sayısı')}>{id =>
      <Select id={id} value={staffTiers ? staffCount : 1} onChange={e=>setStaffCount(Number(e.target.value) as 1 | 2 | 3)}>
        <option value="1">1</option>
        {automatic.staffing[2] && <option value="2">2</option>}
        {automatic.staffing[3] && <option value="3">3</option>}
      </Select>}
    </Field>}
    <Field label={(automatic ? t('Общая касса точки за день','Mağazanın günlük toplam cirosu') : t('Выручка за смену','Vardiya cirosu'))+', '+currencySymbol(currency)} error={!valid ? t('Введите сумму выручки','Ciro tutarını girin') : undefined}>{(id, describedBy) =>
      <MoneyInput id={id} value={revenue} currency={currency} describedBy={describedBy} placeholder="0"
        onChange={setRevenue} onValidityChange={setValid} />}</Field>
    <div aria-live="polite">
      {valid && !policy && !traineePolicy && <p className="pay-help">{t('Для расчёта проверьте поля схемы.','Hesaplama için plan alanlarını kontrol edin.')}</p>}
      {valid && traineePolicy && <ExampleResult label={t('На стажировке','Staj sırasında')} currency={currency} total={BigInt(revenue || '0')} policy={traineePolicy} />}
      {valid && examplePolicy && <ExampleResult label={traineePolicy !== undefined ? t('После стажировки','Stajdan sonra') : t('Сотрудник получит','Çalışanın kazancı')} currency={currency} total={BigInt(revenue || '0')} policy={examplePolicy} />}
    </div>
  </section>;
}

export const payTiming = 'При сдаче выручки применяются условия, действовавшие в день смены. Принятые и ранее открытые смены сохраняют свои условия.';

function TeamPayEditor({ partner, saved, initialDate, onClose }: { partner: string; saved: Motivation; initialDate: string; onClose: () => void }) {
  const {t}=useLocale();
  const qc = useQueryClient();
  const [version] = useState(saved.version);
  const [date, setDate] = useState(initialDate || saved.today || '');
  const draft=usePayDraft(saved.scheduled?.find(v=>v.effective_from===initialDate)?.policy ?? saved.policy);
  const policy=draft.policy;
  const m = useMutation({
    mutationFn: (next: ShiftPolicy) => command('motivation_set', { partner, policy: { ...next, ...(date ? { effective_from: date } : {}) }, expected_version: version }),
    onError: error => {
      if (toAppError(error).code === 'version-conflict') void qc.invalidateQueries({ queryKey: ['motivation', partner] });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['motivation', partner] });
      onClose();
    },
  });
  return <div className="pay-layout" data-unsaved="true">
    <Field label={t('Действует с','Başlangıç tarihi')} help={t('Дата смены по местному времени точки.','Şubenin yerel saatine göre vardiya tarihi.')}>{id => <Input id={id} type="date" readOnly={Boolean(initialDate)} value={date} onChange={e => setDate(e.target.value)} />}</Field>
    <PayDraftFields currency={saved.currency} draft={draft} />
    <details className="pay-explanation"><summary>{t('Как считается оплата','Ücret nasıl hesaplanır')}</summary>
      <p className="pay-help">{draft.mode==='fixed'?t('Сотрудник получает ставку за выход и процент от выручки смены.','Çalışan vardiya ücreti ve vardiya cirosundan pay alır.'):t('Сотрудник получает большую из двух сумм — гарантию или процент от всей выручки смены. Премия прибавляется сверху.','Garanti ile vardiya cirosundan alınan payın yüksek olanına prim eklenir.')}</p>
      <PayExample currency={saved.currency} policy={policy} />
      <p className="pay-help">{t(payTiming,'Vardiya tarihindeki koşullar uygulanır. Kaydedilmiş ve daha önce açılmış vardiyaların koşulları korunur.')}</p>
    </details>
    <ActionError error={m.error} />
    <div className="row"><Button disabled={m.isPending} onClick={onClose}>{t('Отмена','İptal')}</Button>
      <Button variant="primary" loading={m.isPending} disabled={!policy} onClick={() => policy && m.mutate(policy)}>{t('Сохранить схему','Planı kaydet')}</Button></div>
  </div>;
}

export function MotivationPanel({ partner, canEdit }: { partner: string; canEdit: boolean }) {
  const {t,locale}=useLocale();
  const q = useMotivation(partner);
  const [edit, setEdit] = useState<string | null>(null);
  return <><Card title={t("Общая схема","Ortak ücret planı")} className="pay-settings"><DataState query={q}>{d =>
    edit !== null && canEdit ? <TeamPayEditor partner={partner} saved={d} initialDate={edit} onClose={() => setEdit(null)} /> : <div className="pay-layout">
      {d.policy.name && <strong>{d.policy.name}</strong>}
      {'mode' in d.policy ? <p>{t('Ставка за выход','Vardiya ücreti')} {formatMoneyShort(d.policy.fee_minor,d.currency,locale)} + {pctBp(d.policy.rate_bp)}</p> :
      <><p>{t('Гарантия за смену','Vardiya garantisi')} <strong className="num">{formatMoneyShort(d.policy.floor_minor, d.currency,locale)}</strong></p>
      <p className="pay-help">{t('Для сотрудников на общей схеме процент и премия зависят от выручки смены. У стажёра своя гарантия.','Ortak planda yüzde ve prim vardiya cirosuna bağlıdır. Stajyerin garantisi ayrıdır.')}</p>
      <details className="pay-table"><summary>{t('Ступени по выручке','Ciro kademeleri')} ({d.policy.tiers.length})</summary>
        <div className="table-wrap"><table className="table"><thead><tr><th>{t('Выручка от','Ciro eşiği')}</th><th>{t('Доля','Pay')}</th><th>{t('Премия','Prim')}</th></tr></thead>
          <tbody>{d.policy.tiers.map(t => <tr key={t.from_minor}><td>{formatMoneyShort(t.from_minor, d.currency,locale)}</td><td>{pctBp(t.rate_bp)}</td><td>{formatMoneyShort(t.bonus_minor, d.currency,locale)}</td></tr>)}</tbody></table></div>
      </details></>}
      {canEdit && <Button onClick={() => setEdit('')}>{t('Изменить общую схему','Ortak planı düzenle')}</Button>}
      {d.scheduled?.map(v => <div className="row between" key={v.effective_from}>
        <span>{t('С','Başlangıç')} {formatDate(v.effective_from,locale)} · {v.policy.name ?? ('mode' in v.policy ? formatMoneyShort(v.policy.fee_minor,d.currency,locale)+' + '+pctBp(v.policy.rate_bp) : t('Гарантия','Garanti')+' '+formatMoneyShort(v.policy.floor_minor, d.currency,locale))}</span>
        {canEdit && <Button size="sm" onClick={() => setEdit(v.effective_from)}>{t('Изменить условия с','Koşulları düzenle')} {formatDate(v.effective_from,locale)}</Button>}
      </div>)}
    </div>}
  </DataState></Card>
  {canEdit && q.data && <PayCatalogue partner={partner} currency={q.data.currency} version={q.data.version} today={q.data.today} policy={q.data.policy}/>}</>;
}
