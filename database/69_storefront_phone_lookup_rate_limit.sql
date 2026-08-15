-- ============================================================================
-- Tiny POS — Security hardening: rate-limit the public phone order lookup
-- Run once, any time after 51_step46_4_15_online_tracking_offline_checkout_recovery.sql.
--
-- find_public_orders_by_phone() is reachable by anyone who knows a storefront
-- slug, with no authentication. It previously had no throttle, so it could be
-- hammered with a range of trailing phone digits to enumerate a store's
-- recent order activity (masked order numbers, status, totals). This adds
-- the same source_ip_hash + time-window throttle already used for
-- submit_online_order() in 52_step46_4_16_login_storefront_checkout_recovery.sql:
-- count attempts from the same ip hash in the last 15 minutes, reject once
-- the limit is hit, and log the attempt — all inside one atomic call, so
-- there is no separate "logging" step a caller could skip.
-- ============================================================================

begin;

create table if not exists public.storefront_lookup_attempts(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  source_ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists storefront_lookup_attempts_throttle_idx
  on public.storefront_lookup_attempts(organization_id, branch_id, source_ip_hash, created_at desc);

alter table public.storefront_lookup_attempts enable row level security;
revoke all on public.storefront_lookup_attempts from anon, authenticated;
grant all on public.storefront_lookup_attempts to service_role;

-- Drop the old two-argument overload first: Postgres treats a different
-- argument list as a distinct function, so without this the old signature
-- would stay callable (with no throttle) alongside the new one.
revoke all on function public.find_public_orders_by_phone(text,text)
  from public,anon,authenticated;
drop function if exists public.find_public_orders_by_phone(text,text);

create or replace function public.find_public_orders_by_phone(
  p_slug text,
  p_phone text,
  p_source_ip_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,extensions,pg_temp
as $$
declare
  v_store public.online_store_settings%rowtype;
  v_digits text;
  v_match_digits integer;
begin
  select * into v_store
  from public.online_store_settings
  where slug=lower(trim(p_slug))
    and is_published=true;

  if not found then raise exception 'Storefront not found'; end if;

  v_digits:=regexp_replace(coalesce(p_phone,''),'[^0-9]','','g');
  if length(v_digits)<7 then
    raise exception 'Enter a valid phone number';
  end if;
  v_match_digits:=least(9,length(v_digits));

  if p_source_ip_hash is not null then
    if (
      select count(*)>=20
      from public.storefront_lookup_attempts a
      where a.organization_id=v_store.organization_id
        and a.branch_id=v_store.branch_id
        and a.source_ip_hash=p_source_ip_hash
        and a.created_at>now()-interval '15 minutes'
    ) then
      raise exception 'Too many recent lookup attempts. Please try again later';
    end if;

    insert into public.storefront_lookup_attempts(organization_id,branch_id,source_ip_hash)
    values (v_store.organization_id,v_store.branch_id,p_source_ip_hash);
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'masked_order_number',
        case
          when length(o.order_number)>7
            then left(o.order_number,4)||repeat('•',greatest(length(o.order_number)-9,3))||right(o.order_number,5)
          else o.order_number
        end,
      'status',o.status,
      'payment_status',o.payment_status,
      'currency',o.currency,
      'total_amount',o.total_amount,
      'created_at',o.created_at,
      'updated_at',o.updated_at
    ) order by o.created_at desc)
    from (
      select order_row.*
      from public.online_orders order_row
      where order_row.organization_id=v_store.organization_id
        and order_row.branch_id=v_store.branch_id
        and right(regexp_replace(coalesce(order_row.customer_phone,''),'[^0-9]','','g'),v_match_digits)
          =right(v_digits,v_match_digits)
      order by order_row.created_at desc
      limit 10
    ) o
  ),'[]'::jsonb);
end;
$$;

revoke all on function public.find_public_orders_by_phone(text,text,text)
  from public,anon,authenticated;
grant execute on function public.find_public_orders_by_phone(text,text,text)
  to service_role;

commit;
