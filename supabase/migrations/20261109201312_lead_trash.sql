-- Recoverable CRM deletion; landing submissions and original rows are preserved.
alter table public.franchise_lead add column deleted_at timestamptz, add column deleted_by uuid references public.app_user(id);

create function public.lead_trash_list() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 return coalesce((select jsonb_agg(app_private.lead_json(id) order by deleted_at desc) from public.franchise_lead where deleted_at is not null),'[]');
end $$;

create or replace function public.lead_list() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 return coalesce((select jsonb_agg(app_private.lead_json(id) order by created_at desc) from public.franchise_lead where deleted_at is null),'[]');
end $$;

create or replace function public.lead_inbox() returns int
language plpgsql stable security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
 perform app_private.require_user();
 if not app_private.has_perm('org.manage') then return 0; end if;
 return (select count(*)::int from public.franchise_lead where status='new' and deleted_at is null);
end $$;

-- Also protects old open clients which still call lead_update/save/move.
create function app_private.guard_deleted_lead() returns trigger
language plpgsql set search_path=pg_catalog,public,app_private,pg_temp as $$
begin
 if old.deleted_at is not null and new.deleted_at is not null then
  perform app_private.fail('transition-not-allowed','Заявка удалена. Сначала восстановите её из корзины');
 end if;
 return new;
end $$;
create trigger guard_deleted_lead before update on public.franchise_lead for each row execute function app_private.guard_deleted_lead();

create function public.lead_set_deleted(p_id uuid,p_deleted boolean,p_expected_updated_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,public,app_private,pg_temp as $$
declare l public.franchise_lead;
begin
 perform app_private.require_user(); perform app_private.require_perm('org.manage');
 if p_deleted is null then perform app_private.fail('validation','Укажите действие с заявкой'); end if;
 select * into l from public.franchise_lead where id=p_id for update;
 if not found then perform app_private.fail('not-found','Заявка не найдена'); end if;
 -- Repeating a lost response is safe. A stale request cannot undo a later opposite action.
 if (l.deleted_at is not null)=p_deleted then return app_private.lead_json(p_id); end if;
 if p_expected_updated_at is null or l.updated_at is distinct from p_expected_updated_at then
  perform app_private.fail('version-conflict','Заявка уже изменилась. Обновите список и проверьте её заново');
 end if;
 update public.franchise_lead set deleted_at=case when p_deleted then clock_timestamp() else null end,
  deleted_by=case when p_deleted then auth.uid() else null end,updated_by=auth.uid(),updated_at=clock_timestamp() where id=p_id;
 perform app_private.audit(case when p_deleted then 'lead.delete' else 'lead.restore' end,'franchise_lead',p_id,null,jsonb_build_object('previous_updated_at',l.updated_at));
 return app_private.lead_json(p_id);
end $$;
insert into app_private.client_command(fn) values ('public.lead_trash_list()'),('public.lead_set_deleted(uuid,boolean,timestamptz)');
select app_private.apply_grants();
