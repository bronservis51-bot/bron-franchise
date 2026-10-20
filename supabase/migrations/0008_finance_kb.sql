-- 0008
-- 1) Сотрудник не видит выручку и план точки: только свои смены и заработок.
-- 2) «Финансы» франчайзи: выручка, зарплата сотрудников, роялти, остаток — по всем точкам или по одной; помесячно.
-- 3) Роялти у менеджера: корректировка начисления в плюс и в минус (автоматический расчёт остаётся), журнал операций с отменой.
-- 4) База знаний под рост: подразделы и значки разделов, страница раздела, просмотры, оценка «помогла ли статья», связанные статьи.

------------------------------------------------------------------------------
-- 1. Экран сотрудника — без выручки точки
------------------------------------------------------------------------------
create or replace function public.staff_home(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); s public.staff_member; v_month date;
begin
  s := app_private.my_staff();
  v_month := date_trunc('month', coalesce(p_month, (select app_private.local_today(s.location_ids[1]))))::date;
  return jsonb_build_object(
    'month', v_month,
    'rate_bp', s.rate_bp, 'shift_fee_minor', s.shift_fee_minor,
    'partner_name', (select name from public.partner where id = s.partner_id),
    'open_shift', (select to_jsonb(w) || jsonb_build_object('location_name', l.name, 'currency', l.currency)
                   from public.work_shift w join public.location l on l.id = w.location_id where w.employee_id = v_user and w.status = 'open'),
    -- только точки и своя смена сегодня; выручки и плана точки здесь нет
    'locations', coalesce((select jsonb_agg(jsonb_build_object('location_id', l.id, 'location_name', l.name, 'currency', l.currency,
        'today', app_private.local_today(l.id),
        'my_today', (select to_jsonb(w) from public.work_shift w where w.employee_id = v_user and w.location_id = l.id and w.day = app_private.local_today(l.id)))
        order by l.name)
      from public.location l where l.id = any(s.location_ids) and l.status = 'active'), '[]'::jsonb),
    'month_earned_minor', (select coalesce(sum(earned_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_revenue_minor', (select coalesce(sum(total_minor), 0) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'month_shifts', (select count(*) from public.work_shift where employee_id = v_user and status = 'closed'
      and day >= v_month and day < v_month + interval '1 month'),
    'currency', (select currency from public.partner where id = s.partner_id),
    'shifts', coalesce((select jsonb_agg(to_jsonb(w) || jsonb_build_object('location_name', l.name) order by w.day desc, w.opened_at desc)
      from public.work_shift w join public.location l on l.id = w.location_id
      where w.employee_id = v_user and w.status = 'closed' and w.day >= v_month and w.day < v_month + interval '1 month'), '[]'::jsonb));
end $$;

------------------------------------------------------------------------------
-- 2. Финансы франчайзи
------------------------------------------------------------------------------
-- Показатели месяца по набору точек: выручка (нал/карта), план, зарплата по сменам, роялти по ставке месяца.
create function app_private.fin_month(p_partner uuid, p_locations uuid[], p_month date) returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  with r as (
    select coalesce(sum(total_minor), 0)::bigint t, coalesce(sum(cash_minor), 0)::bigint c, coalesce(sum(card_minor), 0)::bigint k
    from public.daily_revenue where location_id = any(p_locations) and day >= p_month and day < (p_month + interval '1 month')::date
  ), w as (
    select coalesce(sum(earned_minor), 0)::bigint e, count(*)::int n from public.work_shift
    where location_id = any(p_locations) and status = 'closed' and day >= p_month and day < (p_month + interval '1 month')::date
  ), p as (
    select sum(amount_minor)::bigint v from public.revenue_plan where location_id = any(p_locations) and month = p_month
  )
  select jsonb_build_object(
    'month', p_month, 'revenue_minor', r.t, 'cash_minor', r.c, 'card_minor', r.k, 'plan_minor', p.v,
    'pct', case when p.v > 0 then round(r.t * 100.0 / p.v, 1) end,
    'payroll_minor', w.e, 'shifts', w.n,
    'rate_bp', app_private.rate_bp(p_partner, p_month),
    'royalty_minor', round(r.t * app_private.rate_bp(p_partner, p_month) / 10000.0)::bigint,
    'net_minor', r.t - w.e - round(r.t * app_private.rate_bp(p_partner, p_month) / 10000.0)::bigint,
    'is_open', p_month >= app_private.current_month())
  from r, w, p
$$;

create function public.finance_my(p_month date, p_location uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_partner uuid; p public.partner; v_month date := date_trunc('month', p_month)::date; v_locs uuid[]; v_all uuid[]; m date;
  v_months jsonb := '[]'::jsonb;
begin
  perform app_private.require_user();
  select scope_id into v_partner from app_private.active_assignments() a where a.role = 'franchisee' limit 1;
  if v_partner is null then perform app_private.fail('forbidden', 'Финансы видит франчайзи'); end if;
  perform app_private.require_perm('revenue.read', v_partner);
  select * into p from public.partner where id = v_partner;
  select array_agg(id order by name) into v_all from public.location where partner_id = v_partner;
  if p_location is not null and not (p_location = any(v_all)) then perform app_private.fail('not-found', 'Точка не найдена'); end if;
  v_locs := case when p_location is null then v_all else array[p_location] end;
  -- полгода по месяцам, последний — выбранный
  for m in select generate_series(v_month - interval '5 months', v_month, interval '1 month')::date loop
    v_months := v_months || jsonb_build_array(app_private.fin_month(v_partner, v_locs, m));
  end loop;
  return jsonb_build_object(
    'partner_name', p.name, 'currency', p.currency, 'month', v_month, 'location_id', p_location,
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status) order by name)
      from public.location where partner_id = v_partner), '[]'::jsonb),
    'current', app_private.fin_month(v_partner, v_locs, v_month),
    'months', v_months,
    'by_location', case when p_location is null then coalesce((select jsonb_agg(app_private.fin_month(v_partner, array[l.id], v_month)
        || jsonb_build_object('location_id', l.id, 'location_name', l.name) order by l.name)
      from public.location l where l.partner_id = v_partner), '[]'::jsonb) end,
    'by_staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', u.id, 'full_name', u.full_name, 'shifts', x.n, 'revenue_minor', x.t, 'earned_minor', x.e)
        order by x.e desc)
      from (select employee_id, count(*)::int n, sum(total_minor)::bigint t, sum(earned_minor)::bigint e from public.work_shift
            where location_id = any(v_locs) and status = 'closed' and day >= v_month and day < v_month + interval '1 month' group by employee_id) x
      join public.app_user u on u.id = x.employee_id), '[]'::jsonb),
    -- корректировки и прошлые долги — на уровне франчайзи; показываются в режиме «все точки»
    'royalty', case when p_location is null then public.royalty_my() end);
end $$;

------------------------------------------------------------------------------
-- 3. Роялти: корректировки и отмена операций
------------------------------------------------------------------------------
alter table public.royalty_manual add column kind text not null default 'past_debt' check (kind in ('past_debt', 'correction'));
alter table public.royalty_manual drop constraint royalty_manual_amount_minor_check;
alter table public.royalty_manual add constraint royalty_manual_amount_check check (amount_minor <> 0 and (kind = 'correction' or amount_minor > 0));

-- Исправить начисление месяца: «должно быть X» → разница записывается корректировкой; автоматический расчёт остаётся как есть.
create function public.royalty_set_accrual(p_partner uuid, p_month date, p_target bigint, p_note text) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_month date := date_trunc('month', p_month)::date; g record; v_delta bigint; v_id uuid;
begin
  perform app_private.royalty_partner_check(p_partner);
  if p_target is null or p_target < 0 then perform app_private.fail('validation', 'Укажите сумму начисления', 'amount'); end if;
  if v_month > app_private.current_month() then perform app_private.fail('validation', 'Нельзя исправить будущий месяц', 'month'); end if;
  if coalesce(trim(p_note), '') = '' then perform app_private.fail('validation', 'Напишите причину исправления', 'note'); end if;
  select * into g from app_private.royalty_ledger(p_partner) l where l.month = v_month;
  v_delta := p_target - coalesce(g.accrued_minor, 0) - coalesce(g.manual_minor, 0);
  if v_delta = 0 then return jsonb_build_object('id', null, 'delta_minor', 0); end if;
  insert into public.royalty_manual(partner_id, month, amount_minor, note, kind, created_by)
  values (p_partner, v_month, v_delta, trim(p_note), 'correction', auth.uid()) returning id into v_id;
  perform app_private.audit('royalty.correction', 'royalty_manual', v_id, p_partner, jsonb_build_object('month', v_month, 'target', p_target, 'delta', v_delta));
  return jsonb_build_object('id', v_id, 'delta_minor', v_delta);
end $$;

-- Журнал операций по роялти (оплаты, прошлые долги, корректировки) — чтобы отменить ошибочную.
create function public.royalty_ops(p_partner uuid default null, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('royalty.manage');
  return coalesce((select jsonb_agg(t.x order by t.created_at desc) from (
    select * from (
      select r.created_at, jsonb_build_object('id', r.id, 'op', 'payment', 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'paid_on', r.paid_on, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by)) as x
      from public.royalty_payment r join public.partner p on p.id = r.partner_id where p_partner is null or r.partner_id = p_partner
      union all
      select r.created_at, jsonb_build_object('id', r.id, 'op', r.kind, 'partner_id', r.partner_id, 'partner_name', p.name, 'currency', p.currency,
        'month', r.month, 'amount_minor', r.amount_minor, 'note', r.note, 'created_at', r.created_at,
        'by', (select full_name from public.app_user where id = r.created_by))
      from public.royalty_manual r join public.partner p on p.id = r.partner_id where p_partner is null or r.partner_id = p_partner
    ) u order by created_at desc limit greatest(1, least(p_limit, 200))) t), '[]'::jsonb);
end $$;

------------------------------------------------------------------------------
-- 4. База знаний под рост
------------------------------------------------------------------------------
alter table public.kb_section add column parent_id uuid references public.kb_section(id);
alter table public.kb_section add column icon text not null default 'book'
  check (icon in ('book', 'rocket', 'smartphone', 'scissors', 'shield', 'users', 'wallet', 'megaphone', 'wrench', 'graduation', 'star', 'clipboard'));

create table public.kb_view (
  article_id uuid not null references public.article(id),
  user_id uuid not null references public.app_user(id),
  day date not null default current_date,
  primary key (article_id, user_id, day)
);
create index on public.kb_view (day);

create table public.kb_rating (
  article_id uuid not null references public.article(id),
  user_id uuid not null references public.app_user(id),
  helpful boolean not null,
  comment text,
  at timestamptz not null default now(),
  primary key (article_id, user_id)
);

create function app_private.kb_has_video(p_body text) returns boolean language sql immutable as $$
  select coalesce(p_body, '') ~* '(youtube\.com/watch|youtu\.be/|rutube\.ru/video|vk\.com/video|vkvideo\.ru/video)'
$$;

-- Карточка статьи для списков (опубликованная редакция; менеджеру — и черновики).
create function app_private.kb_card(a public.article) returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select jsonb_build_object('id', a.id, 'type', a.type, 'status', a.status, 'section_id', a.section_id, 'required_ack', a.required_ack,
    'title', coalesce(r.title, d.title), 'summary', coalesce(r.summary, d.summary), 'published_at', r.published_at, 'updated_at', a.updated_at,
    'has_video', app_private.kb_has_video(coalesce(r.body, d.body)),
    'minutes', greatest(1, round(length(coalesce(r.body_text, d.body_text, '')) / 1200.0)),
    'views_30', (select count(distinct user_id) from public.kb_view v where v.article_id = a.id and v.day > current_date - 30),
    'has_draft', exists (select 1 from public.article_revision x where x.article_id = a.id and x.status = 'draft'),
    'read', exists (select 1 from public.kb_view v where v.article_id = a.id and v.user_id = auth.uid()))
  from (select 1) one
  left join public.article_revision r on r.id = a.published_revision_id
  left join lateral (select * from public.article_revision x where x.article_id = a.id order by rev_no desc limit 1) d on true
$$;

-- Разделы с числом статей (включая подразделы) — для главной и меню.
create function app_private.kb_sections_tree() returns jsonb
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'parent_id', s.parent_id, 'title', s.title, 'description', s.description,
      'icon', s.icon, 'sort', s.sort,
      'count', (select count(*) from public.article a where app_private.can_read_article(a) and a.status = 'published'
                and (a.section_id = s.id or a.section_id in (select id from public.kb_section c where c.parent_id = s.id))))
    order by s.sort, s.title), '[]'::jsonb)
  from public.kb_section s
$$;

create function public.kb_home() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare v_editor boolean;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.read') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  v_editor := app_private.kb_is_editor();
  return jsonb_build_object(
    'sections', app_private.kb_sections_tree(),
    'recent', coalesce((select jsonb_agg(app_private.kb_card(a) order by r.published_at desc)
      from (select a.* from public.article a join public.article_revision r on r.id = a.published_revision_id
            where a.status = 'published' and app_private.can_read_article(a) order by r.published_at desc limit 6) a
      join public.article_revision r on r.id = a.published_revision_id), '[]'::jsonb),
    'popular', coalesce((select jsonb_agg(app_private.kb_card(a) order by x.n desc)
      from (select article_id, count(distinct user_id) n from public.kb_view where day > current_date - 30 group by article_id order by 2 desc limit 6) x
      join public.article a on a.id = x.article_id where a.status = 'published' and app_private.can_read_article(a)), '[]'::jsonb),
    'continue', coalesce((select jsonb_agg(app_private.kb_card(a) order by x.d desc)
      from (select article_id, max(day) d from public.kb_view where user_id = auth.uid() group by article_id order by 2 desc limit 4) x
      join public.article a on a.id = x.article_id where a.status = 'published'), '[]'::jsonb),
    'drafts', case when v_editor then (select count(*) from public.article a where exists (select 1 from public.article_revision x where x.article_id = a.id and x.status = 'draft')) end,
    'total', (select count(*) from public.article a where a.status = 'published' and app_private.can_read_article(a)));
end $$;

create function public.kb_section_page(p_section uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
declare s public.kb_section; v_editor boolean;
begin
  perform app_private.require_user();
  if not app_private.has_perm_anywhere('kb.read') then perform app_private.fail('forbidden', 'Недостаточно прав'); end if;
  v_editor := app_private.kb_is_editor();
  select * into s from public.kb_section where id = p_section;
  if not found then perform app_private.fail('not-found', 'Раздел не найден'); end if;
  return jsonb_build_object(
    'section', to_jsonb(s),
    'parent', (select jsonb_build_object('id', id, 'title', title) from public.kb_section where id = s.parent_id),
    'children', coalesce((select jsonb_agg(x order by (x ->> 'sort')::int, x ->> 'title') from jsonb_array_elements(app_private.kb_sections_tree()) x
      where x ->> 'parent_id' = s.id::text), '[]'::jsonb),
    'articles', coalesce((select jsonb_agg(app_private.kb_card(a) order by a.required_ack desc, coalesce(r.title, '') )
      from public.article a left join public.article_revision r on r.id = a.published_revision_id
      where a.section_id = s.id and app_private.can_read_article(a) and (a.status = 'published' or v_editor)), '[]'::jsonb));
end $$;

-- Открытие статьи: отметить просмотр, вернуть путь, связанные статьи, оценку.
create function public.kb_article_open(p_article uuid) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article; s public.kb_section; v_editor boolean := app_private.kb_is_editor();
begin
  perform app_private.require_user();
  select * into a from public.article where id = p_article;
  if not found or not app_private.can_read_article(a) then perform app_private.fail('not-found', 'Статья не найдена'); end if;
  if not v_editor and a.status = 'published' then
    insert into public.kb_view(article_id, user_id) values (a.id, auth.uid()) on conflict do nothing;
  end if;
  select * into s from public.kb_section where id = a.section_id;
  return jsonb_build_object(
    'section', jsonb_build_object('id', s.id, 'title', s.title),
    'parent', (select jsonb_build_object('id', id, 'title', title) from public.kb_section where id = s.parent_id),
    'related', coalesce((select jsonb_agg(app_private.kb_card(x)) from (
        select x.* from public.article x where x.section_id = a.section_id and x.id <> a.id and x.status = 'published' and app_private.can_read_article(x)
        order by x.required_ack desc, x.updated_at desc limit 5) x), '[]'::jsonb),
    'my_rating', (select helpful from public.kb_rating where article_id = a.id and user_id = auth.uid()),
    'stats', case when v_editor then jsonb_build_object(
      'views_30', (select count(distinct user_id) from public.kb_view where article_id = a.id and day > current_date - 30),
      'helpful', (select count(*) from public.kb_rating where article_id = a.id and helpful),
      'not_helpful', (select count(*) from public.kb_rating where article_id = a.id and not helpful),
      'comments', coalesce((select jsonb_agg(jsonb_build_object('comment', r.comment, 'at', r.at, 'user', u.full_name) order by r.at desc)
        from public.kb_rating r join public.app_user u on u.id = r.user_id where r.article_id = a.id and r.comment is not null), '[]'::jsonb)) end);
end $$;

create function public.kb_rate(p_article uuid, p_helpful boolean, p_comment text default null) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare a public.article;
begin
  perform app_private.require_user();
  select * into a from public.article where id = p_article;
  if not found or a.status <> 'published' or not app_private.can_read_article(a) then perform app_private.fail('not-found', 'Статья не найдена'); end if;
  insert into public.kb_rating(article_id, user_id, helpful, comment) values (p_article, auth.uid(), p_helpful, nullif(left(trim(p_comment), 1000), ''))
  on conflict (article_id, user_id) do update set helpful = excluded.helpful, comment = coalesce(excluded.comment, public.kb_rating.comment), at = now();
end $$;

-- Менеджеру: все статьи одной таблицей — раздел, статус, просмотры, оценки, ознакомление.
create function public.kb_manage() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_editor();
  return coalesce((select jsonb_agg(app_private.kb_card(a) || jsonb_build_object(
      'section_title', s.title, 'parent_title', (select title from public.kb_section where id = s.parent_id),
      'helpful', (select count(*) from public.kb_rating where article_id = a.id and helpful),
      'not_helpful', (select count(*) from public.kb_rating where article_id = a.id and not helpful),
      'ack_done', case when a.required_ack then (select count(distinct k.user_id) from public.acknowledgement k where k.article_id = a.id and k.rev_no >= coalesce(a.ack_rev_no, 0)
        and k.user_id in (select app_private.kb_readers())) end,
      'ack_total', case when a.required_ack then (select count(*) from app_private.kb_readers()) end)
    order by s.sort, a.updated_at desc)
    from public.article a join public.kb_section s on s.id = a.section_id), '[]'::jsonb);
end $$;

-- Разделы: название, описание, значок, порядок, родитель (не глубже двух уровней).
delete from app_private.client_command where fn = 'public.kb_section_save(uuid, text, text, int)'::regprocedure;
drop function public.kb_section_save(uuid, text, text, int);

create function public.kb_section_save(p_id uuid, p_parent uuid, p_title text, p_description text, p_sort int, p_icon text default 'book') returns uuid
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  perform app_private.require_editor();
  if coalesce(trim(p_title), '') = '' then perform app_private.fail('validation', 'Укажите название раздела', 'title'); end if;
  if p_parent is not null then
    if p_parent = v_id then perform app_private.fail('validation', 'Раздел не может входить сам в себя', 'parent'); end if;
    if exists (select 1 from public.kb_section where id = p_parent and parent_id is not null) then
      perform app_private.fail('validation', 'Подраздел можно создать только в разделе верхнего уровня', 'parent');
    end if;
    if exists (select 1 from public.kb_section where parent_id = v_id) then
      perform app_private.fail('validation', 'У раздела есть подразделы — его нельзя сделать подразделом', 'parent');
    end if;
  end if;
  insert into public.kb_section(id, slug, title, description, sort, parent_id, icon)
  values (v_id, 's-' || left(replace(v_id::text, '-', ''), 10), trim(p_title), nullif(trim(p_description), ''), coalesce(p_sort, 100), p_parent, coalesce(p_icon, 'book'))
  on conflict (id) do update set title = excluded.title, description = excluded.description, sort = excluded.sort,
    parent_id = excluded.parent_id, icon = excluded.icon;
  return v_id;
end $$;

create function public.kb_section_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_editor();
  if exists (select 1 from public.article where section_id = p_id) then perform app_private.fail('validation', 'В разделе есть статьи — сначала перенесите их'); end if;
  if exists (select 1 from public.kb_section where parent_id = p_id) then perform app_private.fail('validation', 'В разделе есть подразделы'); end if;
  delete from public.kb_section where id = p_id;
end $$;

alter table public.kb_view enable row level security;
alter table public.kb_rating enable row level security;
create policy read_own on public.kb_view for select to authenticated using (user_id = auth.uid() or app_private.kb_is_editor());
create policy read_own on public.kb_rating for select to authenticated using (user_id = auth.uid() or app_private.kb_is_editor());

insert into app_private.client_table(tbl) values ('public.kb_view'), ('public.kb_rating');
insert into app_private.client_command(fn) values
  ('public.finance_my(date, uuid)'), ('public.royalty_set_accrual(uuid, date, bigint, text)'), ('public.royalty_ops(uuid, int)'),
  ('public.kb_home()'), ('public.kb_section_page(uuid)'), ('public.kb_article_open(uuid)'), ('public.kb_rate(uuid, boolean, text)'),
  ('public.kb_manage()'), ('public.kb_section_save(uuid, uuid, text, text, int, text)'), ('public.kb_section_delete(uuid)');
select app_private.apply_grants();
