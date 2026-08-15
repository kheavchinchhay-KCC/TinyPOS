-- ============================================================================
-- Tiny POS - Step 19: Package-aware purchase orders and supplier returns
-- Run once in the NEW Supabase project after Step 18.
--
-- Purchasing unit example:
--   1 Box = 24 Pieces
--   Purchase quantity = 10 Boxes
--   Cost per Box = $12.00
--
-- Inventory received:
--   240 Pieces
--   Base cost = $0.50 per Piece
--
-- This migration does not delete existing purchases, stock, or suppliers.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PURCHASE-ITEM UNIT SNAPSHOTS
-- ----------------------------------------------------------------------------

alter table public.purchase_items
  add column if not exists product_unit_id uuid
    references public.product_units(id) on delete set null,
  add column if not exists purchase_unit_name text,
  add column if not exists unit_factor numeric(14,3) not null default 1
    check (unit_factor > 0),
  add column if not exists base_quantity numeric(14,3),
  add column if not exists base_unit_cost numeric(14,4);

update public.purchase_items pi
set
  product_unit_id = coalesce(
    pi.product_unit_id,
    (
      select pu.id
      from public.product_units pu
      where pu.product_id = pi.product_id
        and pu.is_base = true
      limit 1
    )
  ),
  purchase_unit_name = coalesce(
    nullif(pi.purchase_unit_name, ''),
    (
      select pu.name
      from public.product_units pu
      where pu.product_id = pi.product_id
        and pu.is_base = true
      limit 1
    ),
    (
      select p.unit_name
      from public.products p
      where p.id = pi.product_id
    ),
    'pcs'
  ),
  unit_factor = coalesce(nullif(pi.unit_factor, 0), 1),
  base_quantity = coalesce(pi.base_quantity, pi.quantity),
  base_unit_cost = coalesce(pi.base_unit_cost, pi.unit_cost)
where
  pi.purchase_unit_name is null
  or pi.base_quantity is null
  or pi.base_unit_cost is null
  or pi.product_unit_id is null;

alter table public.purchase_items
  alter column purchase_unit_name set default 'pcs',
  alter column purchase_unit_name set not null,
  alter column base_quantity set default 1,
  alter column base_quantity set not null,
  alter column base_unit_cost set default 0,
  alter column base_unit_cost set not null;

create index if not exists purchase_items_product_unit_idx
  on public.purchase_items (product_unit_id);

-- ----------------------------------------------------------------------------
-- 2. SUPPLIER-RETURN UNIT SNAPSHOTS
-- ----------------------------------------------------------------------------

alter table public.purchase_return_items
  add column if not exists return_unit_name text,
  add column if not exists unit_factor numeric(14,3) not null default 1
    check (unit_factor > 0),
  add column if not exists base_quantity numeric(14,3),
  add column if not exists base_unit_cost numeric(14,4);

update public.purchase_return_items pri
set
  return_unit_name = coalesce(
    nullif(pri.return_unit_name, ''),
    (
      select pi.purchase_unit_name
      from public.purchase_items pi
      where pi.id = pri.purchase_item_id
    ),
    'pcs'
  ),
  unit_factor = coalesce(
    nullif(pri.unit_factor, 0),
    (
      select pi.unit_factor
      from public.purchase_items pi
      where pi.id = pri.purchase_item_id
    ),
    1
  ),
  base_quantity = coalesce(
    pri.base_quantity,
    pri.quantity * coalesce(
      (
        select pi.unit_factor
        from public.purchase_items pi
        where pi.id = pri.purchase_item_id
      ),
      1
    )
  ),
  base_unit_cost = coalesce(
    pri.base_unit_cost,
    (
      select pi.base_unit_cost
      from public.purchase_items pi
      where pi.id = pri.purchase_item_id
    ),
    pri.unit_cost
  )
where
  pri.return_unit_name is null
  or pri.base_quantity is null
  or pri.base_unit_cost is null;

alter table public.purchase_return_items
  alter column return_unit_name set default 'pcs',
  alter column return_unit_name set not null,
  alter column base_quantity set default 1,
  alter column base_quantity set not null,
  alter column base_unit_cost set default 0,
  alter column base_unit_cost set not null;

-- ----------------------------------------------------------------------------
-- 3. SAVE A PACKAGE-AWARE PURCHASE ORDER
-- The user-entered quantity and cost remain in the selected purchasing unit.
-- ----------------------------------------------------------------------------

create or replace function public.save_purchase_order_v2(
  p_purchase_id uuid,
  p_supplier_id uuid,
  p_items jsonb,
  p_currency public.currency_code default 'USD',
  p_discount_amount numeric default 0,
  p_tax_amount numeric default 0,
  p_expected_date date default null,
  p_supplier_invoice_number text default null,
  p_payment_terms text default null,
  p_delivery_address text default null,
  p_notes text default null,
  p_status public.purchase_status default 'draft'
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
  v_item record;
  v_product public.products%rowtype;
  v_unit public.product_units%rowtype;

  v_purchase_id uuid;
  v_purchase_number text;

  v_item_count integer;
  v_distinct_count integer;

  v_subtotal numeric(14,2) := 0;
  v_total numeric(14,2);
  v_line_total numeric(14,2);
  v_base_quantity numeric(14,3);
  v_base_unit_cost numeric(14,4);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot manage purchase orders';
  end if;

  if p_status not in ('draft','ordered') then
    raise exception 'A purchase order can only be draft or ordered';
  end if;

  if p_supplier_id is null or not exists (
    select 1
    from public.suppliers s
    where s.id = p_supplier_id
      and s.organization_id = v_profile.organization_id
      and s.is_active = true
  ) then
    raise exception 'Choose an active supplier';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product';
  end if;

  if coalesce(p_discount_amount, 0) < 0
     or coalesce(p_tax_amount, 0) < 0 then
    raise exception 'Discount and tax cannot be negative';
  end if;

  select count(*), count(distinct x.product_id)
  into v_item_count, v_distinct_count
  from jsonb_to_recordset(p_items)
    as x(
      product_id uuid,
      product_unit_id uuid,
      quantity numeric,
      unit_cost numeric
    );

  if v_item_count <> v_distinct_count then
    raise exception 'The same product cannot appear twice';
  end if;

  for v_item in
    select
      x.product_id,
      x.product_unit_id,
      x.quantity,
      x.unit_cost
    from jsonb_to_recordset(p_items)
      as x(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric,
        unit_cost numeric
      )
    order by x.product_id
  loop
    if v_item.product_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every item requires a product and quantity greater than zero';
    end if;

    if v_item.unit_cost is null or v_item.unit_cost < 0 then
      raise exception 'Unit cost cannot be negative';
    end if;

    select *
    into v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id
      and is_active = true;

    if not found then
      raise exception 'A purchase-order product is missing or inactive';
    end if;

    if v_product.currency <> p_currency then
      raise exception 'Product "%" uses %, but the order uses %',
        v_product.name, v_product.currency, p_currency;
    end if;

    select *
    into v_unit
    from public.product_units
    where organization_id = v_profile.organization_id
      and product_id = v_product.id
      and (
        (
          v_item.product_unit_id is not null
          and id = v_item.product_unit_id
        )
        or
        (
          v_item.product_unit_id is null
          and is_base = true
        )
      )
    limit 1;

    if not found or v_unit.is_active is not true then
      raise exception 'The selected purchasing unit for "%" is unavailable',
        v_product.name;
    end if;

    v_line_total := round(v_item.quantity * v_item.unit_cost, 2);
    v_subtotal := v_subtotal + v_line_total;
  end loop;

  v_total := greatest(
    round(
      v_subtotal
      - coalesce(p_discount_amount, 0)
      + coalesce(p_tax_amount, 0),
      2
    ),
    0
  );

  if p_purchase_id is null then
    v_purchase_number := private.next_document_number(
      v_profile.organization_id,
      v_profile.branch_id,
      'PO'
    );

    insert into public.purchases (
      organization_id,
      branch_id,
      purchase_number,
      supplier_id,
      status,
      currency,
      subtotal,
      discount_amount,
      tax_amount,
      total_amount,
      amount_paid,
      supplier_invoice_number,
      notes,
      expected_date,
      payment_terms,
      delivery_address,
      ordered_at,
      ordered_by,
      created_by
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_purchase_number,
      p_supplier_id,
      p_status,
      p_currency,
      v_subtotal,
      round(coalesce(p_discount_amount, 0), 2),
      round(coalesce(p_tax_amount, 0), 2),
      v_total,
      0,
      nullif(trim(p_supplier_invoice_number), ''),
      nullif(trim(p_notes), ''),
      p_expected_date,
      nullif(trim(p_payment_terms), ''),
      nullif(trim(p_delivery_address), ''),
      case when p_status = 'ordered' then now() else null end,
      case when p_status = 'ordered' then v_user_id else null end,
      v_user_id
    )
    returning * into v_purchase;
  else
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

    if v_purchase.status not in ('draft','ordered') then
      raise exception 'Only draft or ordered purchase orders can be edited';
    end if;

    if coalesce(v_purchase.amount_paid, 0) > 0 then
      raise exception 'This order already has a payment and cannot be edited';
    end if;

    update public.purchases
    set
      supplier_id = p_supplier_id,
      status = p_status,
      currency = p_currency,
      subtotal = v_subtotal,
      discount_amount = round(coalesce(p_discount_amount, 0), 2),
      tax_amount = round(coalesce(p_tax_amount, 0), 2),
      total_amount = v_total,
      supplier_invoice_number =
        nullif(trim(p_supplier_invoice_number), ''),
      notes = nullif(trim(p_notes), ''),
      expected_date = p_expected_date,
      payment_terms = nullif(trim(p_payment_terms), ''),
      delivery_address = nullif(trim(p_delivery_address), ''),
      ordered_at = case
        when p_status = 'ordered'
          then coalesce(v_purchase.ordered_at, now())
        else null
      end,
      ordered_by = case
        when p_status = 'ordered'
          then coalesce(v_purchase.ordered_by, v_user_id)
        else null
      end,
      updated_at = now()
    where id = v_purchase.id
    returning * into v_purchase;

    delete from public.purchase_items
    where purchase_id = v_purchase.id;
  end if;

  v_purchase_id := v_purchase.id;
  v_purchase_number := v_purchase.purchase_number;

  for v_item in
    select
      x.product_id,
      x.product_unit_id,
      x.quantity,
      x.unit_cost
    from jsonb_to_recordset(p_items)
      as x(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric,
        unit_cost numeric
      )
    order by x.product_id
  loop
    select *
    into strict v_unit
    from public.product_units
    where organization_id = v_profile.organization_id
      and product_id = v_item.product_id
      and (
        (
          v_item.product_unit_id is not null
          and id = v_item.product_unit_id
        )
        or
        (
          v_item.product_unit_id is null
          and is_base = true
        )
      )
    limit 1;

    v_base_quantity := round(
      v_item.quantity * v_unit.conversion_factor,
      3
    );

    v_base_unit_cost := round(
      case
        when v_unit.conversion_factor > 0
          then v_item.unit_cost / v_unit.conversion_factor
        else v_item.unit_cost
      end,
      4
    );

    insert into public.purchase_items (
      organization_id,
      purchase_id,
      product_id,
      product_unit_id,
      purchase_unit_name,
      unit_factor,
      quantity,
      base_quantity,
      unit_cost,
      base_unit_cost,
      tax_amount,
      line_total
    )
    values (
      v_profile.organization_id,
      v_purchase_id,
      v_item.product_id,
      v_unit.id,
      v_unit.name,
      v_unit.conversion_factor,
      round(v_item.quantity, 3),
      v_base_quantity,
      round(v_item.unit_cost, 4),
      v_base_unit_cost,
      0,
      round(v_item.quantity * v_item.unit_cost, 2)
    );
  end loop;

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
    case
      when p_purchase_id is null
        then 'create_purchase_order'
      else 'update_purchase_order'
    end,
    'purchase',
    v_purchase_id,
    jsonb_build_object(
      'purchase_number', v_purchase_number,
      'status', p_status,
      'supplier_id', p_supplier_id,
      'item_count', v_item_count,
      'total_amount', v_total,
      'currency', p_currency,
      'package_aware', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase_id,
    'purchase_number', v_purchase_number,
    'status', p_status,
    'subtotal', v_subtotal,
    'total_amount', v_total,
    'currency', p_currency
  );
end;
$$;

revoke all on function public.save_purchase_order_v2(
  uuid,
  uuid,
  jsonb,
  public.currency_code,
  numeric,
  numeric,
  date,
  text,
  text,
  text,
  text,
  public.purchase_status
) from public, anon;

grant execute on function public.save_purchase_order_v2(
  uuid,
  uuid,
  jsonb,
  public.currency_code,
  numeric,
  numeric,
  date,
  text,
  text,
  text,
  text,
  public.purchase_status
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. RECEIVE PURCHASED PACKAGES INTO BASE INVENTORY
-- ----------------------------------------------------------------------------

create or replace function public.receive_purchase_order_v2(
  p_purchase_id uuid,
  p_amount_paid numeric default 0,
  p_payment_method public.payment_method default 'cash',
  p_payment_reference text default null,
  p_supplier_invoice_number text default null,
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
  v_item record;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;

  v_new_quantity numeric(14,3);
  v_new_average numeric(14,4);
  v_new_paid numeric(14,2);

  v_item_count integer := 0;
  v_total_purchase_units numeric(14,3) := 0;
  v_total_base_units numeric(14,3) := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot receive purchase orders';
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

  if v_purchase.status not in ('draft','ordered') then
    raise exception 'Only draft or ordered purchase orders can be received';
  end if;

  if p_amount_paid is null or p_amount_paid < 0 then
    raise exception 'Payment amount cannot be negative';
  end if;

  v_new_paid := round(
    coalesce(v_purchase.amount_paid, 0) + p_amount_paid,
    2
  );

  if v_new_paid > v_purchase.total_amount then
    raise exception 'Total payments cannot exceed the purchase total';
  end if;

  if not exists (
    select 1
    from public.purchase_items
    where purchase_id = v_purchase.id
  ) then
    raise exception 'This purchase order has no items';
  end if;

  -- Create all inventory rows first.
  for v_item in
    select pi.product_id
    from public.purchase_items pi
    where pi.purchase_id = v_purchase.id
    order by pi.product_id
  loop
    select *
    into v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id;

    if not found or v_product.is_active is not true then
      raise exception 'A purchase-order product is missing or inactive';
    end if;

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
  end loop;

  perform ib.id
  from public.inventory_balances ib
  join public.purchase_items pi
    on pi.product_id = ib.product_id
  where pi.purchase_id = v_purchase.id
    and ib.branch_id = v_profile.branch_id
  order by ib.product_id
  for update of ib;

  for v_item in
    select
      pi.*,
      p.track_stock,
      p.name
    from public.purchase_items pi
    join public.products p on p.id = pi.product_id
    where pi.purchase_id = v_purchase.id
    order by pi.product_id
  loop
    v_item_count := v_item_count + 1;
    v_total_purchase_units :=
      v_total_purchase_units + v_item.quantity;
    v_total_base_units :=
      v_total_base_units + v_item.base_quantity;

    if v_item.track_stock then
      select *
      into strict v_balance
      from public.inventory_balances
      where branch_id = v_profile.branch_id
        and product_id = v_item.product_id
      for update;

      v_new_quantity :=
        v_balance.quantity + v_item.base_quantity;

      if v_balance.quantity > 0 and v_new_quantity > 0 then
        v_new_average := round(
          (
            (v_balance.quantity * coalesce(v_balance.average_cost, 0))
            + (v_item.base_quantity * v_item.base_unit_cost)
          ) / v_new_quantity,
          4
        );
      else
        v_new_average := v_item.base_unit_cost;
      end if;

      update public.inventory_balances
      set
        quantity = v_new_quantity,
        average_cost = v_new_average,
        updated_at = now()
      where id = v_balance.id;

      update public.products
      set
        default_cost = v_new_average,
        updated_at = now()
      where id = v_item.product_id;

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
        v_item.product_id,
        'purchase',
        v_item.base_quantity,
        v_balance.quantity,
        v_new_quantity,
        v_item.base_unit_cost,
        'purchases',
        v_purchase.id,
        format(
          '%s · %s %s = %s base units',
          v_purchase.purchase_number,
          v_item.quantity,
          v_item.purchase_unit_name,
          v_item.base_quantity
        ),
        v_user_id
      );
    else
      update public.products
      set
        default_cost = v_item.base_unit_cost,
        updated_at = now()
      where id = v_item.product_id;
    end if;
  end loop;

  if p_amount_paid > 0 then
    insert into public.purchase_payments (
      organization_id,
      branch_id,
      purchase_id,
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
      p_payment_method,
      v_purchase.currency,
      round(p_amount_paid, 2),
      nullif(trim(p_payment_reference), ''),
      nullif(trim(p_notes), ''),
      v_user_id
    );
  end if;

  update public.purchases
  set
    status = 'received',
    amount_paid = v_new_paid,
    supplier_invoice_number = coalesce(
      nullif(trim(p_supplier_invoice_number), ''),
      supplier_invoice_number
    ),
    notes = case
      when nullif(trim(p_notes), '') is null then notes
      when notes is null then trim(p_notes)
      else notes || E'\n' || trim(p_notes)
    end,
    ordered_at = coalesce(ordered_at, now()),
    ordered_by = coalesce(ordered_by, v_user_id),
    received_at = now(),
    received_by = v_user_id,
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
    'receive_purchase_order',
    'purchase',
    v_purchase.id,
    jsonb_build_object(
      'purchase_number', v_purchase.purchase_number,
      'item_count', v_item_count,
      'purchase_units', v_total_purchase_units,
      'base_units', v_total_base_units,
      'total_amount', v_purchase.total_amount,
      'amount_paid', v_new_paid,
      'balance_due', v_purchase.total_amount - v_new_paid,
      'package_aware', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number', v_purchase.purchase_number,
    'status', 'received',
    'item_count', v_item_count,
    'purchase_units', v_total_purchase_units,
    'base_units', v_total_base_units,
    'total_amount', v_purchase.total_amount,
    'amount_paid', v_new_paid,
    'balance_due', v_purchase.total_amount - v_new_paid,
    'currency', v_purchase.currency
  );
end;
$$;

revoke all on function public.receive_purchase_order_v2(
  uuid,
  numeric,
  public.payment_method,
  text,
  text,
  text
) from public, anon;

grant execute on function public.receive_purchase_order_v2(
  uuid,
  numeric,
  public.payment_method,
  text,
  text,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. RETURN PURCHASED PACKAGES TO A SUPPLIER
-- Return quantity is entered in the original purchasing unit.
-- ----------------------------------------------------------------------------

create or replace function public.process_supplier_return_v2(
  p_purchase_id uuid,
  p_items jsonb,
  p_reason text,
  p_supplier_reference text default null
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
  v_item record;
  v_purchase_item public.purchase_items%rowtype;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;

  v_previous_returned numeric(14,3);
  v_available_purchase_units numeric(14,3);
  v_base_return_quantity numeric(14,3);

  v_return_id uuid;
  v_return_number text;
  v_line_total numeric(14,2);

  v_total_amount numeric(14,2) := 0;
  v_total_purchase_units numeric(14,3) := 0;
  v_total_base_units numeric(14,3) := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'An active user profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot return stock to suppliers';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A supplier return reason is required';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one purchase item to return';
  end if;

  select *
  into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Purchase not found';
  end if;

  if v_purchase.branch_id <> v_profile.branch_id then
    raise exception 'This purchase belongs to another branch';
  end if;

  if v_purchase.status <> 'received' then
    raise exception 'Only received purchases can be returned';
  end if;

  v_return_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'SRT'
  );

  insert into public.purchase_returns (
    organization_id,
    branch_id,
    return_number,
    purchase_id,
    supplier_id,
    status,
    currency,
    total_amount,
    reason,
    supplier_reference,
    created_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_return_number,
    v_purchase.id,
    v_purchase.supplier_id,
    'completed',
    v_purchase.currency,
    0,
    trim(p_reason),
    nullif(trim(p_supplier_reference), ''),
    v_user_id
  )
  returning id into v_return_id;

  for v_item in
    select
      x.purchase_item_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(
        purchase_item_id uuid,
        quantity numeric
      )
    group by x.purchase_item_id
    order by x.purchase_item_id
  loop
    if v_item.purchase_item_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every supplier return item requires a valid quantity';
    end if;

    select *
    into v_purchase_item
    from public.purchase_items
    where id = v_item.purchase_item_id
      and purchase_id = v_purchase.id
    for update;

    if not found then
      raise exception 'A selected item does not belong to this purchase';
    end if;

    select coalesce(sum(pri.quantity), 0)
    into v_previous_returned
    from public.purchase_return_items pri
    join public.purchase_returns pr
      on pr.id = pri.purchase_return_id
    where pri.purchase_item_id = v_purchase_item.id
      and pr.status = 'completed';

    v_available_purchase_units :=
      v_purchase_item.quantity - v_previous_returned;

    if v_item.quantity > v_available_purchase_units then
      raise exception
        'Only % % can still be returned for this purchase item',
        v_available_purchase_units,
        v_purchase_item.purchase_unit_name;
    end if;

    select *
    into strict v_product
    from public.products
    where id = v_purchase_item.product_id
      and organization_id = v_profile.organization_id;

    v_base_return_quantity := round(
      v_item.quantity * v_purchase_item.unit_factor,
      3
    );

    select *
    into v_balance
    from public.inventory_balances
    where branch_id = v_profile.branch_id
      and product_id = v_product.id
    for update;

    if not found
       or v_balance.quantity < v_base_return_quantity then
      raise exception
        'Not enough current stock to return "%". Available: % base units; required: %',
        v_product.name,
        coalesce(v_balance.quantity, 0),
        v_base_return_quantity;
    end if;

    v_line_total := round(
      v_purchase_item.unit_cost * v_item.quantity,
      2
    );

    insert into public.purchase_return_items (
      organization_id,
      purchase_return_id,
      purchase_item_id,
      product_id,
      quantity,
      base_quantity,
      return_unit_name,
      unit_factor,
      unit_cost,
      base_unit_cost,
      line_total
    )
    values (
      v_profile.organization_id,
      v_return_id,
      v_purchase_item.id,
      v_product.id,
      v_item.quantity,
      v_base_return_quantity,
      v_purchase_item.purchase_unit_name,
      v_purchase_item.unit_factor,
      v_purchase_item.unit_cost,
      v_purchase_item.base_unit_cost,
      v_line_total
    );

    update public.inventory_balances
    set
      quantity = quantity - v_base_return_quantity,
      updated_at = now()
    where id = v_balance.id;

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
      'supplier_return',
      -v_base_return_quantity,
      v_balance.quantity,
      v_balance.quantity - v_base_return_quantity,
      v_purchase_item.base_unit_cost,
      'purchase_returns',
      v_return_id,
      format(
        '%s from %s · %s %s = %s base units',
        v_return_number,
        v_purchase.purchase_number,
        v_item.quantity,
        v_purchase_item.purchase_unit_name,
        v_base_return_quantity
      ),
      v_user_id
    );

    v_total_amount := v_total_amount + v_line_total;
    v_total_purchase_units :=
      v_total_purchase_units + v_item.quantity;
    v_total_base_units :=
      v_total_base_units + v_base_return_quantity;
  end loop;

  update public.purchase_returns
  set total_amount = v_total_amount
  where id = v_return_id;

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
    'process_supplier_return',
    'purchase_return',
    v_return_id,
    jsonb_build_object(
      'return_number', v_return_number,
      'purchase_number', v_purchase.purchase_number,
      'total_amount', v_total_amount,
      'purchase_units', v_total_purchase_units,
      'base_units', v_total_base_units,
      'reason', trim(p_reason),
      'package_aware', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'return_id', v_return_id,
    'return_number', v_return_number,
    'purchase_number', v_purchase.purchase_number,
    'currency', v_purchase.currency,
    'total_amount', v_total_amount,
    'purchase_units', v_total_purchase_units,
    'base_units', v_total_base_units
  );
end;
$$;

revoke all on function public.process_supplier_return_v2(
  uuid,
  jsonb,
  text,
  text
) from public, anon;

grant execute on function public.process_supplier_return_v2(
  uuid,
  jsonb,
  text,
  text
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 19
-- ============================================================================
