// Партнёры и точки (SUP-01): единая карточка партнёра — точки, договоры, проекты, обращения, закупки, отчётность.
import { LocationNotes } from '../shared/LocationNotes';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { from, rows } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { formatDate, formatPeriod } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { Badge, Card, DataState, EmptyState, Input, KV, Money, NoResults, PageHeader } from '../../ui';
import { OPENING_STATUS, ORDER_STATUS, REPORT_STATUS, st, TICKET_STATUS } from '../../ui/status';
import { useLocations, usePartners, type Location } from '../shared/lookups';

const LOC_STATUS: Record<string, [string, 'neutral' | 'info' | 'success' | 'warning']> = {
  planned: ['планируется', 'neutral'], opening: ['открывается', 'info'], active: ['работает', 'success'], closed: ['закрыта', 'neutral'],
};

export function PartnersPage() {
  const { isStaff, me } = useSession();
  const partners = usePartners();
  const locs = useLocations();
  const [q, setQ] = useState('');
  const own = (locs.data ?? []).filter((l) => l.kind === 'own');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (partners.data ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s) ||
      (locs.data ?? []).some((l) => l.partner_id === p.id && l.name.toLowerCase().includes(s)));
  }, [partners.data, locs.data, q]);

  // Партнёр с одной организацией сразу видит свою карточку
  if (!isStaff && partners.data?.length === 1) return <Navigate to={`/partners/${partners.data[0].id}`} replace />;

  return (
    <>
      <PageHeader title="Партнёры и точки" sub={isStaff ? 'Франшизные партнёры и собственные точки в вашей области' : me?.user.full_name} />
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="p-search" className="sr-only">Поиск</label>
        <Input id="p-search" type="search" placeholder="Партнёр, код или точка" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="grid grid-2">
        <Card title="Партнёры" bodyless>
          <DataState query={partners} empty={() => (filtered.length ? null : q ? <NoResults query={q} /> : <EmptyState title="Партнёров нет" />)}>
            {() => (
              <ul className="list">
                {filtered.map((p) => {
                  const pl = (locs.data ?? []).filter((l) => l.partner_id === p.id);
                  return (
                    <li key={p.id}>
                      <Link className="list-item" to={`/partners/${p.id}`}>
                        <div className="main-col">
                          <div className="title">{p.name}</div>
                          <div className="meta"><span className="mono">{p.code}</span><span>{p.country}</span><span>{pl.length} точ.</span></div>
                        </div>
                        <div className="side" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </DataState>
        </Card>
        {isStaff && own.length > 0 && (
          <Card title="Собственные точки" bodyless>
            <ul className="list">
              {own.map((l) => <LocationRow key={l.id} l={l} />)}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

function LocationRow({ l }: { l: Location }) {
  const [label, tone] = LOC_STATUS[l.status] ?? [l.status, 'neutral'];
  return (
    <li className="list-item">
      <div className="main-col">
        <div className="title">{l.name}</div>
        <div className="meta"><span className="mono">{l.code}</span><span>{l.city}</span>{l.address && <span>{l.address}</span>}<span>{l.timezone} · {l.currency}</span></div>
      </div>
      <div className="side"><Badge tone={tone}>{label}</Badge>{l.opened_on && <span className="faint">с {formatDate(l.opened_on, intlLocale())}</span>}</div>
    </li>
  );
}

function Section({ title, link, children }: { title: string; link?: string; children: ReactNode }) {
  return <Card title={title} actions={link && <Link to={link}>Все</Link>} bodyless>{children}</Card>;
}

function PartnerNotes({ locations }: { locations: Location[] }) {
  const [sel, setSel] = useState(locations.find((l) => l.status === 'active')?.id ?? locations[0].id);
  return (
    <Card>
      {locations.length > 1 && (
        <div className="chips" role="group" aria-label="Точка" style={{ marginBottom: 10 }}>
          {locations.map((l) => <button key={l.id} type="button" className="chip" aria-pressed={sel === l.id} onClick={() => setSel(l.id)}>{l.name}</button>)}
        </div>
      )}
      <LocationNotes key={sel} locationId={sel} />
    </Card>
  );
}

export function PartnerPage() {
  const { id = '' } = useParams();
  const { can, isStaff } = useSession();
  const { t } = useT();
  const partner = useQuery({ queryKey: ['partner', id], queryFn: async () => (await rows<{ id: string; name: string; code: string; country: string; locale: string; status: string; contact_name: string | null; contact_phone: string | null; contact_email: string | null; is_demo: boolean }>(from('partner').select('*').eq('id', id)))[0] ?? null });
  const locs = useQuery({ queryKey: ['partner', id, 'locs'], queryFn: () => rows<Location>(from('location').select('*').eq('partner_id', id).order('name')) });
  const contracts = useQuery({ queryKey: ['partner', id, 'contracts'], enabled: can('contract.read'),
    queryFn: () => rows<{ id: string; number: string; currency: string; valid_from: string; valid_to: string | null; status: string; is_test: boolean;
      contract_policy_version: { version: number; effective_from: string; rate_bp: number; rounding: string; report_due_day: number; payment_due_day: number }[] }>(
      from('contract').select('id, number, currency, valid_from, valid_to, status, is_test, contract_policy_version(version, effective_from, rate_bp, rounding, report_due_day, payment_due_day)').eq('partner_id', id)) });
  const openings = useQuery({ queryKey: ['partner', id, 'openings'], enabled: can('opening.read'),
    queryFn: () => rows<{ id: string; number: string; status: string; planned_open_on: string }>(from('opening_project').select('id, number, status, planned_open_on').eq('partner_id', id).order('created_at', { ascending: false })) });
  const tickets = useQuery({ queryKey: ['partner', id, 'tickets'], enabled: can('ticket.read'),
    queryFn: () => rows<{ id: string; number: string; subject: string; status: string }>(from('ticket').select('id, number, subject, status').eq('partner_id', id).not('status', 'eq', 'closed').order('created_at', { ascending: false }).limit(10)) });
  const orders = useQuery({ queryKey: ['partner', id, 'orders'], enabled: can('order.read'),
    queryFn: () => rows<{ id: string; number: string; status: string; total_minor: string; currency: string; submitted_at: string }>(from('sales_order').select('id, number, status, total_minor, currency, submitted_at').eq('partner_id', id).neq('status', 'draft').order('submitted_at', { ascending: false }).limit(10)) });
  const reports = useQuery({ queryKey: ['partner', id, 'reports'], enabled: can('royalty.read'),
    queryFn: () => rows<{ id: string; number: string; period: string; status: string }>(from('revenue_report').select('id, number, period, status').eq('partner_id', id).order('period', { ascending: false }).limit(6)) });
  const balance = useQuery({ queryKey: ['partner', id, 'balance'], enabled: can('royalty.read'),
    queryFn: () => rows<{ currency: string; outstanding_minor: string; due_on: string }>(from('v_accrual_balance').select('currency, outstanding_minor, due_on').eq('partner_id', id).gt('outstanding_minor', 0)) });

  return (
    <DataState query={partner} empty={(p) => (p ? null : <EmptyState title="Партнёр не найден" text="Нет доступа или объект не существует." />)}>
      {(p) => p && (
        <>
          <PageHeader back={isStaff ? { to: '/partners', label: 'Партнёры и точки' } : undefined} title={p.name}
            sub={<span className="row"><span className="mono">{p.code}</span><span>{p.country}</span></span>} />
          <div className="grid grid-main">
            <div className="stack">
              <Section title="Точки">
                <ul className="list">{(locs.data ?? []).map((l) => <LocationRow key={l.id} l={l} />)}</ul>
              </Section>
              {(locs.data ?? []).length > 0 && <PartnerNotes locations={locs.data!} />}
              {can('opening.read') && Boolean(openings.data?.length) && (
                <Section title="Открытия" link="/openings">
                  <ul className="list">
                    {openings.data!.map((o) => (
                      <li key={o.id}><Link className="list-item" to={`/openings/${o.id}`}><div className="main-col"><div className="title mono">{o.number}</div><div className="meta">План: {formatDate(o.planned_open_on, intlLocale())}</div></div><div className="side"><Badge tone={st(OPENING_STATUS, o.status)[1]}>{st(OPENING_STATUS, o.status)[0]}</Badge></div></Link></li>
                    ))}
                  </ul>
                </Section>
              )}
              {can('ticket.read') && (
                <Section title="Открытые обращения" link="/support">
                  {tickets.data?.length ? (
                    <ul className="list">{tickets.data.map((k) => (
                      <li key={k.id}><Link className="list-item" to={`/support/${k.id}`}><div className="main-col"><div className="title">{k.subject}</div><div className="meta mono">{k.number}</div></div><div className="side"><Badge tone={st(TICKET_STATUS, k.status)[1]}>{t(st(TICKET_STATUS, k.status)[0])}</Badge></div></Link></li>
                    ))}</ul>
                  ) : <EmptyState title="Открытых обращений нет" />}
                </Section>
              )}
              {can('order.read') && Boolean(orders.data?.length) && (
                <Section title="Последние заказы" link="/orders">
                  <ul className="list">{orders.data!.map((o) => (
                    <li key={o.id}><Link className="list-item" to={`/orders/${o.id}`}><div className="main-col"><div className="title mono">{o.number}</div><div className="meta">{formatDate(o.submitted_at, intlLocale())}</div></div><div className="side"><Money minor={o.total_minor} currency={o.currency} /><Badge tone={st(ORDER_STATUS, o.status)[1]}>{st(ORDER_STATUS, o.status)[0]}</Badge></div></Link></li>
                  ))}</ul>
                </Section>
              )}
            </div>
            <div className="stack">
              {can('org.read') && (
                <Card title="Контакты">
                  <KV items={[['Контакт', p.contact_name], ['Телефон', p.contact_phone], ['Email', p.contact_email], ['Язык', p.locale === 'tr' ? 'турецкий' : 'русский']]} />
                </Card>
              )}
              {can('royalty.read') && (
                <Card title="Роялти" actions={<Link to="/royalties">Подробнее</Link>}>
                  {balance.data?.length ? balance.data.map((b, i) => (
                    <div key={i} className="row between"><span>Остаток до {formatDate(b.due_on, intlLocale())}</span><Money minor={b.outstanding_minor} currency={b.currency} strong /></div>
                  )) : <div className="muted">Задолженности нет</div>}
                  <hr className="divider" />
                  {(reports.data ?? []).map((r) => (
                    <div key={r.id} className="row between" style={{ padding: '4px 0' }}>
                      <Link to={`/royalties/reports/${r.id}`}>{formatPeriod(r.period, intlLocale())}</Link>
                      <Badge tone={st(REPORT_STATUS, r.status)[1]}>{t(st(REPORT_STATUS, r.status)[0])}</Badge>
                    </div>
                  ))}
                </Card>
              )}
              {can('contract.read') && (contracts.data ?? []).map((c) => {
                const pol = [...c.contract_policy_version].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
                return (
                  <Card key={c.id} title={`Договор ${c.number}`} >
                    <KV items={[
                      ['Действует', `с ${formatDate(c.valid_from, intlLocale())}${c.valid_to ? ` по ${formatDate(c.valid_to, intlLocale())}` : ''}`],
                      ['Валюта', c.currency],
                      ['Ставка', pol[0] ? `${(pol[0].rate_bp / 100).toLocaleString(intlLocale())}% с ${formatDate(pol[0].effective_from, intlLocale())}` : '—'],
                      ['Сдача / оплата', pol[0] ? `до ${pol[0].report_due_day} / до ${pol[0].payment_due_day} числа следующего месяца` : '—'],
                      ['Версий правил', String(pol.length)],
                    ]} />
                  </Card>
                );
              })}
            </div>
          </div>
        </>
      )}
    </DataState>
  );
}
