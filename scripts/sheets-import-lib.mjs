// Перенос выручки из Google-таблиц франчайзи (лист «ВЫРУЧКА», выгруженный в CSV).
// Формат листа: блоки месяцев («ОКТЯБРЬ» / «Ekim»…), в каждом — раздел «Сумма» с парами «дд.мм | сумма» в 5 колонках недель
// и «ПЛАН А» справа; раздел «Кол-во» (число продаж) пропускается. Год в таблице не указан — он задаётся в настройках.

const MONTHS = {
  ЯНВАРЬ: 1, ФЕВРАЛЬ: 2, МАРТ: 3, АПРЕЛЬ: 4, МАЙ: 5, ИЮНЬ: 6, ИЮЛЬ: 7, АВГУСТ: 8, СЕНТЯБРЬ: 9, ОКТЯБРЬ: 10, НОЯБРЬ: 11, ДЕКАБРЬ: 12,
  OCAK: 1, ŞUBAT: 2, MART: 3, NISAN: 4, NİSAN: 4, MAYIS: 5, HAZIRAN: 6, TEMMUZ: 7, AĞUSTOS: 8, EYLÜL: 9, EKIM: 10, EKİM: 10, KASIM: 11, ARALIK: 12,
};

/** Простой разбор CSV (кавычки, запятые внутри кавычек). */
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** «12 500» / «12 500» / «12500,5» → число; пусто или текст → null. */
function num(s) {
  const t = String(s ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

const norm = (s) => String(s ?? '').toUpperCase().replace(/А/g, 'A').replace(/\s+/g, ' ').trim();

/** Выручка по дням { 'MM-DD': сумма } и план А по месяцам { M: сумма } из листа «ВЫРУЧКА». */
export function parseRevenueSheet(text) {
  const days = new Map(); const plans = new Map();
  let month = null; let inSum = false;
  for (const raw of parseCsv(text)) {
    const r = [...raw, ...Array(20).fill('')];
    const b = r[1].trim();
    const m = MONTHS[b.toUpperCase()] ?? MONTHS[b.toLocaleUpperCase('tr-TR')];
    if (m && r.slice(2, 12).every((x) => !x.trim())) { month = m; inSum = false; continue; }
    const low = b.toLowerCase();
    if (low.startsWith('сумма') || low.startsWith('günlük gelir')) { inSum = true; continue; }
    if (low.startsWith('кол-во') || low.startsWith('satış sayısı')) { inSum = false; continue; }
    if (!inSum || !month) continue;
    for (const c of [1, 3, 5, 7, 9]) {
      const d = /^(\d{1,2})\.\d{2}$/.exec(r[c].trim()); // месяц в дате бывает с ошибкой копирования — берём месяц блока, день — из даты
      const v = num(r[c + 1]);
      if (d && v && v > 0) days.set(`${String(month).padStart(2, '0')}-${d[1].padStart(2, '0')}`, Math.round(v * 100));
    }
    for (let c = 10; c < 16; c++) {
      if (['ПЛAН A', 'PLAN A'].includes(norm(r[c]))) { const v = num(r[c + 1]); if (v && v > 0) plans.set(month, Math.round(v * 100)); }
    }
  }
  return { days, plans };
}

/** Дата открытия: первый день первого месяца, где внесено хотя бы 5 дней (одиночная запись — обычно итог месяца, а не открытие). */
export function openedOn(year, days) {
  const byMonth = new Map();
  for (const k of days.keys()) { const m = k.slice(0, 2); byMonth.set(m, [...(byMonth.get(m) ?? []), k]); }
  const months = [...byMonth.keys()].sort();
  const first = months.find((m) => byMonth.get(m).length >= 5) ?? months[0];
  return first ? `${year}-${[...byMonth.get(first)].sort()[0]}` : null;
}

/**
 * Записать франчайзи, точку, выручку и план. q(sql, params) → rows. Повторный запуск заменяет перенесённые данные.
 * Демо-франчайзи с тем же кодом превращаются в реальных: их выдуманные точки, смены, оплаты и долги удаляются.
 */
export async function importPartner(q, cfg, csvText, year, log = console.log) {
  const { days, plans } = parseRevenueSheet(csvText);
  const opened = openedOn(year, days);
  const locCode = `${cfg.code}-1`;
  const [p] = await q(`insert into public.partner(code, name, country, currency, royalty_from, is_demo)
      values ($1, $2, $3, $4, date_trunc('month', now() at time zone 'Europe/Moscow')::date, false)
    on conflict (code) do update set name = excluded.name, country = excluded.country, currency = excluded.currency,
      royalty_from = coalesce(public.partner.royalty_from, excluded.royalty_from), is_demo = false, updated_at = now(),
      -- выдуманные контакты демо-стенда не переносятся на реального франчайзи
      contact_name = case when public.partner.is_demo then null else public.partner.contact_name end,
      contact_phone = case when public.partner.is_demo then null else public.partner.contact_phone end,
      contact_email = case when public.partner.is_demo then null else public.partner.contact_email end
    returning id`, [cfg.code, cfg.name, cfg.country, cfg.currency]);
  const pid = p.id;
  // выдуманные данные демо-стенда по этому франчайзи
  await q(`delete from public.work_shift where partner_id = $1`, [pid]);
  await q(`delete from public.expense where partner_id = $1`, [pid]);
  await q(`delete from public.royalty_payment where partner_id = $1`, [pid]);
  await q(`delete from public.royalty_manual where partner_id = $1`, [pid]);
  await q(`delete from public.revenue_plan where location_id in (select id from public.location where partner_id = $1)`, [pid]);
  await q(`delete from public.daily_revenue where partner_id = $1`, [pid]);
  const [l] = await q(`insert into public.location(code, name, partner_id, city, timezone, currency, opened_on, is_demo, status)
      values ($1, $2, $3, $4, $5, $6, $7, false, 'active')
    on conflict (code) do update set name = excluded.name, partner_id = excluded.partner_id, city = excluded.city, address = null,
      timezone = excluded.timezone, currency = excluded.currency, opened_on = excluded.opened_on, is_demo = false, status = 'active', updated_at = now()
    returning id`, [locCode, cfg.location, pid, cfg.city, cfg.timezone, cfg.currency, opened]);
  // лишние выдуманные точки
  await q(`update public.staff_member set location_ids = array[$2::uuid] where partner_id = $1`, [pid, l.id]);
  await q(`delete from public.location where partner_id = $1 and id <> $2`, [pid, l.id]);
  const [{ today }] = await q(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as today`, [cfg.timezone]);
  let n = 0; let skipped = 0;
  for (const [md, minor] of [...days.entries()].sort()) {
    const day = `${year}-${md}`;
    if (day > today || Number.isNaN(Date.parse(day))) { skipped++; continue; }
    await q(`insert into public.daily_revenue(location_id, partner_id, day, currency, cash_minor, card_minor, comment)
      values ($1, $2, $3, $4, $5, 0, 'Перенесено из Google-таблицы (без разбивки на наличные и карту)')`, [l.id, pid, day, cfg.currency, minor]);
    n++;
  }
  for (const [m, minor] of plans) {
    await q(`insert into public.revenue_plan(location_id, month, amount_minor) values ($1, $2, $3)`, [l.id, `${year}-${String(m).padStart(2, '0')}-01`, minor]);
  }
  await q(`select app_private.audit('import.sheet', 'partner', $1, $1, $2::jsonb)`, [pid, JSON.stringify({ days: n, plans: plans.size, opened_on: opened })]);
  log(`  ${cfg.name}: дней выручки ${n}${skipped ? ` (пропущено будущих ${skipped})` : ''}, планов ${plans.size}, открыта ${opened ?? '—'}`);
  return { partner_id: pid, location_id: l.id, days: n, plans: plans.size };
}
