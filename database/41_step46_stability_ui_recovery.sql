-- ============================================================================
-- Tiny POS - Step 46: Stability, custom roles, attendance geofence and recovery
-- Run ONCE in the current NEW Supabase project before deploying the Step 46 files.
--
-- This migration is additive and does not delete sales, products, purchases,
-- customers, stock, users, receipts, accounting records or Telegram links.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. CUSTOM STAFF ROLE TEMPLATES
-- ---------------------------------------------------------------------------

create table if not exists public.custom_staff_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 80),
  description text,
  base_role public.app_role not null default 'cashier',
  permission_keys text[] not null default '{}'::text[],
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists custom_staff_roles_org_name_uq
  on public.custom_staff_roles (organization_id, lower(trim(name)));

create index if not exists custom_staff_roles_org_active_idx
  on public.custom_staff_roles (organization_id, is_active, name);

alter table public.custom_staff_roles enable row level security;

drop policy if exists custom_staff_roles_read on public.custom_staff_roles;
create policy custom_staff_roles_read
on public.custom_staff_roles
for select
to authenticated
using (organization_id = private.current_organization_id());

revoke all on public.custom_staff_roles from anon;
grant select on public.custom_staff_roles to authenticated;
grant all on public.custom_staff_roles to service_role;

alter table public.profiles
  add column if not exists custom_role_id uuid;

do $step46$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_custom_role_id_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_custom_role_id_fkey
      foreign key (custom_role_id)
      references public.custom_staff_roles(id)
      on delete set null;
  end if;
end;
$step46$;

create index if not exists profiles_custom_role_idx
  on public.profiles (organization_id, custom_role_id)
  where custom_role_id is not null;

-- Keep individual permission overrides while allowing an active custom role to
-- replace the standard role template. Individual overrides always win.
create or replace function private.has_permission(
  p_permission_key text,
  p_user_id uuid default auth.uid()
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_profile record;
  v_override boolean;
  v_custom_permissions text[];
  v_custom_active boolean;
  v_defaults public.app_role[];
begin
  if p_user_id is null then
    return false;
  end if;

  select
    profile_row.organization_id,
    profile_row.role,
    profile_row.custom_role_id,
    profile_row.is_active
  into v_profile
  from public.profiles profile_row
  where profile_row.id = p_user_id;

  if not found or v_profile.is_active is not true then
    return false;
  end if;

  if v_profile.role = 'owner' then
    return true;
  end if;

  select override_row.allowed
  into v_override
  from public.user_permission_overrides override_row
  where override_row.user_id = p_user_id
    and override_row.permission_key = p_permission_key;

  if found then
    return v_override;
  end if;

  if v_profile.custom_role_id is not null then
    select role_row.permission_keys, role_row.is_active
    into v_custom_permissions, v_custom_active
    from public.custom_staff_roles role_row
    where role_row.id = v_profile.custom_role_id
      and role_row.organization_id = v_profile.organization_id;

    if found then
      if v_custom_active is true then
        return p_permission_key = any(coalesce(v_custom_permissions, '{}'::text[]));
      end if;

      -- An inactive custom role is a deliberate access suspension. Do not
      -- silently fall back to its base role permissions.
      return false;
    end if;
  end if;

  select definition.default_roles
  into v_defaults
  from public.permission_definitions definition
  where definition.permission_key = p_permission_key
    and definition.is_active = true;

  if not found then
    return false;
  end if;

  return v_profile.role = any(v_defaults);
end;
$$;

revoke all on function private.has_permission(text, uuid) from public;
grant execute on function private.has_permission(text, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. BRANCH ATTENDANCE GEOFENCE
-- ---------------------------------------------------------------------------

alter table public.branches
  add column if not exists latitude numeric(10,7),
  add column if not exists longitude numeric(10,7),
  add column if not exists attendance_radius_m integer not null default 150,
  add column if not exists attendance_geofence_required boolean not null default false;

do $step46$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'branches_attendance_radius_check'
      and conrelid = 'public.branches'::regclass
  ) then
    alter table public.branches
      add constraint branches_attendance_radius_check
      check (attendance_radius_m between 25 and 5000);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'branches_latitude_check'
      and conrelid = 'public.branches'::regclass
  ) then
    alter table public.branches
      add constraint branches_latitude_check
      check (latitude is null or latitude between -90 and 90);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'branches_longitude_check'
      and conrelid = 'public.branches'::regclass
  ) then
    alter table public.branches
      add constraint branches_longitude_check
      check (longitude is null or longitude between -180 and 180);
  end if;
end;
$step46$;

alter table public.attendance_sessions
  add column if not exists check_in_latitude numeric(10,7),
  add column if not exists check_in_longitude numeric(10,7),
  add column if not exists check_in_accuracy_m numeric(10,2),
  add column if not exists check_in_distance_m numeric(10,2),
  add column if not exists check_out_latitude numeric(10,7),
  add column if not exists check_out_longitude numeric(10,7),
  add column if not exists check_out_accuracy_m numeric(10,2),
  add column if not exists check_out_distance_m numeric(10,2);

create or replace function private.attendance_distance_m(
  p_latitude_1 numeric,
  p_longitude_1 numeric,
  p_latitude_2 numeric,
  p_longitude_2 numeric
)
returns numeric
language sql
immutable
security definer
set search_path = public, private, pg_temp
as $sql$
  select round((
    6371000 * 2 * asin(
      least(1, sqrt(
        power(sin(radians((p_latitude_2 - p_latitude_1)::double precision) / 2), 2)
        + cos(radians(p_latitude_1::double precision))
          * cos(radians(p_latitude_2::double precision))
          * power(sin(radians((p_longitude_2 - p_longitude_1)::double precision) / 2), 2)
      ))
    )
  )::numeric, 2)
$sql$;

revoke all on function private.attendance_distance_m(numeric,numeric,numeric,numeric) from public;
grant execute on function private.attendance_distance_m(numeric,numeric,numeric,numeric) to authenticated,service_role;

create or replace function private.validate_attendance_location(
  p_user_id uuid,
  p_branch_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_accuracy_m numeric
)
returns numeric
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_branch public.branches%rowtype;
  v_distance numeric;
  v_allowance numeric;
begin
  select * into v_profile
  from public.profiles
  where id = p_user_id and is_active = true;
  if not found then raise exception 'Active POS user not found'; end if;

  select * into v_branch
  from public.branches
  where id = p_branch_id
    and organization_id = v_profile.organization_id
    and is_active = true;
  if not found then raise exception 'Active branch not found'; end if;

  if v_branch.attendance_geofence_required is not true then
    return null;
  end if;

  if v_branch.latitude is null or v_branch.longitude is null then
    raise exception 'Attendance location is not configured for %. Ask an owner to edit this branch first.', v_branch.name;
  end if;

  if p_latitude is null or p_longitude is null then
    raise exception 'Location is required. Allow precise location and try again while you are at the branch.';
  end if;

  if p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    raise exception 'The device returned an invalid location.';
  end if;

  if p_accuracy_m is null or p_accuracy_m < 0 or p_accuracy_m > 100 then
    raise exception 'Location accuracy is too weak. Move near a window, enable precise location and try again.';
  end if;

  v_distance := private.attendance_distance_m(
    v_branch.latitude,
    v_branch.longitude,
    p_latitude,
    p_longitude
  );
  v_allowance := least(greatest(p_accuracy_m, 0), 25);

  if v_distance > (v_branch.attendance_radius_m + v_allowance) then
    raise exception 'You are about % metres from %. Check-in is allowed only within % metres.',
      round(v_distance), v_branch.name, v_branch.attendance_radius_m;
  end if;

  return v_distance;
end;
$$;

revoke all on function private.validate_attendance_location(uuid,uuid,numeric,numeric,numeric) from public;
grant execute on function private.validate_attendance_location(uuid,uuid,numeric,numeric,numeric) to authenticated,service_role;

create or replace function public.attendance_check_in_v2(
  p_branch_id uuid default null,
  p_note text default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_accuracy_m numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_branch_id uuid;
  v_distance numeric;
  v_result jsonb;
  v_session_id uuid;
  v_session public.attendance_sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('staff_operations.self');

  select * into v_profile
  from public.profiles
  where id = auth.uid() and is_active = true;
  if not found then raise exception 'Active POS user not found'; end if;

  v_branch_id := coalesce(p_branch_id, v_profile.branch_id);
  if v_branch_id is null then raise exception 'A branch is required for check-in'; end if;

  if v_branch_id <> v_profile.branch_id
     and not private.has_permission('branches.all', auth.uid()) then
    raise exception 'You cannot check in to another branch';
  end if;

  v_distance := private.validate_attendance_location(
    auth.uid(), v_branch_id, p_latitude, p_longitude, p_accuracy_m
  );

  v_result := private.perform_attendance_action(
    auth.uid(), 'check_in', v_branch_id, p_note, 'pos', auth.uid()
  );
  v_session_id := nullif(v_result #>> '{session,id}', '')::uuid;

  update public.attendance_sessions
  set check_in_latitude = p_latitude,
      check_in_longitude = p_longitude,
      check_in_accuracy_m = p_accuracy_m,
      check_in_distance_m = v_distance,
      updated_at = now()
  where id = v_session_id
  returning * into v_session;

  return jsonb_build_object(
    'ok', true,
    'action', 'check_in',
    'distance_m', v_distance,
    'session', to_jsonb(v_session)
  );
end;
$$;

revoke all on function public.attendance_check_in_v2(uuid,text,numeric,numeric,numeric) from public,anon;
grant execute on function public.attendance_check_in_v2(uuid,text,numeric,numeric,numeric) to authenticated;

create or replace function public.attendance_check_out_v2(
  p_note text default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_accuracy_m numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_open public.attendance_sessions%rowtype;
  v_distance numeric;
  v_result jsonb;
  v_session_id uuid;
  v_session public.attendance_sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('staff_operations.self');

  select * into v_open
  from public.attendance_sessions
  where user_id = auth.uid() and status = 'open'
  order by check_in_at desc
  limit 1;
  if not found then raise exception 'You are not currently checked in'; end if;

  v_distance := private.validate_attendance_location(
    auth.uid(), v_open.branch_id, p_latitude, p_longitude, p_accuracy_m
  );

  v_result := private.perform_attendance_action(
    auth.uid(), 'check_out', null, p_note, 'pos', auth.uid()
  );
  v_session_id := nullif(v_result #>> '{session,id}', '')::uuid;

  update public.attendance_sessions
  set check_out_latitude = p_latitude,
      check_out_longitude = p_longitude,
      check_out_accuracy_m = p_accuracy_m,
      check_out_distance_m = v_distance,
      updated_at = now()
  where id = v_session_id
  returning * into v_session;

  return jsonb_build_object(
    'ok', true,
    'action', 'check_out',
    'distance_m', v_distance,
    'session', to_jsonb(v_session)
  );
end;
$$;

revoke all on function public.attendance_check_out_v2(text,numeric,numeric,numeric) from public,anon;
grant execute on function public.attendance_check_out_v2(text,numeric,numeric,numeric) to authenticated;

-- Text-only Telegram attendance cannot provide trusted coordinates. Branches
-- with the geofence enabled must use the Mini App attendance screen.
create or replace function public.telegram_attendance_action(
  p_user_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_branch public.branches%rowtype;
  v_open public.attendance_sessions%rowtype;
begin
  select * into v_profile
  from public.profiles
  where id = p_user_id and is_active = true;
  if not found then raise exception 'Active POS user not found'; end if;

  if p_action = 'check_out' then
    select * into v_open
    from public.attendance_sessions
    where user_id = p_user_id and status = 'open'
    order by check_in_at desc limit 1;
    if not found then raise exception 'You are not currently checked in'; end if;
    select * into v_branch from public.branches where id = v_open.branch_id;
  else
    select * into v_branch from public.branches where id = v_profile.branch_id;
  end if;

  if v_branch.attendance_geofence_required is true then
    raise exception 'Open Tiny POS Attendance at the branch. Telegram text commands cannot verify your location.';
  end if;

  return private.perform_attendance_action(
    p_user_id, p_action, null, null, 'telegram', p_user_id
  );
end;
$$;

revoke all on function public.telegram_attendance_action(uuid,text) from public,anon,authenticated;
grant execute on function public.telegram_attendance_action(uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. RUNTIME COMPATIBILITY AND DATA-FLOW FIXES
-- ---------------------------------------------------------------------------

alter table public.return_item_batches
  alter column sale_item_batch_id drop not null;


-- Reinstall the current partial-receiving endpoint so each selected line and
-- the Receive All action use the same verified batch-aware implementation.
create or replace function public.receive_purchase_order_v5(
  p_purchase_id uuid,p_items jsonb,p_batch_allocations jsonb default '[]'::jsonb,
  p_amount_paid numeric default 0,p_payment_method public.payment_method default 'cash',
  p_payment_reference text default null,p_supplier_invoice_number text default null,
  p_received_at timestamptz default now(),p_notes text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_input record; v_pi public.purchase_items%rowtype; v_product public.products%rowtype;
 v_requested numeric(14,3); v_allocated numeric(14,3); v_result jsonb; v_receipt_id uuid; v_receipt_item public.purchase_receipt_items%rowtype;
 v_alloc record; v_batch_id uuid; v_base numeric(14,3); v_expiry date; v_count integer:=0; v_received_date date;
begin
  perform private.require_permission('purchases.receive');
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  if p_batch_allocations is null or jsonb_typeof(p_batch_allocations)<>'array' then p_batch_allocations:='[]'::jsonb; end if;
  v_received_date:=(coalesce(p_received_at,now()))::date;
  for v_input in select x.purchase_item_id,sum(x.quantity)::numeric(14,3) quantity
    from jsonb_to_recordset(p_items) x(purchase_item_id uuid,quantity numeric)
    group by x.purchase_item_id loop
    select * into v_pi from public.purchase_items where id=v_input.purchase_item_id and purchase_id=p_purchase_id;
    if not found then raise exception 'A selected receipt item is invalid'; end if;
    select * into v_product from public.products where id=v_pi.product_id and organization_id=v_org;
    if v_product.batch_tracking then
      select coalesce(sum(a.quantity),0)::numeric(14,3) into v_allocated
      from jsonb_to_recordset(p_batch_allocations) a(purchase_item_id uuid,batch_number text,expiry_date date,quantity numeric,notes text)
      where a.purchase_item_id=v_pi.id;
      if abs(v_allocated-v_input.quantity)>0.0005 then
        raise exception 'Batch quantities for % must total % %',v_product.name,v_input.quantity,v_pi.purchase_unit_name;
      end if;
      for v_alloc in select * from jsonb_to_recordset(p_batch_allocations)
        a(purchase_item_id uuid,batch_number text,expiry_date date,quantity numeric,notes text)
        where a.purchase_item_id=v_pi.id loop
        if v_alloc.batch_number is null or length(trim(v_alloc.batch_number))=0 or v_alloc.quantity<=0 then
          raise exception 'Every batch for % needs a lot number and quantity',v_product.name;
        end if;
        v_expiry:=coalesce(v_alloc.expiry_date,
          case when v_product.default_shelf_life_days is not null then v_received_date+v_product.default_shelf_life_days else null end);
        if v_product.expiry_tracking and v_expiry is null then raise exception 'Expiry date is required for %',v_product.name; end if;
        if v_expiry is not null and v_expiry<v_received_date then raise exception 'Expiry date for % cannot be before received date',v_product.name; end if;
      end loop;
    end if;
  end loop;
  v_result:=public.receive_purchase_order_v4(p_purchase_id,p_items,p_amount_paid,p_payment_method,
    p_payment_reference,p_supplier_invoice_number,p_received_at,p_notes);
  v_receipt_id:=(v_result->>'receipt_id')::uuid;
  for v_alloc in select * from jsonb_to_recordset(p_batch_allocations)
    a(purchase_item_id uuid,batch_number text,expiry_date date,quantity numeric,notes text) loop
    select * into v_pi from public.purchase_items where id=v_alloc.purchase_item_id and purchase_id=p_purchase_id;
    select * into v_product from public.products where id=v_pi.product_id;
    if not v_product.batch_tracking then continue; end if;
    select * into v_receipt_item from public.purchase_receipt_items
      where receipt_id=v_receipt_id and purchase_item_id=v_pi.id;
    if not found then raise exception 'Batch allocation does not match a received line'; end if;
    v_base:=round(v_alloc.quantity*v_pi.unit_factor,3);
    v_expiry:=coalesce(v_alloc.expiry_date,
      case when v_product.default_shelf_life_days is not null then v_received_date+v_product.default_shelf_life_days else null end);
    insert into public.inventory_batches(organization_id,branch_id,product_id,batch_number,expiry_date,received_date,
      source_type,purchase_receipt_item_id,supplier_id,initial_quantity,quantity,unit_cost,status,notes,created_by)
    select v_org,v_branch,v_product.id,trim(v_alloc.batch_number),v_expiry,v_received_date,'purchase',v_receipt_item.id,
      p.supplier_id,v_base,v_base,v_receipt_item.base_unit_cost,'active',nullif(trim(v_alloc.notes),''),auth.uid()
    from public.purchases p where p.id=p_purchase_id returning id into v_batch_id;
    insert into public.purchase_receipt_item_batches(organization_id,receipt_item_id,inventory_batch_id,
      purchase_unit_quantity,base_quantity,unit_cost)
    values(v_org,v_receipt_item.id,v_batch_id,v_alloc.quantity,v_base,v_receipt_item.base_unit_cost);
    v_count:=v_count+1;
  end loop;
  return v_result||jsonb_build_object('batch_count',v_count,'batch_tracking',true);
end; $$;
revoke all on function public.receive_purchase_order_v5(uuid,jsonb,jsonb,numeric,public.payment_method,text,text,timestamptz,text) from public,anon;
grant execute on function public.receive_purchase_order_v5(uuid,jsonb,jsonb,numeric,public.payment_method,text,text,timestamptz,text) to authenticated,service_role;

-- Reinstall supplier payment recording with granular/custom-role permission
-- checks while preserving supplier-return credit validation.
create or replace function public.record_purchase_payment(
  p_purchase_id uuid,
  p_amount numeric,
  p_method public.payment_method,
  p_reference_number text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_purchase public.purchases%rowtype;
  v_return_credit numeric(14,2);
  v_balance_due numeric(14,2);
  v_new_paid numeric(14,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    organization_id,
    branch_id,
    role,
    is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  perform private.require_permission('supplier_payables.pay');

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  select *
  into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Purchase order not found';
  end if;

  if v_purchase.status = 'cancelled' then
    raise exception 'A cancelled purchase order cannot receive payments';
  end if;

  v_return_credit := round(
    private.purchase_supplier_credit_total(
      v_purchase.id
    ),
    2
  );

  v_balance_due := greatest(
    round(
      v_purchase.total_amount
      - coalesce(v_purchase.amount_paid, 0)
      - v_return_credit,
      2
    ),
    0
  );

  if v_balance_due <= 0 then
    raise exception 'This purchase has no outstanding supplier balance';
  end if;

  if round(p_amount, 2) > v_balance_due then
    raise exception
      'Payment exceeds the outstanding balance of %',
      v_balance_due;
  end if;

  v_new_paid := round(
    coalesce(v_purchase.amount_paid, 0)
    + p_amount,
    2
  );

  insert into public.purchase_payments (
    organization_id,
    branch_id,
    purchase_id,
    payment_batch_id,
    method,
    currency,
    amount,
    reference_number,
    notes,
    paid_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_purchase.id,
    null,
    p_method,
    v_purchase.currency,
    round(p_amount, 2),
    nullif(trim(p_reference_number), ''),
    nullif(trim(p_notes), ''),
    v_user_id
  );

  update public.purchases
  set
    amount_paid = v_new_paid,
    updated_at = now()
  where id = v_purchase.id;

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'record_purchase_payment',
    'purchase',
    v_purchase.id,
    jsonb_build_object(
      'purchase_number',
        v_purchase.purchase_number,
      'payment_amount',
        round(p_amount, 2),
      'amount_paid',
        v_new_paid,
      'supplier_return_credit',
        v_return_credit,
      'balance_due',
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_return_credit,
          0
        ),
      'method',
        p_method
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number',
      v_purchase.purchase_number,
    'amount_paid', v_new_paid,
    'supplier_return_credit',
      v_return_credit,
    'balance_due',
      round(
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_return_credit,
          0
        ),
        2
      ),
    'payment_status',
      case
        when greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_return_credit,
          0
        ) = 0 then 'paid'
        when v_new_paid > 0
          or v_return_credit > 0 then 'partial'
        else 'unpaid'
      end
  );
end;
$$;

revoke all on function public.record_purchase_payment(
  uuid,
  numeric,
  public.payment_method,
  text,
  text
) from public, anon;

grant execute on function public.record_purchase_payment(
  uuid,
  numeric,
  public.payment_method,
  text,
  text
) to authenticated, service_role;
create or replace function private.resolve_sales_unit_price(
  p_organization_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_product_unit_id uuid,
  p_currency public.currency_code,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_unit record;
  v_customer public.customers%rowtype;
  v_list public.price_lists%rowtype;
  v_override numeric(14,2);
begin
  select
    unit_row.id,
    unit_row.product_id,
    unit_row.selling_price,
    unit_row.is_active,
    product.currency,
    product.is_active as product_active
  into v_unit
  from public.product_units unit_row
  join public.products product
    on product.id = unit_row.product_id
  where unit_row.id = p_product_unit_id
    and unit_row.organization_id = p_organization_id
    and product.organization_id = p_organization_id;

  if not found
     or v_unit.is_active is not true
     or v_unit.product_active is not true then
    raise exception 'Selling unit is unavailable';
  end if;

  if v_unit.currency <> p_currency then
    raise exception
      'Selling unit currency does not match the sale currency';
  end if;

  if p_customer_id is not null then
    select customer.*
    into v_customer
    from public.customers customer
    where customer.id = p_customer_id
      and customer.organization_id = p_organization_id
      and customer.is_active = true;

    if not found then
      raise exception 'Customer not found or inactive';
    end if;
  end if;

  -- A directly assigned list wins when it is currently valid.
  if v_customer.price_list_id is not null then
    select list_row.*
    into v_list
    from public.price_lists list_row
    where list_row.id = v_customer.price_list_id
      and list_row.organization_id = p_organization_id
      and list_row.currency = p_currency
      and list_row.is_active = true
      and (
        list_row.branch_id is null
        or list_row.branch_id = p_branch_id
      )
      and (
        list_row.starts_at is null
        or list_row.starts_at <= p_at
      )
      and (
        list_row.ends_at is null
        or list_row.ends_at > p_at
      )
    limit 1;
  end if;

  -- Otherwise use customer-type pricing, then All Customers.
  if v_list.id is null then
    select list_row.*
    into v_list
    from public.price_lists list_row
    where list_row.organization_id = p_organization_id
      and list_row.currency = p_currency
      and list_row.is_active = true
      and (
        list_row.branch_id is null
        or list_row.branch_id = p_branch_id
      )
      and list_row.customer_type in (
        coalesce(v_customer.customer_type, 'all'),
        'all'
      )
      and (
        list_row.starts_at is null
        or list_row.starts_at <= p_at
      )
      and (
        list_row.ends_at is null
        or list_row.ends_at > p_at
      )
    order by
      case
        when p_customer_id is not null
          and list_row.customer_type = v_customer.customer_type
          then 0
        when list_row.customer_type = 'all'
          then 1
        else 2
      end,
      case
        when list_row.branch_id = p_branch_id
          then 0
        else 1
      end,
      list_row.priority desc,
      list_row.created_at desc
    limit 1;
  end if;

  if v_list.id is not null then
    select item.selling_price
    into v_override
    from public.price_list_items item
    where item.price_list_id = v_list.id
      and item.product_unit_id = v_unit.id
    limit 1;
  end if;

  return jsonb_build_object(
    'product_unit_id', v_unit.id,
    'product_id', v_unit.product_id,
    'price_list_id', v_list.id,
    'price_list_code', v_list.code,
    'price_list_name', v_list.name,
    'list_price', v_unit.selling_price,
    'effective_price',
      coalesce(v_override, v_unit.selling_price),
    'price_adjustment',
      round(
        v_unit.selling_price
        - coalesce(v_override, v_unit.selling_price),
        2
      ),
    'has_override', v_override is not null
  );
end;
$$;

create or replace function public.get_customer_price_catalog(
  p_customer_id uuid default null,
  p_currency public.currency_code default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_customer public.customers%rowtype;
  v_list public.price_lists%rowtype;
  v_items jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    organization_id,
    branch_id,
    role,
    is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in (
    'owner',
    'admin',
    'manager',
    'cashier',
    'viewer'
  ) then
    raise exception 'Your role cannot view selling prices';
  end if;

  if p_customer_id is not null then
    select customer.*
    into v_customer
    from public.customers customer
    where customer.id = p_customer_id
      and customer.organization_id =
        v_profile.organization_id
      and customer.is_active = true;

    if not found then
      raise exception 'Customer not found or inactive';
    end if;
  end if;

  if v_customer.price_list_id is not null then
    select list_row.*
    into v_list
    from public.price_lists list_row
    where list_row.id = v_customer.price_list_id
      and list_row.organization_id =
        v_profile.organization_id
      and list_row.currency = p_currency
      and list_row.is_active = true
      and (
        list_row.branch_id is null
        or list_row.branch_id =
          v_profile.branch_id
      )
      and (
        list_row.starts_at is null
        or list_row.starts_at <= now()
      )
      and (
        list_row.ends_at is null
        or list_row.ends_at > now()
      )
    limit 1;
  end if;

  if v_list.id is null then
    select list_row.*
    into v_list
    from public.price_lists list_row
    where list_row.organization_id =
        v_profile.organization_id
      and list_row.currency = p_currency
      and list_row.is_active = true
      and (
        list_row.branch_id is null
        or list_row.branch_id =
          v_profile.branch_id
      )
      and list_row.customer_type in (
        coalesce(v_customer.customer_type, 'all'),
        'all'
      )
      and (
        list_row.starts_at is null
        or list_row.starts_at <= now()
      )
      and (
        list_row.ends_at is null
        or list_row.ends_at > now()
      )
    order by
      case
        when p_customer_id is not null
          and list_row.customer_type =
            v_customer.customer_type
          then 0
        when list_row.customer_type = 'all'
          then 1
        else 2
      end,
      case
        when list_row.branch_id =
          v_profile.branch_id
          then 0
        else 1
      end,
      list_row.priority desc,
      list_row.created_at desc
    limit 1;
  end if;

  if v_list.id is not null then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'product_id', item.product_id,
        'product_unit_id', item.product_unit_id,
        'selling_price', item.selling_price
      )
      order by item.product_id, item.product_unit_id
    ), '[]'::jsonb)
    into v_items
    from public.price_list_items item
    where item.price_list_id = v_list.id;
  end if;

  return jsonb_build_object(
    'price_list_id', v_list.id,
    'price_list_code', v_list.code,
    'price_list_name', v_list.name,
    'customer_type', v_list.customer_type,
    'currency', p_currency,
    'items', v_items
  );
end;
$$;

create or replace function public.get_reports_data(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_all_branches boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_branch_id uuid;
  v_branch_name text;
  v_all_branches boolean := false;
  v_can_all_branches boolean := false;
  v_base_currency public.currency_code;
  v_usd_to_khr_rate numeric(14,4);
  v_timezone text;
  v_granularity text;

  v_summary jsonb;
  v_trend jsonb;
  v_payment_methods jsonb;
  v_top_products jsonb;
  v_top_categories jsonb;
  v_cashiers jsonb;
  v_sales_rows jsonb;
  v_purchase_rows jsonb;
  v_top_suppliers jsonb;
  v_stock_summary jsonb;
  v_stock_age jsonb;
  v_stock_rows jsonb;
  v_customer_summary jsonb;
  v_top_customers jsonb;
  v_customer_types jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    p.organization_id,
    p.branch_id,
    p.role,
    p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  perform private.require_permission('reports.view');
  v_can_all_branches := private.has_permission('branches.all');

  if p_from is null or p_to is null then
    raise exception 'A report start date and end date are required';
  end if;

  if p_from > p_to then
    raise exception 'The start date cannot be after the end date';
  end if;

  if (p_to - p_from) > 1095 then
    raise exception 'Choose a report period of three years or less';
  end if;

  select
    s.base_currency,
    s.usd_to_khr_rate,
    coalesce(nullif(trim(s.timezone), ''), 'Asia/Phnom_Penh')
  into
    v_base_currency,
    v_usd_to_khr_rate,
    v_timezone
  from public.app_settings s
  where s.organization_id = v_profile.organization_id;

  if v_base_currency is null then
    v_base_currency := 'USD';
  end if;

  if v_usd_to_khr_rate is null or v_usd_to_khr_rate <= 0 then
    v_usd_to_khr_rate := 4100;
  end if;

  if v_can_all_branches and p_all_branches then
    v_all_branches := true;
    v_branch_id := null;
    v_branch_name := 'All branches';
  else
    v_branch_id := coalesce(p_branch_id, v_profile.branch_id);

    if not v_can_all_branches
       and v_branch_id is distinct from v_profile.branch_id then
      raise exception 'You may report only your assigned branch';
    end if;

    select b.name
    into v_branch_name
    from public.branches b
    where b.id = v_branch_id
      and b.organization_id = v_profile.organization_id;

    if v_branch_name is null then
      raise exception 'Report branch not found';
    end if;
  end if;

  v_granularity := case
    when (p_to - p_from) <= 92 then 'day'
    else 'month'
  end;

  -- --------------------------------------------------------------------------
  -- Summary and profit figures
  -- --------------------------------------------------------------------------
  with report_sales as (
    select
      s.id,
      private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as total_base,
      private.convert_to_base_currency(
        s.subtotal, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as subtotal_base,
      private.convert_to_base_currency(
        s.discount_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as discount_base,
      private.convert_to_base_currency(
        s.tax_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as tax_base,
      private.convert_to_base_currency(
        s.cost_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as cost_base,
      private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      ) as profit_base
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
  ),
  report_returns as (
    select
      private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as refund_base,
      private.convert_to_base_currency(
        r.tax_refund, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as tax_refund_base,
      private.convert_to_base_currency(
        r.cost_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as cost_return_base,
      private.convert_to_base_currency(
        r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as profit_reversal_base
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
  ),
  report_purchases as (
    select
      private.convert_to_base_currency(
        p.total_amount, p.currency, v_base_currency, v_usd_to_khr_rate
      ) as purchase_base,
      private.convert_to_base_currency(
        p.amount_paid, p.currency, v_base_currency, v_usd_to_khr_rate
      ) as paid_base
    from public.purchases p
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.status = 'received'
      and (timezone(v_timezone, coalesce(p.received_at, p.created_at)))::date
        between p_from and p_to
  ),
  sold_units as (
    select coalesce(sum(si.quantity), 0) as quantity
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
  ),
  returned_units as (
    select coalesce(sum(ri.quantity), 0) as quantity
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
  )
  select jsonb_build_object(
    'gross_sales', coalesce((select sum(total_base) from report_sales), 0),
    'subtotal', coalesce((select sum(subtotal_base) from report_sales), 0),
    'discounts', coalesce((select sum(discount_base) from report_sales), 0),
    'tax_collected', coalesce((select sum(tax_base) from report_sales), 0),
    'refunds', coalesce((select sum(refund_base) from report_returns), 0),
    'tax_refunded', coalesce((select sum(tax_refund_base) from report_returns), 0),
    'net_sales',
      coalesce((select sum(total_base) from report_sales), 0)
      - coalesce((select sum(refund_base) from report_returns), 0),
    'gross_cogs', coalesce((select sum(cost_base) from report_sales), 0),
    'returned_cogs', coalesce((select sum(cost_return_base) from report_returns), 0),
    'net_cogs',
      coalesce((select sum(cost_base) from report_sales), 0)
      - coalesce((select sum(cost_return_base) from report_returns), 0),
    'gross_profit_before_refunds',
      coalesce((select sum(profit_base) from report_sales), 0),
    'profit_reversal',
      coalesce((select sum(profit_reversal_base) from report_returns), 0),
    'gross_profit',
      coalesce((select sum(profit_base) from report_sales), 0)
      - coalesce((select sum(profit_reversal_base) from report_returns), 0),
    'gross_margin_percent',
      case
        when (
          coalesce((select sum(total_base) from report_sales), 0)
          - coalesce((select sum(refund_base) from report_returns), 0)
        ) > 0
        then round(
          (
            coalesce((select sum(profit_base) from report_sales), 0)
            - coalesce((select sum(profit_reversal_base) from report_returns), 0)
          ) * 100
          / (
            coalesce((select sum(total_base) from report_sales), 0)
            - coalesce((select sum(refund_base) from report_returns), 0)
          ),
          2
        )
        else 0
      end,
    'sale_count', (select count(*) from report_sales),
    'refund_count', (select count(*) from report_returns),
    'average_sale',
      case
        when (select count(*) from report_sales) > 0
        then round(
          (
            coalesce((select sum(total_base) from report_sales), 0)
            - coalesce((select sum(refund_base) from report_returns), 0)
          ) / (select count(*) from report_sales),
          2
        )
        else 0
      end,
    'units_sold', coalesce((select quantity from sold_units), 0),
    'units_returned', coalesce((select quantity from returned_units), 0),
    'net_units',
      coalesce((select quantity from sold_units), 0)
      - coalesce((select quantity from returned_units), 0),
    'purchase_total', coalesce((select sum(purchase_base) from report_purchases), 0),
    'purchase_paid', coalesce((select sum(paid_base) from report_purchases), 0),
    'purchase_count', (select count(*) from report_purchases)
  ) into v_summary;

  -- --------------------------------------------------------------------------
  -- Sales/refunds/profit trend
  -- --------------------------------------------------------------------------
  with periods as (
    select generate_series(
      date_trunc(v_granularity, p_from::timestamp),
      date_trunc(v_granularity, p_to::timestamp),
      case when v_granularity = 'day' then interval '1 day' else interval '1 month' end
    )::date as period
  ),
  sales_by_period as (
    select
      date_trunc(
        v_granularity,
        timezone(v_timezone, coalesce(s.completed_at, s.created_at))
      )::date as period,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_sales,
      sum(private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_profit,
      count(*) as sale_count
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by 1
  ),
  returns_by_period as (
    select
      date_trunc(v_granularity, timezone(v_timezone, r.processed_at))::date as period,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds,
      sum(private.convert_to_base_currency(
        r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as profit_reversal,
      count(*) as refund_count
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'period', to_char(p.period, 'YYYY-MM-DD'),
      'gross_sales', coalesce(s.gross_sales, 0),
      'refunds', coalesce(r.refunds, 0),
      'net_sales', coalesce(s.gross_sales, 0) - coalesce(r.refunds, 0),
      'gross_profit', coalesce(s.gross_profit, 0) - coalesce(r.profit_reversal, 0),
      'sale_count', coalesce(s.sale_count, 0),
      'refund_count', coalesce(r.refund_count, 0)
    ) order by p.period
  ), '[]'::jsonb)
  into v_trend
  from periods p
  left join sales_by_period s on s.period = p.period
  left join returns_by_period r on r.period = p.period;

  -- --------------------------------------------------------------------------
  -- Payment-method performance
  -- --------------------------------------------------------------------------
  with money_flow as (
    select
      p.method::text as method,
      private.convert_to_base_currency(
        p.amount, p.currency, v_base_currency, v_usd_to_khr_rate
      ) as collected,
      0::numeric as refunded,
      1 as payment_count,
      0 as refund_count
    from public.payments p
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and (timezone(v_timezone, p.paid_at))::date between p_from and p_to

    union all

    select
      coalesce(r.refund_method::text, 'other') as method,
      0::numeric as collected,
      private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      ) as refunded,
      0 as payment_count,
      1 as refund_count
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'method', method,
      'collected', collected,
      'refunded', refunded,
      'net', collected - refunded,
      'payment_count', payment_count,
      'refund_count', refund_count
    ) order by collected - refunded desc
  ), '[]'::jsonb)
  into v_payment_methods
  from (
    select
      method,
      round(sum(collected), 2) as collected,
      round(sum(refunded), 2) as refunded,
      sum(payment_count) as payment_count,
      sum(refund_count) as refund_count
    from money_flow
    group by method
  ) q;

  -- --------------------------------------------------------------------------
  -- Top products
  -- --------------------------------------------------------------------------
  with sold as (
    select
      coalesce(si.product_id::text, 'name:' || lower(si.product_name)) as item_key,
      max(si.product_id::text)::uuid as product_id,
      max(si.product_name) as product_name,
      sum(si.quantity) as sold_quantity,
      sum(private.convert_to_base_currency(
        si.line_total, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as sold_revenue,
      sum(private.convert_to_base_currency(
        si.line_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as sold_profit
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by 1
  ),
  refunded as (
    select
      coalesce(ri.product_id::text, 'name:' || lower(si.product_name)) as item_key,
      max(ri.product_id::text)::uuid as product_id,
      max(si.product_name) as product_name,
      sum(ri.quantity) as returned_quantity,
      sum(private.convert_to_base_currency(
        ri.line_refund - ri.tax_refund,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as returned_revenue,
      sum(private.convert_to_base_currency(
        ri.line_profit_reversal,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as returned_profit
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    join public.sale_items si on si.id = ri.sale_item_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'sold_quantity', sold_quantity,
      'returned_quantity', returned_quantity,
      'net_quantity', sold_quantity - returned_quantity,
      'gross_revenue', sold_revenue,
      'refund_revenue', returned_revenue,
      'net_revenue', sold_revenue - returned_revenue,
      'gross_profit', sold_profit - returned_profit
    ) order by sold_revenue - returned_revenue desc
  ), '[]'::jsonb)
  into v_top_products
  from (
    select
      coalesce(s.item_key, r.item_key) as item_key,
      coalesce(s.product_id, r.product_id) as product_id,
      coalesce(s.product_name, r.product_name) as product_name,
      coalesce(s.sold_quantity, 0) as sold_quantity,
      coalesce(r.returned_quantity, 0) as returned_quantity,
      coalesce(s.sold_revenue, 0) as sold_revenue,
      coalesce(r.returned_revenue, 0) as returned_revenue,
      coalesce(s.sold_profit, 0) as sold_profit,
      coalesce(r.returned_profit, 0) as returned_profit
    from sold s
    full join refunded r on r.item_key = s.item_key
    order by coalesce(s.sold_revenue, 0) - coalesce(r.returned_revenue, 0) desc
    limit 15
  ) q;

  -- --------------------------------------------------------------------------
  -- Top categories
  -- --------------------------------------------------------------------------
  with category_sales as (
    select
      coalesce(c.id::text, 'uncategorized') as category_key,
      coalesce(max(c.name), 'Uncategorized') as category_name,
      sum(si.quantity) as sold_quantity,
      sum(private.convert_to_base_currency(
        si.line_total, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as sold_revenue
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
    left join public.products p on p.id = si.product_id
    left join public.categories c on c.id = p.category_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by 1
  ),
  category_returns as (
    select
      coalesce(c.id::text, 'uncategorized') as category_key,
      coalesce(max(c.name), 'Uncategorized') as category_name,
      sum(ri.quantity) as returned_quantity,
      sum(private.convert_to_base_currency(
        ri.line_refund - ri.tax_refund,
        r.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as returned_revenue
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    left join public.products p on p.id = ri.product_id
    left join public.categories c on c.id = p.category_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by 1
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'category_name', category_name,
      'sold_quantity', sold_quantity,
      'returned_quantity', returned_quantity,
      'net_quantity', sold_quantity - returned_quantity,
      'net_revenue', sold_revenue - returned_revenue
    ) order by sold_revenue - returned_revenue desc
  ), '[]'::jsonb)
  into v_top_categories
  from (
    select
      coalesce(s.category_key, r.category_key) as category_key,
      coalesce(s.category_name, r.category_name) as category_name,
      coalesce(s.sold_quantity, 0) as sold_quantity,
      coalesce(r.returned_quantity, 0) as returned_quantity,
      coalesce(s.sold_revenue, 0) as sold_revenue,
      coalesce(r.returned_revenue, 0) as returned_revenue
    from category_sales s
    full join category_returns r on r.category_key = s.category_key
    order by coalesce(s.sold_revenue, 0) - coalesce(r.returned_revenue, 0) desc
    limit 12
  ) q;

  -- --------------------------------------------------------------------------
  -- Cashier performance
  -- --------------------------------------------------------------------------
  with cashier_sales as (
    select
      s.cashier_id,
      max(coalesce(p.full_name, p.email, 'POS Staff')) as cashier_name,
      count(*) as sale_count,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_sales,
      sum(private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_profit
    from public.sales s
    left join public.profiles p on p.id = s.cashier_id
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by s.cashier_id
  ),
  cashier_returns as (
    select
      s.cashier_id,
      count(*) as refund_count,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds,
      sum(private.convert_to_base_currency(
        r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as profit_reversal
    from public.returns r
    join public.sales s on s.id = r.original_sale_id
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by s.cashier_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'cashier_id', s.cashier_id,
      'cashier_name', s.cashier_name,
      'sale_count', s.sale_count,
      'refund_count', coalesce(r.refund_count, 0),
      'gross_sales', s.gross_sales,
      'refunds', coalesce(r.refunds, 0),
      'net_sales', s.gross_sales - coalesce(r.refunds, 0),
      'gross_profit', s.gross_profit - coalesce(r.profit_reversal, 0)
    ) order by s.gross_sales - coalesce(r.refunds, 0) desc
  ), '[]'::jsonb)
  into v_cashiers
  from cashier_sales s
  left join cashier_returns r on r.cashier_id = s.cashier_id;

  -- --------------------------------------------------------------------------
  -- Invoice-level rows for the detailed sales table and CSV export
  -- --------------------------------------------------------------------------
  select coalesce(jsonb_agg(row_data order by completed_at desc), '[]'::jsonb)
  into v_sales_rows
  from (
    select jsonb_build_object(
      'invoice_number', s.invoice_number,
      'completed_at', coalesce(s.completed_at, s.created_at),
      'branch_name', b.name,
      'customer_name', coalesce(c.name, 'Walk-in'),
      'cashier_name', coalesce(pr.full_name, pr.email, 'POS Staff'),
      'payment_methods', coalesce(pay.methods, '—'),
      'currency', s.currency,
      'gross_total', private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ),
      'refund_total', coalesce(ref.refund_total, 0),
      'net_total', private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) - coalesce(ref.refund_total, 0),
      'cost', private.convert_to_base_currency(
        s.cost_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      ) - coalesce(ref.cost_return, 0),
      'gross_profit', private.convert_to_base_currency(
        s.gross_profit, s.currency, v_base_currency, v_usd_to_khr_rate
      ) - coalesce(ref.profit_reversal, 0),
      'status', s.status
    ) as row_data,
    coalesce(s.completed_at, s.created_at) as completed_at
    from public.sales s
    join public.branches b on b.id = s.branch_id
    left join public.customers c on c.id = s.customer_id
    left join public.profiles pr on pr.id = s.cashier_id
    left join lateral (
      select string_agg(distinct upper(p.method::text), ', ' order by upper(p.method::text)) as methods
      from public.payments p
      where p.sale_id = s.id
    ) pay on true
    left join lateral (
      select
        sum(private.convert_to_base_currency(
          r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
        )) as refund_total,
        sum(private.convert_to_base_currency(
          r.cost_amount, r.currency, v_base_currency, v_usd_to_khr_rate
        )) as cost_return,
        sum(private.convert_to_base_currency(
          r.profit_reversal, r.currency, v_base_currency, v_usd_to_khr_rate
        )) as profit_reversal
      from public.returns r
      where r.original_sale_id = s.id
        and r.status = 'completed'
    ) ref on true
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    order by coalesce(s.completed_at, s.created_at) desc
    limit 500
  ) rows;

  -- --------------------------------------------------------------------------
  -- Purchases and suppliers
  -- --------------------------------------------------------------------------
  select coalesce(jsonb_agg(row_data order by received_at desc), '[]'::jsonb)
  into v_purchase_rows
  from (
    select
      jsonb_build_object(
        'purchase_number', p.purchase_number,
        'received_at', coalesce(p.received_at, p.created_at),
        'branch_name', b.name,
        'supplier_name', coalesce(s.name, 'No supplier'),
        'supplier_invoice_number', p.supplier_invoice_number,
        'total', private.convert_to_base_currency(
          p.total_amount, p.currency, v_base_currency, v_usd_to_khr_rate
        ),
        'amount_paid', private.convert_to_base_currency(
          p.amount_paid, p.currency, v_base_currency, v_usd_to_khr_rate
        ),
        'balance', private.convert_to_base_currency(
          greatest(p.total_amount - p.amount_paid, 0),
          p.currency,
          v_base_currency,
          v_usd_to_khr_rate
        ),
        'status', p.status
      ) as row_data,
      coalesce(p.received_at, p.created_at) as received_at
    from public.purchases p
    join public.branches b on b.id = p.branch_id
    left join public.suppliers s on s.id = p.supplier_id
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.status = 'received'
      and (timezone(v_timezone, coalesce(p.received_at, p.created_at)))::date
        between p_from and p_to
    order by coalesce(p.received_at, p.created_at) desc
    limit 500
  ) rows;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'supplier_name', supplier_name,
      'purchase_count', purchase_count,
      'purchase_total', purchase_total,
      'amount_paid', amount_paid,
      'balance', purchase_total - amount_paid
    ) order by purchase_total desc
  ), '[]'::jsonb)
  into v_top_suppliers
  from (
    select
      coalesce(s.name, 'No supplier') as supplier_name,
      count(*) as purchase_count,
      sum(private.convert_to_base_currency(
        p.total_amount, p.currency, v_base_currency, v_usd_to_khr_rate
      )) as purchase_total,
      sum(private.convert_to_base_currency(
        p.amount_paid, p.currency, v_base_currency, v_usd_to_khr_rate
      )) as amount_paid
    from public.purchases p
    left join public.suppliers s on s.id = p.supplier_id
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.status = 'received'
      and (timezone(v_timezone, coalesce(p.received_at, p.created_at)))::date
        between p_from and p_to
    group by coalesce(s.name, 'No supplier')
    order by purchase_total desc
    limit 15
  ) q;

  -- --------------------------------------------------------------------------
  -- Current stock and last-inbound-age analysis
  -- This is not FIFO batch aging. It classifies current stock using the latest
  -- positive stock movement for each product and branch.
  -- --------------------------------------------------------------------------
  with selected_branches as (
    select b.id, b.name
    from public.branches b
    where b.organization_id = v_profile.organization_id
      and b.is_active = true
      and (v_all_branches or b.id = v_branch_id)
  ),
  stock_detail as (
    select
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.barcode,
      coalesce(c.name, 'Uncategorized') as category_name,
      sb.id as branch_id,
      sb.name as branch_name,
      p.currency,
      p.selling_price,
      coalesce(ib.quantity, 0) as quantity,
      coalesce(nullif(ib.average_cost, 0), p.default_cost, 0) as average_cost,
      coalesce(p.low_stock_threshold, settings.low_stock_threshold, 0) as low_stock_threshold,
      coalesce(last_in.last_inbound_at, p.created_at) as last_inbound_at,
      greatest(
        p_to - (timezone(v_timezone, coalesce(last_in.last_inbound_at, p.created_at)))::date,
        0
      ) as age_days
    from public.products p
    cross join selected_branches sb
    left join public.categories c on c.id = p.category_id
    left join public.inventory_balances ib
      on ib.product_id = p.id
      and ib.branch_id = sb.id
    join public.app_settings settings
      on settings.organization_id = p.organization_id
    left join lateral (
      select max(sm.created_at) as last_inbound_at
      from public.stock_movements sm
      where sm.product_id = p.id
        and sm.branch_id = sb.id
        and sm.quantity_change > 0
    ) last_in on true
    where p.organization_id = v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
  ),
  valued_stock as (
    select
      *,
      private.convert_to_base_currency(
        quantity * average_cost,
        currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as cost_value,
      private.convert_to_base_currency(
        quantity * selling_price,
        currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as retail_value
    from stock_detail
  )
  select jsonb_build_object(
    'product_count', count(distinct product_id),
    'stock_units', coalesce(sum(quantity), 0),
    'stock_cost_value', coalesce(sum(cost_value), 0),
    'stock_retail_value', coalesce(sum(retail_value), 0),
    'potential_margin', coalesce(sum(retail_value - cost_value), 0),
    'low_stock_count', count(*) filter (
      where quantity > 0 and quantity <= low_stock_threshold
    ),
    'out_of_stock_count', count(*) filter (where quantity <= 0),
    'negative_stock_count', count(*) filter (where quantity < 0)
  )
  into v_stock_summary
  from valued_stock;

  with selected_branches as (
    select b.id
    from public.branches b
    where b.organization_id = v_profile.organization_id
      and b.is_active = true
      and (v_all_branches or b.id = v_branch_id)
  ),
  aged as (
    select
      p.id as product_id,
      coalesce(ib.quantity, 0) as quantity,
      private.convert_to_base_currency(
        coalesce(ib.quantity, 0)
          * coalesce(nullif(ib.average_cost, 0), p.default_cost, 0),
        p.currency,
        v_base_currency,
        v_usd_to_khr_rate
      ) as cost_value,
      greatest(
        p_to - (timezone(
          v_timezone,
          coalesce(last_in.last_inbound_at, p.created_at)
        ))::date,
        0
      ) as age_days
    from public.products p
    cross join selected_branches sb
    left join public.inventory_balances ib
      on ib.product_id = p.id and ib.branch_id = sb.id
    left join lateral (
      select max(sm.created_at) as last_inbound_at
      from public.stock_movements sm
      where sm.product_id = p.id
        and sm.branch_id = sb.id
        and sm.quantity_change > 0
    ) last_in on true
    where p.organization_id = v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
      and coalesce(ib.quantity, 0) > 0
  ),
  buckets(bucket_order, bucket, min_days, max_days) as (
    values
      (1, '0–30 days', 0, 30),
      (2, '31–60 days', 31, 60),
      (3, '61–90 days', 61, 90),
      (4, '91+ days', 91, 1000000)
  ),
  bucket_totals as (
    select
      b.bucket_order,
      b.bucket,
      count(a.product_id) as product_count,
      coalesce(sum(a.quantity), 0) as quantity,
      coalesce(sum(a.cost_value), 0) as stock_value
    from buckets b
    left join aged a
      on a.age_days between b.min_days and b.max_days
    group by b.bucket_order, b.bucket
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'bucket', bucket,
      'product_count', product_count,
      'quantity', quantity,
      'stock_value', stock_value
    ) order by bucket_order
  ), '[]'::jsonb)
  into v_stock_age
  from bucket_totals;

  with selected_branches as (
    select b.id
    from public.branches b
    where b.organization_id = v_profile.organization_id
      and b.is_active = true
      and (v_all_branches or b.id = v_branch_id)
  ),
  detail as (
    select
      p.id as product_id,
      p.name as product_name,
      p.sku,
      p.barcode,
      coalesce(c.name, 'Uncategorized') as category_name,
      sum(coalesce(ib.quantity, 0)) as quantity,
      sum(private.convert_to_base_currency(
        coalesce(ib.quantity, 0)
          * coalesce(nullif(ib.average_cost, 0), p.default_cost, 0),
        p.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as cost_value,
      sum(private.convert_to_base_currency(
        coalesce(ib.quantity, 0) * p.selling_price,
        p.currency,
        v_base_currency,
        v_usd_to_khr_rate
      )) as retail_value,
      max(coalesce(last_in.last_inbound_at, p.created_at)) as last_inbound_at,
      min(greatest(
        p_to - (timezone(
          v_timezone,
          coalesce(last_in.last_inbound_at, p.created_at)
        ))::date,
        0
      )) as age_days,
      max(coalesce(p.low_stock_threshold, settings.low_stock_threshold, 0)) as low_stock_threshold
    from public.products p
    cross join selected_branches sb
    left join public.categories c on c.id = p.category_id
    left join public.inventory_balances ib
      on ib.product_id = p.id and ib.branch_id = sb.id
    join public.app_settings settings
      on settings.organization_id = p.organization_id
    left join lateral (
      select max(sm.created_at) as last_inbound_at
      from public.stock_movements sm
      where sm.product_id = p.id
        and sm.branch_id = sb.id
        and sm.quantity_change > 0
    ) last_in on true
    where p.organization_id = v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
    group by p.id, p.name, p.sku, p.barcode, c.name
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'product_id', product_id,
      'product_name', product_name,
      'sku', sku,
      'barcode', barcode,
      'category_name', category_name,
      'quantity', quantity,
      'cost_value', cost_value,
      'retail_value', retail_value,
      'potential_margin', retail_value - cost_value,
      'last_inbound_at', last_inbound_at,
      'age_days', age_days,
      'low_stock_threshold', low_stock_threshold,
      'stock_status', case
        when quantity < 0 then 'negative'
        when quantity = 0 then 'out'
        when quantity <= low_stock_threshold then 'low'
        else 'ok'
      end
    ) order by cost_value desc, product_name
  ), '[]'::jsonb)
  into v_stock_rows
  from (
    select *
    from detail
    order by cost_value desc, product_name
    limit 1000
  ) q;

  -- --------------------------------------------------------------------------
  -- Customer analysis
  -- --------------------------------------------------------------------------
  with customer_sales as (
    select
      s.customer_id,
      count(*) as sale_count,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_spend,
      max(coalesce(s.completed_at, s.created_at)) as last_purchase
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.customer_id is not null
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by s.customer_id
  ),
  customer_returns as (
    select
      r.customer_id,
      count(*) as refund_count,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.customer_id is not null
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by r.customer_id
  )
  select jsonb_build_object(
    'total_customers', (
      select count(*) from public.customers c
      where c.organization_id = v_profile.organization_id
    ),
    'active_customers', (
      select count(*) from public.customers c
      where c.organization_id = v_profile.organization_id
        and c.is_active = true
    ),
    'new_customers', (
      select count(*) from public.customers c
      where c.organization_id = v_profile.organization_id
        and (timezone(v_timezone, c.created_at))::date between p_from and p_to
    ),
    'customers_with_sales', (select count(*) from customer_sales),
    'repeat_customers', (
      select count(*) from customer_sales where sale_count >= 2
    ),
    'loyalty_points_outstanding', (
      select coalesce(sum(c.loyalty_points), 0)
      from public.customers c
      where c.organization_id = v_profile.organization_id
        and c.is_active = true
    ),
    'customer_gross_spend', coalesce((select sum(gross_spend) from customer_sales), 0),
    'customer_refunds', coalesce((select sum(refunds) from customer_returns), 0),
    'customer_net_spend',
      coalesce((select sum(gross_spend) from customer_sales), 0)
      - coalesce((select sum(refunds) from customer_returns), 0)
  ) into v_customer_summary;

  with customer_sales as (
    select
      s.customer_id,
      count(*) as sale_count,
      sum(private.convert_to_base_currency(
        s.total_amount, s.currency, v_base_currency, v_usd_to_khr_rate
      )) as gross_spend,
      max(coalesce(s.completed_at, s.created_at)) as last_purchase
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and (v_all_branches or s.branch_id = v_branch_id)
      and s.customer_id is not null
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, coalesce(s.completed_at, s.created_at)))::date
        between p_from and p_to
    group by s.customer_id
  ),
  customer_returns as (
    select
      r.customer_id,
      count(*) as refund_count,
      sum(private.convert_to_base_currency(
        r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
      )) as refunds
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.customer_id is not null
      and r.status = 'completed'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
    group by r.customer_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'customer_id', customer_id,
      'customer_code', customer_code,
      'customer_name', customer_name,
      'customer_type', customer_type,
      'phone', phone,
      'sale_count', sale_count,
      'refund_count', refund_count,
      'gross_spend', gross_spend,
      'refunds', refunds,
      'net_spend', net_spend,
      'average_sale', average_sale,
      'last_purchase', last_purchase,
      'loyalty_points', loyalty_points
    ) order by net_spend desc
  ), '[]'::jsonb)
  into v_top_customers
  from (
    select
      c.id as customer_id,
      c.customer_code,
      c.name as customer_name,
      c.customer_type,
      c.phone,
      s.sale_count,
      coalesce(r.refund_count, 0) as refund_count,
      s.gross_spend,
      coalesce(r.refunds, 0) as refunds,
      s.gross_spend - coalesce(r.refunds, 0) as net_spend,
      case
        when s.sale_count > 0 then round(s.gross_spend / s.sale_count, 2)
        else 0
      end as average_sale,
      s.last_purchase,
      c.loyalty_points
    from customer_sales s
    join public.customers c on c.id = s.customer_id
    left join customer_returns r on r.customer_id = s.customer_id
    order by s.gross_spend - coalesce(r.refunds, 0) desc
    limit 20
  ) ranked_customers;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'customer_type', customer_type,
      'customer_count', customer_count,
      'loyalty_points', loyalty_points
    ) order by customer_count desc
  ), '[]'::jsonb)
  into v_customer_types
  from (
    select
      c.customer_type,
      count(*) as customer_count,
      coalesce(sum(c.loyalty_points), 0) as loyalty_points
    from public.customers c
    where c.organization_id = v_profile.organization_id
      and c.is_active = true
    group by c.customer_type
  ) q;

  return jsonb_build_object(
    'generated_at', now(),
    'from', p_from,
    'to', p_to,
    'timezone', v_timezone,
    'base_currency', v_base_currency,
    'usd_to_khr_rate', v_usd_to_khr_rate,
    'granularity', v_granularity,
    'scope', jsonb_build_object(
      'all_branches', v_all_branches,
      'branch_id', v_branch_id,
      'branch_name', v_branch_name
    ),
    'summary', coalesce(v_summary, '{}'::jsonb),
    'trend', coalesce(v_trend, '[]'::jsonb),
    'payment_methods', coalesce(v_payment_methods, '[]'::jsonb),
    'top_products', coalesce(v_top_products, '[]'::jsonb),
    'top_categories', coalesce(v_top_categories, '[]'::jsonb),
    'cashiers', coalesce(v_cashiers, '[]'::jsonb),
    'sales_rows', coalesce(v_sales_rows, '[]'::jsonb),
    'purchase_rows', coalesce(v_purchase_rows, '[]'::jsonb),
    'top_suppliers', coalesce(v_top_suppliers, '[]'::jsonb),
    'stock_summary', coalesce(v_stock_summary, '{}'::jsonb),
    'stock_age', coalesce(v_stock_age, '[]'::jsonb),
    'stock_rows', coalesce(v_stock_rows, '[]'::jsonb),
    'customer_summary', coalesce(v_customer_summary, '{}'::jsonb),
    'top_customers', coalesce(v_top_customers, '[]'::jsonb),
    'customer_types', coalesce(v_customer_types, '[]'::jsonb),
    'stock_age_note', 'Stock age uses the latest positive stock movement for each product and branch. It is not FIFO batch aging.'
  );
end;
$$;

create or replace function public.process_sale_return_v4(
  p_sale_id uuid,p_items jsonb,p_refund_method text,p_reason text,p_refund_reference text default null,
  p_approval_request_id uuid default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_result jsonb;
  v_return_id uuid;
  v_ri record;
  v_alloc record;
  v_restored numeric(14,3);
  v_available numeric(14,3);
  v_take numeric(14,3);
  v_remaining numeric(14,3);
  v_today date;
  v_org uuid;
  v_branch uuid;
  v_legacy_batch_id uuid;
  v_legacy_batch_number text;
begin
  v_result:=public.process_sale_return_v3(
    p_sale_id,p_items,p_refund_method,p_reason,p_refund_reference,p_approval_request_id
  );
  v_return_id:=(v_result->>'return_id')::uuid;

  if exists(
    select 1
    from public.return_item_batches
    where return_item_id in(
      select id from public.return_items where return_id=v_return_id
    )
  ) then
    return v_result;
  end if;

  v_org:=private.current_organization_id();
  v_branch:=private.current_branch_id();
  v_today:=coalesce(private.batch_business_date(v_org),current_date);

  for v_ri in
    select
      ri.*,
      p.batch_tracking,
      p.expiry_tracking,
      p.name as product_name
    from public.return_items ri
    join public.products p on p.id=ri.product_id
    where ri.return_id=v_return_id
      and ri.restock=true
      and p.batch_tracking=true
  loop
    v_remaining:=v_ri.base_quantity;

    for v_alloc in
      select sib.*
      from public.sale_item_batches sib
      where sib.sale_item_id=v_ri.sale_item_id
      order by sib.allocation_order,sib.created_at
    loop
      exit when v_remaining<=0.0005;

      select coalesce(sum(rib.base_quantity),0)
      into v_restored
      from public.return_item_batches rib
      where rib.sale_item_batch_id=v_alloc.id
        and rib.restocked=true;

      v_available:=greatest(v_alloc.base_quantity-v_restored,0);
      if v_available<=0 then continue; end if;

      v_take:=least(v_remaining,v_available);

      update public.inventory_batches
      set quantity=quantity+v_take,
          initial_quantity=greatest(initial_quantity,quantity+v_take),
          status=case
            when expiry_date is not null and expiry_date<v_today
              then 'quarantined'::public.inventory_batch_status
            else 'active'::public.inventory_batch_status
          end,
          updated_at=now()
      where id=v_alloc.inventory_batch_id;

      insert into public.return_item_batches(
        organization_id,return_item_id,sale_item_batch_id,inventory_batch_id,base_quantity,restocked
      ) values(
        v_org,v_ri.id,v_alloc.id,v_alloc.inventory_batch_id,v_take,true
      );

      v_remaining:=round(v_remaining-v_take,3);
    end loop;

    -- Sales completed before batch tracing was enabled do not have enough
    -- sale_item_batches rows. Preserve the return instead of blocking it by
    -- creating a clearly marked customer-return batch for the unmatched part.
    if v_remaining>0.0005 then
      v_legacy_batch_number:=concat(
        'RETURN-',
        upper(substr(replace(v_return_id::text,'-',''),1,8)),
        '-',
        upper(substr(replace(v_ri.id::text,'-',''),1,8))
      );

      insert into public.inventory_batches(
        organization_id,branch_id,product_id,batch_number,received_date,source_type,
        initial_quantity,quantity,unit_cost,status,notes,created_by
      ) values(
        v_org,
        v_branch,
        v_ri.product_id,
        v_legacy_batch_number,
        v_today,
        'customer_return',
        v_remaining,
        v_remaining,
        coalesce(v_ri.unit_cost,0),
        case
          when v_ri.expiry_tracking
            then 'quarantined'::public.inventory_batch_status
          else 'active'::public.inventory_batch_status
        end,
        concat(
          'Legacy batch recovery for return ',v_return_id::text,
          '. Original sale batch trace was incomplete. Product: ',v_ri.product_name
        ),
        auth.uid()
      ) returning id into v_legacy_batch_id;

      insert into public.return_item_batches(
        organization_id,return_item_id,sale_item_batch_id,inventory_batch_id,base_quantity,restocked
      ) values(
        v_org,v_ri.id,null,v_legacy_batch_id,v_remaining,true
      );
    end if;
  end loop;

  return v_result||jsonb_build_object(
    'batch_restocked',true,
    'legacy_batch_fallback_supported',true
  );
end; $$;

commit;
