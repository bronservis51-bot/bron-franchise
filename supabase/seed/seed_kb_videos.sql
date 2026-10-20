-- Видеообучение в базе знаний: публичные ролики (Rutube, YouTube) встраиваются ссылкой отдельной строкой.
-- Новые редакции не требуют повторного ознакомления: содержание дополнено, а не изменено.

create function pg_temp.add_revision(p_slug text, p_body_add text, p_note text) returns void language plpgsql as $$
declare a public.article; r public.article_revision; v_new uuid;
begin
  select * into a from public.article where slug = p_slug;
  if a.id is null then return; end if;
  select * into r from public.article_revision where id = a.published_revision_id;
  if r.body like '%' || split_part(trim(p_body_add), E'\n', 1) || '%' then return; end if;
  update public.article_revision set status = 'superseded' where id = r.id;
  insert into public.article_revision(article_id, rev_no, title, summary, body, status, author_id, published_by, published_at, change_note)
  values (a.id, r.rev_no + 1, r.title, r.summary, r.body || E'\n\n' || p_body_add, 'published', r.author_id, r.published_by, now(), p_note)
  returning id into v_new;
  update public.article set published_revision_id = v_new, updated_at = now() where id = a.id;
end $$;

select pg_temp.add_revision('standart-okleyki', $md$## Видео: как это выглядит

Короткая инструкция по наклейке гидрогелевой плёнки на экран (3 минуты):

https://rutube.ru/video/8b1d32f5ad17f459dd053965d4534850/

Ещё один вариант — с акцентом на то, как не оставить пузырей:

https://rutube.ru/video/f9a5871db2116d81ae237e4ba9bd0765/

https://www.youtube.com/watch?v=d7CjkwXd_6U

> Видео сторонних авторов — для наглядности. Если порядок действий в ролике отличается от стандарта выше, работайте по стандарту.$md$, 'Добавлены видеоинструкции');

select pg_temp.add_revision('plotter-lekala', $md$## Видео: настройка и обслуживание плоттера

Подключение и настройка режущего плоттера для гидрогелевой плёнки:

https://www.youtube.com/watch?v=GgHgzdPHU44

Частые проблемы: смещение реза, треск при резке, нож прорезает все слои — как настроить и обслужить:

https://www.youtube.com/watch?v=YghqhBCA9WU

> Модели плоттеров отличаются. Сверяйтесь с инструкцией к своему аппарату; если не получается — задайте вопрос в базе знаний.$md$, 'Добавлены видео по настройке плоттера');

-- Новая статья: оклейка корпуса (задней крышки)
do $$
declare v_art uuid; v_rev uuid; v_fm uuid := (select id from public.app_user where email = 'fm@demo.example.com');
begin
  if exists (select 1 from public.article where slug = 'okleyka-korpusa') then return; end if;
  insert into public.article(slug, section_id, type, tags, created_by)
  values ('okleyka-korpusa', (select id from public.kb_section where slug = 'okleyka'), 'instruction', '{видео}', v_fm) returning id into v_art;
  insert into public.article_revision(article_id, rev_no, title, summary, body, status, author_id, published_by, published_at, change_note)
  values (v_art, 1, 'Оклейка корпуса (задней крышки) смартфона', 'Подготовка, вырезы камер, прогрев краёв — с видео',
$md$## Когда предлагать

Клиенту, который носит телефон без чехла или хочет сменить цвет корпуса. Хорошо продаётся в паре с плёнкой на экран.

## Порядок

1. Снимите чехол, обезжирьте корпус и особенно блок камер.
2. Выберите лекало задней крышки точно по модели — вырезы камер должны совпасть до миллиметра.
3. Начинайте с блока камер: совместите вырезы, затем разглаживайте от камер к краям.
4. Изогнутые края прогрейте феном (40–50 °C) и прикатайте ракелем.
5. Через 2–3 минуты проверьте края ещё раз: если поднимаются — прогрейте и прикатайте снова.

## Видео

https://rutube.ru/video/e9f449a206b12e8437e4cb45ca3e0289/

> Видео стороннего автора — для наглядности.$md$, 'published', v_fm, v_fm, now(), 'Первая публикация')
  returning id into v_rev;
  update public.article set status = 'published', published_revision_id = v_rev where id = v_art;
end $$;
