// Предложение плана на месяц по каждой точке: прогноз по истории + цель роста. Менеджер правит суммы и сохраняет одним действием.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { command } from '../../platform/backend';
import { monthLabel, monthStart, shiftMonth } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { ConfirmDialog, DataState, Input, MoneyInput, Select } from '../../ui';
import { useToast } from '../../ui/toast';
import { planSet, WEEKDAY_SHORT } from '../revenue/api';

interface Suggestion {
  location_id: string; location_name: string; partner_name: string; currency: string; method: 'full' | 'short' | 'none'; reason?: string;
  forecast_minor: number; proposed_minor: number; current_plan_minor: number | null; level_day_minor: number; weekday_factors: number[];
  trend_month_pct: number; season_factor: number; season_source: string; days: number; weekend_days: number; stretch_pct: number;
  last_month_scaled_minor: number | null; guard: string | null; history_days: number;
}

function Explain({ s }: { s: Suggestion }) {
  const f = s.weekday_factors ?? [];
  return (
    <div className="plan-explain">
      <div>Средний день (без учёта дня недели, свежие недели весомее): <strong>{formatMoneyShort(Math.round(s.level_day_minor / 100) * 100, s.currency)}</strong> · история {s.history_days} дн.</div>
      {s.method === 'full' && <div>Профиль недели: {f.map((x, i) => `${WEEKDAY_SHORT[i + 1]} ×${Number(x).toFixed(2)}`).join(' · ')}</div>}
      <div>Тренд: {s.trend_month_pct > 0 ? '+' : ''}{s.trend_month_pct} % в месяц (приглушён вдвое) · сезонность ×{s.season_factor} ({s.season_source === 'нет' ? 'нет данных прошлого года' : s.season_source})</div>
      <div>В месяце {s.days} дн., из них выходных {s.weekend_days} → прогноз <strong>{formatMoneyShort(Math.round(s.forecast_minor / 100) * 100, s.currency)}</strong>, цель роста +{s.stretch_pct} %{s.guard ? ` · ограничено: ${s.guard}` : ''}</div>
    </div>
  );
}

export function PlanSuggestDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [month, setMonth] = useState(shiftMonth(monthStart(), 1));
  const [stretch, setStretch] = useState('5');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const bp = Math.round(Number(stretch.replace(',', '.')) * 100);
  const q = useQuery({ queryKey: ['plan-suggest', month, bp], enabled: Number.isFinite(bp), queryFn: () => command<Suggestion[]>('plan_suggest', { month, stretch_bp: bp }) });
  useEffect(() => {
    if (q.data) setAmounts(Object.fromEntries(q.data.filter((s) => s.method !== 'none').map((s) => [s.location_id, String(s.proposed_minor)])));
  }, [q.data]);
  const apply = useMutation({
    mutationFn: async () => { for (const [loc, a] of Object.entries(amounts)) if (a && a !== '0') await planSet(loc, month, a); },
    onSuccess: () => { toast(`План на ${monthLabel(month)} сохранён`); void qc.invalidateQueries({ queryKey: ['revenue'] }); onClose(); },
  });

  return (
    <ConfirmDialog open title="Предложить план" confirmLabel="Сохранить план для всех точек" busy={apply.isPending} error={apply.error ?? q.error}
      disabled={!Object.keys(amounts).length} onClose={onClose} onConfirm={() => apply.mutate()}>
      <div className="grid grid-2" style={{ gap: 12 }}>
        <label className="field"><span className="label">Месяц</span>
          <Select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value={monthStart()}>{monthLabel(monthStart())}</option>
            <option value={shiftMonth(monthStart(), 1)}>{monthLabel(shiftMonth(monthStart(), 1))}</option>
          </Select></label>
        <label className="field"><span className="label">Цель роста к прогнозу, %</span>
          <Input inputMode="decimal" value={stretch} onChange={(e) => setStretch(e.target.value)} /></label>
      </div>
      <p className="faint">Прогноз строится по выручке точки: средний день за последние недели, разница дней недели, тренд, сезонность и календарь месяца. Сумму каждой точки можно поправить.</p>
      <DataState query={q}>
        {(list) => (
          <div className="plan-suggest">
            {list.map((s) => (
              <div key={s.location_id} className="plan-row">
                <div className="row between" style={{ flexWrap: 'nowrap', gap: 10 }}>
                  <span style={{ minWidth: 0 }}><strong>{s.location_name}</strong><span className="faint" style={{ display: 'block' }}>{s.partner_name}
                    {s.current_plan_minor ? ` · сейчас ${formatMoneyShort(s.current_plan_minor, s.currency)}` : ''}{s.last_month_scaled_minor ? ` · факт прошлого мес. ≈ ${formatMoneyShort(Math.round(s.last_month_scaled_minor / 100) * 100, s.currency)}` : ''}</span></span>
                  {s.method === 'none'
                    ? <span className="faint">{s.reason}</span>
                    : <span style={{ width: 150, flex: 'none' }}><MoneyInput id={`p-${s.location_id}`} value={amounts[s.location_id] ?? ''} currency={s.currency}
                        onChange={(v) => setAmounts({ ...amounts, [s.location_id]: v })} /></span>}
                </div>
                {s.method !== 'none' && (
                  <button type="button" className="link-btn" onClick={() => setOpen(open === s.location_id ? null : s.location_id)}>
                    {open === s.location_id ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}Как посчитано
                  </button>
                )}
                {open === s.location_id && <Explain s={s} />}
              </div>
            ))}
          </div>
        )}
      </DataState>
    </ConfirmDialog>
  );
}
