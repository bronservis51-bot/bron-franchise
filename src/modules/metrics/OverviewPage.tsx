// Управленческий обзор (MET-01/02): исключения, каждое число раскрывается до списка и объясняет расчёт.
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { command } from '../../platform/backend';
import { formatDateTime } from '../../platform/dates';
import { intlLocale } from '../../platform/i18n';
import { Card, DataState, Money, PageHeader } from '../../ui';

interface Item { key: string; title: string; link: string; definition: string; value: unknown }

function Value({ v }: { v: unknown }) {
  if (typeof v === 'number') return <>{v}</>;
  if (Array.isArray(v)) {
    if (!v.length) return <>0</>;
    return (
      <span style={{ display: 'flex', flexDirection: 'column', fontSize: 'var(--fs-l)', gap: 2 }}>
        {v.map((x: { currency: string; amount_minor?: string; collected_minor?: string; due_minor?: string; count?: number }) => (
          <span key={x.currency}>
            {x.amount_minor !== undefined && <Money minor={x.amount_minor} currency={x.currency} />}
            {x.collected_minor !== undefined && <><Money minor={x.collected_minor} currency={x.currency} /><span className="faint" style={{ fontSize: 'var(--fs-s)' }}> из <Money minor={x.due_minor} currency={x.currency} /></span></>}
          </span>
        ))}
      </span>
    );
  }
  if (v && typeof v === 'object') {
    const o = v as { done?: number; total?: number; on_time?: number; expected?: number };
    if (o.total !== undefined) return <>{o.done} / {o.total}</>;
    if (o.expected !== undefined) return <>{o.on_time} / {o.expected}</>;
  }
  return <>—</>;
}

const isZero = (v: unknown) => v === 0 || (Array.isArray(v) && v.length === 0);

export function OverviewPage() {
  const q = useQuery({ queryKey: ['metrics'], queryFn: () => command<{ generated_at: string; items: Item[]; note: string }>('metrics_overview'), refetchInterval: 300_000 });
  return (
    <>
      <PageHeader title="Обзор" sub="Где процесс требует вмешательства" />
      <DataState query={q} skeleton={8}>
        {(d) => (
          <>
            <div style={{ marginBottom: 16 }}><p className="faint">Обновлено {formatDateTime(d.generated_at, intlLocale())}. Суммы в разных валютах не складываются.</p></div>
            <div className="grid grid-3">
              {d.items.map((i) => (
                <Link key={i.key} to={i.link} className="stat-link" aria-label={`${i.title}: открыть список`}>
                  <Card>
                    <div className="stat" style={{ padding: 0 }}>
                      <span className="label">{i.title}</span>
                      <span className="value" style={{ color: isZero(i.value) ? 'var(--success)' : undefined }}><Value v={i.value} /></span>
                      <span className="faint" style={{ display: 'flex', gap: 6 }}><Info size={14} aria-hidden style={{ flex: 'none', marginTop: 2 }} />{i.definition}</span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </>
        )}
      </DataState>
    </>
  );
}
