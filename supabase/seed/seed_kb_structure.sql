-- Демо: структура базы знаний с подразделами и значками, просмотры и оценки статей.

update public.kb_section set icon = 'rocket', sort = 10, title = 'Начало работы', description = 'Кабинет, выручка за день, первые шаги' where slug = 'nachalo';
update public.kb_section set icon = 'smartphone', sort = 20, title = 'Оклейка', description = 'Экран, корпус, материалы и качество' where slug = 'okleyka';
update public.kb_section set icon = 'wrench', sort = 30, title = 'Оборудование и лекала', description = 'Плоттер, нож, калибровка, библиотека лекал' where slug = 'oborudovanie';
update public.kb_section set icon = 'users', sort = 40, title = 'Клиенты и продажи', description = 'Как предлагать, отвечать на вопросы, допродавать' where slug = 'prodazhi';
update public.kb_section set icon = 'shield', sort = 50, title = 'Гарантии и жалобы', description = 'Что делать, если клиент недоволен' where slug = 'garantii';

-- Подразделы «Оклейки»
insert into public.kb_section(slug, title, description, sort, parent_id, icon)
select v.slug, v.title, v.descr, v.sort, (select id from public.kb_section where slug = 'okleyka'), 'smartphone'
from (values ('okleyka-ekran', 'Экран', 'Плёнка на экран смартфона и планшета', 10),
             ('okleyka-korpus', 'Корпус', 'Задняя крышка, блок камер, края', 20),
             ('okleyka-materialy', 'Плёнки и материалы', 'Какие бывают плёнки и когда какую предлагать', 30)) v(slug, title, descr, sort)
on conflict (slug) do nothing;
update public.article set section_id = (select id from public.kb_section where slug = 'okleyka-ekran') where slug = 'standart-okleyki';
update public.article set section_id = (select id from public.kb_section where slug = 'okleyka-korpus') where slug = 'okleyka-korpusa';
update public.article set section_id = (select id from public.kb_section where slug = 'okleyka-materialy') where slug = 'novinki-plenok';

-- Просмотры за последние недели и пара оценок — чтобы «Популярное» и статистика не были пустыми
insert into public.kb_view(article_id, user_id, day)
select a.id, u.id, current_date - (abs(hashtext(a.slug || u.email)) % 20)
from public.article a cross join public.app_user u
where a.status = 'published' and u.email in ('alpha.owner@demo.example.com', 'beta.owner@demo.example.com', 'gamma.owner@demo.example.com', '79000000011@staff.bron.local')
  and (abs(hashtext(a.slug || u.email)) % 3) <> 0
on conflict do nothing;

insert into public.kb_rating(article_id, user_id, helpful, comment)
select a.id, u.id, v.helpful, v.comment
from (values ('standart-okleyki', 'alpha.owner@demo.example.com', true, null),
             ('standart-okleyki', 'beta.owner@demo.example.com', true, null),
             ('plotter-lekala', 'beta.owner@demo.example.com', false, 'Нет инструкции для моего плоттера, только общие советы')) v(slug, email, helpful, comment)
join public.article a on a.slug = v.slug join public.app_user u on u.email = v.email
on conflict do nothing;
