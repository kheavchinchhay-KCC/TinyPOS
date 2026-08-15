-- Tiny POS Patch 46.35
-- Cash-register override permission + strict owner/explicit-override enforcement.
-- Additive migration. Do not rerun older migrations.

begin;

insert into public.permission_definitions(
  permission_key,
  module_key,
  label,
  description,
  risk_level,
  default_roles,
  approval_action,
  sort_order
)
values (
  'cash_register.override',
  'Cash Register',
  'Override Cash Register Session',
  'Close or correct an open cash-register session opened by another user. Owner access remains implicit.',
  'critical',
  array[]::public.app_role[],
  false,
  114
)
on conflict (permission_key) do update set
  module_key = excluded.module_key,
  label = excluded.label,
  description = excluded.description,
  risk_level = excluded.risk_level,
  default_roles = excluded.default_roles,
  approval_action = excluded.approval_action,
  sort_order = excluded.sort_order,
  is_active = true;

create or replace function public.close_cash_register_v2(
  p_counted_cash_usd numeric,
  p_counted_cash_khr numeric,
  p_closing_note text default null,
  p_session_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_profile record;
  v_session public.cash_register_sessions%rowtype;
  v_summary jsonb;
  v_now timestamptz := now();
  v_eu numeric;
  v_ek numeric;
  v_cu numeric;
  v_ck numeric;
  v_override boolean := false;
begin
  perform private.require_permission('cash_register.close');

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user;

  if not found or not v_profile.is_active then
    raise exception 'Active POS profile required';
  end if;

  -- Owner is always allowed. Any non-owner cross-user close requires the
  -- explicit critical override permission; manager status alone is not enough.
  v_override :=
    v_profile.role = 'owner'
    or private.has_permission('cash_register.override', v_user);

  select *
  into v_session
  from public.cash_register_sessions
  where organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
    and status = 'open'
    and (id = coalesce(p_session_id, id))
    and (opened_by = v_user or v_override)
  order by opened_at desc
  limit 1
  for update;

  if not found then
    raise exception 'No permitted open register session was found';
  end if;

  v_summary := private.cash_register_summary(v_session.id, v_now);
  v_eu := coalesce((v_summary#>>'{totals,USD,expected}')::numeric, 0);
  v_ek := coalesce((v_summary#>>'{totals,KHR,expected}')::numeric, 0);
  v_cu := round(coalesce(p_counted_cash_usd, 0), 2);
  v_ck := round(coalesce(p_counted_cash_khr, 0), 2);

  update public.cash_register_sessions
  set status = 'closed',
      expected_cash_usd = v_eu,
      expected_cash_khr = v_ek,
      counted_cash_usd = v_cu,
      counted_cash_khr = v_ck,
      variance_usd = v_cu - v_eu,
      variance_khr = v_ck - v_ek,
      closing_note = nullif(trim(p_closing_note), ''),
      closed_by = v_user,
      closed_at = v_now,
      updated_at = v_now
  where id = v_session.id;

  return private.cash_register_summary(v_session.id, v_now);
end;
$$;

revoke all on function public.close_cash_register_v2(
  numeric,
  numeric,
  text,
  uuid
) from public;

grant execute on function public.close_cash_register_v2(
  numeric,
  numeric,
  text,
  uuid
) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
