// Browser QA only. Every backend request is intercepted; all data and tokens below are synthetic.
import { createRoot } from 'react-dom/client';
import { App } from '../../src/app/App';
import '../../src/ui/styles.css';

const uid = '00000000-0000-4000-8000-000000000001';
if (!crypto.randomUUID) crypto.randomUUID = () => `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`;
const user = { id: uid, aud: 'authenticated', role: 'authenticated', email: 'qa@example.invalid', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const exp = Math.floor(Date.now() / 1000) + 3600;
const encode = (v: unknown) => btoa(JSON.stringify(v)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: uid, exp, role: 'authenticated' })}.synthetic-qa`;
localStorage.removeItem('bron.remember-device');
sessionStorage.setItem('bron.auth', JSON.stringify({ access_token: token, refresh_token: 'synthetic-qa-only', token_type: 'bearer', expires_at: exp, expires_in: 3600, user }));
const partner = { id: 'qa-partner', name: 'Франчайзи с очень длинным названием города и несколькими торговыми точками', country: 'RU', currency: 'RUB', status: 'active', contact_name: 'Вымышленный владелец', contact_phone: null, contact_email: 'long-contact-address-for-responsive-test@example.invalid', order_url: null };
const location = { id: 'qa-location', name: 'Торговый центр с очень длинным названием', partner_id: partner.id, city: 'Вымышленный город', currency: 'RUB', status: 'active', opened_on: null, address: null };
const section = { id: 'qa-section', slug: 'qa-section', title: 'Гарантии и жалобы', description: 'Что делать, если клиент недоволен', icon: 'shield', sort: 10, parent_id: null, count: 3 };
const articles = ['Гарантия: как принимать обращение', 'Очень длинное название статьи без сокращения текста на маленьком телефоне', 'Что объяснить клиенту после оклейки'].map((title, i) => ({ id: i ? `qa-article-${i}` : 'qa-article', section_id: section.id, title, summary: 'Синтетическое описание для проверки переноса строк и кнопок.', type: i === 2 ? 'checklist' : 'regulation', status: 'published', minutes: 1, views_30: 0, required_ack: false, has_video: false, has_draft: false, read: false }));
const month = '2026-11-01';
const royaltyRows = ['TRY', 'RUB', 'KZT'].map((currency, i) => ({
  partner_id: i ? `qa-partner-${i}` : partner.id,
  partner_name: i ? `Вымышленный партнёр ${i} с длинным названием` : partner.name,
  status: 'active', country: ['TR', 'RU', 'KZ'][i], currency, rate_bp: 700,
  revenue_minor: 123456789, accrued_minor: 8641975, manual_minor: 125000,
  paid_minor: 100000, debt_minor: 8666975, is_open: false,
  current_revenue_minor: 950000, current_accrual_minor: 66500,
  debt_months: [{ month: '2026-10-01', debt_minor: 8666975 }],
  last_payment_on: '2026-11-02', fx_rub: 1,
}));
const detail = { ...location, location_id: location.id, location_name: location.name, partner_id: partner.id, partner_name: partner.name, month, today: '2026-11-04', plan_minor: null, fact_minor: 0, cash_minor: 0, card_minor: 0, pct: null, days_in_month: 30, days_left: 26, need_per_day_minor: null, missing_days: ['2026-11-01', '2026-11-02', '2026-11-03'], last_day: null, fx_rub: 1, editable_from: '2026-10-01', days: [], prev_month_total_minor: 0, prev_same_period_minor: 0, same_period_minor: 0, weekday_avg: [], staff: [] };
const profile = { owner_name: 'Вымышленный владелец', legal_name: 'Индивидуальный предприниматель с длинным наименованием', legal_address: 'Длинный адрес юридического лица для проверки мобильной карточки', notes: 'Текст для проверки. '.repeat(20), updated_at: '2026-11-04T12:00:00Z' };
const me = { user: { ...user, full_name: 'Тест интерфейса', is_demo: false }, assignments: [{ id: 'qa-role', role: 'franchise_manager', role_name: 'Менеджер по франшизе', scope_type: 'company', scope_id: null as string | null, scope_name: 'Вся сеть', permissions: ['org.manage', 'kb.read', 'kb.edit', 'revenue.read', 'revenue.write', 'royalty.read', 'royalty.write', 'staff.manage', 'rating.read', 'finance.read'] }] };
const qaParams = new URLSearchParams(window.location.search);
if (qaParams.get('role') === 'franchisee') {
  me.assignments = [{ id: 'qa-owner', role: 'franchisee', role_name: 'Франчайзи', scope_type: 'partner', scope_id: partner.id, scope_name: partner.name, permissions: ['kb.read', 'revenue.read', 'revenue.write', 'staff.manage', 'rating.read', 'finance.read'] }];
}
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, locationOrigin());
  if (url.pathname.includes('/auth/v1/')) return Response.json(url.pathname.endsWith('/user') ? user : {});
  if (!url.pathname.includes('/rest/v1/')) return originalFetch(input, init);
  const name = url.pathname.split('/').pop();
  if (url.pathname.includes('/rpc/')) {
    const answers: Record<string, unknown> = {
      order_link: { url: qaParams.get('order') === 'missing' ? null : 'https://b2b.moysklad.ru/qa-synthetic-not-an-order-link' },
      me, ping: { ok: true }, lead_list: [], lead_inbox: { new: 0 }, kb_inbox: { unanswered: 0, new_answers: 0 }, kb_to_read: [], kb_search_misses: [], kb_questions: [],
      partner_card: { partner, profile, locations: [location], documents: [{ id: 'qa-document', title: 'ОченьДлинноеНазваниеДокументаБезПробелов'.repeat(3), kind: 'contract', path: 'qa', mime: 'application/pdf', size_bytes: 1000 }], stats: { opened_on: null, revenue_12m_minor: 25000000, rate_bp: 700, users: 1, staff: 0 } },
      partner_access: { users: [{ assignment_id: 'qa-access', user_id: uid, full_name: 'Вымышленный пользователь с длинным именем', email: 'very-long-synthetic-login@example.invalid' }], invites: [] },
      staff_list: [{user_id:uid,full_name:'Вымышленный сотрудник с длинным именем и фамилией',phone:'70000000000',active:true,location_ids:[location.id],location_names:[location.name],rate_bp:2000,shift_fee_minor:50000,open_shift:null,month_shifts:20,month_revenue_minor:100000000,month_earned_minor:20000000,shifts:[]}], revenue_month: detail,
      revenue_overview: { month, rows: [detail], fact_rub_minor: 0, plan_rub_minor: null, missing_fx: [] },
      kb_home: { sections: [section, { ...section, id: 'qa-empty', title: 'Раздел для будущего наполнения', count: 0 }], recent: articles, popular: [], continue: [], drafts: 0, total: articles.length },
      kb_section_page: { section, parent: null, children: [], articles }, kb_article_open: { section, parent: null, related: articles.slice(1), my_rating: null, stats: { views_30: 0, helpful: 0, not_helpful: 0, comments: [] } },
      kb_manage: articles.map(a => ({ ...a, section_title: section.title, parent_title: null, helpful: 0, not_helpful: 0, ack_done: null, ack_total: null })),
      royalty_summary: { month: null, current_month: month, rows: royaltyRows, totals: royaltyRows.map(r => ({ currency: r.currency, accrued_minor: r.accrued_minor, paid_minor: r.paid_minor, debt_minor: r.debt_minor })), debt_rub_minor: 26000925 }, royalty_ops: [],
      royalty_partner: { partner_id: partner.id, partner_name: partner.name, currency: 'RUB', rate_bp: 700,
        months: [{ month: '2026-10-01', revenue_minor: 123456789, rate_bp: 700, accrued_minor: 8641975, manual_minor: 125000, paid_minor: 100000, debt_minor: 8666975, is_open: false }, { month, revenue_minor: 950000, rate_bp: 700, accrued_minor: 66500, manual_minor: 0, paid_minor: 0, debt_minor: 66500, is_open: true }], payments: [], manual: [], rates: [] },
      manager_supply_snapshot: {month, fetched_at:null, period_to:null, currency:'RUB', rows:[{partner_id:partner.id,partner_name:partner.name,mapped_count:0,counterparties:[],sales_minor:0,cost_minor:0,profit_minor:0}], unmapped:[]},
      rating: { rows: [{rank:1,partner_id:partner.id,partner_name:partner.name,cities:location.city,is_me:false,forecast_pct:123.4,pct_to_date:90,fill_pct:100,growth_pct:20,badges:['leader','no_gaps'],points:1,currency:'RUB',fact_minor:1234567890,plan_minor:1500000000,forecast_minor:1900000000,fact_rub_minor:1234567890,forecast_rub_minor:1900000000}], month },
    };
    if (name === 'order_link' && qaParams.get('order') === 'error') return Response.json({ message: 'offline', details: 'Тестовый сбой загрузки ссылки' }, { status: 503 });
    if (name && name in answers) return Response.json(answers[name]);
    console.warn('Missing QA response', name);
    return Response.json({ message: 'not-found', details: `Нет тестовых данных для ${name}` }, { status: 400 });
  }
  if (name === 'partner') return Response.json([partner]);
  if (name === 'location') return Response.json([location]);
  if (name === 'currency') return Response.json([{ code: 'RUB', minor_unit: 2 }]);
  if (name === 'country') return Response.json([{ code: 'RU', name: 'Россия', default_currency: 'RUB' }]);
  if (name === 'article') return Response.json([{ ...articles[0], slug: 'qa', published_revision_id: 'qa-revision', published: { ...articles[0], rev_no: 1 }, revision: 1, tags: [] }]);
  if (name === 'article_revision') {
    const revision = { id: 'qa-revision', article_id: 'qa-article', rev_no: 1, title: articles[0].title, summary: 'Проверка статьи', body: '## Заголовок\n\n' + 'Тест длинной строки и содержания. '.repeat(50) + '\n\nhttps://www.youtube.com/watch?v=5CZntWrxKl8', status: 'published', published_at: '2026-11-04T12:00:00Z' };
    return Response.json([revision]);
  }
  if (name === 'kb_section') return Response.json([section]);
  return Response.json([]);
};
function locationOrigin() { return window.location.origin; }
const textScale = new URLSearchParams(window.location.search).get('text');
if (textScale === '200') {
  const root = document.documentElement, styles = getComputedStyle(root);
  const sizes = ['--fs-xs', '--fs-s', '--fs', '--fs-l', '--fs-xl', '--fs-2xl'].map(key => [key, parseFloat(styles.getPropertyValue(key)) * 2] as const);
  sizes.forEach(([key, value]) => root.style.setProperty(key, `${value}px`));
}
createRoot(document.getElementById('root')!).render(<App />);
