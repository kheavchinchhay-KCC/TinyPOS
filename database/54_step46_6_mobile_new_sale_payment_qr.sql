-- ============================================================================
-- Tiny POS - Step 46.6: Mobile New Sale payment QR helper
-- Run ONCE after the existing Step 53 migration.
--
-- Purpose:
--   Allow a staff member who can create sales to read ONLY the current branch's
--   bank QR image/comment that was already configured in Online Store settings.
--   This does not expose the rest of Online Store administration settings.
-- ============================================================================

create or replace function public.get_pos_payment_qr()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, auth, extensions, pg_temp
as $$
declare
  v_org uuid;
  v_branch uuid;
  v_qr_url text;
  v_comment text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform private.require_permission('sales.create');

  v_org := private.current_organization_id();
  v_branch := private.current_branch_id();

  select
    s.bank_qr_url,
    s.bank_comment
  into
    v_qr_url,
    v_comment
  from public.online_store_settings s
  where s.organization_id = v_org
    and s.branch_id = v_branch
  limit 1;

  return jsonb_build_object(
    'bank_qr_url', coalesce(v_qr_url, ''),
    'bank_comment', coalesce(v_comment, '')
  );
end;
$$;

revoke all on function public.get_pos_payment_qr() from public, anon;
grant execute on function public.get_pos_payment_qr() to authenticated;
