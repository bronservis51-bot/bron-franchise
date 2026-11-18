-- Сводка обучения учитывает результаты только опубликованной редакции урока.
create or replace function public.learning_overview() returns jsonb
language plpgsql stable security definer set search_path=public,app_private,pg_temp as $$
declare
  context jsonb := app_private.learning_context();
  lesson_day date := (context->>'day')::date;
begin
  return jsonb_build_object(
    'day', context->>'day',
    'audience', context->>'audience',
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'article_id', l.article_id,
        'revision_id', l.revision_id,
        'title', l.title,
        'stage', l.stage,
        'questions', jsonb_array_length(l.questions),
        'due', p.due,
        'percent', p.last_percent,
        'completed', coalesce(p.streak > 0, false),
        'active', exists (
          select 1 from app_private.learning_attempt t
          where t.user_id = auth.uid() and t.article_id = l.article_id
            and t.revision_id = l.revision_id and t.completed_at is null
        )
      ) order by case when p.due <= lesson_day then 0 when p.user_id is null then 1 else 2 end,
                 l."position", l.article_id)
      from app_private.learning_available() l
      left join app_private.learning_progress p
        on p.user_id = auth.uid() and p.article_id = l.article_id and p.revision_id = l.revision_id
    ), '[]'::jsonb)
  );
end $$;
