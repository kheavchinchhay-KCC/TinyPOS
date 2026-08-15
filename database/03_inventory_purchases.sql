-- ============================================================================
-- Tiny POS NEW - Step 5 migration
-- Secure inventory adjustment and purchase receiving
-- Run once AFTER Step 4.
-- ============================================================================

begin;

create or replace function public.adjust_inventory(
  p_product_id uuid,
  p_mode text,
  p_quantity numeric,
  p_reason public.adjustment_reason,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_branch_id uuid;
  v_role public.app_role;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_adjustment_id uuid;
  v_adjustment_number text;
  v_quantity_change numeric(14,3);
  v_quantity_after numeric(14,3);
  v_unit_cost numeric(14,4);
  v_allow_negative boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role
  into v_organization_id, v_branch_id, v_role
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if v_organization_id is null or v_branch_id is null then
    raise exception 'Active user profile and branch are required';
  end if;

  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot adjust inventory';
  end if;

  select *
  into v_product
  from public.products
  where id = p_product_id
    and organization_id = v_organization_id;

  if not found then
    raise exception 'Product not found';
  end if;

  if v_product.track_stock is not true then
    raise exception 'This product does not track stock';
  end if;

  if lower(trim(coalesce(p_mode, ''))) not in ('add', 'remove', 'set') then
    raise exception 'Adjustment mode must be add, remove, or set';
  end if;

  if p_quantity is null or p_quantity < 0 then
    raise exception 'Quantity cannot be negative';
  end if;

  if lower(trim(p_mode)) in ('add', 'remove') and p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  insert into public.inventory_balances (
    organization_id,
    branch_id,
    product_id,
    quantity,
    average_cost
  ) values (
    v_organization_id,
    v_branch_id,
    v_product.id,
    0,
    v_product.default_cost
  )
  on conflict (branch_id, product_id) do nothing;

  select *
  into v_balance
  from public.inventory_balances
  where branch_id = v_branch_id
    and product_id = v_product.id
  for update;

  case lower(trim(p_mode))
    when 'add' then
      v_quantity_change := round(p_quantity, 3);
    when 'remove' then
      v_quantity_change := -round(p_quantity, 3);
    when 'set' then
      v_quantity_change := round(p_quantity, 3) - v_balance.quantity;
  end case;

  if v_quantity_change = 0 then
    raise exception 'The stock quantity is already %', v_balance.quantity;
  end if;

  v_quantity_after := v_balance.quantity + v_quantity_change;

  select coalesce(allow_negative_stock, false)
  into v_allow_negative
  from public.app_settings
  where organization_id = v_organization_id;

  if v_quantity_after < 0
     and not (v_allow_negative or v_product.allow_negative_stock) then
    raise exception 'Stock cannot become negative. Current stock: %', v_balance.quantity;
  end if;

  v_unit_cost := coalesce(nullif(v_balance.average_cost, 0), v_product.default_cost, 0);
  v_adjustment_number := private.next_document_number(
    v_organization_id,
    v_branch_id,
    'ADJ'
  );

  insert into public.inventory_adjustments (
    organization_id,
    branch_id,
    adjustment_number,
    reason,
    notes,
    created_by
  ) values (
    v_organization_id,
    v_branch_id,
    v_adjustment_number,
    p_reason,
    nullif(trim(p_notes), ''),
    v_user_id
  ) returning id into v_adjustment_id;

  insert into public.inventory_adjustment_items (
    organization_id,
    adjustment_id,
    product_id,
    quantity_before,
    quantity_change,
    quantity_after,
    unit_cost
  ) values (
    v_organization_id,
    v_adjustment_id,
    v_product.id,
    v_balance.quantity,
    v_quantity_change,
    v_quantity_after,
    v_unit_cost
  );

  update public.inventory_balances
  set quantity = v_quantity_after,
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
  ) values (
    v_organization_id,
    v_branch_id,
    v_product.id,
    'adjustment',
    v_quantity_change,
    v_balance.quantity,
    v_quantity_after,
    v_unit_cost,
    'inventory_adjustments',
    v_adjustment_id,
    concat(v_adjustment_number, case when nullif(trim(p_notes), '') is not null then ' - ' || trim(p_notes) else '' end),
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
  ) values (
    v_organization_id,
    v_branch_id,
    v_user_id,
    'adjust_inventory',
    'inventory_adjustment',
    v_adjustment_id,
    jsonb_build_object(
      'adjustment_number', v_adjustment_number,
      'product_id', v_product.id,
      'product_name', v_product.name,
      'quantity_before', v_balance.quantity,
      'quantity_change', v_quantity_change,
      'quantity_after', v_quantity_after,
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'ok', true,
    'adjustment_id', v_adjustment_id,
    'adjustment_number', v_adjustment_number,
    'product_id', v_product.id,
    'quantity_before', v_balance.quantity,
    'quantity_change', v_quantity_change,
    'quantity_after', v_quantity_after
  );
end;
$$;

revoke all on function public.adjust_inventory(
  uuid,
  text,
  numeric,
  public.adjustment_reason,
  text
) from public, anon;

grant execute on function public.adjust_inventory(
  uuid,
  text,
  numeric,
  public.adjustment_reason,
  text
) to authenticated, service_role;

create or replace function public.receive_purchase(
  p_items jsonb,
  p_supplier_id uuid default null,
  p_supplier_invoice_number text default null,
  p_amount_paid numeric default 0,
  p_currency public.currency_code default 'USD',
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_branch_id uuid;
  v_role public.app_role;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_item record;
  v_purchase_id uuid;
  v_purchase_number text;
  v_subtotal numeric(14,2) := 0;
  v_line_total numeric(14,2);
  v_new_quantity numeric(14,3);
  v_new_average numeric(14,4);
  v_item_count integer;
  v_distinct_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role
  into v_organization_id, v_branch_id, v_role
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if v_organization_id is null or v_branch_id is null then
    raise exception 'Active user profile and branch are required';
  end if;

  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot receive purchases';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one purchase item';
  end if;

  if p_amount_paid is null or p_amount_paid < 0 then
    raise exception 'Amount paid cannot be negative';
  end if;

  if p_supplier_id is not null and not exists (
    select 1
    from public.suppliers
    where id = p_supplier_id
      and organization_id = v_organization_id
      and is_active = true
  ) then
    raise exception 'Supplier not found or inactive';
  end if;

  select count(*), count(distinct x.product_id)
  into v_item_count, v_distinct_count
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity numeric, unit_cost numeric);

  if v_item_count <> v_distinct_count then
    raise exception 'The same product cannot appear twice in one purchase';
  end if;

  -- Validate products, calculate the total, and make sure balance rows exist.
  for v_item in
    select x.product_id, x.quantity, x.unit_cost
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_cost numeric)
    order by x.product_id
  loop
    if v_item.product_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every purchase item needs a product and quantity greater than zero';
    end if;

    if v_item.unit_cost is null or v_item.unit_cost < 0 then
      raise exception 'Unit cost cannot be negative';
    end if;

    select *
    into v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_organization_id
    for share;

    if not found or v_product.is_active is not true then
      raise exception 'A purchase product is missing or inactive';
    end if;

    if v_product.currency <> p_currency then
      raise exception 'Product "%" uses %, but this purchase uses %',
        v_product.name, v_product.currency, p_currency;
    end if;

    v_line_total := round(v_item.quantity * v_item.unit_cost, 2);
    v_subtotal := v_subtotal + v_line_total;

    insert into public.inventory_balances (
      organization_id,
      branch_id,
      product_id,
      quantity,
      average_cost
    ) values (
      v_organization_id,
      v_branch_id,
      v_product.id,
      0,
      v_product.default_cost
    )
    on conflict (branch_id, product_id) do nothing;
  end loop;

  if p_amount_paid > v_subtotal then
    raise exception 'Amount paid (%) cannot exceed purchase total (%)',
      p_amount_paid, v_subtotal;
  end if;

  -- Lock all affected inventory rows in a stable order.
  perform ib.id
  from public.inventory_balances ib
  join jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity numeric, unit_cost numeric)
    on x.product_id = ib.product_id
  where ib.branch_id = v_branch_id
  order by ib.product_id
  for update of ib;

  v_purchase_number := private.next_document_number(
    v_organization_id,
    v_branch_id,
    'PUR'
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
    ordered_at,
    received_at,
    created_by,
    received_by
  ) values (
    v_organization_id,
    v_branch_id,
    v_purchase_number,
    p_supplier_id,
    'received',
    p_currency,
    v_subtotal,
    0,
    0,
    v_subtotal,
    round(p_amount_paid, 2),
    nullif(trim(p_supplier_invoice_number), ''),
    nullif(trim(p_notes), ''),
    now(),
    now(),
    v_user_id,
    v_user_id
  ) returning id into v_purchase_id;

  for v_item in
    select x.product_id, x.quantity, x.unit_cost
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_cost numeric)
    order by x.product_id
  loop
    select *
    into strict v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_organization_id;

    v_line_total := round(v_item.quantity * v_item.unit_cost, 2);

    insert into public.purchase_items (
      organization_id,
      purchase_id,
      product_id,
      quantity,
      unit_cost,
      tax_amount,
      line_total
    ) values (
      v_organization_id,
      v_purchase_id,
      v_product.id,
      round(v_item.quantity, 3),
      round(v_item.unit_cost, 4),
      0,
      v_line_total
    );

    if v_product.track_stock then
      select *
      into strict v_balance
      from public.inventory_balances
      where branch_id = v_branch_id
        and product_id = v_product.id
      for update;

      v_new_quantity := v_balance.quantity + round(v_item.quantity, 3);

      if v_balance.quantity > 0 and v_new_quantity > 0 then
        v_new_average := round(
          ((v_balance.quantity * coalesce(v_balance.average_cost, 0))
            + (v_item.quantity * v_item.unit_cost))
          / v_new_quantity,
          4
        );
      else
        v_new_average := round(v_item.unit_cost, 4);
      end if;

      update public.inventory_balances
      set quantity = v_new_quantity,
          average_cost = v_new_average,
          updated_at = now()
      where id = v_balance.id;

      update public.products
      set default_cost = v_new_average,
          updated_at = now()
      where id = v_product.id;

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
      ) values (
        v_organization_id,
        v_branch_id,
        v_product.id,
        'purchase',
        round(v_item.quantity, 3),
        v_balance.quantity,
        v_new_quantity,
        round(v_item.unit_cost, 4),
        'purchases',
        v_purchase_id,
        v_purchase_number,
        v_user_id
      );
    else
      update public.products
      set default_cost = round(v_item.unit_cost, 4),
          updated_at = now()
      where id = v_product.id;
    end if;
  end loop;

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  ) values (
    v_organization_id,
    v_branch_id,
    v_user_id,
    'receive_purchase',
    'purchase',
    v_purchase_id,
    jsonb_build_object(
      'purchase_number', v_purchase_number,
      'supplier_id', p_supplier_id,
      'item_count', v_item_count,
      'total_amount', v_subtotal,
      'amount_paid', p_amount_paid,
      'currency', p_currency
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase_id,
    'purchase_number', v_purchase_number,
    'item_count', v_item_count,
    'total_amount', v_subtotal,
    'amount_paid', round(p_amount_paid, 2),
    'balance_due', round(v_subtotal - p_amount_paid, 2),
    'currency', p_currency
  );
end;
$$;

revoke all on function public.receive_purchase(
  jsonb,
  uuid,
  text,
  numeric,
  public.currency_code,
  text
) from public, anon;

grant execute on function public.receive_purchase(
  jsonb,
  uuid,
  text,
  numeric,
  public.currency_code,
  text
) to authenticated, service_role;

commit;
