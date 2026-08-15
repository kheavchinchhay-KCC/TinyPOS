-- ============================================================================
-- Tiny POS - Step 30: Partial purchase receiving, backorders and GRNs
-- Run once in the NEW Supabase project after Step 29.
--
-- Purchase-order status remains "ordered" while any quantity is outstanding.
-- The frontend derives "Partially received" from receipt quantities. The order
-- becomes "received" only after every ordered line is fully received.
--
-- This migration does not delete existing business data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. RECEIVED-TO-DATE QUANTITIES
-- Quantities are stored both in the original purchasing unit and base unit.
-- ----------------------------------------------------------------------------

alter table public.purchase_items
  add column if not exists received_quantity numeric(14,3)
    not null default 0,
  add column if not exists base_received_quantity numeric(14,3)
    not null default 0;

update public.purchase_items item
set
  received_quantity = case
    when purchase.status = 'received'
      then item.quantity
    else least(
      greatest(item.received_quantity, 0),
      item.quantity
    )
  end,
  base_received_quantity = case
    when purchase.status = 'received'
      then item.base_quantity
    else least(
      greatest(item.base_received_quantity, 0),
      item.base_quantity
    )
  end
from public.purchases purchase
where purchase.id = item.purchase_id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_items_received_quantity_ck'
  ) then
    alter table public.purchase_items
      add constraint purchase_items_received_quantity_ck
      check (
        received_quantity >= 0
        and received_quantity <= quantity
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_items_base_received_quantity_ck'
  ) then
    alter table public.purchase_items
      add constraint purchase_items_base_received_quantity_ck
      check (
        base_received_quantity >= 0
        and base_received_quantity <= base_quantity
      );
  end if;
end
$$;

alter table public.purchases
  add column if not exists first_received_at timestamptz,
  add column if not exists last_received_at timestamptz;

update public.purchases
set
  first_received_at = coalesce(
    first_received_at,
    received_at
  ),
  last_received_at = coalesce(
    last_received_at,
    received_at
  )
where status = 'received';

-- ----------------------------------------------------------------------------
-- 2. GOODS-RECEIVED NOTES
-- ----------------------------------------------------------------------------

create table if not exists public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid not null
    references public.branches(id) on delete restrict,

  purchase_id uuid not null
    references public.purchases(id) on delete restrict,

  receipt_number text not null,

  supplier_invoice_number text,
  received_at timestamptz not null default now(),
  notes text,

  created_by uuid not null
    references auth.users(id) on delete restrict,

  created_at timestamptz not null default now(),

  unique (organization_id, receipt_number)
);

create table if not exists public.purchase_receipt_items (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  receipt_id uuid not null
    references public.purchase_receipts(id) on delete cascade,

  purchase_item_id uuid not null
    references public.purchase_items(id) on delete restrict,

  product_id uuid not null
    references public.products(id) on delete restrict,

  purchase_unit_name text not null,
  unit_factor numeric(14,3) not null
    check (unit_factor > 0),

  quantity numeric(14,3) not null
    check (quantity > 0),

  base_quantity numeric(14,3) not null
    check (base_quantity > 0),

  unit_cost numeric(14,4) not null
    check (unit_cost >= 0),

  base_unit_cost numeric(14,4) not null
    check (base_unit_cost >= 0),

  line_total numeric(14,2) not null
    check (line_total >= 0),

  created_at timestamptz not null default now(),

  unique (receipt_id, purchase_item_id)
);

create index if not exists purchase_receipts_purchase_date_idx
  on public.purchase_receipts (
    purchase_id,
    received_at desc
  );

create index if not exists purchase_receipts_branch_date_idx
  on public.purchase_receipts (
    organization_id,
    branch_id,
    received_at desc
  );

create index if not exists purchase_receipt_items_receipt_idx
  on public.purchase_receipt_items (receipt_id);

create index if not exists purchase_receipt_items_purchase_item_idx
  on public.purchase_receipt_items (purchase_item_id);

alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_items enable row level security;

drop policy if exists purchase_receipts_select_management
  on public.purchase_receipts;

create policy purchase_receipts_select_management
on public.purchase_receipts
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and branch_id =
    (select private.current_branch_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

drop policy if exists purchase_receipt_items_select_management
  on public.purchase_receipt_items;

create policy purchase_receipt_items_select_management
on public.purchase_receipt_items
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and exists (
    select 1
    from public.purchase_receipts receipt
    where receipt.id = receipt_id
      and receipt.organization_id =
        (select private.current_organization_id())
      and receipt.branch_id =
        (select private.current_branch_id())
  )
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

revoke all on public.purchase_receipts from anon;
revoke all on public.purchase_receipt_items from anon;

grant select on public.purchase_receipts
  to authenticated;

grant select on public.purchase_receipt_items
  to authenticated;

grant all on public.purchase_receipts
  to service_role;

grant all on public.purchase_receipt_items
  to service_role;

-- Prevent the existing PO edit function from deleting item rows after receipt.
create or replace function private.prevent_received_purchase_item_delete()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  if old.received_quantity > 0
     or exists (
       select 1
       from public.purchase_receipt_items receipt_item
       where receipt_item.purchase_item_id = old.id
     ) then
    raise exception
      'A purchase order with received quantities cannot be edited. Create a new order for quantity changes';
  end if;

  return old;
end;
$$;

drop trigger if exists prevent_received_purchase_item_delete
  on public.purchase_items;

create trigger prevent_received_purchase_item_delete
before delete on public.purchase_items
for each row execute function
  private.prevent_received_purchase_item_delete();

-- ----------------------------------------------------------------------------
-- 3. PARTIAL RECEIVING
-- p_items uses quantities in each line's original purchase unit.
-- ----------------------------------------------------------------------------

create or replace function public.receive_purchase_order_v3(
  p_purchase_id uuid,
  p_items jsonb,
  p_amount_paid numeric default 0,
  p_payment_method public.payment_method default 'cash',
  p_payment_reference text default null,
  p_supplier_invoice_number text default null,
  p_received_at timestamptz default now(),
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
  v_purchase_item public.purchase_items%rowtype;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;

  v_receipt_id uuid;
  v_receipt_number text;
  v_received_at timestamptz;

  v_remaining_purchase_units numeric(14,3);
  v_base_receipt_quantity numeric(14,3);
  v_new_received_quantity numeric(14,3);
  v_new_base_received_quantity numeric(14,3);

  v_new_stock_quantity numeric(14,3);
  v_new_average numeric(14,4);
  v_line_total numeric(14,2);

  v_supplier_credit numeric(14,2) := 0;
  v_balance_due numeric(14,2);
  v_new_paid numeric(14,2);

  v_receipt_item_count integer := 0;
  v_receipt_purchase_units numeric(14,3) := 0;
  v_receipt_base_units numeric(14,3) := 0;
  v_receipt_value numeric(14,2) := 0;

  v_order_purchase_units numeric(14,3) := 0;
  v_order_received_units numeric(14,3) := 0;
  v_order_base_units numeric(14,3) := 0;
  v_order_base_received numeric(14,3) := 0;

  v_fully_received boolean := false;
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

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot receive purchase orders';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Enter a received quantity for at least one product';
  end if;

  if p_amount_paid is null or p_amount_paid < 0 then
    raise exception 'Payment amount cannot be negative';
  end if;

  v_received_at := coalesce(p_received_at, now());

  if v_received_at > now() + interval '5 minutes' then
    raise exception 'Received time cannot be in the future';
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
    raise exception 'Only an open purchase order can receive stock';
  end if;

  if v_received_at < v_purchase.created_at then
    raise exception 'Received time cannot be before the purchase order was created';
  end if;

  if not exists (
    select 1
    from public.purchase_items item
    where item.purchase_id = v_purchase.id
  ) then
    raise exception 'This purchase order has no items';
  end if;

  if to_regprocedure('private.purchase_supplier_credit_total(uuid)')
     is not null then
    v_supplier_credit := round(
      private.purchase_supplier_credit_total(
        v_purchase.id
      ),
      2
    );
  end if;

  v_balance_due := greatest(
    round(
      v_purchase.total_amount
      - coalesce(v_purchase.amount_paid, 0)
      - v_supplier_credit,
      2
    ),
    0
  );

  if round(p_amount_paid, 2) > v_balance_due then
    raise exception
      'Payment exceeds the outstanding purchase balance of %',
      v_balance_due;
  end if;

  v_new_paid := round(
    coalesce(v_purchase.amount_paid, 0)
    + p_amount_paid,
    2
  );

  -- Validate and lock every selected purchase item.
  for v_item in
    select
      input.purchase_item_id,
      sum(input.quantity)::numeric(14,3)
        as quantity
    from jsonb_to_recordset(p_items)
      as input(
        purchase_item_id uuid,
        quantity numeric
      )
    group by input.purchase_item_id
    order by input.purchase_item_id
  loop
    if v_item.purchase_item_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every receipt item needs a quantity greater than zero';
    end if;

    select *
    into v_purchase_item
    from public.purchase_items
    where id = v_item.purchase_item_id
      and purchase_id = v_purchase.id
    for update;

    if not found then
      raise exception 'A selected receipt item does not belong to this purchase order';
    end if;

    v_remaining_purchase_units := round(
      v_purchase_item.quantity
      - v_purchase_item.received_quantity,
      3
    );

    if v_remaining_purchase_units <= 0 then
      raise exception
        'The selected purchase item has already been fully received';
    end if;

    if v_item.quantity > v_remaining_purchase_units then
      raise exception
        'Only % % remains for this purchase item',
        v_remaining_purchase_units,
        v_purchase_item.purchase_unit_name;
    end if;

    select *
    into v_product
    from public.products
    where id = v_purchase_item.product_id
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
    on conflict (branch_id, product_id)
    do nothing;
  end loop;

  -- Lock selected balances in a stable order.
  perform balance.id
  from public.inventory_balances balance
  join public.purchase_items item
    on item.product_id = balance.product_id
  join (
    select distinct input.purchase_item_id
    from jsonb_to_recordset(p_items)
      as input(
        purchase_item_id uuid,
        quantity numeric
      )
  ) selected
    on selected.purchase_item_id = item.id
  where item.purchase_id = v_purchase.id
    and balance.branch_id = v_profile.branch_id
  order by balance.product_id
  for update of balance;

  v_receipt_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'GRN'
  );

  insert into public.purchase_receipts (
    organization_id,
    branch_id,
    purchase_id,
    receipt_number,
    supplier_invoice_number,
    received_at,
    notes,
    created_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_purchase.id,
    v_receipt_number,
    nullif(trim(p_supplier_invoice_number), ''),
    v_received_at,
    nullif(trim(p_notes), ''),
    v_user_id
  )
  returning id into v_receipt_id;

  for v_item in
    select
      input.purchase_item_id,
      sum(input.quantity)::numeric(14,3)
        as quantity
    from jsonb_to_recordset(p_items)
      as input(
        purchase_item_id uuid,
        quantity numeric
      )
    group by input.purchase_item_id
    order by input.purchase_item_id
  loop
    select *
    into strict v_purchase_item
    from public.purchase_items
    where id = v_item.purchase_item_id
      and purchase_id = v_purchase.id
    for update;

    select *
    into strict v_product
    from public.products
    where id = v_purchase_item.product_id
      and organization_id = v_profile.organization_id;

    v_base_receipt_quantity := round(
      v_item.quantity
      * v_purchase_item.unit_factor,
      3
    );

    v_new_received_quantity := round(
      v_purchase_item.received_quantity
      + v_item.quantity,
      3
    );

    v_new_base_received_quantity := round(
      v_purchase_item.base_received_quantity
      + v_base_receipt_quantity,
      3
    );

    if v_new_received_quantity > v_purchase_item.quantity
       or v_new_base_received_quantity > v_purchase_item.base_quantity then
      raise exception 'Received quantity exceeds the ordered quantity';
    end if;

    v_line_total := round(
      v_item.quantity
      * v_purchase_item.unit_cost,
      2
    );

    insert into public.purchase_receipt_items (
      organization_id,
      receipt_id,
      purchase_item_id,
      product_id,
      purchase_unit_name,
      unit_factor,
      quantity,
      base_quantity,
      unit_cost,
      base_unit_cost,
      line_total
    )
    values (
      v_profile.organization_id,
      v_receipt_id,
      v_purchase_item.id,
      v_purchase_item.product_id,
      v_purchase_item.purchase_unit_name,
      v_purchase_item.unit_factor,
      v_item.quantity,
      v_base_receipt_quantity,
      v_purchase_item.unit_cost,
      v_purchase_item.base_unit_cost,
      v_line_total
    );

    update public.purchase_items
    set
      received_quantity = v_new_received_quantity,
      base_received_quantity =
        v_new_base_received_quantity
    where id = v_purchase_item.id;

    if v_product.track_stock then
      select *
      into strict v_balance
      from public.inventory_balances
      where branch_id = v_profile.branch_id
        and product_id = v_product.id
      for update;

      v_new_stock_quantity := round(
        v_balance.quantity
        + v_base_receipt_quantity,
        3
      );

      if v_balance.quantity > 0
         and v_new_stock_quantity > 0 then
        v_new_average := round(
          (
            v_balance.quantity
            * coalesce(v_balance.average_cost, 0)
            + v_base_receipt_quantity
            * v_purchase_item.base_unit_cost
          )
          / v_new_stock_quantity,
          4
        );
      else
        v_new_average :=
          v_purchase_item.base_unit_cost;
      end if;

      update public.inventory_balances
      set
        quantity = v_new_stock_quantity,
        average_cost = v_new_average,
        updated_at = now()
      where id = v_balance.id;

      update public.products
      set
        default_cost = v_new_average,
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
        created_by,
        created_at
      )
      values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_product.id,
        'purchase',
        v_base_receipt_quantity,
        v_balance.quantity,
        v_new_stock_quantity,
        v_purchase_item.base_unit_cost,
        'purchase_receipts',
        v_receipt_id,
        format(
          '%s · %s · %s %s = %s %s',
          v_receipt_number,
          v_purchase.purchase_number,
          v_item.quantity,
          v_purchase_item.purchase_unit_name,
          v_base_receipt_quantity,
          v_product.unit_name
        ),
        v_user_id,
        v_received_at
      );
    else
      update public.products
      set
        default_cost =
          v_purchase_item.base_unit_cost,
        updated_at = now()
      where id = v_product.id;
    end if;

    v_receipt_item_count :=
      v_receipt_item_count + 1;

    v_receipt_purchase_units :=
      v_receipt_purchase_units
      + v_item.quantity;

    v_receipt_base_units :=
      v_receipt_base_units
      + v_base_receipt_quantity;

    v_receipt_value :=
      v_receipt_value
      + v_line_total;
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
      paid_by,
      paid_at
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_purchase.id,
      p_payment_method,
      v_purchase.currency,
      round(p_amount_paid, 2),
      nullif(trim(p_payment_reference), ''),
      concat_ws(
        ' · ',
        v_receipt_number,
        nullif(trim(p_notes), '')
      ),
      v_user_id,
      v_received_at
    );
  end if;

  select
    coalesce(sum(item.quantity), 0),
    coalesce(sum(item.received_quantity), 0),
    coalesce(sum(item.base_quantity), 0),
    coalesce(sum(item.base_received_quantity), 0),
    bool_and(
      item.received_quantity >= item.quantity
    )
  into
    v_order_purchase_units,
    v_order_received_units,
    v_order_base_units,
    v_order_base_received,
    v_fully_received
  from public.purchase_items item
  where item.purchase_id = v_purchase.id;

  v_fully_received :=
    coalesce(v_fully_received, false);

  update public.purchases
  set
    status = case
      when v_fully_received
        then 'received'
      else 'ordered'
    end,

    amount_paid = v_new_paid,

    supplier_invoice_number = coalesce(
      nullif(trim(p_supplier_invoice_number), ''),
      supplier_invoice_number
    ),

    notes = case
      when nullif(trim(p_notes), '') is null
        then notes
      when notes is null
        then trim(p_notes)
      else notes || E'\n' || trim(p_notes)
    end,

    ordered_at = coalesce(
      ordered_at,
      v_received_at
    ),

    ordered_by = coalesce(
      ordered_by,
      v_user_id
    ),

    first_received_at = case
      when first_received_at is null
        then v_received_at
      else least(
        first_received_at,
        v_received_at
      )
    end,

    last_received_at = greatest(
      coalesce(last_received_at, v_received_at),
      v_received_at
    ),

    received_at = case
      when v_fully_received
        then greatest(
          coalesce(last_received_at, v_received_at),
          v_received_at
        )
      else null
    end,

    received_by = case
      when v_fully_received
        then v_user_id
      else null
    end,

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
    'receive_purchase_order_partial',
    'purchase_receipt',
    v_receipt_id,
    jsonb_build_object(
      'receipt_number', v_receipt_number,
      'purchase_id', v_purchase.id,
      'purchase_number',
        v_purchase.purchase_number,
      'receipt_item_count',
        v_receipt_item_count,
      'receipt_purchase_units',
        v_receipt_purchase_units,
      'receipt_base_units',
        v_receipt_base_units,
      'receipt_value',
        round(v_receipt_value, 2),
      'order_purchase_units',
        v_order_purchase_units,
      'order_received_units',
        v_order_received_units,
      'order_base_units',
        v_order_base_units,
      'order_base_received',
        v_order_base_received,
      'fully_received',
        v_fully_received,
      'amount_paid',
        v_new_paid,
      'balance_due',
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_supplier_credit,
          0
        )
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number',
      v_purchase.purchase_number,
    'receipt_id', v_receipt_id,
    'receipt_number', v_receipt_number,
    'received_at', v_received_at,
    'status', case
      when v_fully_received
        then 'received'
      else 'ordered'
    end,
    'receiving_status', case
      when v_fully_received
        then 'received'
      else 'partially_received'
    end,
    'receipt_item_count',
      v_receipt_item_count,
    'receipt_purchase_units',
      v_receipt_purchase_units,
    'receipt_base_units',
      v_receipt_base_units,
    'receipt_value',
      round(v_receipt_value, 2),
    'order_purchase_units',
      v_order_purchase_units,
    'order_received_units',
      v_order_received_units,
    'order_remaining_units',
      greatest(
        v_order_purchase_units
        - v_order_received_units,
        0
      ),
    'order_base_units',
      v_order_base_units,
    'order_base_received',
      v_order_base_received,
    'order_base_remaining',
      greatest(
        v_order_base_units
        - v_order_base_received,
        0
      ),
    'fully_received', v_fully_received,
    'amount_paid', v_new_paid,
    'supplier_return_credit',
      v_supplier_credit,
    'balance_due',
      round(
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_supplier_credit,
          0
        ),
        2
      ),
    'currency', v_purchase.currency
  );
end;
$$;

revoke all on function public.receive_purchase_order_v3(
  uuid,
  jsonb,
  numeric,
  public.payment_method,
  text,
  text,
  timestamptz,
  text
) from public, anon;

grant execute on function public.receive_purchase_order_v3(
  uuid,
  jsonb,
  numeric,
  public.payment_method,
  text,
  text,
  timestamptz,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. BLOCK CANCELLATION AFTER ANY GOODS RECEIPT
-- ----------------------------------------------------------------------------

create or replace function public.cancel_purchase_order(
  p_purchase_id uuid,
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
  v_purchase public.purchases%rowtype;
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

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot cancel purchase orders';
  end if;

  if p_reason is null
     or length(trim(p_reason)) < 3 then
    raise exception 'Cancellation reason is required';
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
    raise exception 'Only an open purchase order can be cancelled';
  end if;

  if coalesce(v_purchase.amount_paid, 0) > 0 then
    raise exception 'This order has supplier payments. Reverse them before cancellation';
  end if;

  if exists (
    select 1
    from public.purchase_items item
    where item.purchase_id = v_purchase.id
      and item.received_quantity > 0
  ) then
    raise exception 'A partially received purchase order cannot be cancelled. Return received stock to the supplier instead';
  end if;

  update public.purchases
  set
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = v_user_id,
    cancel_reason = trim(p_reason),
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
    'cancel_purchase_order',
    'purchase',
    v_purchase.id,
    jsonb_build_object(
      'purchase_number',
        v_purchase.purchase_number,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number',
      v_purchase.purchase_number,
    'status', 'cancelled'
  );
end;
$$;

revoke all on function public.cancel_purchase_order(uuid,text)
  from public, anon;

grant execute on function public.cancel_purchase_order(uuid,text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. SUPPLIER RETURNS USE RECEIVED-TO-DATE, NOT ORDERED QUANTITY
-- ----------------------------------------------------------------------------

create or replace function public.process_supplier_return_v3(
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

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot return stock to suppliers';
  end if;

  if p_reason is null
     or length(trim(p_reason)) < 3 then
    raise exception 'A supplier return reason is required';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one received item to return';
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

  if v_purchase.status not in ('ordered','received') then
    raise exception 'Only a purchase with received stock can be returned';
  end if;

  if not exists (
    select 1
    from public.purchase_items item
    where item.purchase_id = v_purchase.id
      and item.received_quantity > 0
  ) then
    raise exception 'This purchase order has no received stock';
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
      input.purchase_item_id,
      sum(input.quantity)::numeric(14,3)
        as quantity
    from jsonb_to_recordset(p_items)
      as input(
        purchase_item_id uuid,
        quantity numeric
      )
    group by input.purchase_item_id
    order by input.purchase_item_id
  loop
    if v_item.purchase_item_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every supplier return item needs a valid quantity';
    end if;

    select *
    into v_purchase_item
    from public.purchase_items
    where id = v_item.purchase_item_id
      and purchase_id = v_purchase.id
    for update;

    if not found then
      raise exception 'A selected item does not belong to this purchase order';
    end if;

    select coalesce(sum(return_item.quantity), 0)
    into v_previous_returned
    from public.purchase_return_items return_item
    join public.purchase_returns supplier_return
      on supplier_return.id = return_item.purchase_return_id
    where return_item.purchase_item_id = v_purchase_item.id
      and supplier_return.status = 'completed';

    v_available_purchase_units := greatest(
      v_purchase_item.received_quantity
      - v_previous_returned,
      0
    );

    if v_available_purchase_units <= 0 then
      raise exception 'No received quantity remains returnable for this item';
    end if;

    if v_item.quantity > v_available_purchase_units then
      raise exception
        'Only % % of received stock can still be returned for this item',
        v_available_purchase_units,
        v_purchase_item.purchase_unit_name;
    end if;

    select *
    into strict v_product
    from public.products
    where id = v_purchase_item.product_id
      and organization_id = v_profile.organization_id;

    v_base_return_quantity := round(
      v_item.quantity
      * v_purchase_item.unit_factor,
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
        'Not enough current stock to return "%". Available: % %; required: % %',
        v_product.name,
        coalesce(v_balance.quantity, 0),
        v_product.unit_name,
        v_base_return_quantity,
        v_product.unit_name;
    end if;

    v_line_total := round(
      v_purchase_item.unit_cost
      * v_item.quantity,
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
      quantity = quantity
        - v_base_return_quantity,
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
      v_balance.quantity
        - v_base_return_quantity,
      v_purchase_item.base_unit_cost,
      'purchase_returns',
      v_return_id,
      format(
        '%s from %s · %s %s = %s %s',
        v_return_number,
        v_purchase.purchase_number,
        v_item.quantity,
        v_purchase_item.purchase_unit_name,
        v_base_return_quantity,
        v_product.unit_name
      ),
      v_user_id
    );

    v_total_amount :=
      v_total_amount + v_line_total;

    v_total_purchase_units :=
      v_total_purchase_units
      + v_item.quantity;

    v_total_base_units :=
      v_total_base_units
      + v_base_return_quantity;
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
      'purchase_number',
        v_purchase.purchase_number,
      'total_amount', v_total_amount,
      'purchase_units',
        v_total_purchase_units,
      'base_units',
        v_total_base_units,
      'reason', trim(p_reason),
      'received_quantity_aware', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'return_id', v_return_id,
    'return_number', v_return_number,
    'purchase_number',
      v_purchase.purchase_number,
    'currency', v_purchase.currency,
    'total_amount', v_total_amount,
    'purchase_units',
      v_total_purchase_units,
    'base_units', v_total_base_units
  );
end;
$$;

revoke all on function public.process_supplier_return_v3(
  uuid,
  jsonb,
  text,
  text
) from public, anon;

grant execute on function public.process_supplier_return_v3(
  uuid,
  jsonb,
  text,
  text
) to authenticated, service_role;

-- Force authenticated clients through the receipt-aware functions.
revoke execute on function public.receive_purchase_order(
  uuid,
  numeric,
  public.payment_method,
  text,
  text,
  text
) from authenticated;

revoke execute on function public.receive_purchase_order_v2(
  uuid,
  numeric,
  public.payment_method,
  text,
  text,
  text
) from authenticated;

revoke execute on function public.process_supplier_return(
  uuid,
  jsonb,
  text,
  text
) from authenticated;

revoke execute on function public.process_supplier_return_v2(
  uuid,
  jsonb,
  text,
  text
) from authenticated;

commit;

-- ============================================================================
-- END STEP 30
-- ============================================================================
