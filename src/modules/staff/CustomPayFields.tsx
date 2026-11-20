import { useState, type Dispatch, type SetStateAction } from 'react';
import { formatMoneyShort } from '../../platform/money';
import { Button, Field, Input, MoneyInput } from '../../ui';
import type { CustomShiftPay } from './api';

const maxMinor = 99_999_999_999;
const maxTiers = 20;
const nameLimit = 100;

type Money = { minor: string; valid: boolean };
type Tier = { id: string; from: Money; rate: string; bonus: Money };
export type CustomPayDraft = { name: string; floor: Money; tiers: Tier[] };

function money(minor = 0): Money { return { minor: String(minor), valid: true }; }

function newTier(id: string): Tier { return { id, from: money(), rate: '0', bonus: money() }; }

export function customPayDraft(policy?: CustomShiftPay | null): CustomPayDraft {
  return {
    name: policy?.name ?? '', floor: money(policy?.floor_minor),
    tiers: policy?.tiers.map((t, i) => ({ id: `tier-${i}`, from: money(t.from_minor), rate: String(t.rate_bp / 100).replace('.', ','), bonus: money(t.bonus_minor) }))
      ?? [newTier('first')],
  };
}

function validMoney(value: Money) { return value.valid && Number(value.minor) <= maxMinor; }

export function percentToBp(value: string): number | null {
  const input = value.trim();
  if (input && !/^\d+(?:[,.]\d{0,2})?$/.test(input)) return null;
  const percent = Number(input.replace(',', '.'));
  return percent >= 0 && percent <= 100 ? Math.round(percent * 100) : null;
}

export function customPayPolicy(draft: CustomPayDraft): CustomShiftPay | null {
  const name = draft.name.trim();
  if (!name || name.length > nameLimit || !validMoney(draft.floor) || !draft.tiers.length || draft.tiers.length > maxTiers) return null;
  const tiers: CustomShiftPay['tiers'] = [];
  for (const [index, tier] of draft.tiers.entries()) {
    const rate = percentToBp(tier.rate);
    const from = Number(tier.from.minor);
    if (rate === null || !validMoney(tier.from) || !validMoney(tier.bonus)
      || (index ? from <= tiers[index - 1].from_minor : from !== 0)) return null;
    tiers.push({ from_minor: from, rate_bp: rate, bonus_minor: Number(tier.bonus.minor) });
  }
  return { name, floor_minor: Number(draft.floor.minor), tiers };
}

function PolicyMoney({ label, value, currency, onChange, error }: {
  label: string; value: Money; currency: string; onChange: (value: Money) => void; error?: string;
}) {
  return <Field label={label} error={error ?? (validMoney(value) ? undefined : 'Проверьте сумму')}>
    {id => <MoneyInput id={id} value={value.minor} currency={currency} placeholder="0"
      onChange={minor => onChange({ minor, valid: true })}
      onValidityChange={valid => { if (!valid) onChange({ ...value, valid: false }); }} />}
  </Field>;
}

export function CustomPayFields({ currency, draft, setDraft }: {
  currency: string; draft: CustomPayDraft; setDraft: Dispatch<SetStateAction<CustomPayDraft>>;
}) {
  const [openedTier, setOpenedTier] = useState(draft.tiers[0]?.id);
  const updateTier = (id: string, next: Partial<Tier>) => setDraft(current => ({ ...current,
    tiers: current.tiers.map(tier => tier.id === id ? { ...tier, ...next } : tier),
  }));
  const addTier = () => {
    const next = newTier(crypto.randomUUID());
    setDraft(current => ({ ...current, tiers: [...current.tiers, next] }));
    setOpenedTier(next.id);
  };
  return <div className="stack">
    <Field label="Название формулы" required>{id => <Input id={id} value={draft.name} maxLength={nameLimit}
      onChange={e => setDraft(current => ({ ...current, name: e.target.value }))} />}</Field>
    <PolicyMoney label={`Минимум за смену, ${currency}`} value={draft.floor} currency={currency}
      onChange={floor => setDraft(current => ({ ...current, floor }))} />
    <p className="faint">Берётся большее из минимума и процента от выручки. Премия прибавляется сверху.</p>
    {draft.tiers.map((tier, index) => {
      const fromError = index > 0 && Number(tier.from.minor) <= Number(draft.tiers[index - 1].from.minor)
        ? 'Порог должен быть выше предыдущего' : undefined;
      const rateError = percentToBp(tier.rate) === null ? 'Введите число от 0 до 100 с точностью до сотых' : undefined;
      return <details key={tier.id} open={openedTier === tier.id}>
        <summary>{validMoney(tier.from) ? `От ${formatMoneyShort(tier.from.minor, currency)}` : 'Проверьте порог'}
          {Boolean(fromError || rateError || !validMoney(tier.bonus)) && <span className="danger-text" style={{ marginInlineStart: 8 }}>Проверьте значения</span>}
        </summary>
        <div className="grid grid-3" style={{ marginTop: 'var(--space-2)' }}>
          {index > 0 && <PolicyMoney label={`Выручка от, ${currency}`} value={tier.from} currency={currency} error={fromError}
            onChange={from => updateTier(tier.id, { from })} />}
          <Field label="Процент" error={rateError}>{(id, describedBy) => <Input id={id} inputMode="decimal" value={tier.rate}
            aria-describedby={describedBy} aria-invalid={Boolean(rateError) || undefined} onChange={e => updateTier(tier.id, { rate: e.target.value })} />}</Field>
          <PolicyMoney label={`Премия, ${currency}`} value={tier.bonus} currency={currency} onChange={bonus => updateTier(tier.id, { bonus })} />
        </div>
        {index > 0 && <Button size="sm" variant="ghost" onClick={() => setDraft(current => ({ ...current,
          tiers: current.tiers.filter(item => item.id !== tier.id),
        }))}>Убрать ступень</Button>}
      </details>;
    })}
    {draft.tiers.length < maxTiers && <Button size="sm" onClick={addTier}>Добавить ступень</Button>}
  </div>;
}
