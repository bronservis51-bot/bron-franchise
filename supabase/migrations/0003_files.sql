-- 0003 Files: метаданные файлов, связи с объектами, политики закрытого bucket (SEC-05, COST-09).
-- Поток загрузки: file_prepare (сервер проверяет область, тип, размер; выдаёт путь) → загрузка в Storage
-- (политика пускает только по подготовленному пути автора) → file_confirm.

create table public.file_asset (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'private-files',
  path text not null unique,
  name text not null,
  mime text not null,
  size_bytes bigint not null check (size_bytes > 0),
  checksum text,
  visibility text not null check (visibility in ('scope', 'staff', 'all')),
  partner_id uuid references public.partner(id),
  location_id uuid references public.location(id),
  status text not null default 'pending' check (status in ('pending', 'ready', 'quarantined', 'deleted')),
  uploaded_by uuid not null references public.app_user(id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table public.attachment_link (
  file_id uuid not null references public.file_asset(id),
  entity_type text not null,
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (file_id, entity_type, entity_id)
);
create index on public.attachment_link (entity_type, entity_id);

create table public.file_type_policy (
  mime text primary key,
  max_bytes bigint not null,
  label text not null
);
insert into public.file_type_policy(mime, max_bytes, label) values
  ('image/jpeg', 20971520, 'Фото JPEG'),
  ('image/png', 20971520, 'Изображение PNG'),
  ('image/webp', 20971520, 'Изображение WebP'),
  ('image/heic', 20971520, 'Фото HEIC'),
  ('application/pdf', 20971520, 'PDF'),
  ('video/mp4', 52428800, 'Видео MP4'),
  ('text/csv', 5242880, 'CSV'),
  ('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 20971520, 'Документ DOCX'),
  ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 20971520, 'Таблица XLSX');

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
select 'private-files', 'private-files', false, 52428800, array_agg(mime) from public.file_type_policy
on conflict (id) do nothing;

create function app_private.can_read_file(f public.file_asset) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select f.status = 'ready' and case f.visibility
    when 'all' then app_private.has_perm_anywhere('kb.read')
    when 'staff' then app_private.is_staff() and app_private.in_scope(f.partner_id, f.location_id)
    else app_private.in_scope(f.partner_id, f.location_id) end
$$;

create function app_private.can_read_storage_object(p_name text) returns boolean
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select exists (select 1 from public.file_asset f where f.path = p_name and app_private.can_read_file(f))
$$;

create function app_private.can_upload_storage_object(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.file_asset f
                 where f.path = p_name and f.status = 'pending' and f.uploaded_by = auth.uid()
                   and f.created_at > now() - interval '1 hour')
$$;

-- Подготовка загрузки. Разрешение на прикрепление проверяет модуль-владелец сущности через p_perm.
create function app_private.file_prepare(p_perm text, p_partner uuid, p_location uuid, p_visibility text,
  p_name text, p_mime text, p_size bigint, p_checksum text, p_entity_type text, p_entity_id uuid) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); v_policy public.file_type_policy; v_id uuid := gen_random_uuid(); v_path text; v_safe text;
begin
  perform app_private.require_perm(p_perm, p_partner, p_location);
  select * into v_policy from public.file_type_policy where mime = p_mime;
  if not found then perform app_private.fail('validation', 'Тип файла не разрешён', 'mime'); end if;
  if p_size is null or p_size <= 0 or p_size > v_policy.max_bytes then
    perform app_private.fail('validation', 'Файл больше допустимого размера', 'size');
  end if;
  v_safe := regexp_replace(coalesce(nullif(trim(p_name), ''), 'file'), '[^A-Za-z0-9._-]+', '_', 'g');
  v_safe := left(v_safe, 80);
  v_path := coalesce(p_partner::text, 'company') || '/' || v_id || '/' || v_safe;
  insert into public.file_asset(id, path, name, mime, size_bytes, checksum, visibility, partner_id, location_id, uploaded_by)
  values (v_id, v_path, left(p_name, 200), p_mime, p_size, p_checksum, p_visibility, p_partner, p_location, v_user);
  if p_entity_type is not null then
    insert into public.attachment_link(file_id, entity_type, entity_id) values (v_id, p_entity_type, p_entity_id);
  end if;
  return jsonb_build_object('file_id', v_id, 'bucket', 'private-files', 'path', v_path);
end $$;

create function public.file_confirm(p_file uuid) returns jsonb
language plpgsql security definer set search_path = public, app_private, pg_temp as $$
declare v_user uuid := app_private.require_user(); f public.file_asset;
begin
  select * into f from public.file_asset where id = p_file for update;
  if not found or f.uploaded_by <> v_user then perform app_private.fail('not-found', 'Файл не найден'); end if;
  if f.status = 'ready' then return jsonb_build_object('file_id', f.id, 'status', 'ready'); end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = f.bucket and o.name = f.path) then
    perform app_private.fail('validation', 'Файл ещё не загружен в хранилище', 'upload');
  end if;
  update public.file_asset set status = 'ready', confirmed_at = now() where id = p_file;
  return jsonb_build_object('file_id', f.id, 'status', 'ready');
end $$;

-- Файлы объекта, доступные пользователю.
create function public.files_for(p_entity_type text, p_entity_id uuid)
returns table (id uuid, name text, mime text, size_bytes bigint, path text, visibility text, created_at timestamptz, uploaded_by uuid)
language sql stable security definer set search_path = public, app_private, pg_temp as $$
  select f.id, f.name, f.mime, f.size_bytes, f.path, f.visibility, f.created_at, f.uploaded_by
  from public.attachment_link l join public.file_asset f on f.id = l.file_id
  where l.entity_type = p_entity_type and l.entity_id = p_entity_id and app_private.can_read_file(f)
  order by f.created_at
$$;

alter table public.file_asset enable row level security;
alter table public.attachment_link enable row level security;
alter table public.file_type_policy enable row level security;
create policy read_file on public.file_asset for select to authenticated using (app_private.can_read_file(file_asset));
create policy read_link on public.attachment_link for select to authenticated
  using (exists (select 1 from public.file_asset f where f.id = file_id and app_private.can_read_file(f)));
create policy read_all on public.file_type_policy for select to authenticated using (true);

create policy bron_private_read on storage.objects for select to authenticated
  using (bucket_id = 'private-files' and app_private.can_read_storage_object(name));
create policy bron_private_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'private-files' and app_private.can_upload_storage_object(name));
-- UPDATE/DELETE политик нет: изменение и удаление файлов клиентом запрещены.

insert into app_private.client_table(tbl) values ('public.file_asset'), ('public.attachment_link'), ('public.file_type_policy');
insert into app_private.client_command(fn) values ('public.file_confirm(uuid)'), ('public.files_for(text, uuid)');
insert into app_private.policy_helper(fn) values ('app_private.can_read_file(public.file_asset)'),
  ('app_private.can_read_storage_object(text)'), ('app_private.can_upload_storage_object(text)');
select app_private.apply_grants();
