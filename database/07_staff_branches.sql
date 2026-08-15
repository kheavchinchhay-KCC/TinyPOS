-- ============================================================================
-- Tiny POS - Step 9: Staff accounts, roles, branches, and login tracking
-- Run once in the NEW Supabase project.
-- This migration does not delete or reset existing business data.
-- ============================================================================

begin;

-- Faster staff and branch filtering.
create index if not exists profiles_org_branch_role_active_idx
  on public.profiles (organization_id, branch_id, role, is_active);

create index if not exists branches_org_active_name_idx
  on public.branches (organization_id, is_active, name);

-- Ensure every existing branch has a zero balance row for every tracked
-- product. The product/catalog screens already treat a missing row as zero,
-- but explicit rows make branch inventory reporting simpler and faster.
insert into public.inventory_balances (
  organization_id,
  branch_id,
  product_id,
  quantity,
  average_cost
)
select
  b.organization_id,
  b.id,
  p.id,
  0,
  p.default_cost
from public.branches b
join public.products p
  on p.organization_id = b.organization_id
on conflict (branch_id, product_id) do nothing;

-- A newly created branch starts with every existing product at zero stock.
create or replace function public.initialize_new_branch_inventory()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.inventory_balances (
    organization_id,
    branch_id,
    product_id,
    quantity,
    average_cost
  )
  select
    new.organization_id,
    new.id,
    p.id,
    0,
    p.default_cost
  from public.products p
  where p.organization_id = new.organization_id
  on conflict (branch_id, product_id) do nothing;

  return new;
end;
$$;

drop trigger if exists initialize_new_branch_inventory_after_insert
  on public.branches;

create trigger initialize_new_branch_inventory_after_insert
after insert on public.branches
for each row execute function public.initialize_new_branch_inventory();

revoke all on function public.initialize_new_branch_inventory()
  from public, anon, authenticated;

-- Record the authenticated staff member's most recent successful app login.
create or replace function public.record_pos_login()
returns timestamptz
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_login_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  update public.profiles
  set
    last_login_at = v_login_at,
    updated_at = now()
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'This POS account is inactive or missing';
  end if;

  return v_login_at;
end;
$$;

revoke all on function public.record_pos_login() from public, anon;
grant execute on function public.record_pos_login() to authenticated, service_role;

-- Staff should always be able to read their own profile so the application can
-- show a clear inactive-account message. Only management can list coworkers.
drop policy if exists profiles_select_own_org on public.profiles;
drop policy if exists profiles_select_authorized on public.profiles;

create policy profiles_select_authorized
on public.profiles
for select to authenticated
using (
  id = (select auth.uid())
  or (
    organization_id = (select private.current_organization_id())
    and (select private.has_any_role(
      array['owner','admin','manager']::public.app_role[]
    ))
  )
);

-- Read-only directory view. It obeys the RLS policies above because it is a
-- security-invoker view.
create or replace view public.staff_directory
with (security_invoker = true)
as
select
  p.id,
  p.organization_id,
  p.branch_id,
  p.email,
  p.full_name,
  p.role,
  p.phone,
  p.avatar_url,
  p.is_active,
  p.last_login_at,
  p.created_at,
  p.updated_at,
  b.name as branch_name,
  b.code as branch_code,
  b.is_active as branch_is_active
from public.profiles p
left join public.branches b
  on b.id = p.branch_id;

revoke all on public.staff_directory from anon;
grant select on public.staff_directory to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 9
-- ============================================================================
