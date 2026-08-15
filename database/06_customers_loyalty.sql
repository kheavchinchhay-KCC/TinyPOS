-- ============================================================================
-- Tiny POS - Step 8: Customers and loyalty
-- Run once in the NEW Supabase project.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. CUSTOMER PROFILE FIELDS
-- ----------------------------------------------------------------------------

alter table public.customers
  add column if not exists customer_code text,
  add column if not exists customer_type text not null default 'regular'
    check (customer_type in ('regular', 'vip', 'wholesale')),
  add column if not exists company_name text,
  add column if not exists date_of_birth date;

-- Backfill stable customer codes for customers created before this migration.
with ranked as (
  select
    c.id,
    c.organization_id,
    row_number() over (
      partition by c.organization_id
      order by c.created_at, c.id
    ) as sequence_number
  from public.customers c
  where c.customer_code is null
)
update public.customers c
set customer_code = 'C' || lpad(r.sequence_number::text, 6, '0')
from ranked r
where c.id = r.id;

alter table public.customers
  alter column customer_code set not null;

create unique index if not exists customers_org_code_uq
  on public.customers (organization_id, customer_code);

create index if not exists customers_org_type_active_idx
  on public.customers (organization_id, customer_type, is_active);

create index if not exists customers_org_name_idx
  on public.customers (organization_id, lower(name));

-- ----------------------------------------------------------------------------
-- 2. ORGANIZATION CUSTOMER NUMBER COUNTERS
-- ----------------------------------------------------------------------------

create table if not exists public.customer_counters (
  organization_id uuid primary key
    references public.organizations(id) on delete cascade,
  last_number integer not null default 0 check (last_number >= 0),
  updated_at timestamptz not null default now()
);

insert into public.customer_counters (organization_id, last_number)
select
  c.organization_id,
  coalesce(
    max(
      case
        when c.customer_code ~ '^C[0-9]+$'
          then substring(c.customer_code from 2)::integer
        else 0
      end
    ),
    0
  )
from public.customers c
group by c.organization_id
on conflict (organization_id)
do update set
  last_number = greatest(
    public.customer_counters.last_number,
    excluded.last_number
  ),
  updated_at = now();

create or replace function private.next_customer_code(
  p_organization_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number integer;
begin
  insert into public.customer_counters (
    organization_id,
    last_number,
    updated_at
  )
  values (
    p_organization_id,
    1,
    now()
  )
  on conflict (organization_id)
  do update set
    last_number = public.customer_counters.last_number + 1,
    updated_at = now()
  returning last_number into v_number;

  return 'C' || lpad(v_number::text, 6, '0');
end;
$$;

revoke all on function private.next_customer_code(uuid) from public;
grant execute on function private.next_customer_code(uuid)
  to authenticated, service_role;

create or replace function public.set_customer_code()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.organization_id is null then
    raise exception 'Customer organization is required';
  end if;

  if new.customer_code is null or length(trim(new.customer_code)) = 0 then
    new.customer_code := private.next_customer_code(new.organization_id);
  else
    new.customer_code := upper(trim(new.customer_code));

    if new.customer_code !~ '^[A-Z0-9_-]{2,30}$' then
      raise exception 'Customer code may use only A-Z, 0-9, underscore, and dash';
    end if;

    if new.customer_code ~ '^C[0-9]+$' then
      insert into public.customer_counters (
        organization_id,
        last_number,
        updated_at
      )
      values (
        new.organization_id,
        substring(new.customer_code from 2)::integer,
        now()
      )
      on conflict (organization_id)
      do update set
        last_number = greatest(
          public.customer_counters.last_number,
          excluded.last_number
        ),
        updated_at = now();
    end if;
  end if;

  new.name := trim(new.name);
  new.phone := nullif(trim(new.phone), '');
  new.email := nullif(lower(trim(new.email)), '');
  new.company_name := nullif(trim(new.company_name), '');

  return new;
end;
$$;

drop trigger if exists set_customer_code_before_insert
  on public.customers;

create trigger set_customer_code_before_insert
before insert or update on public.customers
for each row execute function public.set_customer_code();

-- ----------------------------------------------------------------------------
-- 3. LOYALTY MOVEMENT LEDGER
-- ----------------------------------------------------------------------------

create table if not exists public.customer_loyalty_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  customer_id uuid not null
    references public.customers(id) on delete cascade,
  points_change numeric(14,2) not null check (points_change <> 0),
  points_before numeric(14,2) not null check (points_before >= 0),
  points_after numeric(14,2) not null check (points_after >= 0),
  reason text not null check (length(trim(reason)) >= 3),
  reference_table text,
  reference_id uuid,
  created_by uuid not null
    references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (points_after = points_before + points_change)
);

create index if not exists customer_loyalty_customer_created_idx
  on public.customer_loyalty_movements (customer_id, created_at desc);

alter table public.customer_counters enable row level security;
alter table public.customer_loyalty_movements enable row level security;

-- Counter rows are intentionally unavailable to browsers. Only the secure
-- customer-code function uses them.

drop policy if exists customer_loyalty_select_management
  on public.customer_loyalty_movements;

create policy customer_loyalty_select_management
on public.customer_loyalty_movements
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin','manager']::public.app_role[]
  ))
);

revoke all on public.customer_counters from anon, authenticated;
grant all on public.customer_counters to service_role;

grant select on public.customer_loyalty_movements to authenticated;
grant all on public.customer_loyalty_movements to service_role;

-- Prevent browser clients from directly changing loyalty balances. Customer
-- profile fields remain editable under the existing customer RLS policies.
revoke insert, update on public.customers from authenticated;

grant insert (
  organization_id,
  customer_code,
  customer_type,
  name,
  company_name,
  phone,
  email,
  address,
  date_of_birth,
  credit_limit,
  notes,
  is_active,
  created_by
) on public.customers to authenticated;

grant update (
  customer_code,
  customer_type,
  name,
  company_name,
  phone,
  email,
  address,
  date_of_birth,
  credit_limit,
  notes,
  is_active
) on public.customers to authenticated;

-- ----------------------------------------------------------------------------
-- 4. SECURE LOYALTY ADJUSTMENT
-- ----------------------------------------------------------------------------

create or replace function public.adjust_customer_loyalty(
  p_customer_id uuid,
  p_points_change numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid;
  v_profile record;
  v_customer record;
  v_before numeric(14,2);
  v_after numeric(14,2);
  v_movement_id uuid;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    p.organization_id,
    p.role,
    p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS user account is inactive or missing';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Only an owner, admin, or manager can adjust loyalty points';
  end if;

  if p_points_change is null or p_points_change = 0 then
    raise exception 'Points change must not be zero';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A reason is required';
  end if;

  select c.*
  into v_customer
  from public.customers c
  where c.id = p_customer_id
    and c.organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Customer not found';
  end if;

  v_before := coalesce(v_customer.loyalty_points, 0);
  v_after := round(v_before + p_points_change, 2);

  if v_after < 0 then
    raise exception 'Loyalty points cannot become negative';
  end if;

  update public.customers
  set
    loyalty_points = v_after,
    updated_at = now()
  where id = v_customer.id;

  insert into public.customer_loyalty_movements (
    organization_id,
    customer_id,
    points_change,
    points_before,
    points_after,
    reason,
    created_by
  )
  values (
    v_profile.organization_id,
    v_customer.id,
    round(p_points_change, 2),
    v_before,
    v_after,
    trim(p_reason),
    v_user_id
  )
  returning id into v_movement_id;

  insert into public.audit_logs (
    organization_id,
    user_id,
    action,
    entity_type,
    entity_id,
    old_data,
    new_data
  )
  values (
    v_profile.organization_id,
    v_user_id,
    'adjust_customer_loyalty',
    'customer',
    v_customer.id,
    jsonb_build_object('loyalty_points', v_before),
    jsonb_build_object(
      'loyalty_points', v_after,
      'points_change', round(p_points_change, 2),
      'reason', trim(p_reason),
      'movement_id', v_movement_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'customer_id', v_customer.id,
    'customer_code', v_customer.customer_code,
    'points_before', v_before,
    'points_change', round(p_points_change, 2),
    'points_after', v_after,
    'movement_id', v_movement_id
  );
end;
$$;

revoke all on function public.adjust_customer_loyalty(
  uuid,
  numeric,
  text
) from public, anon;

grant execute on function public.adjust_customer_loyalty(
  uuid,
  numeric,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. CUSTOMER DIRECTORY VIEW
-- Sales totals include completed, partially refunded, and refunded invoices.
-- Net spent and net profit subtract completed returns.
-- ----------------------------------------------------------------------------

create or replace view public.customer_directory
with (security_invoker = true)
as
select
  c.id,
  c.organization_id,
  c.customer_code,
  c.customer_type,
  c.name,
  c.company_name,
  c.phone,
  c.email,
  c.address,
  c.date_of_birth,
  c.loyalty_points,
  c.credit_limit,
  c.notes,
  c.is_active,
  c.created_by,
  c.created_at,
  c.updated_at,
  settings.base_currency as summary_currency,
  coalesce(s.sale_count, 0)::bigint as sale_count,
  coalesce(s.gross_sales, 0)::numeric(14,2) as gross_sales,
  coalesce(s.gross_profit, 0)::numeric(14,4) as gross_profit,
  coalesce(r.refund_count, 0)::bigint as refund_count,
  coalesce(r.refund_amount, 0)::numeric(14,2) as refund_amount,
  coalesce(r.profit_reversal, 0)::numeric(14,4) as profit_reversal,
  round(
    coalesce(s.gross_sales, 0) - coalesce(r.refund_amount, 0),
    2
  )::numeric(14,2) as net_spent,
  round(
    coalesce(s.gross_profit, 0) - coalesce(r.profit_reversal, 0),
    4
  )::numeric(14,4) as net_profit,
  case
    when coalesce(s.sale_count, 0) > 0 then
      round(
        (
          coalesce(s.gross_sales, 0) - coalesce(r.refund_amount, 0)
        ) / s.sale_count,
        2
      )
    else 0
  end::numeric(14,2) as average_sale,
  s.last_purchase_at
from public.customers c
join public.app_settings settings
  on settings.organization_id = c.organization_id
left join lateral (
  select
    count(*) as sale_count,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.total_amount
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.total_amount / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.total_amount * settings.usd_to_khr_rate
        else x.total_amount
      end
    ), 0) as gross_sales,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.gross_profit
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.gross_profit / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.gross_profit * settings.usd_to_khr_rate
        else x.gross_profit
      end
    ), 0) as gross_profit,
    max(coalesce(x.completed_at, x.created_at)) as last_purchase_at
  from public.sales x
  where x.customer_id = c.id
    and x.organization_id = c.organization_id
    and x.status in ('completed', 'partially_refunded', 'refunded')
) s on true
left join lateral (
  select
    count(*) as refund_count,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.refund_amount
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.refund_amount / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.refund_amount * settings.usd_to_khr_rate
        else x.refund_amount
      end
    ), 0) as refund_amount,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.profit_reversal
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.profit_reversal / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.profit_reversal * settings.usd_to_khr_rate
        else x.profit_reversal
      end
    ), 0) as profit_reversal
  from public.returns x
  where x.customer_id = c.id
    and x.organization_id = c.organization_id
    and x.status = 'completed'
) r on true;

revoke all on public.customer_directory from anon;
grant select on public.customer_directory to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 8
-- ============================================================================
