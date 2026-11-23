-- Show the result recorded for this attempt, even after the lesson is edited.
create or replace function public.learning_report(p_partner uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public, app_private, pg_temp as $$
begin
  perform app_private.require_user();
  perform app_private.require_perm('staff.manage', p_partner);
  return coalesce((
    select jsonb_agg(item order by item->>'day' desc, item->>'user_name')
    from (
      select jsonb_build_object(
        'user_id', t.user_id, 'user_name', u.full_name, 'day', x.day, 'article_id', t.article_id,
        'article_title', t.title, 'read_at', x.read_at, 'completed_at', x.completed_at,
        'score', case when x.completed_at is not null then t.score end, 'total', jsonb_array_length(t.questions),
        'percent', case when x.completed_at is not null then t.result->'percent' end,
        'passed', case when x.completed_at is not null then t.result->'passed' end,
        'pass_percent', t.pass_percent,
        'next_due', case when x.completed_at is not null then t.result->'next_due' end
      ) as item
      from app_private.learning_attempt t
      join app_private.learning_activity x on x.attempt_id = t.id
      join public.app_user u on u.id = t.user_id
      where t.partner_id = p_partner and (app_private.staff_owner(p_partner) or app_private.staff_member_scope(t.user_id))
        and x.day >= date_trunc('month', p_month)::date and x.day < date_trunc('month', p_month) + interval '1 month'
      union all
      -- Original daily tasks recorded scores only.
      select jsonb_build_object(
        'user_id', t.user_id, 'user_name', u.full_name, 'day', t.day, 'article_id', t.article_id,
        'article_title', t.title, 'read_at', t.read_at, 'completed_at', t.completed_at,
        'score', t.score, 'total', jsonb_array_length(t.questions), 'passed', null, 'pass_percent', null
      )
      from app_private.learning_task t join public.app_user u on u.id = t.user_id
      where t.partner_id = p_partner and (app_private.staff_owner(p_partner) or app_private.staff_member_scope(t.user_id))
        and t.day >= date_trunc('month', p_month)::date and t.day < date_trunc('month', p_month) + interval '1 month'
    ) as activity
  ), '[]'::jsonb);
end $$;
