import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command, toAppError } from '../../platform/backend';
import { formatDate } from '../../platform/dates';
import { formatMoneyShort, parseMoney } from '../../platform/money';
import { ActionError, Button, Card, DataState, Field, Input, MoneyInput } from '../../ui';
import { CustomPayFields, currencySymbol, customPayDraft, tierPolicy } from './CustomPayFields';
import { pctBp } from './api';
import './pay-settings.css';

export type PayPolicy = { floor_minor: number; tiers: { from_minor: number; rate_bp: number; bonus_minor: number }[] };
export type ShiftPolicy = (PayPolicy | { mode: 'legacy'; rate_bp: number; fee_minor: number }) & { additional_point?: boolean };
type DatedPolicy = { effective_from: string; policy: PayPolicy };
type Motivation = { version: number; policy: PayPolicy; currency: string; today?: string;
  baseline?: PayPolicy; history?: DatedPolicy[]; scheduled?: DatedPolicy[] };

export function teamPolicyForDate(terms: Pick<Motivation, 'policy' | 'baseline' | 'history' | 'scheduled'>, date: string) {
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
  const tier = 'tiers' in policy ? reachedTier(policy, total) : null;
  const terms = 'mode' in policy
    ? `${formatMoneyShort(policy.fee_minor, currency)} за выход + ${pctBp(policy.rate_bp)} от выручки`
    : tier && `${pctBp(tier.rate_bp)} от выручки, гарантия ${formatMoneyShort(policy.floor_minor, currency)}, премия ${formatMoneyShort(tier.bonus_minor, currency)}`;
  return <div className="pay-result">
    <span>{label}</span>
    <strong className="num">{formatMoneyShort(calculatePay(total, 0, 0, policy), currency)}</strong>
    <small>{terms}</small>
  </div>;
}

export function PayExample({ currency, policy, traineePolicy }: { currency: string; policy: ShiftPolicy | null; traineePolicy?: PayPolicy | null }) {
  const [revenue, setRevenue] = useState(() => String(parseMoney('10000', currency)));
  const [valid, setValid] = useState(true);
  return <section className="pay-example" aria-label="Пример расчёта">
    <h4>Пример расчёта</h4>
    <Field label={`Выручка за смену, ${currencySymbol(currency)}`} error={!valid ? 'Введите сумму выручки' : undefined}>{(id, describedBy) =>
      <MoneyInput id={id} value={revenue} currency={currency} describedBy={describedBy} placeholder="0"
        onChange={setRevenue} onValidityChange={setValid} />}</Field>
    <div aria-live="polite">
      {valid && !policy && !traineePolicy && <p className="pay-help">Для расчёта проверьте поля схемы.</p>}
      {valid && traineePolicy && <ExampleResult label="На стажировке" currency={currency} total={BigInt(revenue || '0')} policy={traineePolicy} />}
      {valid && policy && <ExampleResult label={traineePolicy !== undefined ? 'После стажировки' : 'Сотрудник получит'} currency={currency} total={BigInt(revenue || '0')} policy={policy} />}
    </div>
  </section>;
}

export const payTiming = 'При сдаче выручки применяются условия, действовавшие в день смены. Принятые и ранее открытые смены сохраняют свои условия.';

function TeamPayEditor({ partner, saved, initialDate, onClose }: { partner: string; saved: Motivation; initialDate: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [version] = useState(saved.version);
  const [date, setDate] = useState(initialDate || saved.today || '');
  const [draft, setDraft] = useState(() => customPayDraft(saved.scheduled?.find(v => v.effective_from === initialDate)?.policy ?? saved.policy));
  const policy = tierPolicy(draft);
  const m = useMutation({
    mutationFn: (next: PayPolicy) => command('motivation_set', { partner, policy: { ...next, ...(date ? { effective_from: date } : {}) }, expected_version: version }),
    onError: error => {
      if (toAppError(error).code === 'version-conflict') void qc.invalidateQueries({ queryKey: ['motivation', partner] });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['motivation', partner] });
      onClose();
    },
  });
  return <div className="pay-layout" data-unsaved="true">
    <Field label="Действует с" hint="Дата смены по местному времени точки.">{id => <Input id={id} type="date" readOnly={Boolean(initialDate)} value={date} onChange={e => setDate(e.target.value)} />}</Field>
    <CustomPayFields named={false} currency={saved.currency} draft={draft} setDraft={setDraft} />
    <details className="pay-explanation"><summary>Как считается оплата</summary>
      <p className="pay-help">Сотрудник получает большую из двух сумм — гарантию или процент от всей выручки смены. Премия прибавляется сверху.</p>
      <PayExample currency={saved.currency} policy={policy} />
      <p className="pay-help">{payTiming}</p>
    </details>
    <ActionError error={m.error} />
    <div className="row"><Button disabled={m.isPending} onClick={onClose}>Отмена</Button>
      <Button variant="primary" loading={m.isPending} disabled={!policy} onClick={() => policy && m.mutate(policy)}>Сохранить схему</Button></div>
  </div>;
}

export function MotivationPanel({ partner, canEdit }: { partner: string; canEdit: boolean }) {
  const q = useMotivation(partner);
  const [edit, setEdit] = useState<string | null>(null);
  return <Card title="Общая схема" className="pay-settings"><DataState query={q}>{d =>
    edit !== null && canEdit ? <TeamPayEditor partner={partner} saved={d} initialDate={edit} onClose={() => setEdit(null)} /> : <div className="pay-layout">
      <p>Гарантия за смену <strong className="num">{formatMoneyShort(d.policy.floor_minor, d.currency)}</strong></p>
      <p className="pay-help">Для сотрудников на общей схеме процент и премия зависят от выручки смены. У стажёра своя гарантия.</p>
      <details className="pay-table"><summary>Ступени по выручке ({d.policy.tiers.length})</summary>
        <div className="table-wrap"><table className="table"><thead><tr><th>Выручка от</th><th>Доля</th><th>Премия</th></tr></thead>
          <tbody>{d.policy.tiers.map(t => <tr key={t.from_minor}><td>{formatMoneyShort(t.from_minor, d.currency)}</td><td>{pctBp(t.rate_bp)}</td><td>{formatMoneyShort(t.bonus_minor, d.currency)}</td></tr>)}</tbody></table></div>
      </details>
      {canEdit && <Button onClick={() => setEdit('')}>Изменить общую схему</Button>}
      {d.scheduled?.map(v => <div className="row between" key={v.effective_from}>
        <span>С {formatDate(v.effective_from)} · гарантия {formatMoneyShort(v.policy.floor_minor, d.currency)}</span>
        {canEdit && <Button size="sm" onClick={() => setEdit(v.effective_from)}>Изменить условия с {formatDate(v.effective_from)}</Button>}
      </div>)}
    </div>}
  </DataState></Card>;
}
