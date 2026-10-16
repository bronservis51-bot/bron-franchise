// Карта сети для руководства: все точки (собственные и франшизы) на карте мира; нажатие — сводка по точке.
// Карта рисуется локально из открытых контуров стран (world-atlas, ISC): без внешних картографических серверов,
// поэтому работает при блокировках и не передаёт данные третьим лицам.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { geoNaturalEarth1, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import 'd3-transition';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import worldData from 'world-atlas/countries-50m.json';
import { AlertTriangle, Clock, Globe2, Headset, Minus, Plus, Rocket, Store, Users, Wallet, X } from 'lucide-react';
import { command } from '../../platform/backend';
import { LocationNotes } from '../shared/LocationNotes';
import { formatDate } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort } from '../../platform/money';
import { Badge, Card, Chips, DataState, PageHeader, Progress } from '../../ui';

interface MapLocation {
  id: string; code: string; name: string; kind: 'own' | 'franchise'; status: string; city: string; country: string; address: string | null; currency: string;
  opened_on: string | null; lat: number | null; lng: number | null; partner_id: string | null; partner_name: string | null; today: string;
  revenue_minor: number; revenue_rub_minor: number; days_with_data: number; prev_revenue_minor: number; today_revenue_minor: number; days_passed: number; missing_days: number;
  on_shift: { name: string; since: string }[]; open_tickets: number; stopped_tickets: number;
  opening: { id: string; planned_open_on: string; status: string; done: number; total: number } | null;
  debt: { outstanding_minor: number; overdue_minor: number; currency: string | null } | null;
  control: { risk: number; report_diff_minor: number; film_phones_60d: number; services_60d: number; services_est_60d: number; reductions: number; card_share: number | null } | null;
}
type Filter = 'all' | 'own' | 'franchise' | 'attention';

const W = 960;
const H = 520;

function attention(l: MapLocation): string[] {
  const r: string[] = [];
  if (l.stopped_tickets > 0) r.push('Точка не работает: срочное обращение');
  if (l.status === 'active' && l.missing_days > 2) r.push(`Нет выручки за ${l.missing_days} дн.`);
  if (l.status === 'active' && l.debt && Number(l.debt.overdue_minor) > 0) r.push('Просрочен платёж роялти');
  if (l.control && l.control.report_diff_minor < 0) r.push('Отчёт роялти меньше смен');
  if (l.control && l.control.film_phones_60d > 0 && l.control.services_est_60d < l.control.film_phones_60d * 0.6) r.push('Мало оклеек на купленную плёнку');
  if (l.control && l.control.reductions > 0) r.push('Франчайзи уменьшал смены');
  return r;
}

function trend(cur: number, prev: number, days: number) {
  if (!prev || !days) return null;
  // Сравнение темпа: выручка месяца на день против среднего дня прошлого месяца
  const pace = cur / days;
  const prevPace = prev / 30;
  return Math.round(((pace - prevPace) / prevPace) * 100);
}

function Details({ l, onClose }: { l: MapLocation; onClose: () => void }) {
  const { t } = useT();
  const money = (v: number, c = l.currency) => formatMoneyShort(v, c, intlLocale());
  const tr = trend(Number(l.revenue_minor), Number(l.prev_revenue_minor), l.days_with_data);
  const warn = attention(l);
  return (
    <aside className="map-details" aria-label={l.name}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="map-kind">{l.kind === 'own' ? t('Собственная точка') : `${t('Франшиза')} · ${l.partner_name ?? ''}`}</div>
          <h2 style={{ margin: '2px 0 0', fontSize: 20 }}>{l.name}</h2>
          <div className="faint">{l.city}{l.address ? `, ${l.address}` : ''}</div>
        </div>
        <button type="button" className="icon-btn" aria-label={t('Закрыть')} onClick={onClose}><X size={18} /></button>
      </div>
      <div className="row" style={{ gap: 6, margin: '10px 0', flexWrap: 'wrap' }}>
        {l.status === 'active' ? <Badge tone="success">{t('работает')}</Badge> : l.status === 'opening' ? <Badge tone="info">{t('открывается')}</Badge> : <Badge tone="neutral">{l.status}</Badge>}
        {l.opened_on && <span className="faint">{t('с')} {formatDate(l.opened_on, intlLocale())}</span>}
      </div>
      {warn.length > 0 && (
        <div className="map-warn"><AlertTriangle size={16} aria-hidden /><ul>{warn.map((w) => <li key={w}>{t(w)}</li>)}</ul></div>
      )}
      {l.status !== 'opening' && (
        <div className="map-kpis">
          <div><span className="l">{t('Выручка за месяц')}</span><span className="v">{money(l.revenue_minor)}</span>
            {tr !== null && <span className={`s ${tr < 0 ? 'down' : 'up'}`}>{tr > 0 ? '+' : ''}{tr}% {t('к темпу прошлого месяца')}</span>}</div>
          <div><span className="l">{t('Сегодня')}</span><span className="v">{money(l.today_revenue_minor)}</span>
            <span className="s">{l.on_shift.length ? `${t('на смене')}: ${l.on_shift.map((s) => s.name).join(', ')}` : t('никто не на смене')}</span></div>
        </div>
      )}
      {l.status === 'active' && l.days_passed > 0 && (
        <div style={{ margin: '10px 0' }}><Progress value={Math.max(0, l.days_passed - l.missing_days)} max={l.days_passed} label="Дней с выручкой" /></div>
      )}
      <ul className="map-facts">
        {l.on_shift.length > 0 && <li><Clock size={15} aria-hidden /> {t('На смене')}: {l.on_shift.map((s) => `${s.name} (${t('с')} ${new Date(s.since).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })})`).join(', ')}</li>}
        <li><Headset size={15} aria-hidden /> {t('Открытых обращений')}: {l.open_tickets}{l.stopped_tickets ? ` · ${t('точка стоит')}: ${l.stopped_tickets}` : ''}</li>
        {l.opening && <li><Rocket size={15} aria-hidden /> {t('Открытие')} {formatDate(l.opening.planned_open_on, intlLocale())}: {l.opening.done} / {l.opening.total} {t('задач')}</li>}
        {l.debt && Number(l.debt.outstanding_minor) > 0 && <li><Wallet size={15} aria-hidden /> {t('Долг франчайзи по роялти')}: {money(l.debt.outstanding_minor, l.debt.currency ?? l.currency)}
          {Number(l.debt.overdue_minor) > 0 && <strong style={{ color: 'var(--danger)' }}> · {t('просрочено')} {money(l.debt.overdue_minor, l.debt.currency ?? l.currency)}</strong>}</li>}
        {l.control && l.control.film_phones_60d > 0 && <li><Store size={15} aria-hidden /> {t('Плёнка → оклейки за 60 дн.')}: ~{l.control.services_est_60d} / {l.control.film_phones_60d}</li>}
      </ul>
      <LocationNotes key={l.id} locationId={l.id} compact />
      <div className="map-links">
        {l.status !== 'opening' && <Link className="btn btn-sm" to={`/sales?tab=location&location=${l.id}`}>{t('Выручка по дням')}</Link>}
        {l.partner_id && <Link className="btn btn-sm" to={`/partners/${l.partner_id}`}>{t('Карточка франчайзи')}</Link>}
        {l.opening && <Link className="btn btn-sm" to={`/openings/${l.opening.id}`}>{t('Проект открытия')}</Link>}
        <Link className="btn btn-sm" to="/support">{t('Обращения')}</Link>
      </div>
    </aside>
  );
}

function WorldMap({ points, selected, onSelect }: { points: MapLocation[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const { t } = useT();
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // Масштаб карты; точки и подписи рисуются поверх в экранных координатах и не растут при приближении
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  // Единиц карты на один пиксель экрана: точки и текст одного размера на телефоне и на компьютере
  // и видимая полоса по горизонтали (на телефоне карта выше и обрезается по бокам)
  const [{ u, left, right }, setFit] = useState({ u: 1, left: 0, right: W });
  useEffect(() => {
    const el = svgRef.current!;
    const update = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!cw || !ch) return;
      const unit = 1 / Math.max(cw / W, ch / H);
      setFit({ u: unit, left: W / 2 - (cw * unit) / 2, right: W / 2 + (cw * unit) / 2 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const projection = useMemo(() => geoNaturalEarth1().fitExtent([[8, 8], [W - 8, H - 8]], { type: 'Sphere' } as GeoPermissibleObjects), []);
  const path = useMemo(() => geoPath(projection), [projection]);
  const countries = useMemo(() => {
    const topo = worldData as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
    return feature(topo, topo.objects.countries).features;
  }, []);
  const withPoints = useMemo(() => new Set(points.map((p) => ({ RU: 'Russia', KZ: 'Kazakhstan', TR: 'Turkey', BY: 'Belarus', UZ: 'Uzbekistan', KG: 'Kyrgyzstan', AM: 'Armenia', GE: 'Georgia', AZ: 'Azerbaijan' } as Record<string, string>)[p.country])), [points]);
  // Точки одного города разводятся по кругу, чтобы на них можно было нажать
  const placed = useMemo(() => {
    const byCity = new Map<string, MapLocation[]>();
    for (const p of points) if (p.lat !== null && p.lng !== null) byCity.set(`${p.lat},${p.lng}`, [...(byCity.get(`${p.lat},${p.lng}`) ?? []), p]);
    const out: { p: MapLocation; x: number; y: number; dx: number; dy: number; group: MapLocation[]; first: boolean }[] = [];
    for (const group of byCity.values()) {
      const [x, y] = projection([Number(group[0].lng), Number(group[0].lat)]) ?? [0, 0];
      group.forEach((p, i) => {
        const a = (i / group.length) * Math.PI * 2;
        const r = group.length > 1 ? 1 : 0;
        out.push({ p, x, y, dx: Math.cos(a) * r, dy: Math.sin(a) * r, group, first: i === 0 });
      });
    }
    return out;
  }, [points, projection]);

  useEffect(() => {
    const svg = select(svgRef.current!);
    const z = d3zoom<SVGSVGElement, unknown>().scaleExtent([1, 60]).translateExtent([[0, 0], [W, H]])
      .on('zoom', (e) => setView({ x: e.transform.x, y: e.transform.y, k: e.transform.k }));
    zoomRef.current = z;
    svg.call(z);
    return () => { svg.on('.zoom', null); };
  }, []);

  // Первое открытие: приблизить к району, где есть точки
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !placed.length || !zoomRef.current) return;
    fitted.current = true;
    const xs = placed.map((q) => q.x);
    const ys = placed.map((q) => q.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const el = svgRef.current!;
    const vw = el.clientWidth && el.clientHeight ? Math.min(W, (el.clientWidth / el.clientHeight) * H) : W; // видимая ширина карты
    const scale = Math.min(14, 0.7 / Math.max((x1 - x0 + 40) / vw, (y1 - y0 + 40) / H));
    const tx = W / 2 - scale * (x0 + x1) / 2;
    const ty = H / 2 - scale * (y0 + y1) / 2;
    select(svgRef.current!).call(zoomRef.current.transform, zoomIdentity.translate(tx, ty).scale(scale));
  }, [placed]);

  const zoomBy = (f: number) => select(svgRef.current!).transition().duration(250).call(zoomRef.current!.scaleBy, f);
  const world = () => select(svgRef.current!).transition().duration(400).call(zoomRef.current!.transform, zoomIdentity);

  // Страны не перерисовываются при движении карты — меняется только трансформация слоя
  const geography = useMemo(() => (
    <>
      <path d={path({ type: 'Sphere' } as GeoPermissibleObjects) ?? ''} className="map-sea" />
      {countries.map((c, i) => (
        <path key={i} d={path(c) ?? ''} className={`map-country${withPoints.has(c.properties?.name) ? ' active' : ''}`} />
      ))}
    </>
  ), [countries, path, withPoints]);

  const { x: tx, y: ty, k } = view;
  const toScreen = (x: number, y: number) => [x * k + tx, y * k + ty] as const;
  // Подписи: одна на город (название точки или «город · N»), выбранная точка — всегда; пересекающиеся пропускаются
  const labels: { id: string; x: number; y: number; text: string }[] = [];
  if (k > 2 || selected) {
    const boxes: [number, number, number, number][] = [];
    const cand = placed
      .filter((q) => (k > 2 && q.first) || q.p.id === selected)
      .map((q) => {
        const one = q.group.length === 1 || q.p.id === selected;
        const [sx, sy] = toScreen(q.x, q.y);
        return { id: q.p.id, x: one ? sx + q.dx * 14 * u : sx, y: (one ? sy + q.dy * 14 * u : sy) - (q.group.length > 1 && !one ? 22 : 13) * u, text: one ? q.p.name : `${q.p.city} · ${q.group.length}`, pri: q.p.id === selected ? 0 : 1 };
      })
      .sort((a, b) => a.pri - b.pri);
    for (const c of cand) {
      const w = (c.text.length * 6.8 + 8) * u;
      if (c.x < left || c.x > right || c.y < 0 || c.y > H) continue; // точка за краем — подпись не нужна
      c.x = Math.min(Math.max(c.x, left + w / 2 + 4 * u), right - w / 2 - 56 * u); // не заходить под кнопки масштаба
      const box: [number, number, number, number] = [c.x - w / 2, c.y - 13 * u, c.x + w / 2, c.y + 3 * u];
      if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      boxes.push(box);
      labels.push(c);
    }
  }

  return (
    <div className="world-map">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" role="img" aria-label={t('Карта точек сети')} onClick={(e) => { if (!(e.target as Element).closest('.map-pin')) onSelect(null); }}>
        <g transform={`translate(${tx},${ty}) scale(${k})`}>{geography}</g>
        {placed.map(({ p, x, y, dx, dy }) => {
          const warn = attention(p).length > 0;
          const [sx, sy] = toScreen(x, y);
          const r = 6 * u;
          return (
            <g key={p.id} transform={`translate(${sx + dx * 14 * u},${sy + dy * 14 * u})`} className={`map-pin ${p.kind}${p.status === 'opening' ? ' opening' : ''}${selected === p.id ? ' selected' : ''}`}
              role="button" tabIndex={0} aria-label={`${p.name}, ${p.city}`} onClick={(e) => { e.stopPropagation(); onSelect(p.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.id); } }}>
              {warn && <circle r={r * 2.1} className="pin-alert" />}
              <circle r={r} className="pin-dot" strokeWidth={1.6 * u} />
            </g>
          );
        })}
        {labels.map((l) => <text key={l.id} x={l.x} y={l.y} className="pin-label" fontSize={12 * u} strokeWidth={3 * u}>{l.text}</text>)}
      </svg>
      <div className="map-controls">
        <button type="button" aria-label={t('Приблизить')} onClick={() => zoomBy(1.8)}><Plus size={18} /></button>
        <button type="button" aria-label={t('Отдалить')} onClick={() => zoomBy(1 / 1.8)}><Minus size={18} /></button>
        <button type="button" aria-label={t('Весь мир')} onClick={world}><Globe2 size={18} /></button>
      </div>
      <div className="map-legend">
        <span><i className="lg own" /> {t('Собственная')}</span>
        <span><i className="lg franchise" /> {t('Франшиза')}</span>
        <span><i className="lg opening" /> {t('Открывается')}</span>
        <span><i className="lg attn" /> {t('Требует внимания')}</span>
      </div>
    </div>
  );
}

export function NetworkMapPage() {
  const { t } = useT();
  const q = useQuery({ queryKey: ['network-map'], queryFn: () => command<{ locations: MapLocation[] }>('network_map'), refetchInterval: 120_000 });
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <PageHeader title={t('Карта сети')} sub="Все точки — собственные и франшизы. Нажмите на точку, чтобы увидеть выручку, смены и проблемы" />
      <DataState query={q}>
        {(d) => {
          const all = d.locations;
          const list = all.filter((l) => filter === 'all' || (filter === 'attention' ? attention(l).length > 0 : l.kind === filter));
          const sel = all.find((l) => l.id === selected) ?? null;
          const countries = new Set(all.map((l) => l.country)).size;
          const rub = all.reduce((a, l) => a + Number(l.revenue_rub_minor ?? 0), 0);
          return (
            <div className="stack">
              <div className="map-summary">
                <div><span className="v">{all.length}</span><span className="l">{t('точек в')} {countries} {t('странах')}</span></div>
                <div><span className="v">{all.filter((l) => l.kind === 'own').length}</span><span className="l">{t('собственных')}</span></div>
                <div><span className="v">{all.filter((l) => l.kind === 'franchise').length}</span><span className="l">{t('франшиз')}</span></div>
                <div><span className="v">{all.filter((l) => l.status === 'opening').length}</span><span className="l">{t('открываются')}</span></div>
                <div className="alert"><span className="v">{all.filter((l) => attention(l).length > 0).length}</span><span className="l">{t('требуют внимания')}</span></div>
                <div className="wide"><span className="v">{formatMoneyShort(Math.round(rub / 100) * 100, 'RUB', intlLocale())}</span><span className="l">{t('выручка сети за месяц, в рублях')}</span></div>
              </div>
              <Chips label="Фильтр точек" value={filter} onChange={setFilter} options={[
                { id: 'all', label: 'Все' }, { id: 'own', label: 'Собственные' }, { id: 'franchise', label: 'Франшизы' }, { id: 'attention', label: 'Требуют внимания' }]} />
              <div className={`map-layout${sel ? ' with-details' : ''}`}>
                <WorldMap points={list} selected={selected} onSelect={setSelected} />
                {sel && <Details l={sel} onClose={() => setSelected(null)} />}
              </div>
              <Card title="Все точки" icon={<Users size={18} />} bodyless>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>{t('Точка')}</th><th>{t('Город')}</th><th className="r">{t('Выручка за месяц')}</th><th className="r">{t('Сегодня')}</th><th>{t('Внимание')}</th></tr></thead>
                  <tbody>{list.map((l) => {
                    const w = attention(l);
                    return (
                      <tr key={l.id} className={selected === l.id ? 'row-selected' : undefined} style={{ cursor: 'pointer' }} onClick={() => { setSelected(l.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                        <td><strong>{l.name}</strong><div className="faint">{l.kind === 'own' ? t('собственная') : l.partner_name}</div></td>
                        <td>{l.city}</td>
                        <td className="r">{l.status === 'opening' ? <Badge tone="info">{t('открывается')}</Badge> : formatMoneyShort(l.revenue_minor, l.currency, intlLocale())}</td>
                        <td className="r">{formatMoneyShort(l.today_revenue_minor, l.currency, intlLocale())}{l.on_shift.length > 0 && <span className="on-shift-dot" style={{ marginLeft: 6 }} title={t('Есть смена')} />}</td>
                        <td>{w.length ? <Badge tone="warning">{t(w[0])}{w.length > 1 ? ` +${w.length - 1}` : ''}</Badge> : <span className="faint">—</span>}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              </Card>
            </div>
          );
        }}
      </DataState>
    </>
  );
}
