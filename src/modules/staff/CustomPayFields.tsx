import type { Dispatch, SetStateAction } from 'react';
import { HelpTip } from '../../ui/HelpTip';
import { useLocale } from '../../platform/locale';
import { X } from 'lucide-react';
import { Button, Field, Input, MoneyInput } from '../../ui';
import type { CustomShiftPay } from './api';
import type { PayPolicy } from './Motivation';

export const maxPolicyMinor = 99_999_999_999;
const maxTiers = 20;
const nameLimit = 100;

type Money = { minor: string; valid: boolean };
type Tier = { id: string; from: Money; rate: string; bonus: Money };
export type CustomPayDraft = { name: string; floor: Money; tiers: Tier[] };

function money(minor = 0): Money { return { minor: String(minor), valid: true }; }

function newTier(id: string): Tier { return { id, from: money(), rate: '0', bonus: money() }; }

export function customPayDraft(policy?: (PayPolicy & { name?: string }) | null): CustomPayDraft {
  return {
    name: policy?.name ?? '', floor: money(policy?.floor_minor),
    tiers: policy?.tiers.map((t, i) => ({ id: `tier-${i}`, from: money(t.from_minor), rate: String(t.rate_bp / 100).replace('.', ','), bonus: money(t.bonus_minor) }))
      ?? [newTier('first')],
  };
}

export function validPolicyMoney(value: Money) { return value.valid && Number(value.minor) <= maxPolicyMinor; }

export function percentToBp(value: string): number | null {
  const input = value.trim();
  if (input && !/^\d+(?:[,.]\d{1,2})?$/.test(input)) return null;
  const percent = Number(input.replace(',', '.'));
  return percent >= 0 && percent <= 100 ? Math.round(percent * 100) : null;
}

export function tierPolicy(draft: CustomPayDraft): PayPolicy | null {
  if (!validPolicyMoney(draft.floor) || !draft.tiers.length || draft.tiers.length > maxTiers) return null;
  const tiers: CustomShiftPay['tiers'] = [];
  for (const [index, tier] of draft.tiers.entries()) {
    const rate = percentToBp(tier.rate);
    const from = Number(tier.from.minor);
    if (rate === null || !validPolicyMoney(tier.from) || !validPolicyMoney(tier.bonus)
      || (index ? from <= tiers[index - 1].from_minor : from !== 0)) return null;
    tiers.push({ from_minor: from, rate_bp: rate, bonus_minor: Number(tier.bonus.minor) });
  }
  return { floor_minor: Number(draft.floor.minor), tiers };
}

export function customPayPolicy(draft: CustomPayDraft): CustomShiftPay | null {
  const policy = tierPolicy(draft);
  const name = draft.name.trim();
  return policy && name && name.length <= nameLimit ? { name, ...policy } : null;
}

export function currencySymbol(currency: string) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
    .formatToParts(0).find(part => part.type === 'currency')?.value ?? currency;
}

function PolicyMoney({ label, value, currency, onChange, error, help }: {
  label: string; value: Money; currency: string; onChange: (value: Money) => void; error?: string; help?:string;
}) {
  const {t}=useLocale();
  const message = error ?? (validPolicyMoney(value) ? undefined : t('Проверьте сумму','Tutarı kontrol edin'));
  return <Field label={label} error={message} help={help}>
    {(id, describedBy) => <MoneyInput id={id} describedBy={describedBy} invalid={Boolean(message)}
      value={value.minor} currency={currency} placeholder="0"
      onChange={minor => onChange({ minor, valid: true })}
      onValidityChange={valid => { if (!valid) onChange({ ...value, valid: false }); }} />}
  </Field>;
}

export function CustomPayFields({ currency, draft, setDraft, named = true }: {
  currency: string; draft: CustomPayDraft; setDraft: Dispatch<SetStateAction<CustomPayDraft>>; named?: boolean;
}) {
  const {t}=useLocale();
  const unit = currencySymbol(currency);
  const updateTier = (id: string, next: Partial<Tier>) => setDraft(current => ({ ...current,
    tiers: current.tiers.map(tier => tier.id === id ? { ...tier, ...next } : tier),
  }));
  return <div className="pay-fields">
    {named && <Field label={t('Название схемы','Plan adı')} help={t('Так условия будут подписаны в карточке сотрудника.','Bu ad çalışanın kartında gösterilir.')} required hint={!draft.name.trim() ? 'Введите название для сохранения условий.' : undefined}>{(id, describedBy) =>
      <Input id={id} aria-describedby={describedBy} value={draft.name} maxLength={nameLimit}
      placeholder="Например, старший продавец" onChange={e => {
        const name = e.target.value;
        setDraft(current => ({ ...current, name }));
      }} />}</Field>}
    <PolicyMoney label={t('Гарантия за смену','Vardiya garantisi')+', '+unit} help={t('Минимум за смену до начисления премии.','Prim eklenmeden önceki asgari vardiya ücreti.')} value={draft.floor} currency={currency}
      onChange={floor => setDraft(current => ({ ...current, floor }))} />
    <div className="pay-tier-wrap">
      <div className="pay-tier-mobile-help">{t('Ступени оплаты','Ücret kademeleri')}
        <HelpTip label={t('Как читать ступени','Kademeler nasıl okunur')}>{t('Достигнутый порог определяет процент от всей выручки и премию за смену.', 'Ulaşılan eşik tüm cironun yüzdesini ve vardiya primini belirler.')}</HelpTip></div>
      <table className="pay-tier-grid" aria-label={t('Ступени оплаты','Ücret kademeleri')}>
      <thead><tr><th scope="col">{t('Выручка от','Ciro eşiği')}, {unit}<HelpTip label={t('Порог выручки','Ciro eşiği')}>{t('При этой выручке начинает действовать строка.','Bu cirodan itibaren satırdaki koşullar uygulanır.')}</HelpTip></th>
        <th scope="col">{t('Доля, %','Pay, %')}<HelpTip label={t('Доля выручки','Ciro payı')}>{t('Процент применяется ко всей выручке смены.','Yüzde vardiyanın tüm cirosuna uygulanır.')}</HelpTip></th>
        <th scope="col">{t('Премия','Prim')}, {unit}<HelpTip label={t('Премия за смену','Vardiya primi')}>{t('Прибавляется к гарантии или проценту достигнутой ступени.','Ulaşılan kademenin garantisine veya yüzde tutarına eklenir.')}</HelpTip></th>
        <th scope="col"><span className="sr-only">Действие</span></th></tr></thead>
      <tbody>{draft.tiers.map((tier, index) => {
        const fromError = index > 0 && Number(tier.from.minor) <= Number(draft.tiers[index - 1].from.minor)
          ? 'Порог должен быть выше предыдущего' : undefined;
        const rateError = percentToBp(tier.rate) === null ? 'Введите число от 0 до 100 с точностью до сотых' : undefined;
        const row = t('Ступень','Kademe')+' '+(index+1);
        return <tr key={tier.id}>
          <td>{index === 0 ? <span className="pay-from-zero"><span className="sr-only">{row}. Выручка от, {unit}: </span>0</span>
            : <PolicyMoney label={row+'. '+t('Выручка от','Ciro eşiği')+', '+unit} value={tier.from} currency={currency} error={fromError}
              onChange={from => updateTier(tier.id, { from })} />}</td>
          <td><Field label={row+'. '+t('Доля выручки, %','Ciro payı, %')} error={rateError}>{(id, describedBy) =>
            <Input id={id} inputMode="decimal" value={tier.rate} aria-describedby={describedBy}
              aria-invalid={Boolean(rateError) || undefined} onChange={e => updateTier(tier.id, { rate: e.target.value })} />}</Field></td>
          <td><PolicyMoney label={row+'. '+t('Премия','Prim')+', '+unit} value={tier.bonus} currency={currency}
            onChange={bonus => updateTier(tier.id, { bonus })} /></td>
          <td>{index > 0 && <Button size="sm" variant="ghost" aria-label={`Убрать ступень ${index + 1}`}
            onClick={() => setDraft(current => ({ ...current, tiers: current.tiers.filter(item => item.id !== tier.id) }))}>
            <X size={16} aria-hidden /></Button>}</td>
        </tr>;
      })}</tbody>
    </table></div>
    {draft.tiers.length < maxTiers && <Button size="sm" onClick={() => {
      const next = newTier(crypto.randomUUID());
      setDraft(current => ({ ...current, tiers: [...current.tiers, next] }));
    }}>{t('Добавить ступень','Kademe ekle')}</Button>}
  </div>;
}
