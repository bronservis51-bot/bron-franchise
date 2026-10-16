-- Демо-данные, которым нужны пользователи. Выполнять после scripts/seed-users.mjs.

-- Статьи написал и опубликовал менеджер
update public.article set created_by = (select id from public.app_user where email = 'fm@demo.example.com') where created_by is null;
update public.article_revision set author_id = (select id from public.app_user where email = 'fm@demo.example.com'),
  published_by = case when status = 'published' then (select id from public.app_user where email = 'fm@demo.example.com') end
where author_id is null;

-- Кто вносил выручку и ставил планы
update public.daily_revenue r set entered_by = a.user_id
from public.role_assignment a where a.scope_id = r.partner_id and a.role = 'franchisee' and r.entered_by is null;
update public.revenue_plan set set_by = (select id from public.app_user where email = 'fm@demo.example.com') where set_by is null;
update public.royalty_payment set created_by = (select id from public.app_user where email = 'fm@demo.example.com') where created_by is null;
update public.royalty_manual set created_by = (select id from public.app_user where email = 'fm@demo.example.com') where created_by is null;

-- Виктор уже ознакомился со стандартом оклейки; остальные обязательные статьи ждут подтверждения
insert into public.acknowledgement(article_id, user_id, rev_no)
select a.id, u.id, 1 from public.article a, public.app_user u
where a.slug = 'standart-okleyki' and u.email = 'alpha.owner@demo.example.com'
on conflict do nothing;
