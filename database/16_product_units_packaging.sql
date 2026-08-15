-- ============================================================================
-- Tiny POS - Step 18: Product units and sales packaging
-- Run once in the NEW Supabase project after Step 17.
--
-- Examples:
--   Base unit: Piece, factor 1, price $0.75
--   Box:       Box,   factor 24, price $16.00
--   Carton:    Carton,factor 240, price $150.00
--
-- Inventory is always stored in the base unit.
-- This migration does not delete existing business data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PRODUCT SELLING UNITS
-- ----------------------------------------------------------------------------

create table if not exists public.product_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  product_id uuid not null
    references public.products(id) on delete cascade,

  name text not null
    check (length(trim(name)) between 1 and 60),
  short_name text,

  -- Number of base units contained in one of this unit.
  conversion_factor numeric(14,3) not null default 1
    check (conversion_factor > 0),

  selling_price numeric(14,2) not null default 0
    check (selling_price >= 0),

  barcode text,
  is_base boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,

  created_by uuid
    references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (product_id, name),
  check (barcode is null or length(trim(barcode)) > 0),
  check (short_name is null or length(trim(short_name)) > 0),
  check (not is_base or conversion_factor = 1)
);

create unique index if not exists product_units_one_base_uq
  on public.product_units (product_id)
  where is_base = true;

create unique index if not exists product_units_org_barcode_uq
  on public.product_units (organization_id, barcode)
  where barcode is not null;

create index if not exists product_units_product_sort_idx
  on public.product_units (
    product_id,
    is_active desc,
    is_base desc,
    sort_order,
    name
  );

drop trigger if exists set_product_units_updated_at
  on public.product_units;

create trigger set_product_units_updated_at
before update on public.product_units
for each row execute function public.set_updated_at();

-- Backfill one base selling unit for every existing product.
insert into public.product_units (
  organization_id,
  product_id,
  name,
  short_name,
  conversion_factor,
  selling_price,
  barcode,
  is_base,
  is_active,
  sort_order,
  created_by
)
select
  p.organization_id,
  p.id,
  coalesce(nullif(trim(p.unit_name), ''), 'pcs'),
  coalesce(nullif(trim(p.unit_name), ''), 'pcs'),
  1,
  p.selling_price,
  p.barcode,
  true,
  p.is_active,
  0,
  p.created_by
from public.products p
where not exists (
  select 1
  from public.product_units pu
  where pu.product_id = p.id
    and pu.is_base = true
);

-- ----------------------------------------------------------------------------
-- 2. KEEP THE PRODUCT BASE FIELDS AND BASE UNIT SYNCHRONIZED
-- ----------------------------------------------------------------------------

create or replace function private.check_product_barcode_conflict()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.barcode is null or length(trim(new.barcode)) = 0 then
    new.barcode := null;
    return new;
  end if;

  new.barcode := trim(new.barcode);

  if exists (
    select 1
    from public.product_units pu
    where pu.organization_id = new.organization_id
      and pu.barcode = new.barcode
      and pu.product_id <> new.id
  ) then
    raise exception 'Barcode % is already assigned to another product unit',
      new.barcode;
  end if;

  return new;
end;
$$;

drop trigger if exists check_product_barcode_conflict
  on public.products;

create trigger check_product_barcode_conflict
before insert or update of barcode
on public.products
for each row execute function private.check_product_barcode_conflict();

create or replace function private.check_product_unit_barcode_conflict()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.barcode is null or length(trim(new.barcode)) = 0 then
    new.barcode := null;
    return new;
  end if;

  new.barcode := trim(new.barcode);

  if exists (
    select 1
    from public.products p
    where p.organization_id = new.organization_id
      and p.barcode = new.barcode
      and p.id <> new.product_id
  ) then
    raise exception 'Barcode % is already assigned to another product',
      new.barcode;
  end if;

  return new;
end;
$$;

drop trigger if exists check_product_unit_barcode_conflict
  on public.product_units;

create trigger check_product_unit_barcode_conflict
before insert or update of barcode
on public.product_units
for each row execute function private.check_product_unit_barcode_conflict();

create or replace function private.ensure_product_base_unit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.product_units (
    organization_id,
    product_id,
    name,
    short_name,
    conversion_factor,
    selling_price,
    barcode,
    is_base,
    is_active,
    sort_order,
    created_by
  )
  values (
    new.organization_id,
    new.id,
    coalesce(nullif(trim(new.unit_name), ''), 'pcs'),
    coalesce(nullif(trim(new.unit_name), ''), 'pcs'),
    1,
    new.selling_price,
    new.barcode,
    true,
    new.is_active,
    0,
    new.created_by
  )
  on conflict (product_id)
    where is_base = true
  do update
  set
    name = excluded.name,
    short_name = excluded.short_name,
    selling_price = excluded.selling_price,
    barcode = excluded.barcode,
    is_active = excluded.is_active,
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists ensure_product_base_unit
  on public.products;

create trigger ensure_product_base_unit
after insert or update of
  unit_name,
  selling_price,
  barcode,
  is_active
on public.products
for each row execute function private.ensure_product_base_unit();

create or replace function private.sync_product_from_base_unit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_base is not true then
    return new;
  end if;

  update public.products p
  set
    unit_name = new.name,
    selling_price = new.selling_price,
    barcode = new.barcode,
    is_active = new.is_active,
    updated_at = now()
  where p.id = new.product_id
    and (
      p.unit_name is distinct from new.name
      or p.selling_price is distinct from new.selling_price
      or p.barcode is distinct from new.barcode
      or p.is_active is distinct from new.is_active
    );

  return new;
end;
$$;

drop trigger if exists sync_product_from_base_unit
  on public.product_units;

create trigger sync_product_from_base_unit
after insert or update of
  name,
  selling_price,
  barcode,
  is_active,
  is_base
on public.product_units
for each row execute function private.sync_product_from_base_unit();

-- ----------------------------------------------------------------------------
-- 3. SALE AND RETURN ITEM UNIT SNAPSHOTS
-- ----------------------------------------------------------------------------

alter table public.sale_items
  add column if not exists product_unit_id uuid
    references public.product_units(id) on delete set null,
  add column if not exists sale_unit_name text,
  add column if not exists unit_factor numeric(14,3) not null default 1
    check (unit_factor > 0),
  add column if not exists base_quantity numeric(14,3);

update public.sale_items si
set
  product_unit_id = coalesce(
    si.product_unit_id,
    (
      select pu.id
      from public.product_units pu
      where pu.product_id = si.product_id
        and pu.is_base = true
      limit 1
    )
  ),
  sale_unit_name = coalesce(
    nullif(si.sale_unit_name, ''),
    (
      select pu.name
      from public.product_units pu
      where pu.product_id = si.product_id
        and pu.is_base = true
      limit 1
    ),
    'pcs'
  ),
  unit_factor = coalesce(nullif(si.unit_factor, 0), 1),
  base_quantity = coalesce(si.base_quantity, si.quantity)
where
  si.sale_unit_name is null
  or si.base_quantity is null
  or si.product_unit_id is null;

alter table public.sale_items
  alter column sale_unit_name set default 'pcs',
  alter column sale_unit_name set not null,
  alter column base_quantity set default 1,
  alter column base_quantity set not null;

alter table public.return_items
  add column if not exists return_unit_name text,
  add column if not exists unit_factor numeric(14,3) not null default 1
    check (unit_factor > 0),
  add column if not exists base_quantity numeric(14,3);

update public.return_items ri
set
  return_unit_name = coalesce(
    nullif(ri.return_unit_name, ''),
    (
      select si.sale_unit_name
      from public.sale_items si
      where si.id = ri.sale_item_id
    ),
    'pcs'
  ),
  unit_factor = coalesce(
    nullif(ri.unit_factor, 0),
    (
      select si.unit_factor
      from public.sale_items si
      where si.id = ri.sale_item_id
    ),
    1
  ),
  base_quantity = coalesce(
    ri.base_quantity,
    ri.quantity * coalesce(
      (
        select si.unit_factor
        from public.sale_items si
        where si.id = ri.sale_item_id
      ),
      1
    )
  )
where
  ri.return_unit_name is null
  or ri.base_quantity is null;

alter table public.return_items
  alter column return_unit_name set default 'pcs',
  alter column return_unit_name set not null,
  alter column base_quantity set default 1,
  alter column base_quantity set not null;

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table public.product_units enable row level security;

drop policy if exists product_units_select_active_user
  on public.product_units;
drop policy if exists product_units_manage_management
  on public.product_units;

create policy product_units_select_active_user
on public.product_units
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
);

create policy product_units_manage_management
on public.product_units
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

revoke all on public.product_units from anon;
grant select, insert, update, delete
  on public.product_units to authenticated;
grant all on public.product_units to service_role;

-- ----------------------------------------------------------------------------
-- 5. SECURE UNIT-AWARE SALE SUBTOTAL
-- Existing preview_coupon() automatically uses this replaced helper.
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
  v_unit record;
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
      x.product_unit_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric
      )
    group by x.product_id, x.product_unit_id
    order by x.product_id, x.product_unit_id
  loop
    if v_item.product_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every cart item requires a valid product and quantity';
    end if;

    select
      p.id,
      p.name,
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

    select
      pu.id,
      pu.name,
      pu.conversion_factor,
      pu.selling_price,
      pu.is_active
    into v_unit
    from public.product_units pu
    where pu.organization_id = p_organization_id
      and pu.product_id = v_product.id
      and (
        (
          v_item.product_unit_id is not null
          and pu.id = v_item.product_unit_id
        )
        or
        (
          v_item.product_unit_id is null
          and pu.is_base = true
        )
      )
    limit 1;

    if not found or v_unit.is_active is not true then
      raise exception 'The selected selling unit for "%" is unavailable',
        v_product.name;
    end if;

    v_subtotal := v_subtotal
      + round(v_unit.selling_price * v_item.quantity, 2);
  end loop;

  return round(v_subtotal, 2);
end;
$$;

revoke all on function private.secure_sale_subtotal(
  uuid,
  jsonb,
  public.currency_code
) from public, anon, authenticated;

grant execute on function private.secure_sale_subtotal(
  uuid,
  jsonb,
  public.currency_code
) to service_role;

-- ----------------------------------------------------------------------------
-- 6. SECURE UNIT-AWARE CHECKOUT V3
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v3(
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
  v_user_id uuid := auth.uid();
  v_profile record;
  v_settings record;
  v_existing record;
  v_item record;
  v_product record;
  v_unit record;
  v_balance record;

  v_coupon jsonb;
  v_coupon_id uuid;
  v_coupon_code text;
  v_coupon_name text;

  v_sale_id uuid;
  v_invoice_number text;

  v_subtotal numeric(14,2) := 0;
  v_discount_amount numeric(14,2) := 0;
  v_tax_amount numeric(14,2) := 0;
  v_total numeric(14,2) := 0;
  v_change numeric(14,2) := 0;

  v_display_discount_type public.discount_type := 'none';
  v_display_discount_value numeric(14,4) := 0;

  v_item_count integer := 0;
  v_item_index integer := 0;
  v_allocated_discount numeric(14,2) := 0;

  v_base_quantity numeric(14,3);
  v_line_subtotal numeric(14,2);
  v_line_discount numeric(14,2);
  v_line_total numeric(14,2);
  v_base_unit_cost numeric(14,4);
  v_selected_unit_cost numeric(14,4);
  v_line_cost numeric(14,4);

  v_cost_total numeric(14,4) := 0;
  v_profit_total numeric(14,4) := 0;
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

  if v_profile.branch_id is null then
    raise exception 'No branch is assigned to this user';
  end if;

  if v_profile.role not in ('owner','admin','manager','cashier') then
    raise exception 'Your role cannot complete sales';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'The cart is empty';
  end if;

  if p_amount_received is null or p_amount_received < 0 then
    raise exception 'Invalid received amount';
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

  if p_customer_id is not null and not exists (
    select 1
    from public.customers c
    where c.id = p_customer_id
      and c.organization_id = v_profile.organization_id
      and c.is_active = true
  ) then
    raise exception 'Customer not found or inactive';
  end if;

  select
    coalesce(s.allow_negative_stock, false) as allow_negative_stock,
    coalesce(s.tax_percent, 0) as tax_percent
  into v_settings
  from public.app_settings s
  where s.organization_id = v_profile.organization_id;

  v_subtotal := private.secure_sale_subtotal(
    v_profile.organization_id,
    p_items,
    p_currency
  );

  if p_coupon_code is not null
     and length(trim(p_coupon_code)) > 0 then
    perform 1
    from public.coupons c
    where c.organization_id = v_profile.organization_id
      and upper(c.code) = upper(trim(p_coupon_code))
    for update;

    if not found then
      raise exception 'Coupon code not found';
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
    v_discount_amount :=
      (v_coupon ->> 'discount_amount')::numeric;
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

  v_tax_amount := round(
    greatest(v_subtotal - v_discount_amount, 0)
      * greatest(coalesce(v_settings.tax_percent, 0), 0) / 100,
    2
  );

  v_total := greatest(
    round(v_subtotal - v_discount_amount + v_tax_amount, 2),
    0
  );

  if p_amount_received < v_total then
    raise exception 'Received amount (%) is less than total (%)',
      p_amount_received, v_total;
  end if;

  if p_payment_method = 'cash' then
    v_change := round(p_amount_received - v_total, 2);
  else
    v_change := 0;
  end if;

  select count(*)
  into v_item_count
  from (
    select
      x.product_id,
      x.product_unit_id
    from jsonb_to_recordset(p_items)
      as x(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric
      )
    group by x.product_id, x.product_unit_id
  ) grouped_items;

  -- Lock product inventory in a stable order and verify stock.
  for v_item in
    select
      x.product_id,
      x.product_unit_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric
      )
    group by x.product_id, x.product_unit_id
    order by x.product_id, x.product_unit_id
  loop
    if v_item.product_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every cart item requires a valid quantity';
    end if;

    select
      p.id,
      p.name,
      p.barcode,
      p.default_cost,
      p.currency,
      p.track_stock,
      p.allow_negative_stock,
      p.is_active
    into v_product
    from public.products p
    where p.id = v_item.product_id
      and p.organization_id = v_profile.organization_id
    for share;

    if not found or v_product.is_active is not true then
      raise exception 'Product % is missing or inactive',
        v_item.product_id;
    end if;

    if v_product.currency <> p_currency then
      raise exception 'Product "%" uses %, but this sale uses %',
        v_product.name, v_product.currency, p_currency;
    end if;

    select
      pu.id,
      pu.name,
      pu.barcode,
      pu.conversion_factor,
      pu.selling_price,
      pu.is_active
    into v_unit
    from public.product_units pu
    where pu.organization_id = v_profile.organization_id
      and pu.product_id = v_product.id
      and (
        (
          v_item.product_unit_id is not null
          and pu.id = v_item.product_unit_id
        )
        or
        (
          v_item.product_unit_id is null
          and pu.is_base = true
        )
      )
    limit 1;

    if not found or v_unit.is_active is not true then
      raise exception 'The selected selling unit for "%" is unavailable',
        v_product.name;
    end if;

    v_base_quantity := round(
      v_item.quantity * v_unit.conversion_factor,
      3
    );

    insert into public.inventory_balances (
      organization_id,
      branch_id,
      product_id,
      quantity,
      average_cost
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_product.id,
      0,
      v_product.default_cost
    )
    on conflict (branch_id, product_id) do nothing;

    select
      ib.quantity,
      ib.average_cost
    into v_balance
    from public.inventory_balances ib
    where ib.branch_id = v_profile.branch_id
      and ib.product_id = v_product.id
    for update;

    if v_product.track_stock
       and not (
         coalesce(v_settings.allow_negative_stock, false)
         or v_product.allow_negative_stock
       )
       and v_balance.quantity < v_base_quantity then
      raise exception
        'Not enough stock for "%". Available: % base units; requested: %',
        v_product.name,
        v_balance.quantity,
        v_base_quantity;
    end if;
  end loop;

  v_invoice_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'INV'
  );

  insert into public.sales (
    organization_id,
    branch_id,
    invoice_number,
    idempotency_key,
    customer_id,
    cashier_id,
    status,
    payment_status,
    currency,
    subtotal,
    discount_type,
    discount_value,
    discount_amount,
    tax_amount,
    total_amount,
    paid_amount,
    change_amount,
    cost_amount,
    gross_profit,
    notes,
    completed_at,
    coupon_id,
    coupon_code,
    coupon_discount_amount
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_invoice_number,
    nullif(trim(p_idempotency_key), ''),
    p_customer_id,
    v_user_id,
    'completed',
    'paid',
    p_currency,
    v_subtotal,
    v_display_discount_type,
    v_display_discount_value,
    v_discount_amount,
    v_tax_amount,
    v_total,
    v_total,
    v_change,
    0,
    0,
    nullif(trim(p_notes), ''),
    now(),
    v_coupon_id,
    v_coupon_code,
    case when v_coupon_id is null then 0 else v_discount_amount end
  )
  returning id into v_sale_id;

  for v_item in
    select
      x.product_id,
      x.product_unit_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric
      )
    group by x.product_id, x.product_unit_id
    order by x.product_id, x.product_unit_id
  loop
    v_item_index := v_item_index + 1;

    select
      p.id,
      p.name,
      p.barcode,
      p.default_cost,
      p.track_stock
    into strict v_product
    from public.products p
    where p.id = v_item.product_id
      and p.organization_id = v_profile.organization_id;

    select
      pu.id,
      pu.name,
      pu.barcode,
      pu.conversion_factor,
      pu.selling_price
    into strict v_unit
    from public.product_units pu
    where pu.organization_id = v_profile.organization_id
      and pu.product_id = v_product.id
      and (
        (
          v_item.product_unit_id is not null
          and pu.id = v_item.product_unit_id
        )
        or
        (
          v_item.product_unit_id is null
          and pu.is_base = true
        )
      )
    limit 1;

    select
      ib.quantity,
      ib.average_cost
    into strict v_balance
    from public.inventory_balances ib
    where ib.branch_id = v_profile.branch_id
      and ib.product_id = v_product.id
    for update;

    v_base_quantity := round(
      v_item.quantity * v_unit.conversion_factor,
      3
    );
    v_line_subtotal := round(
      v_unit.selling_price * v_item.quantity,
      2
    );

    if v_item_index = v_item_count then
      v_line_discount :=
        v_discount_amount - v_allocated_discount;
    elsif v_subtotal > 0 then
      v_line_discount := round(
        v_discount_amount * v_line_subtotal / v_subtotal,
        2
      );
      v_allocated_discount :=
        v_allocated_discount + v_line_discount;
    else
      v_line_discount := 0;
    end if;

    v_line_total := greatest(
      v_line_subtotal - v_line_discount,
      0
    );

    v_base_unit_cost := coalesce(
      nullif(v_balance.average_cost, 0),
      v_product.default_cost,
      0
    );
    v_selected_unit_cost := round(
      v_base_unit_cost * v_unit.conversion_factor,
      4
    );
    v_line_cost := round(
      v_selected_unit_cost * v_item.quantity,
      4
    );

    insert into public.sale_items (
      organization_id,
      sale_id,
      product_id,
      product_unit_id,
      product_name,
      barcode,
      quantity,
      base_quantity,
      sale_unit_name,
      unit_factor,
      unit_price,
      unit_cost,
      discount_amount,
      tax_amount,
      line_total,
      line_profit
    )
    values (
      v_profile.organization_id,
      v_sale_id,
      v_product.id,
      v_unit.id,
      v_product.name,
      coalesce(v_unit.barcode, v_product.barcode),
      v_item.quantity,
      v_base_quantity,
      v_unit.name,
      v_unit.conversion_factor,
      v_unit.selling_price,
      v_selected_unit_cost,
      v_line_discount,
      0,
      v_line_total,
      round(v_line_total - v_line_cost, 4)
    );

    v_cost_total := v_cost_total + v_line_cost;
    v_profit_total :=
      v_profit_total + round(v_line_total - v_line_cost, 4);

    if v_product.track_stock then
      update public.inventory_balances
      set
        quantity = quantity - v_base_quantity,
        updated_at = now()
      where branch_id = v_profile.branch_id
        and product_id = v_product.id;

      insert into public.stock_movements (
        organization_id,
        branch_id,
        product_id,
        movement_type,
        quantity_change,
        quantity_before,
        quantity_after,
        unit_cost,
        reference_table,
        reference_id,
        notes,
        created_by
      )
      values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_product.id,
        'sale',
        -v_base_quantity,
        v_balance.quantity,
        v_balance.quantity - v_base_quantity,
        v_base_unit_cost,
        'sales',
        v_sale_id,
        format(
          '%s · %s %s (%s base units)',
          v_invoice_number,
          v_item.quantity,
          v_unit.name,
          v_base_quantity
        ),
        v_user_id
      );
    end if;
  end loop;

  update public.sales
  set
    cost_amount = v_cost_total,
    gross_profit = v_profit_total,
    updated_at = now()
  where id = v_sale_id;

  if v_total > 0 then
    insert into public.payments (
      organization_id,
      branch_id,
      sale_id,
      method,
      currency,
      amount,
      tendered_amount,
      change_amount,
      reference_number,
      received_by
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_sale_id,
      p_payment_method,
      p_currency,
      v_total,
      p_amount_received,
      v_change,
      nullif(trim(p_payment_reference), ''),
      v_user_id
    );
  end if;

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
  end if;

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
    'complete_sale',
    'sale',
    v_sale_id,
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'subtotal', v_subtotal,
      'discount_amount', v_discount_amount,
      'tax_amount', v_tax_amount,
      'total_amount', v_total,
      'cost_amount', v_cost_total,
      'gross_profit', v_profit_total,
      'coupon_code', v_coupon_code,
      'unit_aware', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate_request', false,
    'sale_id', v_sale_id,
    'invoice_number', v_invoice_number,
    'subtotal', v_subtotal,
    'discount_amount', v_discount_amount,
    'tax_amount', v_tax_amount,
    'total_amount', v_total,
    'amount_received', p_amount_received,
    'change_amount', v_change,
    'cost_amount', v_cost_total,
    'gross_profit', v_profit_total,
    'coupon_id', v_coupon_id,
    'coupon_code', v_coupon_code,
    'coupon_name', v_coupon_name,
    'coupon_discount_amount',
      case when v_coupon_id is null then 0 else v_discount_amount end
  );

exception
  when unique_violation then
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
          'coupon_discount_amount',
            v_existing.coupon_discount_amount
        );
      end if;
    end if;

    raise;
end;
$$;

revoke all on function public.complete_sale_v3(
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

grant execute on function public.complete_sale_v3(
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

-- ----------------------------------------------------------------------------
-- 7. UNIT-AWARE CUSTOMER RETURNS
-- Quantity entered by the manager remains in the sold unit.
-- Inventory restocking converts it back to the base quantity.
-- ----------------------------------------------------------------------------

create or replace function public.process_sale_return(
  p_sale_id uuid,
  p_items jsonb,
  p_refund_method public.payment_method,
  p_reason text,
  p_refund_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_sale record;
  v_item record;
  v_sale_item record;
  v_balance record;

  v_return_id uuid;
  v_return_number text;
  v_new_sale_status public.sale_status;
  v_new_payment_status public.payment_status;

  v_previous_returned numeric(14,3);
  v_available numeric(14,3);
  v_requested numeric(14,3);
  v_base_return_quantity numeric(14,3);

  v_sale_line_total numeric(14,2);
  v_previous_tax_refunded numeric(14,2);
  v_remaining_tax numeric(14,2);

  v_net_refund numeric(14,2);
  v_tax_refund numeric(14,2);
  v_line_refund numeric(14,2);
  v_unit_refund numeric(14,2);
  v_line_cost numeric(14,4);
  v_profit_reversal numeric(14,4);
  v_base_unit_cost numeric(14,4);

  v_total_refund numeric(14,2) := 0;
  v_total_tax_refund numeric(14,2) := 0;
  v_total_cost numeric(14,4) := 0;
  v_total_profit_reversal numeric(14,4) := 0;

  v_total_sold_qty numeric(14,3);
  v_total_returned_qty numeric(14,3);

  v_new_quantity numeric(14,3);
  v_new_average_cost numeric(14,4);
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

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Only an owner, admin, or manager can process refunds';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to refund';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A refund reason is required';
  end if;

  select s.*
  into v_sale
  from public.sales s
  where s.id = p_sale_id
    and s.organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Sale not found';
  end if;

  if v_sale.branch_id <> v_profile.branch_id then
    raise exception 'This sale belongs to another branch';
  end if;

  if v_sale.status not in ('completed','partially_refunded') then
    raise exception
      'This sale cannot be refunded because its status is %',
      v_sale.status;
  end if;

  select coalesce(sum(si.line_total), 0)
  into v_sale_line_total
  from public.sale_items si
  where si.sale_id = v_sale.id;

  select coalesce(sum(ri.tax_refund), 0)
  into v_previous_tax_refunded
  from public.return_items ri
  join public.returns r on r.id = ri.return_id
  where r.original_sale_id = v_sale.id
    and r.status = 'completed';

  v_remaining_tax := greatest(
    v_sale.tax_amount - v_previous_tax_refunded,
    0
  );

  v_return_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'RET'
  );

  insert into public.returns (
    organization_id,
    branch_id,
    return_number,
    original_sale_id,
    customer_id,
    status,
    currency,
    refund_amount,
    refund_method,
    reason,
    processed_by,
    processed_at,
    tax_refund,
    cost_amount,
    profit_reversal,
    refund_reference
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_return_number,
    v_sale.id,
    v_sale.customer_id,
    'completed',
    v_sale.currency,
    0,
    p_refund_method,
    trim(p_reason),
    v_user_id,
    now(),
    0,
    0,
    0,
    nullif(trim(p_refund_reference), '')
  )
  returning id into v_return_id;

  for v_item in
    select
      x.sale_item_id,
      sum(x.quantity)::numeric(14,3) as quantity,
      bool_and(coalesce(x.restock, true)) as restock
    from jsonb_to_recordset(p_items)
      as x(
        sale_item_id uuid,
        quantity numeric,
        restock boolean
      )
    group by x.sale_item_id
    order by x.sale_item_id
  loop
    v_requested := v_item.quantity;

    if v_item.sale_item_id is null
       or v_requested is null
       or v_requested <= 0 then
      raise exception 'Every refund item requires a valid quantity';
    end if;

    select
      si.id,
      si.sale_id,
      si.product_id,
      si.product_name,
      si.quantity,
      si.base_quantity,
      si.sale_unit_name,
      si.unit_factor,
      si.unit_price,
      si.unit_cost,
      si.line_total,
      p.track_stock
    into v_sale_item
    from public.sale_items si
    left join public.products p on p.id = si.product_id
    where si.id = v_item.sale_item_id
      and si.sale_id = v_sale.id
    for update of si;

    if not found then
      raise exception
        'Sale item % does not belong to this sale',
        v_item.sale_item_id;
    end if;

    select coalesce(sum(ri.quantity), 0)
    into v_previous_returned
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    where ri.sale_item_id = v_sale_item.id
      and r.status = 'completed';

    v_available := v_sale_item.quantity - v_previous_returned;

    if v_requested > v_available then
      raise exception
        'Only % % of "%" can still be refunded',
        v_available,
        v_sale_item.sale_unit_name,
        v_sale_item.product_name;
    end if;

    v_base_return_quantity := round(
      v_requested * v_sale_item.unit_factor,
      3
    );

    v_net_refund := round(
      v_sale_item.line_total
        * v_requested / v_sale_item.quantity,
      2
    );

    if v_sale_line_total > 0 and v_remaining_tax > 0 then
      v_tax_refund := least(
        v_remaining_tax,
        round(
          v_sale.tax_amount
            * (v_sale_item.line_total / v_sale_line_total)
            * (v_requested / v_sale_item.quantity),
          2
        )
      );
    else
      v_tax_refund := 0;
    end if;

    v_remaining_tax := greatest(
      v_remaining_tax - v_tax_refund,
      0
    );
    v_line_refund := round(v_net_refund + v_tax_refund, 2);
    v_unit_refund := round(v_line_refund / v_requested, 2);
    v_line_cost := round(
      v_sale_item.unit_cost * v_requested,
      4
    );
    v_profit_reversal := round(
      v_net_refund - v_line_cost,
      4
    );

    insert into public.return_items (
      organization_id,
      return_id,
      sale_item_id,
      product_id,
      quantity,
      base_quantity,
      return_unit_name,
      unit_factor,
      unit_refund,
      line_refund,
      restock,
      tax_refund,
      unit_cost,
      line_cost,
      line_profit_reversal
    )
    values (
      v_profile.organization_id,
      v_return_id,
      v_sale_item.id,
      v_sale_item.product_id,
      v_requested,
      v_base_return_quantity,
      v_sale_item.sale_unit_name,
      v_sale_item.unit_factor,
      v_unit_refund,
      v_line_refund,
      coalesce(v_item.restock, true),
      v_tax_refund,
      v_sale_item.unit_cost,
      v_line_cost,
      v_profit_reversal
    );

    v_total_refund := v_total_refund + v_line_refund;
    v_total_tax_refund :=
      v_total_tax_refund + v_tax_refund;
    v_total_cost := v_total_cost + v_line_cost;
    v_total_profit_reversal :=
      v_total_profit_reversal + v_profit_reversal;

    if coalesce(v_item.restock, true)
       and v_sale_item.product_id is not null
       and coalesce(v_sale_item.track_stock, false) then

      v_base_unit_cost := case
        when v_sale_item.unit_factor > 0
          then v_sale_item.unit_cost / v_sale_item.unit_factor
        else v_sale_item.unit_cost
      end;

      insert into public.inventory_balances (
        organization_id,
        branch_id,
        product_id,
        quantity,
        average_cost
      )
      values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_sale_item.product_id,
        0,
        v_base_unit_cost
      )
      on conflict (branch_id, product_id) do nothing;

      select
        ib.quantity,
        ib.average_cost
      into v_balance
      from public.inventory_balances ib
      where ib.branch_id = v_profile.branch_id
        and ib.product_id = v_sale_item.product_id
      for update;

      v_new_quantity :=
        v_balance.quantity + v_base_return_quantity;

      if v_new_quantity > 0 and v_balance.quantity >= 0 then
        v_new_average_cost := round(
          (
            (v_balance.quantity * v_balance.average_cost)
            + (v_base_return_quantity * v_base_unit_cost)
          ) / v_new_quantity,
          4
        );
      else
        v_new_average_cost := v_base_unit_cost;
      end if;

      update public.inventory_balances
      set
        quantity = v_new_quantity,
        average_cost = v_new_average_cost,
        updated_at = now()
      where branch_id = v_profile.branch_id
        and product_id = v_sale_item.product_id;

      insert into public.stock_movements (
        organization_id,
        branch_id,
        product_id,
        movement_type,
        quantity_change,
        quantity_before,
        quantity_after,
        unit_cost,
        reference_table,
        reference_id,
        notes,
        created_by
      )
      values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_sale_item.product_id,
        'customer_return',
        v_base_return_quantity,
        v_balance.quantity,
        v_new_quantity,
        v_base_unit_cost,
        'returns',
        v_return_id,
        format(
          '%s · %s %s (%s base units)',
          v_return_number,
          v_requested,
          v_sale_item.sale_unit_name,
          v_base_return_quantity
        ),
        v_user_id
      );
    end if;
  end loop;

  if v_total_refund <= 0 then
    raise exception 'Refund amount must be greater than zero';
  end if;

  update public.returns
  set
    refund_amount = v_total_refund,
    tax_refund = v_total_tax_refund,
    cost_amount = v_total_cost,
    profit_reversal = v_total_profit_reversal
  where id = v_return_id;

  select coalesce(sum(si.quantity), 0)
  into v_total_sold_qty
  from public.sale_items si
  where si.sale_id = v_sale.id;

  select coalesce(sum(ri.quantity), 0)
  into v_total_returned_qty
  from public.return_items ri
  join public.returns r on r.id = ri.return_id
  where r.original_sale_id = v_sale.id
    and r.status = 'completed';

  if v_total_returned_qty >= v_total_sold_qty then
    v_new_sale_status := 'refunded';
    v_new_payment_status := 'refunded';
  else
    v_new_sale_status := 'partially_refunded';
    v_new_payment_status := 'partial';
  end if;

  update public.sales
  set
    status = v_new_sale_status,
    payment_status = v_new_payment_status,
    updated_at = now()
  where id = v_sale.id;

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
    'process_sale_return',
    'return',
    v_return_id,
    jsonb_build_object(
      'return_number', v_return_number,
      'invoice_number', v_sale.invoice_number,
      'refund_amount', v_total_refund,
      'tax_refund', v_total_tax_refund,
      'cost_amount', v_total_cost,
      'profit_reversal', v_total_profit_reversal,
      'sale_status', v_new_sale_status,
      'reason', trim(p_reason),
      'unit_aware', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'return_id', v_return_id,
    'return_number', v_return_number,
    'sale_id', v_sale.id,
    'invoice_number', v_sale.invoice_number,
    'currency', v_sale.currency,
    'refund_amount', v_total_refund,
    'tax_refund', v_total_tax_refund,
    'cost_amount', v_total_cost,
    'profit_reversal', v_total_profit_reversal,
    'sale_status', v_new_sale_status,
    'processed_at', now()
  );
end;
$$;

revoke all on function public.process_sale_return(
  uuid,
  jsonb,
  public.payment_method,
  text,
  text
) from public, anon;

grant execute on function public.process_sale_return(
  uuid,
  jsonb,
  public.payment_method,
  text,
  text
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 18
-- ============================================================================
