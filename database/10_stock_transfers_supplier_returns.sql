-- ============================================================================
-- Tiny POS - Step 12: Stock transfers and supplier returns
-- Run once in the NEW Supabase project after Step 11.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. TYPES
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'stock_transfer_status') then
    create type public.stock_transfer_status as enum ('pending', 'received', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'supplier_return_status') then
    create type public.supplier_return_status as enum ('completed', 'cancelled');
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 2. TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  transfer_number text not null,
  source_branch_id uuid not null references public.branches(id) on delete restrict,
  destination_branch_id uuid not null references public.branches(id) on delete restrict,
  status public.stock_transfer_status not null default 'pending',
  notes text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  received_by uuid references auth.users(id) on delete set null,
  received_at timestamptz,
  receive_notes text,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  updated_at timestamptz not null default now(),
  unique (organization_id, transfer_number),
  check (source_branch_id <> destination_branch_id)
);

create table if not exists public.stock_transfer_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost numeric(14,4) not null default 0 check (unit_cost >= 0),
  created_at timestamptz not null default now(),
  unique (transfer_id, product_id)
);

create table if not exists public.purchase_returns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  return_number text not null,
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  supplier_id uuid references public.suppliers(id) on delete set null,
  status public.supplier_return_status not null default 'completed',
  currency public.currency_code not null,
  total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
  reason text not null,
  supplier_reference text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  unique (organization_id, return_number)
);

create table if not exists public.purchase_return_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_return_id uuid not null references public.purchase_returns(id) on delete cascade,
  purchase_item_id uuid not null references public.purchase_items(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  unit_cost numeric(14,4) not null check (unit_cost >= 0),
  line_total numeric(14,2) not null check (line_total >= 0),
  created_at timestamptz not null default now(),
  unique (purchase_return_id, purchase_item_id)
);

create index if not exists stock_transfers_org_created_idx
  on public.stock_transfers (organization_id, created_at desc);

create index if not exists stock_transfers_source_status_idx
  on public.stock_transfers (source_branch_id, status, created_at desc);

create index if not exists stock_transfers_destination_status_idx
  on public.stock_transfers (destination_branch_id, status, created_at desc);

create index if not exists stock_transfer_items_transfer_idx
  on public.stock_transfer_items (transfer_id);

create index if not exists purchase_returns_branch_created_idx
  on public.purchase_returns (branch_id, created_at desc);

create index if not exists purchase_returns_purchase_idx
  on public.purchase_returns (purchase_id, created_at desc);

create index if not exists purchase_return_items_purchase_item_idx
  on public.purchase_return_items (purchase_item_id);

-- Reuse the common updated_at trigger.
drop trigger if exists set_stock_transfers_updated_at on public.stock_transfers;
create trigger set_stock_transfers_updated_at
before update on public.stock_transfers
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. CREATE STOCK TRANSFER
-- Source stock is deducted immediately and remains in transit until received.
-- ----------------------------------------------------------------------------

create or replace function public.create_stock_transfer(
  p_destination_branch_id uuid,
  p_items jsonb,
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
  v_destination public.branches%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_transfer_id uuid;
  v_transfer_number text;
  v_total_items integer := 0;
  v_total_units numeric(14,3) := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true or v_profile.branch_id is null then
    raise exception 'An active user profile and branch are required';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot create stock transfers';
  end if;

  select *
  into v_destination
  from public.branches
  where id = p_destination_branch_id
    and organization_id = v_profile.organization_id
    and is_active = true;

  if not found then
    raise exception 'Destination branch not found or inactive';
  end if;

  if v_destination.id = v_profile.branch_id then
    raise exception 'Source and destination branches must be different';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product to the transfer';
  end if;

  -- Validate and lock all products in a stable order before creating records.
  for v_item in
    select
      x.product_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric)
    group by x.product_id
    order by x.product_id
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Every transfer item requires a product and quantity greater than zero';
    end if;

    select *
    into v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id
      and is_active = true
    for share;

    if not found then
      raise exception 'A transfer product is missing or inactive';
    end if;

    if v_product.track_stock is not true then
      raise exception 'Product "%" does not track stock', v_product.name;
    end if;

    insert into public.inventory_balances (
      organization_id,
      branch_id,
      product_id,
      quantity,
      average_cost
    ) values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_product.id,
      0,
      v_product.default_cost
    ) on conflict (branch_id, product_id) do nothing;

    select *
    into v_balance
    from public.inventory_balances
    where branch_id = v_profile.branch_id
      and product_id = v_product.id
    for update;

    if v_balance.quantity < v_item.quantity then
      raise exception 'Not enough stock for "%". Available: %, requested: %',
        v_product.name, v_balance.quantity, v_item.quantity;
    end if;

    v_total_items := v_total_items + 1;
    v_total_units := v_total_units + v_item.quantity;
  end loop;

  v_transfer_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'TRF'
  );

  insert into public.stock_transfers (
    organization_id,
    transfer_number,
    source_branch_id,
    destination_branch_id,
    status,
    notes,
    created_by
  ) values (
    v_profile.organization_id,
    v_transfer_number,
    v_profile.branch_id,
    v_destination.id,
    'pending',
    nullif(trim(p_notes), ''),
    v_user_id
  ) returning id into v_transfer_id;

  for v_item in
    select
      x.product_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric)
    group by x.product_id
    order by x.product_id
  loop
    select *
    into strict v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id;

    select *
    into strict v_balance
    from public.inventory_balances
    where branch_id = v_profile.branch_id
      and product_id = v_product.id
    for update;

    insert into public.stock_transfer_items (
      organization_id,
      transfer_id,
      product_id,
      quantity,
      unit_cost
    ) values (
      v_profile.organization_id,
      v_transfer_id,
      v_product.id,
      v_item.quantity,
      coalesce(nullif(v_balance.average_cost, 0), v_product.default_cost, 0)
    );

    update public.inventory_balances
    set quantity = quantity - v_item.quantity,
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
      v_profile.organization_id,
      v_profile.branch_id,
      v_product.id,
      'transfer_out',
      -v_item.quantity,
      v_balance.quantity,
      v_balance.quantity - v_item.quantity,
      coalesce(nullif(v_balance.average_cost, 0), v_product.default_cost, 0),
      'stock_transfers',
      v_transfer_id,
      concat(v_transfer_number, ' to ', v_destination.name),
      v_user_id
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
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'create_stock_transfer',
    'stock_transfer',
    v_transfer_id,
    jsonb_build_object(
      'transfer_number', v_transfer_number,
      'destination_branch_id', v_destination.id,
      'destination_branch_name', v_destination.name,
      'item_count', v_total_items,
      'total_units', v_total_units
    )
  );

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer_id,
    'transfer_number', v_transfer_number,
    'status', 'pending',
    'item_count', v_total_items,
    'total_units', v_total_units
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. RECEIVE STOCK TRANSFER
-- Destination stock is increased only after the destination branch receives it.
-- ----------------------------------------------------------------------------

create or replace function public.receive_stock_transfer(
  p_transfer_id uuid,
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
  v_transfer public.stock_transfers%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_new_quantity numeric(14,3);
  v_new_average_cost numeric(14,4);
  v_total_units numeric(14,3) := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true or v_profile.branch_id is null then
    raise exception 'An active user profile and branch are required';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot receive stock transfers';
  end if;

  select *
  into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Stock transfer not found';
  end if;

  if v_transfer.status <> 'pending' then
    raise exception 'Only pending transfers can be received';
  end if;

  if v_transfer.destination_branch_id <> v_profile.branch_id then
    raise exception 'Switch to the destination branch before receiving this transfer';
  end if;

  for v_item in
    select *
    from public.stock_transfer_items
    where transfer_id = v_transfer.id
    order by product_id
  loop
    select *
    into strict v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id;

    insert into public.inventory_balances (
      organization_id,
      branch_id,
      product_id,
      quantity,
      average_cost
    ) values (
      v_profile.organization_id,
      v_transfer.destination_branch_id,
      v_product.id,
      0,
      v_item.unit_cost
    ) on conflict (branch_id, product_id) do nothing;

    select *
    into v_balance
    from public.inventory_balances
    where branch_id = v_transfer.destination_branch_id
      and product_id = v_product.id
    for update;

    v_new_quantity := v_balance.quantity + v_item.quantity;

    if v_new_quantity > 0 and v_balance.quantity >= 0 then
      v_new_average_cost := round(
        (
          (v_balance.quantity * v_balance.average_cost)
          + (v_item.quantity * v_item.unit_cost)
        ) / v_new_quantity,
        4
      );
    else
      v_new_average_cost := v_item.unit_cost;
    end if;

    update public.inventory_balances
    set quantity = v_new_quantity,
        average_cost = v_new_average_cost,
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
      v_profile.organization_id,
      v_transfer.destination_branch_id,
      v_product.id,
      'transfer_in',
      v_item.quantity,
      v_balance.quantity,
      v_new_quantity,
      v_item.unit_cost,
      'stock_transfers',
      v_transfer.id,
      concat(v_transfer.transfer_number, ' received'),
      v_user_id
    );

    v_total_units := v_total_units + v_item.quantity;
  end loop;

  update public.stock_transfers
  set status = 'received',
      received_by = v_user_id,
      received_at = now(),
      receive_notes = nullif(trim(p_notes), ''),
      updated_at = now()
  where id = v_transfer.id;

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'receive_stock_transfer',
    'stock_transfer',
    v_transfer.id,
    jsonb_build_object(
      'transfer_number', v_transfer.transfer_number,
      'total_units', v_total_units
    )
  );

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'status', 'received',
    'total_units', v_total_units
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. CANCEL PENDING STOCK TRANSFER
-- Source stock is restored because destination never received it.
-- ----------------------------------------------------------------------------

create or replace function public.cancel_stock_transfer(
  p_transfer_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_transfer public.stock_transfers%rowtype;
  v_item record;
  v_balance public.inventory_balances%rowtype;
  v_new_quantity numeric(14,3);
  v_new_average_cost numeric(14,4);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true or v_profile.branch_id is null then
    raise exception 'An active user profile and branch are required';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot cancel stock transfers';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A cancellation reason is required';
  end if;

  select *
  into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Stock transfer not found';
  end if;

  if v_transfer.status <> 'pending' then
    raise exception 'Only pending transfers can be cancelled';
  end if;

  if v_transfer.source_branch_id <> v_profile.branch_id then
    raise exception 'Switch to the source branch before cancelling this transfer';
  end if;

  for v_item in
    select *
    from public.stock_transfer_items
    where transfer_id = v_transfer.id
    order by product_id
  loop
    select *
    into v_balance
    from public.inventory_balances
    where branch_id = v_transfer.source_branch_id
      and product_id = v_item.product_id
    for update;

    if not found then
      raise exception 'Source inventory record is missing';
    end if;

    v_new_quantity := v_balance.quantity + v_item.quantity;

    if v_new_quantity > 0 and v_balance.quantity >= 0 then
      v_new_average_cost := round(
        (
          (v_balance.quantity * v_balance.average_cost)
          + (v_item.quantity * v_item.unit_cost)
        ) / v_new_quantity,
        4
      );
    else
      v_new_average_cost := v_item.unit_cost;
    end if;

    update public.inventory_balances
    set quantity = v_new_quantity,
        average_cost = v_new_average_cost,
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
      v_profile.organization_id,
      v_transfer.source_branch_id,
      v_item.product_id,
      'transfer_in',
      v_item.quantity,
      v_balance.quantity,
      v_new_quantity,
      v_item.unit_cost,
      'stock_transfers',
      v_transfer.id,
      concat(v_transfer.transfer_number, ' cancelled and restored'),
      v_user_id
    );
  end loop;

  update public.stock_transfers
  set status = 'cancelled',
      cancelled_by = v_user_id,
      cancelled_at = now(),
      cancel_reason = trim(p_reason),
      updated_at = now()
  where id = v_transfer.id;

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'cancel_stock_transfer',
    'stock_transfer',
    v_transfer.id,
    jsonb_build_object(
      'transfer_number', v_transfer.transfer_number,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'status', 'cancelled'
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. RETURN PURCHASED STOCK TO SUPPLIER
-- ----------------------------------------------------------------------------

create or replace function public.process_supplier_return(
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
  v_available numeric(14,3);
  v_return_id uuid;
  v_return_number text;
  v_line_total numeric(14,2);
  v_total_amount numeric(14,2) := 0;
  v_total_units numeric(14,3) := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true or v_profile.branch_id is null then
    raise exception 'An active user profile and branch are required';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
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
  ) values (
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
  ) returning id into v_return_id;

  for v_item in
    select
      x.purchase_item_id,
      sum(x.quantity)::numeric(14,3) as quantity
    from jsonb_to_recordset(p_items)
      as x(purchase_item_id uuid, quantity numeric)
    group by x.purchase_item_id
    order by x.purchase_item_id
  loop
    if v_item.purchase_item_id is null or v_item.quantity is null or v_item.quantity <= 0 then
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

    v_available := v_purchase_item.quantity - v_previous_returned;

    if v_item.quantity > v_available then
      raise exception 'Only % units can still be returned for this purchase item', v_available;
    end if;

    select *
    into strict v_product
    from public.products
    where id = v_purchase_item.product_id
      and organization_id = v_profile.organization_id;

    select *
    into v_balance
    from public.inventory_balances
    where branch_id = v_profile.branch_id
      and product_id = v_product.id
    for update;

    if not found or v_balance.quantity < v_item.quantity then
      raise exception 'Not enough current stock to return "%". Available: %',
        v_product.name, coalesce(v_balance.quantity, 0);
    end if;

    v_line_total := round(v_purchase_item.unit_cost * v_item.quantity, 2);

    insert into public.purchase_return_items (
      organization_id,
      purchase_return_id,
      purchase_item_id,
      product_id,
      quantity,
      unit_cost,
      line_total
    ) values (
      v_profile.organization_id,
      v_return_id,
      v_purchase_item.id,
      v_product.id,
      v_item.quantity,
      v_purchase_item.unit_cost,
      v_line_total
    );

    update public.inventory_balances
    set quantity = quantity - v_item.quantity,
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
      v_profile.organization_id,
      v_profile.branch_id,
      v_product.id,
      'supplier_return',
      -v_item.quantity,
      v_balance.quantity,
      v_balance.quantity - v_item.quantity,
      v_purchase_item.unit_cost,
      'purchase_returns',
      v_return_id,
      concat(v_return_number, ' from ', v_purchase.purchase_number),
      v_user_id
    );

    v_total_amount := v_total_amount + v_line_total;
    v_total_units := v_total_units + v_item.quantity;
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
  ) values (
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
      'total_units', v_total_units,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'return_id', v_return_id,
    'return_number', v_return_number,
    'purchase_number', v_purchase.purchase_number,
    'currency', v_purchase.currency,
    'total_amount', v_total_amount,
    'total_units', v_total_units
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. PRIVILEGES AND RLS
-- ----------------------------------------------------------------------------

revoke all on function public.create_stock_transfer(uuid, jsonb, text) from public, anon;
revoke all on function public.receive_stock_transfer(uuid, text) from public, anon;
revoke all on function public.cancel_stock_transfer(uuid, text) from public, anon;
revoke all on function public.process_supplier_return(uuid, jsonb, text, text) from public, anon;

grant execute on function public.create_stock_transfer(uuid, jsonb, text)
  to authenticated, service_role;
grant execute on function public.receive_stock_transfer(uuid, text)
  to authenticated, service_role;
grant execute on function public.cancel_stock_transfer(uuid, text)
  to authenticated, service_role;
grant execute on function public.process_supplier_return(uuid, jsonb, text, text)
  to authenticated, service_role;

alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_items enable row level security;
alter table public.purchase_returns enable row level security;
alter table public.purchase_return_items enable row level security;

drop policy if exists stock_transfers_select_management on public.stock_transfers;
create policy stock_transfers_select_management
on public.stock_transfers
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager']::public.app_role[]))
);

drop policy if exists stock_transfer_items_select_management on public.stock_transfer_items;
create policy stock_transfer_items_select_management
on public.stock_transfer_items
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager']::public.app_role[]))
);

drop policy if exists purchase_returns_select_management on public.purchase_returns;
create policy purchase_returns_select_management
on public.purchase_returns
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager']::public.app_role[]))
);

drop policy if exists purchase_return_items_select_management on public.purchase_return_items;
create policy purchase_return_items_select_management
on public.purchase_return_items
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager']::public.app_role[]))
);

grant select on
  public.stock_transfers,
  public.stock_transfer_items,
  public.purchase_returns,
  public.purchase_return_items
  to authenticated;

grant all on
  public.stock_transfers,
  public.stock_transfer_items,
  public.purchase_returns,
  public.purchase_return_items
  to service_role;

commit;

-- ============================================================================
-- END STEP 12
-- ============================================================================
