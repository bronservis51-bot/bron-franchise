import type { Dispatch, SetStateAction } from 'react';
import { formatMoneyShort } from '../../platform/money';
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

function PolicyMoney({ label, value, currency, onChange, error }: {
  label: string; value: Money; currency: string; onChange: (value: Money) => void; error?: string;
}) {
  const message = error ?? (validPolicyMoney(value) ? undefined : 'Проверьте сумму');
  return <Field label={label} error={message}>
    {(id, describedBy) => <MoneyInput id={id} describedBy={describedBy} invalid={Boolean(message)}
      value={value.minor} currency={currency} placeholder="0"
      onChange={minor => onChange({ minor, valid: true })}
      onValidityChange={valid => { if (!valid) onChange({ ...value, valid: false }); }} />}
  </Field>;
}

export function CustomPayFields({ currency, draft, setDraft, named = true }: {
  currency: string; draft: CustomPayDraft; setDraft: Dispatch<SetStateAction<CustomPayDraft>>; named?: boolean;
}) {
  const unit = currencySymbol(currency);
  const updateTier = (id: string, next: Partial<Tier>) => setDraft(current => ({ ...current,
    tiers: current.tiers.map(tier => tier.id === id ? { ...tier, ...next } : tier),
  }));
  return <div className="pay-fields">
    {named && <Field label="Название схемы" required hint={!draft.name.trim() ? 'Введите название для сохранения условий.' : undefined}>{(id, describedBy) =>
      <Input id={id} aria-describedby={describedBy} value={draft.name} maxLength={nameLimit}
      placeholder="Например, старший продавец" onChange={e => {
        const name = e.target.value;
        setDraft(current => ({ ...current, name }));
      }} />}</Field>}
    <PolicyMoney label={`Гарантия за смену, ${unit}`} value={draft.floor} currency={currency}
      onChange={floor => setDraft(current => ({ ...current, floor }))} />
    <p className="pay-help">Порог определяет процент от всей выручки смены. Сотрудник получит большую из двух сумм — гарантию или процент. Премия прибавится сверху.</p>
    {draft.tiers.map((tier, index) => {
      const fromError = index > 0 && Number(tier.from.minor) <= Number(draft.tiers[index - 1].from.minor)
        ? 'Порог должен быть выше предыдущего' : undefined;
      const rateError = percentToBp(tier.rate) === null ? 'Введите число от 0 до 100 с точностью до сотых' : undefined;
      return <fieldset className="pay-tier" key={tier.id}>
        <legend>Ступень {index + 1}{index === 0 && ` · от ${formatMoneyShort(0, currency)}`}</legend>
        <div className="pay-field-grid">
          {index > 0 && <PolicyMoney label={`Выручка от, ${unit}`} value={tier.from} currency={currency} error={fromError}
            onChange={from => updateTier(tier.id, { from })} />}
          <Field label="Доля выручки, %" error={rateError}>{(id, describedBy) => <Input id={id} inputMode="decimal" value={tier.rate}
            aria-describedby={describedBy} aria-invalid={Boolean(rateError) || undefined} onChange={e => updateTier(tier.id, { rate: e.target.value })} />}</Field>
          <PolicyMoney label={`Премия, ${unit}`} value={tier.bonus} currency={currency} onChange={bonus => updateTier(tier.id, { bonus })} />
        </div>
        {index > 0 && <Button size="sm" variant="ghost" aria-label={`Убрать ступень ${index + 1}`} onClick={() => setDraft(current => ({ ...current,
          tiers: current.tiers.filter(item => item.id !== tier.id),
        }))}>Убрать ступень</Button>}
      </fieldset>;
    })}
    {draft.tiers.length < maxTiers && <Button size="sm" onClick={() => {
      const next = newTier(crypto.randomUUID());
      setDraft(current => ({ ...current, tiers: [...current.tiers, next] }));
    }}>Добавить ступень</Button>}
  </div>;
}
