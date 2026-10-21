-- 0012
-- Заявки на франшизу с сайта (лендинг bronservice-franchise): простая CRM менеджера.
-- Сайт без входа вызывает lead_submit (анкета). Менеджер видит заявки, меняет статус и пишет заметку.
-- Заявке сразу ставится оценка «горячая / тёплая / холодная» по ответам анкеты, чтобы первыми звонить тем, кто готов.

create table public.franchise_lead (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null check (length(trim(name)) between 1 and 80),
  phone text not null check (length(phone) between 5 and 30),
  phone_digits text not null,
  contact_via text not null check (contact_via in ('whatsapp', 'telegram', 'call')),
  city text not null check (length(trim(city)) between 2 and 80),
  budget text not null check (budget in ('full', 'partial', 'none')),
  timing text not null check (timing in ('month', 'quarter', 'half', 'research')),
  manage text not null check (manage in ('self', 'manager', 'undecided')),
  experience text not null check (experience in ('business', 'some', 'none')),
  place text not null check (place in ('has', 'options', 'help')),
  comment text check (length(comment) <= 1000),
  source text check (length(source) <= 300),
  score smallint not null,
  tier text not null check (tier in ('hot', 'warm', 'cold')),
  status text not null default 'new' check (status in ('new', 'in_work', 'call_back', 'meeting', 'won', 'lost')),
  note text check (length(note) <= 2000),
  updated_by uuid references public.app_user(id),
  updated_at timestamptz not null default now()
);
create index on public.franchise_lead (created_at desc);
create index on public.franchise_lead (phone_digits, created_at desc);
alter table public.franchise_lead enable row level security;
-- Политик нет: таблицу читают и меняют только команды ниже.

-- Оценка: бюджет и сроки весят больше всего — без денег и с «просто изучаю» разговор обычно пустой.
create function app_private.lead_score(p_budget text, p_timing text, p_manage text, p_experience text, p_place text)
returns smallint language sql immutable as $$
  select (case p_budget when 'full' then 4 when 'partial' then 2 else 0 end
        + case p_timing when 'month' then 3 when 'quarter' then 2 when 'half' then 1 else 0 end
        + case p_manage when 'self' then 2 when 'manager' then 1 else 0 end
        + case p_experience when 'business' then 1 when 'some' then 1 else 0 end
        + case p_place when 'has' then 2 when 'options' then 1 else 0 end)::smallint
$$;

create function app_private.lead_tier(p_score smallint, p_budget text) returns text
language sql immutable as $$
  select case when p_budget = 'none' then 'cold' when p_score >= 9 then 'hot' when p_score >= 5 then 'warm' else 'cold' end
$$;

------------------------------------------------------------------------------
-- Анкета с сайта (без входа)
------------------------------------------------------------------------------
create function public.lead_submit(p_lead jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, app_private, pg_temp as $$
declare
  v_name text := left(trim(coalesce(p_lead->>'name', '')), 80);
  v_phone text := left(trim(coalesce(p_lead->>'phone', '')), 30);
  v_digits text := regexp_replace(coalesce(p_lead->>'phone', ''), '\D', '', 'g');
  v_city text := left(trim(coalesce(p_lead->>'city', '')), 80);
  v_budget text := p_lead->>'budget';
  v_timing text := p_lead->>'timing';
  v_manage text := p_lead->>'manage';
  v_experience text := p_lead->>'experience';
  v_place text := p_lead->>'place';
  v_score smallint;
begin
  -- Ловушка для ботов: скрытое поле, которое человек не видит и не заполняет
  if coalesce(p_lead->>'website', '') <> '' then return jsonb_build_object('ok', true); end if;
  if length(v_name) < 1 or length(v_city) < 2 or length(v_digits) not between 10 and 15 then
    perform app_private.fail('validation', 'Проверьте имя, город и телефон');
  end if;
  if coalesce(v_budget, '') not in ('full', 'partial', 'none') or coalesce(v_timing, '') not in ('month', 'quarter', 'half', 'research')
     or coalesce(v_manage, '') not in ('self', 'manager', 'undecided') or coalesce(v_experience, '') not in ('business', 'some', 'none')
     or coalesce(v_place, '') not in ('has', 'options', 'help')
     or coalesce(p_lead->>'contact_via', '') not in ('whatsapp', 'telegram', 'call') then
    perform app_private.fail('validation', 'Ответьте на все вопросы анкеты');
  end if;
  -- Повторная отправка того же телефона за 10 минут — не дублируем
  if exists (select 1 from public.franchise_lead where phone_digits = v_digits and created_at > now() - interval '10 minutes') then
    return jsonb_build_object('ok', true);
  end if;
  -- Защита от заливки мусором: не больше 200 заявок в сутки
  if (select count(*) from public.franchise_lead where created_at > now() - interval '1 day') >= 200 then
    perform app_private.fail('rate-limited', 'Слишком много заявок. Напишите нам в WhatsApp');
  end if;
  v_score := app_private.lead_score(v_budget, v_timing, v_manage, v_experience, v_place);
  insert into public.franchise_lead(name, phone, phone_digits, contact_via, city, budget, timing, manage, experience, place,
    comment, source, score, tier)
  values (v_name, v_phone, v_digits, p_lead->>'contact_via', v_city, v_budget, v_timing, v_manage, v_experience, v_place,
    nullif(left(trim(coalesce(p_lead->>'comment', '')), 1000), ''), nullif(left(coalesce(p_lead->>'source', ''), 300), ''),
    v_score, app_private.lead_tier(v_score, v_budget));
  return jsonb_build_object('ok', true);
end $$;

------------------------------------------------------------------------------
-- CRM менеджера
------------------------------------------------------------------------------
create function public.lead_list() returns jsonb
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  return coalesce((select jsonb_agg(to_jsonb(l) - 'phone_digits' - 'updated_by'
      || jsonb_build_object('updated_by_name', (select u.full_name from public.app_user u where u.id = l.updated_by))
    order by l.created_at desc)
    from public.franchise_lead l), '[]'::jsonb);
end $$;

create function public.lead_update(p_id uuid, p_status text, p_note text) returns void
language plpgsql volatile security definer set search_path = public, app_private, pg_temp as $$
declare v_old public.franchise_lead;
begin
  perform app_private.require_user();
  perform app_private.require_perm('org.manage');
  if coalesce(p_status, '') not in ('new', 'in_work', 'call_back', 'meeting', 'won', 'lost') then
    perform app_private.fail('validation', 'Неизвестный статус');
  end if;
  select * into v_old from public.franchise_lead where id = p_id for update;
  if not found then perform app_private.fail('not-found', 'Заявка не найдена'); end if;
  update public.franchise_lead
    set status = p_status, note = nullif(left(trim(coalesce(p_note, '')), 2000), ''), updated_by = auth.uid(), updated_at = now()
    where id = p_id;
  perform app_private.audit('lead.update', 'franchise_lead', p_id, null,
    jsonb_build_object('status', jsonb_build_array(v_old.status, p_status)));
end $$;

-- Счётчик новых заявок для меню
create function public.lead_inbox() returns int
language plpgsql stable security definer set search_path = public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  if not app_private.has_perm('org.manage') then return 0; end if;
  return (select count(*)::int from public.franchise_lead where status = 'new');
end $$;

-- lead_submit вызывает сайт, а не кабинет, поэтому он только в anon_command (права выдаются и anon, и authenticated)
insert into app_private.anon_command(fn) values ('public.lead_submit(jsonb)');
insert into app_private.client_command(fn) values
  ('public.lead_list()'), ('public.lead_update(uuid, text, text)'), ('public.lead_inbox()');
select app_private.apply_grants();
