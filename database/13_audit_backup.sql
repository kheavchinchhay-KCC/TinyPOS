-- ============================================================================
-- Tiny POS - Step 15: Audit trail and backup log
-- Run once in the NEW Supabase project.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

create table if not exists public.data_backup_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  branch_id uuid
    references public.branches(id) on delete set null,
  requested_by uuid
    references auth.users(id) on delete set null,
  action text not null
    check (action in ('export', 'validate', 'restore')),
  status text not null default 'completed'
    check (status in ('completed', 'failed')),
  filename text,
  backup_version integer,
  source_organization_name text,
  row_counts jsonb not null default '{}'::jsonb,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists data_backup_logs_org_created_idx
  on public.data_backup_logs (organization_id, created_at desc);

alter table public.data_backup_logs enable row level security;

drop policy if exists data_backup_logs_select_admins
  on public.data_backup_logs;

create policy data_backup_logs_select_admins
on public.data_backup_logs
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin']::public.app_role[]
  ))
);

revoke all on public.data_backup_logs from anon;
grant select on public.data_backup_logs to authenticated;
grant all on public.data_backup_logs to service_role;

commit;

-- ============================================================================
-- END STEP 15
-- ============================================================================
