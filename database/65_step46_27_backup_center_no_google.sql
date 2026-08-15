-- Tiny POS Step 46.27
-- Backup Center: remove external Google Drive requirement.
-- Automatic backups use a private Supabase Storage bucket owned by this project.
-- Additive/safe: existing backup data is not deleted.

begin;

create table if not exists public.backup_schedules (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  is_enabled boolean not null default false,
  frequency_days integer not null default 1 check (frequency_days between 1 and 90),
  backup_time time without time zone not null default '23:00',
  timezone text not null default 'Asia/Phnom_Penh',
  destination text not null default 'supabase_storage',
  last_backup_at timestamptz,
  next_backup_at timestamptz,
  last_status text check (last_status is null or last_status in ('running','completed','failed')),
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Migration 63 may already have created this constraint with Google-only values.
alter table public.backup_schedules drop constraint if exists backup_schedules_destination_check;
alter table public.backup_schedules add constraint backup_schedules_destination_check
  check (destination in ('supabase_storage', 'google_drive'));

update public.backup_schedules
set destination = 'supabase_storage'
where destination is null or destination = 'google_drive';

create table if not exists public.backup_storage_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  size_bytes bigint not null default 0,
  trigger text not null default 'manual' check (trigger in ('manual','scheduled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists backup_storage_files_org_created_idx
  on public.backup_storage_files (organization_id, created_at desc);

alter table public.backup_storage_files enable row level security;
revoke all on public.backup_storage_files from anon;
revoke all on public.backup_storage_files from authenticated;
grant all on public.backup_storage_files to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tiny-pos-backups', 'tiny-pos-backups', false, 125829120, array['application/zip'])
on conflict (id) do update set
  public = false,
  file_size_limit = 125829120,
  allowed_mime_types = array['application/zip'];

alter table public.backup_schedules enable row level security;
revoke all on public.backup_schedules from anon;
grant select on public.backup_schedules to authenticated;
grant all on public.backup_schedules to service_role;

drop policy if exists backup_schedules_select_admins on public.backup_schedules;
create policy backup_schedules_select_admins
on public.backup_schedules
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin']::public.app_role[]))
);

commit;

-- No Google Cloud project, Google OAuth credentials, or billing account is required.
