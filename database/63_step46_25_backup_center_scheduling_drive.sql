-- ============================================================================
-- Tiny POS - Step 46.25: Backup Center scheduling + Google Drive destination
-- Run once after Step 46.24 / migration 63_step46_24_receipt_center_
-- invoice_settings_fix.sql.
-- Additive only. Does not delete or rewrite POS business records.
--
-- NOTE ON FILE NUMBERING: this file shares the "63_" prefix with
-- 63_step46_24_receipt_center_invoice_settings_fix.sql (see that file's
-- header for why). This one — patch 46.25 — is the later of the two and
-- must be applied second; it is safe to install by filename, as sorting
-- the two by name already applies them in the right order.
-- ============================================================================

begin;

create table if not exists public.backup_schedules (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  is_enabled boolean not null default false,
  frequency_days integer not null default 1
    check (frequency_days between 1 and 90),
  backup_time time without time zone not null default '23:00',
  timezone text not null default 'Asia/Phnom_Penh',
  destination text not null default 'google_drive'
    check (destination in ('google_drive')),
  google_drive_folder_id text,
  google_drive_folder_url text,
  last_backup_at timestamptz,
  next_backup_at timestamptz,
  last_status text
    check (last_status is null or last_status in ('running','completed','failed')),
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.backup_google_drive_connections (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  connected_by uuid references auth.users(id) on delete set null,
  account_email text,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  refresh_token_tag text not null,
  scope text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backup_schedules_due_idx
  on public.backup_schedules (is_enabled, next_backup_at)
  where is_enabled = true;

alter table public.backup_schedules enable row level security;
alter table public.backup_google_drive_connections enable row level security;

drop policy if exists backup_schedules_select_admins
  on public.backup_schedules;

create policy backup_schedules_select_admins
on public.backup_schedules
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin']::public.app_role[]
  ))
);

-- Sensitive Google refresh tokens are intentionally server-only.
revoke all on public.backup_google_drive_connections from anon, authenticated;
grant all on public.backup_google_drive_connections to service_role;

revoke all on public.backup_schedules from anon;
grant select on public.backup_schedules to authenticated;
grant all on public.backup_schedules to service_role;

commit;

-- ============================================================================
-- END STEP 46.25
-- ============================================================================
