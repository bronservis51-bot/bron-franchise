-- Hosted scheduler. Installing the function does not start a job or enable orders.
-- Only the database owner can install/rotate the narrowly scoped worker credential.
create or replace function app_private.shop_scheduler_install(p_worker_url text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, app_private, extensions, pg_temp as $$
declare v_key text; v_job bigint; v_command text;
begin
  if p_worker_url is null or p_worker_url !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/shop-worker$' then
    raise exception 'Expected an HTTPS shop-worker URL with a 20-character Supabase project reference';
  end if;
  if not exists(select 1 from pg_extension where extname='supabase_vault')
     or not exists(select 1 from pg_extension where extname='pg_cron')
     or not exists(select 1 from pg_available_extensions where name='pg_net') then
    raise exception 'Hosted scheduler requires Vault, pg_cron and pg_net';
  end if;
  execute 'create extension if not exists pg_net';
  execute 'select decrypted_secret from vault.decrypted_secrets where name=$1'
    into v_key using 'bron_shop_worker_key';
  if v_key is null then
    v_key := encode(extensions.gen_random_bytes(32),'hex');
    perform vault.create_secret(v_key,'bron_shop_worker_key','Narrow credential: invoke shop-worker only');
  end if;
  insert into app_private.procurement_worker_auth(singleton,key_hash,updated_at)
    values(true,extensions.digest(v_key,'sha256'),now())
    on conflict(singleton) do update set key_hash=excluded.key_hash,updated_at=excluded.updated_at;
  v_command := format($job$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type','application/json','x-shop-worker-key',
        (select decrypted_secret from vault.decrypted_secrets where name='bron_shop_worker_key')),
      body := '{"action":"run"}'::jsonb,
      timeout_milliseconds := 50000
    );
  $job$,p_worker_url);
  select cron.schedule('bron-shop-worker','* * * * *',v_command) into v_job;
  return jsonb_build_object('installed',true,'job_id',v_job,'schedule','* * * * *');
end $$;
revoke all on function app_private.shop_scheduler_install(text) from public,anon,authenticated,service_role;
comment on function app_private.shop_scheduler_install(text) is
  'DB owner only. Reuses a Vault credential, schedules the isolated worker; does not enable checkout.';
