-- ============================================================================
-- Tiny POS - Step 14: Purchase orders and supplier management
-- Run once in the NEW Supabase project after Step 13.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Supplier codes and additional supplier information
-- ----------------------------------------------------------------------------

alter table public.suppliers
  add column if not exists supplier_code text,
  add column if not exists contact_name text,
  add column if not exists tax_id text;

create table if not exists public.supplier_code_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_number integer not null default 0 check (last_number >= 0)
);

create or replace function private.next_supplier_code(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number integer;
begin
  insert into public.supplier_code_counters (organization_id, last_number)
  values (p_organization_id, 1)
  on conflict (organization_id)
  do update set last_number = public.supplier_code_counters.last_number + 1
  returning last_number into v_number;

  return 'S' || lpad(v_number::text, 6, '0');
end;
$$;

revoke all on function private.next_supplier_code(uuid) from public;
grant execute on function private.next_supplier_code(uuid) to authenticated, service_role;

create or replace function public.set_supplier_code()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if new.supplier_code is null or length(trim(new.supplier_code)) = 0 then
    new.supplier_code := private.next_supplier_code(new.organization_id);
  else
    new.supplier_code := upper(trim(new.supplier_code));
  end if;
  return new;
end;
$$;

drop trigger if exists set_supplier_code_before_insert on public.suppliers;
create trigger set_supplier_code_before_insert
before insert on public.suppliers
for each row execute function public.set_supplier_code();

-- Backfill existing suppliers in a stable order.
do $$
declare
  r record;
begin
  for r in
    select id, organization_id
    from public.suppliers
    where supplier_code is null or length(trim(supplier_code)) = 0
    order by organization_id, created_at, id
  loop
    update public.suppliers
    set supplier_code = private.next_supplier_code(r.organization_id)
    where id = r.id;
  end loop;
end
$$;

alter table public.suppliers
  alter column supplier_code set not null;

create unique index if not exists suppliers_org_code_uq
  on public.suppliers (organization_id, supplier_code);

-- ----------------------------------------------------------------------------
-- 2. Purchase-order fields and payment ledger
-- ----------------------------------------------------------------------------

alter table public.purchases
  add column if not exists expected_date date,
  add column if not exists payment_terms text,
  add column if not exists delivery_address text,
  add column if not exists ordered_by uuid references auth.users(id) on delete set null,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id) on delete set null,
  add column if not exists cancel_reason text;

create table if not exists public.purchase_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  purchase_id uuid not null references public.purchases(id) on delete cascade,
  method public.payment_method not null,
  currency public.currency_code not null,
  amount numeric(14,2) not null check (amount > 0),
  reference_number text,
  notes text,
  paid_by uuid not null references auth.users(id) on delete restrict,
  paid_at timestamptz not null default now()
);

create index if not exists purchases_org_branch_status_created_idx
  on public.purchases (organization_id, branch_id, status, created_at desc);

create index if not exists purchase_payments_purchase_paid_idx
  on public.purchase_payments (purchase_id, paid_at desc);

alter table public.purchase_payments enable row level security;

drop policy if exists purchase_payments_select_management on public.purchase_payments;
create policy purchase_payments_select_management
on public.purchase_payments
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager']::public.app_role[]))
);

revoke all on public.purchase_payments from anon;
grant select on public.purchase_payments to authenticated;
grant all on public.purchase_payments to service_role;

-- ----------------------------------------------------------------------------
-- 3. Secure supplier save function
-- ----------------------------------------------------------------------------

create or replace function public.save_supplier(
  p_supplier_id uuid,
  p_name text,
  p_contact_name text default null,
  p_phone text default null,
  p_email text default null,
  p_address text default null,
  p_tax_id text default null,
  p_notes text default null,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_supplier public.suppliers%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot manage suppliers';
  end if;

  if p_name is null or length(trim(p_name)) < 2 then
    raise exception 'Supplier name is required';
  end if;

  if p_supplier_id is null then
    insert into public.suppliers (
      organization_id,
      name,
      contact_name,
      phone,
      email,
      address,
      tax_id,
      notes,
      is_active,
      created_by
    ) values (
      v_profile.organization_id,
      trim(p_name),
      nullif(trim(p_contact_name), ''),
      nullif(trim(p_phone), ''),
      nullif(trim(p_email), ''),
      nullif(trim(p_address), ''),
      nullif(trim(p_tax_id), ''),
      nullif(trim(p_notes), ''),
      coalesce(p_is_active, true),
      v_user_id
    ) returning * into v_supplier;
  else
    update public.suppliers
    set
      name = trim(p_name),
      contact_name = nullif(trim(p_contact_name), ''),
      phone = nullif(trim(p_phone), ''),
      email = nullif(trim(p_email), ''),
      address = nullif(trim(p_address), ''),
      tax_id = nullif(trim(p_tax_id), ''),
      notes = nullif(trim(p_notes), ''),
      is_active = coalesce(p_is_active, true),
      updated_at = now()
    where id = p_supplier_id
      and organization_id = v_profile.organization_id
    returning * into v_supplier;

    if not found then
      raise exception 'Supplier not found';
    end if;
  end if;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    case when p_supplier_id is null then 'create_supplier' else 'update_supplier' end,
    'supplier',
    v_supplier.id,
    to_jsonb(v_supplier)
  );

  return jsonb_build_object(
    'ok', true,
    'supplier_id', v_supplier.id,
    'supplier_code', v_supplier.supplier_code,
    'name', v_supplier.name
  );
end;
$$;

revoke all on function public.save_supplier(uuid,text,text,text,text,text,text,text,boolean)
  from public, anon;
grant execute on function public.save_supplier(uuid,text,text,text,text,text,text,text,boolean)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Create or update a draft/ordered purchase order
-- ----------------------------------------------------------------------------

create or replace function public.save_purchase_order(
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
  v_purchase_id uuid;
  v_purchase_number text;
  v_subtotal numeric(14,2) := 0;
  v_total numeric(14,2);
  v_line_total numeric(14,2);
  v_item_count integer;
  v_distinct_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot manage purchase orders';
  end if;

  if p_status not in ('draft','ordered') then
    raise exception 'A purchase order can only be saved as draft or ordered';
  end if;

  if p_supplier_id is null or not exists (
    select 1 from public.suppliers
    where id = p_supplier_id
      and organization_id = v_profile.organization_id
      and is_active = true
  ) then
    raise exception 'Choose an active supplier';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product';
  end if;

  if coalesce(p_discount_amount,0) < 0 or coalesce(p_tax_amount,0) < 0 then
    raise exception 'Discount and tax cannot be negative';
  end if;

  select count(*), count(distinct x.product_id)
  into v_item_count, v_distinct_count
  from jsonb_to_recordset(p_items)
    as x(product_id uuid, quantity numeric, unit_cost numeric);

  if v_item_count <> v_distinct_count then
    raise exception 'The same product cannot appear twice';
  end if;

  for v_item in
    select x.product_id, x.quantity, x.unit_cost
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_cost numeric)
    order by x.product_id
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Every item requires a product and quantity greater than zero';
    end if;

    if v_item.unit_cost is null or v_item.unit_cost < 0 then
      raise exception 'Unit cost cannot be negative';
    end if;

    select * into v_product
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

    v_line_total := round(v_item.quantity * v_item.unit_cost, 2);
    v_subtotal := v_subtotal + v_line_total;
  end loop;

  v_total := greatest(
    round(v_subtotal - coalesce(p_discount_amount,0) + coalesce(p_tax_amount,0), 2),
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
    ) values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_purchase_number,
      p_supplier_id,
      p_status,
      p_currency,
      v_subtotal,
      round(coalesce(p_discount_amount,0),2),
      round(coalesce(p_tax_amount,0),2),
      v_total,
      0,
      nullif(trim(p_supplier_invoice_number),''),
      nullif(trim(p_notes),''),
      p_expected_date,
      nullif(trim(p_payment_terms),''),
      nullif(trim(p_delivery_address),''),
      case when p_status = 'ordered' then now() else null end,
      case when p_status = 'ordered' then v_user_id else null end,
      v_user_id
    ) returning * into v_purchase;
  else
    select * into v_purchase
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

    if coalesce(v_purchase.amount_paid,0) > 0 then
      raise exception 'This order already has a payment and cannot be edited';
    end if;

    update public.purchases
    set
      supplier_id = p_supplier_id,
      status = p_status,
      currency = p_currency,
      subtotal = v_subtotal,
      discount_amount = round(coalesce(p_discount_amount,0),2),
      tax_amount = round(coalesce(p_tax_amount,0),2),
      total_amount = v_total,
      supplier_invoice_number = nullif(trim(p_supplier_invoice_number),''),
      notes = nullif(trim(p_notes),''),
      expected_date = p_expected_date,
      payment_terms = nullif(trim(p_payment_terms),''),
      delivery_address = nullif(trim(p_delivery_address),''),
      ordered_at = case
        when p_status = 'ordered' then coalesce(v_purchase.ordered_at, now())
        else null
      end,
      ordered_by = case
        when p_status = 'ordered' then coalesce(v_purchase.ordered_by, v_user_id)
        else null
      end,
      updated_at = now()
    where id = v_purchase.id
    returning * into v_purchase;

    delete from public.purchase_items where purchase_id = v_purchase.id;
  end if;

  v_purchase_id := v_purchase.id;
  v_purchase_number := v_purchase.purchase_number;

  for v_item in
    select x.product_id, x.quantity, x.unit_cost
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, quantity numeric, unit_cost numeric)
    order by x.product_id
  loop
    insert into public.purchase_items (
      organization_id,
      purchase_id,
      product_id,
      quantity,
      unit_cost,
      tax_amount,
      line_total
    ) values (
      v_profile.organization_id,
      v_purchase_id,
      v_item.product_id,
      round(v_item.quantity,3),
      round(v_item.unit_cost,4),
      0,
      round(v_item.quantity * v_item.unit_cost,2)
    );
  end loop;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    case when p_purchase_id is null then 'create_purchase_order' else 'update_purchase_order' end,
    'purchase',
    v_purchase_id,
    jsonb_build_object(
      'purchase_number', v_purchase_number,
      'status', p_status,
      'supplier_id', p_supplier_id,
      'item_count', v_item_count,
      'total_amount', v_total,
      'currency', p_currency
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

revoke all on function public.save_purchase_order(
  uuid,uuid,jsonb,public.currency_code,numeric,numeric,date,text,text,text,text,public.purchase_status
) from public, anon;
grant execute on function public.save_purchase_order(
  uuid,uuid,jsonb,public.currency_code,numeric,numeric,date,text,text,text,text,public.purchase_status
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. Receive an existing purchase order and update stock once
-- ----------------------------------------------------------------------------

create or replace function public.receive_purchase_order(
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
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot receive purchase orders';
  end if;

  select * into v_purchase
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

  v_new_paid := round(coalesce(v_purchase.amount_paid,0) + p_amount_paid,2);

  if v_new_paid > v_purchase.total_amount then
    raise exception 'Total payments cannot exceed the purchase total';
  end if;

  if not exists (
    select 1 from public.purchase_items where purchase_id = v_purchase.id
  ) then
    raise exception 'This purchase order has no items';
  end if;

  -- Ensure and lock all inventory rows in stable product order.
  for v_item in
    select pi.product_id
    from public.purchase_items pi
    where pi.purchase_id = v_purchase.id
    order by pi.product_id
  loop
    select * into v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id;

    if not found or v_product.is_active is not true then
      raise exception 'A purchase-order product is missing or inactive';
    end if;

    insert into public.inventory_balances (
      organization_id, branch_id, product_id, quantity, average_cost
    ) values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_product.id,
      0,
      v_product.default_cost
    ) on conflict (branch_id,product_id) do nothing;
  end loop;

  perform ib.id
  from public.inventory_balances ib
  join public.purchase_items pi on pi.product_id = ib.product_id
  where pi.purchase_id = v_purchase.id
    and ib.branch_id = v_profile.branch_id
  order by ib.product_id
  for update of ib;

  for v_item in
    select pi.*, p.track_stock, p.name
    from public.purchase_items pi
    join public.products p on p.id = pi.product_id
    where pi.purchase_id = v_purchase.id
    order by pi.product_id
  loop
    v_item_count := v_item_count + 1;

    if v_item.track_stock then
      select * into strict v_balance
      from public.inventory_balances
      where branch_id = v_profile.branch_id
        and product_id = v_item.product_id
      for update;

      v_new_quantity := v_balance.quantity + v_item.quantity;

      if v_balance.quantity > 0 and v_new_quantity > 0 then
        v_new_average := round(
          ((v_balance.quantity * coalesce(v_balance.average_cost,0))
           + (v_item.quantity * v_item.unit_cost)) / v_new_quantity,
          4
        );
      else
        v_new_average := v_item.unit_cost;
      end if;

      update public.inventory_balances
      set quantity = v_new_quantity,
          average_cost = v_new_average,
          updated_at = now()
      where id = v_balance.id;

      update public.products
      set default_cost = v_new_average,
          updated_at = now()
      where id = v_item.product_id;

      insert into public.stock_movements (
        organization_id, branch_id, product_id, movement_type,
        quantity_change, quantity_before, quantity_after, unit_cost,
        reference_table, reference_id, notes, created_by
      ) values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_item.product_id,
        'purchase',
        v_item.quantity,
        v_balance.quantity,
        v_new_quantity,
        v_item.unit_cost,
        'purchases',
        v_purchase.id,
        v_purchase.purchase_number,
        v_user_id
      );
    else
      update public.products
      set default_cost = v_item.unit_cost,
          updated_at = now()
      where id = v_item.product_id;
    end if;
  end loop;

  if p_amount_paid > 0 then
    insert into public.purchase_payments (
      organization_id, branch_id, purchase_id, method, currency,
      amount, reference_number, notes, paid_by
    ) values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_purchase.id,
      p_payment_method,
      v_purchase.currency,
      round(p_amount_paid,2),
      nullif(trim(p_payment_reference),''),
      nullif(trim(p_notes),''),
      v_user_id
    );
  end if;

  update public.purchases
  set
    status = 'received',
    amount_paid = v_new_paid,
    supplier_invoice_number = coalesce(
      nullif(trim(p_supplier_invoice_number),''),
      supplier_invoice_number
    ),
    notes = case
      when nullif(trim(p_notes),'') is null then notes
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
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'receive_purchase_order',
    'purchase',
    v_purchase.id,
    jsonb_build_object(
      'purchase_number', v_purchase.purchase_number,
      'item_count', v_item_count,
      'total_amount', v_purchase.total_amount,
      'amount_paid', v_new_paid,
      'balance_due', v_purchase.total_amount - v_new_paid
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number', v_purchase.purchase_number,
    'status', 'received',
    'item_count', v_item_count,
    'total_amount', v_purchase.total_amount,
    'amount_paid', v_new_paid,
    'balance_due', round(v_purchase.total_amount - v_new_paid,2),
    'currency', v_purchase.currency
  );
end;
$$;

revoke all on function public.receive_purchase_order(uuid,numeric,public.payment_method,text,text,text)
  from public, anon;
grant execute on function public.receive_purchase_order(uuid,numeric,public.payment_method,text,text,text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. Record an additional supplier payment
-- ----------------------------------------------------------------------------

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
  v_new_paid numeric(14,2);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot record supplier payments';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  select * into v_purchase
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

  v_new_paid := round(coalesce(v_purchase.amount_paid,0) + p_amount,2);

  if v_new_paid > v_purchase.total_amount then
    raise exception 'Payment exceeds the outstanding balance';
  end if;

  insert into public.purchase_payments (
    organization_id, branch_id, purchase_id, method, currency,
    amount, reference_number, notes, paid_by
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_purchase.id,
    p_method,
    v_purchase.currency,
    round(p_amount,2),
    nullif(trim(p_reference_number),''),
    nullif(trim(p_notes),''),
    v_user_id
  );

  update public.purchases
  set amount_paid = v_new_paid,
      updated_at = now()
  where id = v_purchase.id;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'record_purchase_payment',
    'purchase',
    v_purchase.id,
    jsonb_build_object(
      'purchase_number', v_purchase.purchase_number,
      'payment_amount', p_amount,
      'amount_paid', v_new_paid,
      'balance_due', v_purchase.total_amount - v_new_paid,
      'method', p_method
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number', v_purchase.purchase_number,
    'amount_paid', v_new_paid,
    'balance_due', round(v_purchase.total_amount - v_new_paid,2),
    'payment_status', case
      when v_new_paid = 0 then 'unpaid'
      when v_new_paid < v_purchase.total_amount then 'partial'
      else 'paid'
    end
  );
end;
$$;

revoke all on function public.record_purchase_payment(uuid,numeric,public.payment_method,text,text)
  from public, anon;
grant execute on function public.record_purchase_payment(uuid,numeric,public.payment_method,text,text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. Cancel an unreceived and unpaid purchase order
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

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot cancel purchase orders';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Cancellation reason is required';
  end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Purchase order not found';
  end if;

  if v_purchase.status not in ('draft','ordered') then
    raise exception 'Only draft or ordered purchase orders can be cancelled';
  end if;

  if coalesce(v_purchase.amount_paid,0) > 0 then
    raise exception 'This order has supplier payments. Reverse them before cancellation';
  end if;

  update public.purchases
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_by = v_user_id,
      cancel_reason = trim(p_reason),
      updated_at = now()
  where id = v_purchase.id;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'cancel_purchase_order',
    'purchase',
    v_purchase.id,
    jsonb_build_object(
      'purchase_number', v_purchase.purchase_number,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number', v_purchase.purchase_number,
    'status', 'cancelled'
  );
end;
$$;

revoke all on function public.cancel_purchase_order(uuid,text) from public, anon;
grant execute on function public.cancel_purchase_order(uuid,text)
  to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 14
-- ============================================================================
