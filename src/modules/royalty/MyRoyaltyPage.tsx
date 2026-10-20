// Роялти франчайзи — полностью и в реальном времени: начисляется сейчас, прогноз на конец месяца, долг, история и оплаты.
import { useQuery } from '@tanstack/react-query';
import { formatDate, monthLabel } from '../../platform/dates';
import { formatMoneyShort } from '../../platform/money';
import { command } from '../../platform/backend';
import { Card, DataState, Money, PageHeader } from '../../ui';

interface LedgerMonth { month: string; revenue_minor: number; rate_bp: number; accrued_minor: number; manual_minor: number; paid_minor: number; debt_minor: number; is_open: boolean }
interface Mine { partner_name: string; currency: string; rate_bp: number; debt_minor: number;
  live: { month: string; revenue_minor: number; accrued_minor: number; projected_accrual_minor: number; paid_minor: number };
  months: LedgerMonth[]; payments: { month: string; amount_minor: number; paid_on: string; note: string | null }[] }

const pct = (bp: number) => `${(bp / 100).toLocaleString('ru-RU')} %`;

export function MyRoyaltyPage() {
  const q = useQuery({ queryKey: ['royalty', 'my'], queryFn: () => command<Mine>('royalty_my'), refetchInterval: 60_000 });
  return (
    <DataState query={q}>
      {(r) => (
        <div className="home" style={{ maxWidth: 860 }}>
          <PageHeader title="Роялти" sub={`${pct(r.rate_bp)} от выручки. Считается само из выручки, которую вы вносите, и обновляется сразу.`} />
          <section className="plan-card" aria-label="Роялти сейчас">
            <div className="plan-label">Начислено за {monthLabel(r.live.month, false)} на сейчас</div>
            <div className="plan-fact">{formatMoneyShort(r.live.accrued_minor, r.currency)}</div>
            <div className="plan-of">{pct(r.rate_bp)} от выручки {formatMoneyShort(r.live.revenue_minor, r.currency)}</div>
            <div className="plan-foot">
              <span>К концу месяца при текущем темпе ≈ <strong>{formatMoneyShort(Math.round(Number(r.live.projected_accrual_minor) / 100) * 100, r.currency)}</strong></span>
            </div>
          </section>
          <div className="kpis" style={{ marginTop: 16 }}>
            <div className={`kpi${Number(r.debt_minor) > 0 ? ' warn' : ''}`}><span className="v">{formatMoneyShort(r.debt_minor, r.currency)}</span><span className="l">долг за закрытые месяцы</span></div>
            <div className="kpi"><span className="v">{r.payments[0] ? formatDate(r.payments[0].paid_on) : '—'}</span><span className="l">последняя оплата</span></div>
          </div>
          <Card title="По месяцам" bodyless>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Месяц</th><th className="r">Выручка</th><th className="r">Ставка</th><th className="r">Начислено</th><th className="r">Прошлый долг</th><th className="r">Оплачено</th><th className="r">Долг</th></tr></thead>
                <tbody>
                  {r.months.map((m) => (
                    <tr key={m.month}>
                      <td>{monthLabel(m.month)}{m.is_open && <div className="faint">начисляется</div>}</td>
                      <td className="r num">{formatMoneyShort(m.revenue_minor, r.currency)}</td>
                      <td className="r">{pct(m.rate_bp)}</td>
                      <td className="r num">{formatMoneyShort(m.accrued_minor, r.currency)}</td>
                      <td className="r num">{m.manual_minor ? formatMoneyShort(m.manual_minor, r.currency) : '—'}</td>
                      <td className="r num">{formatMoneyShort(m.paid_minor, r.currency)}</td>
                      <td className={`r num${m.debt_minor > 0 && !m.is_open ? ' danger-text' : ''}`}>{m.is_open ? '—' : <Money minor={m.debt_minor} currency={r.currency} short strong />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {r.payments.length > 0 && (
            <Card title="Оплаты">
              {r.payments.map((p, i) => (
                <div key={i} className="row between access-row">
                  <span>за {monthLabel(p.month)}<span className="faint" style={{ display: 'block' }}>{formatDate(p.paid_on)}{p.note ? ` · ${p.note}` : ''}</span></span>
                  <Money minor={p.amount_minor} currency={r.currency} strong />
                </div>
              ))}
            </Card>
          )}
          <p className="faint">Оплату отмечает менеджер по франшизе, когда деньги поступили. Если сумма кажется неверной — проверьте выручку по дням на главной.</p>
        </div>
      )}
    </DataState>
  );
}
