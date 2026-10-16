// «Выручка сети» для руководства: все точки за месяц с фильтрами по владению, стране, городу и франчайзи,
// группировкой (точки / города / страны / франчайзи), графиком по дням и сравнением с прошлым месяцем на то же число.
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { command } from '../../platform/backend';
import { formatPeriod } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort } from '../../platform/money';
import { Chips, DataState, Input, PageHeader, Select } from '../../ui';

interface Row {
  id: string; code: string; name: string; kind: 'own' | 'franchise'; status: string; country: string; country_name: string; city: string; currency: string;
  partner_id: string | null; partner_name: string | null; revenue_minor: number; returns_minor: number; services: number; card_minor: number; card_known_minor: number;
  earnings_minor: number; days_with_data: number; prev_revenue_minor: number; prev_to_date_minor: number; missing_days: number; daily: [string, number, number][];
  revenue_rub_minor: number; prev_to_date_rub_minor: number;
}
interface Data { month: string; days_in_month: number; today: string; locations: Row[] }
type Group = 'point' | 'city' | 'country' | 'partner';

const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
function shiftMonth(month: string, n: number) { const d = new Date(`${month}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n, 1); return d.toISOString().slice(0, 10); }
const money = (v: number, c: string) => formatMoneyShort(Math.round(v / 100) * 100, c, intlLocale());
const delta = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

function Delta({ v }: { v: number | null }) {
  if (v === null) return <span className="faint">—</span>;
  return <span className={`delta ${v >= 0 ? 'up' : 'down'}`}>{v > 0 ? '+' : ''}{v}%</span>;
}

/** Столбики по дням для выбранной валюты: одна серия, подсказка при наведении/нажатии. */
function DailyBars({ rows, month, days }: { rows: Row[]; month: string; days: number }) {
  const currency = 'RUB';
  const { t } = useT();
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => {
    const arr = Array.from({ length: days }, () => 0);
    for (const r of rows) for (const [d, , rub] of r.daily) arr[Number(d.slice(8)) - 1] += Number(rub ?? 0);
    return arr;
  }, [rows, days]);
  const max = Math.max(...series, 1);
  const W = 640; const H = 160; const gap = 2; const bw = (W - gap * (days - 1)) / days;
  const sel = hover ?? series.reduce((m, v, i) => (v > 0 ? i : m), 0);
  const label = (i: number) => new Date(`${month.slice(0, 8)}${String(i + 1).padStart(2, '0')}T12:00:00Z`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' });
  return (
    <div className="bars-card">
      <div className="bars-head"><span className="faint">{t('По дням')}</span><span><strong>{money(series[sel], currency)}</strong> <span className="faint">· {label(sel)}</span></span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="bars" role="img" aria-label={t('Выручка по дням')} onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H} y2={H} className="bars-base" />
        {series.map((v, i) => {
          const h = v ? Math.max(3, (v / max) * (H - 8)) : 0;
          const x = i * (bw + gap);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect x={x} y={0} width={bw + gap} height={H} fill="transparent" />
              {h > 0 && <rect x={x} y={H - h} width={bw} height={h} rx={Math.min(4, bw / 2)} className={`bar${i === sel ? ' on' : ''}`} />}
            </g>
          );
        })}
      </svg>
      <div className="bars-axis" aria-hidden>
        {series.map((_, i) => (i === 0 || (i + 1) % 5 === 0) && <span key={i} style={{ left: `${((i * (bw + gap) + bw / 2) / W) * 100}%` }}>{i + 1}</span>)}
      </div>
    </div>
  );
}

export function NetworkSalesPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const max = monthOf();
  const month = params.get('month') ?? max;
  const kind = (params.get('kind') ?? 'all') as 'all' | 'own' | 'franchise';
  const country = params.get('country') ?? '';
  const city = params.get('city') ?? '';
  const partner = params.get('partner') ?? '';
  const group = (params.get('group') ?? 'point') as Group;
  const [q, setQ] = useState('');
  const set = (patch: Record<string, string>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true });
  const data = useQuery({ queryKey: ['network-sales', month], queryFn: () => command<Data>('network_sales', { month }) });
  const label = formatPeriod(month, intlLocale());

  return (
    <>
      <PageHeader title={t('Выручка сети')} actions={
        <div className="row" role="group" aria-label={t('Месяц')}>
          <button type="button" className="icon-btn" aria-label={t('Предыдущий месяц')} onClick={() => set({ month: shiftMonth(month, -1) })}><ChevronLeft size={18} /></button>
          <strong style={{ minWidth: 130, textAlign: 'center' }}>{label.charAt(0).toUpperCase() + label.slice(1)}</strong>
          <button type="button" className="icon-btn" aria-label={t('Следующий месяц')} disabled={month >= max} onClick={() => set({ month: shiftMonth(month, 1) })}><ChevronRight size={18} /></button>
        </div>} />
      <DataState query={data}>
        {(d) => {
          const all = d.locations;
          const countries = [...new Map(all.map((l) => [l.country, l.country_name])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
          const cities = [...new Set(all.filter((l) => !country || l.country === country).map((l) => l.city))].sort((a, b) => a.localeCompare(b, 'ru'));
          const partners = [...new Map(all.filter((l) => l.partner_id).map((l) => [l.partner_id!, l.partner_name!])).entries()];
          const s = q.trim().toLowerCase();
          const rows = all.filter((l) => (kind === 'all' || l.kind === kind) && (!country || l.country === country) && (!city || l.city === city)
            && (!partner || l.partner_id === partner) && (!s || `${l.name} ${l.city} ${l.partner_name ?? ''}`.toLowerCase().includes(s)));
          const rub = rows.reduce((a, r) => a + Number(r.revenue_rub_minor ?? 0), 0);
          const rubPrev = rows.reduce((a, r) => a + Number(r.prev_to_date_rub_minor ?? 0), 0);
          const foreign = rows.some((r) => r.currency !== 'RUB');
          const filtered = Boolean(kind !== 'all' || country || city || partner || s);
          // Группировка: строки таблицы
          type G = { key: string; title: string; sub: string; currency: string; revenue: number; prev: number; local: number; services: number; missing: number; count: number; link?: string };
          const groups = new Map<string, G>();
          for (const r of rows) {
            const [key, title, sub] = group === 'city' ? [`${r.country}|${r.city}`, r.city, r.country_name]
              : group === 'country' ? [r.country, r.country_name, r.currency === 'RUB' ? '' : r.currency]
              : group === 'partner' ? [r.partner_id ?? 'own', r.partner_name ?? t('Собственные точки'), r.kind === 'own' ? t('компания') : t('франчайзи')]
              : [r.id, r.name, `${r.city} · ${r.kind === 'own' ? t('собственная') : r.partner_name}`];
            const g = groups.get(key) ?? { key, title, sub, currency: r.currency, revenue: 0, prev: 0, local: 0, services: 0, missing: 0, count: 0,
              link: group === 'point' ? `/sales?tab=location&location=${r.id}&month=${d.month}` : undefined };
            g.revenue += Number(r.revenue_rub_minor ?? 0); g.prev += Number(r.prev_to_date_rub_minor ?? 0); g.local += Number(r.revenue_minor);
            if (g.currency !== r.currency) g.currency = 'MIX'; g.services += r.services; g.missing += r.missing_days; g.count += 1;
            groups.set(key, g);
          }
          const list = [...groups.values()].sort((a, b) => b.revenue - a.revenue);
          const top = Math.max(...list.map((g) => g.revenue), 1);
          return (
            <div className="stack">
              <div className="net-filters">
                <Chips label="Владение" value={kind} onChange={(v) => set({ kind: v === 'all' ? '' : v })}
                  options={[{ id: 'all', label: 'Все' }, { id: 'own', label: 'Собственные' }, { id: 'franchise', label: 'Франшизы' }]} />
                <div className="net-selects">
                  <Select aria-label={t('Страна')} value={country} onChange={(e) => set({ country: e.target.value, city: '' })}>
                    <option value="">{t('Все страны')}</option>{countries.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
                  </Select>
                  <Select aria-label={t('Город')} value={city} onChange={(e) => set({ city: e.target.value })}>
                    <option value="">{t('Все города')}</option>{cities.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                  {kind !== 'own' && partners.length > 0 && (
                    <Select aria-label={t('Франчайзи')} value={partner} onChange={(e) => set({ partner: e.target.value })}>
                      <option value="">{t('Все франчайзи')}</option>{partners.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
                    </Select>
                  )}
                  <div className="net-search"><Search size={16} aria-hidden /><Input type="search" aria-label={t('Поиск точки')} placeholder={t('Точка или город')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
                  {filtered && <button type="button" className="link-btn dark" onClick={() => { setQ(''); setParams({ month }, { replace: true }); }}><X size={14} aria-hidden /> {t('Сбросить')}</button>}
                </div>
              </div>

              <div className="net-kpis">
                <div className="net-kpi on">
                  <span className="l">{t('Выручка за месяц')}</span>
                  <span className="v">{money(rub, 'RUB')}</span>
                  <span className="s"><Delta v={delta(rub, rubPrev)} /> {t('к прошлому месяцу на то же число')}</span>
                </div>
                <div className="net-kpi">
                  <span className="l">{t('Точек')}</span>
                  <span className="v">{rows.length}</span>
                  <span className="s">{rows.filter((r) => r.kind === 'own').length} {t('собств.')} · {rows.filter((r) => r.kind === 'franchise').length} {t('франш.')}</span>
                </div>
              </div>
              {foreign && <p className="faint" style={{ margin: 0 }}>{t('Тенге и лиры переведены в рубли по курсу дня каждой смены.')}</p>}

              {rows.length > 0 && <DailyBars rows={rows} month={d.month} days={d.days_in_month} />}

              <div className="net-table-head">
                <Chips label="Группировка" value={group} onChange={(v) => set({ group: v === 'point' ? '' : v })}
                  options={[{ id: 'point', label: 'Точки' }, { id: 'city', label: 'Города' }, { id: 'country', label: 'Страны' }, { id: 'partner', label: 'Франчайзи' }]} />
              </div>
              <ul className="net-list">
                {list.map((g) => (
                  <li key={g.key}>
                    <button type="button" className="net-row" disabled={!g.link} onClick={() => g.link && navigate(g.link)}>
                      <span className="net-main">
                        <span className="net-title">{g.title}{group !== 'point' && <span className="faint"> · {g.count}</span>}</span>
                        <span className="net-sub">{g.sub}{g.missing > 0 && <span className="net-miss"> · {t('не внесено')} {g.missing} {t('дн.')}</span>}</span>
                        <span className="net-bar"><span style={{ width: `${Math.round((g.revenue / top) * 100)}%` }} /></span>
                      </span>
                      <span className="net-side">
                        <span className="net-sum">{money(g.revenue, 'RUB')}</span>
                        {g.currency !== 'RUB' && g.currency !== 'MIX' && <span className="faint" style={{ fontSize: 12 }}>{money(g.local, g.currency)}</span>}
                        <Delta v={delta(g.revenue, g.prev)} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="faint">{t('Сравнение — с прошлым месяцем на то же число. Нажмите на точку, чтобы открыть её выручку по дням.')}</p>
            </div>
          );
        }}
      </DataState>
    </>
  );
}
