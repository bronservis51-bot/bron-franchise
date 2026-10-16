-- 0013 Напоминание закрывается событием, которое оно ждало (CORE-02: задача не висит после выполнения условия).
-- Найдено на демо-стенде 13.10.2026: напоминание «Сдать отчёт» оставалось открытым после отправки отчёта.

-- Workflows and Tasks: публичный контракт — системное завершение задачи по ключу дедупликации.
create function app_private.task_complete_by_key(p_dedupe text, p_result text) returns void
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare t public.task;
begin
  select * into t from public.task where dedupe_key = p_dedupe and status not in ('done', 'cancelled') for update;
  if not found then return; end if;
  update public.task set status = 'done', result = p_result, completed_by = auth.uid(), completed_at = now(),
    updated_at = now(), revision = revision + 1 where id = t.id returning * into t;
  perform app_private.task_log(t.id, 'completed', t.status, 'done', p_result);
  perform app_private.task_after_change(t);
end $$;

-- Royalties: отчёт отправлен → напоминание о сдаче за этот период выполнено.
create function app_private.report_submitted_close_reminder() returns trigger
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
begin
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    perform app_private.task_complete_by_key('report_due:' || new.contract_id || ':' || new.period,
      'Отчёт ' || new.number || ' отправлен');
  end if;
  return new;
end $$;

create trigger report_submitted_close_reminder after update of status on public.revenue_report
  for each row execute function app_private.report_submitted_close_reminder();

-- Закрыть уже открытые напоминания по отчётам, которые сданы
select app_private.task_complete_by_key(t.dedupe_key, 'Отчёт ' || r.number || ' уже отправлен')
from public.task t
join public.revenue_report r on t.dedupe_key = 'report_due:' || r.contract_id || ':' || r.period
where t.kind = 'report_due' and t.status not in ('done', 'cancelled') and r.status <> 'draft';
