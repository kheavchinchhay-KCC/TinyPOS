-- ============================================================================
-- Tiny POS - Step 16: Coupons and promotions
-- Run once in the NEW Supabase project.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. COUPONS AND REDEMPTION HISTORY
-- ----------------------------------------------------------------------------

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  branch_id uuid
    references public.branches(id) on delete cascade,
  code text not null,
  name text not null check (length(trim(name)) between 1 and 120),
  description text,
  discount_type public.discount_type not null
    check (discount_type in ('percent', 'fixed')),
  discount_value numeric(14,4) not null check (discount_value > 0),
  max_discount_amount numeric(14,2)
    check (max_discount_amount is null or max_discount_amount > 0),
  minimum_spend numeric(14,2) not null default 0
    check (minimum_spend >= 0),
  currency public.currency_code not null default 'USD',
  customer_type text
    check (customer_type is null or customer_type in ('regular', 'vip', 'wholesale')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  usage_limit integer check (usage_limit is null or usage_limit > 0),
  per_customer_limit integer
    check (per_customer_limit is null or per_customer_limit > 0),
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check (discount_type <> 'percent' or discount_value <= 100)
);

create unique index if not exists coupons_org_code_uq
  on public.coupons (organization_id, upper(code));

create index if not exists coupons_org_active_dates_idx
  on public.coupons (organization_id, is_active, starts_at, ends_at);

create index if not exists coupons_branch_active_idx
  on public.coupons (branch_id, is_active);

create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  branch_id uuid not null
    references public.branches(id) on delete restrict,
  coupon_id uuid not null
    references public.coupons(id) on delete restrict,
  sale_id uuid not null
    references public.sales(id) on delete cascade,
  customer_id uuid
    references public.customers(id) on delete set null,
  coupon_code text not null,
  discount_amount numeric(14,2) not null check (discount_amount > 0),
  currency public.currency_code not null,
  redeemed_by uuid not null
    references auth.users(id) on delete restrict,
  redeemed_at timestamptz not null default now(),
  unique (sale_id),
  unique (coupon_id, sale_id)
);

create index if not exists coupon_redemptions_coupon_created_idx
  on public.coupon_redemptions (coupon_id, redeemed_at desc);

create index if not exists coupon_redemptions_customer_created_idx
  on public.coupon_redemptions (customer_id, redeemed_at desc)
  where customer_id is not null;

alter table public.sales
  add column if not exists coupon_id uuid
    references public.coupons(id) on delete set null,
  add column if not exists coupon_code text,
  add column if not exists coupon_discount_amount numeric(14,2)
    not null default 0 check (coupon_discount_amount >= 0);

alter table public.parked_sales
  add column if not exists coupon_code text;

create index if not exists sales_coupon_created_idx
  on public.sales (coupon_id, created_at desc)
  where coupon_id is not null;

-- ----------------------------------------------------------------------------
-- 2. NORMALIZATION AND updated_at
-- ----------------------------------------------------------------------------

create or replace function public.normalize_coupon()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.code := upper(trim(new.code));
  new.name := trim(new.name);
  new.description := nullif(trim(new.description), '');

  if new.code !~ '^[A-Z0-9_-]{2,30}$' then
    raise exception 'Coupon code may use only A-Z, 0-9, underscore, and dash';
  end if;

  if new.discount_type = 'fixed' then
    new.max_discount_amount := null;
  end if;

  return new;
end;
$$;

drop trigger if exists normalize_coupon_before_write
  on public.coupons;

create trigger normalize_coupon_before_write
before insert or update on public.coupons
for each row execute function public.normalize_coupon();

drop trigger if exists set_coupons_updated_at
  on public.coupons;

create trigger set_coupons_updated_at
before update on public.coupons
for each row execute function public.set_updated_at();

create or replace function public.audit_coupon_change()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_row public.coupons%rowtype;
  v_action text;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;

  -- Server-side restore/import actions have no authenticated browser user.
  -- Skip per-row coupon audit noise for those operations.
  if auth.uid() is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  v_action := case
    when tg_op = 'INSERT' then 'create_coupon'
    when tg_op = 'UPDATE' then 'update_coupon'
    else 'delete_coupon'
  end;

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    old_data,
    new_data
  )
  values (
    v_row.organization_id,
    coalesce(v_row.branch_id, private.current_branch_id()),
    auth.uid(),
    v_action,
    'coupon',
    v_row.id,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists audit_coupon_after_write
  on public.coupons;

create trigger audit_coupon_after_write
after insert or update or delete on public.coupons
for each row execute function public.audit_coupon_change();

revoke all on function public.audit_coupon_change()
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. RLS AND PRIVILEGES
-- ----------------------------------------------------------------------------

alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;

drop policy if exists coupons_select_staff
  on public.coupons;

create policy coupons_select_staff
on public.coupons
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (
    is_active = true
    or (select private.has_any_role(
      array['owner','admin','manager']::public.app_role[]
    ))
  )
);

drop policy if exists coupons_manage_management
  on public.coupons;

create policy coupons_manage_management
on public.coupons
for all to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin','manager']::public.app_role[]
  ))
)
with check (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin','manager']::public.app_role[]
  ))
);

drop policy if exists coupon_redemptions_select_management
  on public.coupon_redemptions;

create policy coupon_redemptions_select_management
on public.coupon_redemptions
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin','manager']::public.app_role[]
  ))
);

revoke all on public.coupons from anon;
revoke all on public.coupon_redemptions from anon;

grant select, insert, update, delete on public.coupons
  to authenticated;
grant select on public.coupon_redemptions
  to authenticated;
grant all on public.coupons, public.coupon_redemptions
  to service_role;

-- ----------------------------------------------------------------------------
-- 4. SECURE CALCULATION HELPERS
-- ----------------------------------------------------------------------------

create or replace function private.secure_sale_subtotal(
  p_organization_id uuid,
  p_items jsonb,
  p_currency public.currency_code
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_product record;
  v_subtotal numeric(14,2) := 0;
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'The cart is empty';
  end if;

  for v_item in
    select
      x.product_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric)
    group by x.product_id
    order by x.product_id
  loop
    if v_item.product_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every cart item requires a valid product and quantity';
    end if;

    select
      p.id,
      p.name,
      p.selling_price,
      p.currency,
      p.is_active
    into v_product
    from public.products p
    where p.id = v_item.product_id
      and p.organization_id = p_organization_id;

    if not found or v_product.is_active is not true then
      raise exception 'Product % is missing or inactive', v_item.product_id;
    end if;

    if v_product.currency <> p_currency then
      raise exception 'Product "%" uses %, but this sale uses %',
        v_product.name, v_product.currency, p_currency;
    end if;

    v_subtotal := v_subtotal
      + round(v_product.selling_price * v_item.quantity, 2);
  end loop;

  return round(v_subtotal, 2);
end;
$$;

create or replace function private.evaluate_coupon(
  p_organization_id uuid,
  p_branch_id uuid,
  p_code text,
  p_subtotal numeric,
  p_customer_id uuid,
  p_currency public.currency_code,
  p_lock boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coupon public.coupons%rowtype;
  v_customer record;
  v_total_usage integer := 0;
  v_customer_usage integer := 0;
  v_discount numeric(14,2) := 0;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    raise exception 'Enter a coupon code';
  end if;

  if p_lock then
    select c.*
    into v_coupon
    from public.coupons c
    where c.organization_id = p_organization_id
      and upper(c.code) = upper(trim(p_code))
    for update;
  else
    select c.*
    into v_coupon
    from public.coupons c
    where c.organization_id = p_organization_id
      and upper(c.code) = upper(trim(p_code));
  end if;

  if not found then
    raise exception 'Coupon code not found';
  end if;

  if v_coupon.is_active is not true then
    raise exception 'This coupon is inactive';
  end if;

  if v_coupon.branch_id is not null
     and v_coupon.branch_id <> p_branch_id then
    raise exception 'This coupon is not valid at the current branch';
  end if;

  if current_timestamp < v_coupon.starts_at then
    raise exception 'This coupon is not active yet';
  end if;

  if v_coupon.ends_at is not null
     and current_timestamp > v_coupon.ends_at then
    raise exception 'This coupon has expired';
  end if;

  if v_coupon.currency <> p_currency then
    raise exception 'This coupon is valid only for % sales', v_coupon.currency;
  end if;

  if p_subtotal < v_coupon.minimum_spend then
    raise exception 'Minimum spend for this coupon is % %',
      v_coupon.currency, v_coupon.minimum_spend;
  end if;

  if p_customer_id is not null then
    select c.id, c.customer_type, c.is_active
    into v_customer
    from public.customers c
    where c.id = p_customer_id
      and c.organization_id = p_organization_id;

    if not found or v_customer.is_active is not true then
      raise exception 'The selected customer is missing or inactive';
    end if;
  end if;

  if v_coupon.customer_type is not null then
    if p_customer_id is null then
      raise exception 'Select a % customer to use this coupon',
        v_coupon.customer_type;
    end if;

    if v_customer.customer_type <> v_coupon.customer_type then
      raise exception 'This coupon is only for % customers',
        v_coupon.customer_type;
    end if;
  end if;

  select count(*)::integer
  into v_total_usage
  from public.coupon_redemptions cr
  where cr.coupon_id = v_coupon.id;

  if v_coupon.usage_limit is not null
     and v_total_usage >= v_coupon.usage_limit then
    raise exception 'This coupon has reached its usage limit';
  end if;

  if v_coupon.per_customer_limit is not null then
    if p_customer_id is null then
      raise exception 'Select a customer to use this coupon';
    end if;

    select count(*)::integer
    into v_customer_usage
    from public.coupon_redemptions cr
    where cr.coupon_id = v_coupon.id
      and cr.customer_id = p_customer_id;

    if v_customer_usage >= v_coupon.per_customer_limit then
      raise exception 'This customer has reached the coupon usage limit';
    end if;
  end if;

  if v_coupon.discount_type = 'percent' then
    v_discount := round(
      p_subtotal * v_coupon.discount_value / 100,
      2
    );

    if v_coupon.max_discount_amount is not null then
      v_discount := least(v_discount, v_coupon.max_discount_amount);
    end if;
  else
    v_discount := least(
      p_subtotal,
      round(v_coupon.discount_value, 2)
    );
  end if;

  if v_discount <= 0 then
    raise exception 'This coupon produces no discount for the current bill';
  end if;

  return jsonb_build_object(
    'id', v_coupon.id,
    'code', v_coupon.code,
    'name', v_coupon.name,
    'description', v_coupon.description,
    'discount_type', v_coupon.discount_type,
    'discount_value', v_coupon.discount_value,
    'discount_amount', v_discount,
    'max_discount_amount', v_coupon.max_discount_amount,
    'minimum_spend', v_coupon.minimum_spend,
    'currency', v_coupon.currency,
    'customer_type', v_coupon.customer_type,
    'starts_at', v_coupon.starts_at,
    'ends_at', v_coupon.ends_at,
    'usage_limit', v_coupon.usage_limit,
    'usage_count', v_total_usage,
    'per_customer_limit', v_coupon.per_customer_limit,
    'customer_usage_count', v_customer_usage,
    'subtotal', p_subtotal,
    'total_after_discount', greatest(p_subtotal - v_discount, 0)
  );
end;
$$;

revoke all on function private.secure_sale_subtotal(
  uuid, jsonb, public.currency_code
) from public, anon, authenticated;
revoke all on function private.evaluate_coupon(
  uuid, uuid, text, numeric, uuid, public.currency_code, boolean
) from public, anon, authenticated;

grant execute on function private.secure_sale_subtotal(
  uuid, jsonb, public.currency_code
) to service_role;
grant execute on function private.evaluate_coupon(
  uuid, uuid, text, numeric, uuid, public.currency_code, boolean
) to service_role;

-- ----------------------------------------------------------------------------
-- 5. COUPON PREVIEW FOR THE CURRENT BILL
-- ----------------------------------------------------------------------------

create or replace function public.preview_coupon(
  p_code text,
  p_items jsonb,
  p_customer_id uuid default null,
  p_currency public.currency_code default 'USD'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid;
  v_profile record;
  v_subtotal numeric(14,2);
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select p.organization_id, p.branch_id, p.role, p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  if v_profile.role not in ('owner','admin','manager','cashier') then
    raise exception 'Your role cannot apply coupons';
  end if;

  v_subtotal := private.secure_sale_subtotal(
    v_profile.organization_id,
    p_items,
    p_currency
  );

  return private.evaluate_coupon(
    v_profile.organization_id,
    v_profile.branch_id,
    p_code,
    v_subtotal,
    p_customer_id,
    p_currency,
    false
  );
end;
$$;

revoke all on function public.preview_coupon(
  text, jsonb, uuid, public.currency_code
) from public, anon;

grant execute on function public.preview_coupon(
  text, jsonb, uuid, public.currency_code
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. SECURE CHECKOUT V2
-- Recomputes subtotal, discount and tax in PostgreSQL. A coupon and a manual
-- discount cannot be combined in the same sale.
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v2(
  p_items jsonb,
  p_payment_method public.payment_method,
  p_amount_received numeric,
  p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',
  p_manual_discount_value numeric default 0,
  p_coupon_code text default null,
  p_currency public.currency_code default 'USD',
  p_notes text default null,
  p_payment_reference text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid;
  v_profile record;
  v_existing record;
  v_coupon jsonb;
  v_coupon_id uuid;
  v_coupon_code text;
  v_coupon_name text;
  v_subtotal numeric(14,2);
  v_discount_amount numeric(14,2) := 0;
  v_tax_percent numeric(7,4) := 0;
  v_tax_amount numeric(14,2) := 0;
  v_display_discount_type public.discount_type := 'none';
  v_display_discount_value numeric(14,4) := 0;
  v_result jsonb;
  v_sale_id uuid;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select p.organization_id, p.branch_id, p.role, p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  if v_profile.branch_id is null then
    raise exception 'No branch is assigned to this user';
  end if;

  if v_profile.role not in ('owner','admin','manager','cashier') then
    raise exception 'Your role cannot complete sales';
  end if;

  if p_idempotency_key is not null
     and length(trim(p_idempotency_key)) > 0 then
    select
      s.id,
      s.invoice_number,
      s.subtotal,
      s.discount_amount,
      s.tax_amount,
      s.total_amount,
      s.change_amount,
      s.cost_amount,
      s.gross_profit,
      s.coupon_code,
      s.coupon_discount_amount
    into v_existing
    from public.sales s
    where s.organization_id = v_profile.organization_id
      and s.idempotency_key = trim(p_idempotency_key)
    limit 1;

    if found then
      return jsonb_build_object(
        'ok', true,
        'duplicate_request', true,
        'sale_id', v_existing.id,
        'invoice_number', v_existing.invoice_number,
        'subtotal', v_existing.subtotal,
        'discount_amount', v_existing.discount_amount,
        'tax_amount', v_existing.tax_amount,
        'total_amount', v_existing.total_amount,
        'change_amount', v_existing.change_amount,
        'cost_amount', v_existing.cost_amount,
        'gross_profit', v_existing.gross_profit,
        'coupon_code', v_existing.coupon_code,
        'coupon_discount_amount', v_existing.coupon_discount_amount
      );
    end if;
  end if;

  v_subtotal := private.secure_sale_subtotal(
    v_profile.organization_id,
    p_items,
    p_currency
  );

  if p_coupon_code is not null
     and length(trim(p_coupon_code)) > 0 then
    -- Serialize coupon redemptions before checking usage limits. Recheck the
    -- idempotency key after waiting for the coupon lock so a retried request
    -- returns the first sale instead of consuming another coupon use.
    perform 1
    from public.coupons c
    where c.organization_id = v_profile.organization_id
      and upper(c.code) = upper(trim(p_coupon_code))
    for update;

    if not found then
      raise exception 'Coupon code not found';
    end if;

    if p_idempotency_key is not null
       and length(trim(p_idempotency_key)) > 0 then
      select
        s.id,
        s.invoice_number,
        s.subtotal,
        s.discount_amount,
        s.tax_amount,
        s.total_amount,
        s.change_amount,
        s.cost_amount,
        s.gross_profit,
        s.coupon_code,
        s.coupon_discount_amount
      into v_existing
      from public.sales s
      where s.organization_id = v_profile.organization_id
        and s.idempotency_key = trim(p_idempotency_key)
      limit 1;

      if found then
        return jsonb_build_object(
          'ok', true,
          'duplicate_request', true,
          'sale_id', v_existing.id,
          'invoice_number', v_existing.invoice_number,
          'subtotal', v_existing.subtotal,
          'discount_amount', v_existing.discount_amount,
          'tax_amount', v_existing.tax_amount,
          'total_amount', v_existing.total_amount,
          'change_amount', v_existing.change_amount,
          'cost_amount', v_existing.cost_amount,
          'gross_profit', v_existing.gross_profit,
          'coupon_code', v_existing.coupon_code,
          'coupon_discount_amount', v_existing.coupon_discount_amount
        );
      end if;
    end if;

    v_coupon := private.evaluate_coupon(
      v_profile.organization_id,
      v_profile.branch_id,
      p_coupon_code,
      v_subtotal,
      p_customer_id,
      p_currency,
      false
    );

    v_coupon_id := (v_coupon ->> 'id')::uuid;
    v_coupon_code := v_coupon ->> 'code';
    v_coupon_name := v_coupon ->> 'name';
    v_discount_amount := (v_coupon ->> 'discount_amount')::numeric;
    v_display_discount_type :=
      (v_coupon ->> 'discount_type')::public.discount_type;
    v_display_discount_value :=
      (v_coupon ->> 'discount_value')::numeric;
  else
    if p_manual_discount_value is null
       or p_manual_discount_value < 0 then
      raise exception 'Invalid discount value';
    end if;

    if p_manual_discount_type = 'percent' then
      if p_manual_discount_value > 100 then
        raise exception 'Percentage discount cannot exceed 100';
      end if;

      v_discount_amount := round(
        v_subtotal * p_manual_discount_value / 100,
        2
      );
      v_display_discount_type := 'percent';
      v_display_discount_value := p_manual_discount_value;
    elsif p_manual_discount_type = 'fixed' then
      v_discount_amount := least(
        v_subtotal,
        round(p_manual_discount_value, 2)
      );
      v_display_discount_type := 'fixed';
      v_display_discount_value := p_manual_discount_value;
    else
      v_discount_amount := 0;
      v_display_discount_type := 'none';
      v_display_discount_value := 0;
    end if;
  end if;

  select coalesce(s.tax_percent, 0)
  into v_tax_percent
  from public.app_settings s
  where s.organization_id = v_profile.organization_id;

  v_tax_amount := round(
    greatest(v_subtotal - v_discount_amount, 0)
      * greatest(v_tax_percent, 0) / 100,
    2
  );

  v_result := public.complete_sale(
    p_items,
    p_payment_method,
    p_amount_received,
    p_customer_id,
    case
      when v_discount_amount > 0 then 'fixed'::public.discount_type
      else 'none'::public.discount_type
    end,
    v_discount_amount,
    v_tax_amount,
    p_currency,
    p_notes,
    p_payment_reference,
    p_idempotency_key
  );

  if coalesce((v_result ->> 'duplicate_request')::boolean, false) then
    return v_result;
  end if;

  v_sale_id := (v_result ->> 'sale_id')::uuid;

  update public.sales
  set
    discount_type = v_display_discount_type,
    discount_value = v_display_discount_value,
    coupon_id = v_coupon_id,
    coupon_code = v_coupon_code,
    coupon_discount_amount = case
      when v_coupon_id is null then 0
      else v_discount_amount
    end,
    updated_at = now()
  where id = v_sale_id;

  if v_coupon_id is not null then
    insert into public.coupon_redemptions (
      organization_id,
      branch_id,
      coupon_id,
      sale_id,
      customer_id,
      coupon_code,
      discount_amount,
      currency,
      redeemed_by
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_coupon_id,
      v_sale_id,
      p_customer_id,
      v_coupon_code,
      v_discount_amount,
      p_currency,
      v_user_id
    );

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
      'redeem_coupon',
      'coupon',
      v_coupon_id,
      jsonb_build_object(
        'coupon_code', v_coupon_code,
        'coupon_name', v_coupon_name,
        'sale_id', v_sale_id,
        'invoice_number', v_result ->> 'invoice_number',
        'discount_amount', v_discount_amount,
        'currency', p_currency
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'discount_amount', v_discount_amount,
    'tax_amount', v_tax_amount,
    'coupon_id', v_coupon_id,
    'coupon_code', v_coupon_code,
    'coupon_name', v_coupon_name,
    'coupon_discount_amount', case
      when v_coupon_id is null then 0
      else v_discount_amount
    end
  );
end;
$$;

revoke all on function public.complete_sale_v2(
  jsonb,
  public.payment_method,
  numeric,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  text,
  text,
  text
) from public, anon;

grant execute on function public.complete_sale_v2(
  jsonb,
  public.payment_method,
  numeric,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  text,
  text,
  text
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 16
-- ============================================================================
