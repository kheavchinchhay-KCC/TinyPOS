-- ============================================================================
-- Tiny POS - Step 26: Sales quotations and proforma invoices
-- Run once in the NEW Supabase project after Step 25.
--
-- Quotations do not deduct stock and do not create payments or receivables.
-- Inventory changes only when the quotation is converted through New Sale.
--
-- This migration does not delete existing business data.
-- ============================================================================

begin;

do $$
begin
  if not exists (
    select 1
    from pg_type
    where typname = 'sales_quote_status'
  ) then
    create type public.sales_quote_status as enum (
      'draft',
      'sent',
      'accepted',
      'expired',
      'cancelled',
      'converted'
    );
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 1. QUOTATION HEADERS
-- ----------------------------------------------------------------------------

create table if not exists public.sales_quotes (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid not null
    references public.branches(id) on delete restrict,

  quote_number text not null,

  customer_id uuid
    references public.customers(id) on delete set null,

  status public.sales_quote_status
    not null default 'draft',

  currency public.currency_code
    not null default 'USD',

  subtotal numeric(14,2) not null default 0
    check (subtotal >= 0),

  discount_type public.discount_type
    not null default 'none',

  discount_value numeric(14,4)
    not null default 0
    check (discount_value >= 0),

  discount_amount numeric(14,2)
    not null default 0
    check (discount_amount >= 0),

  coupon_id uuid
    references public.coupons(id) on delete set null,

  coupon_code text,

  tax_amount numeric(14,2)
    not null default 0
    check (tax_amount >= 0),

  total_amount numeric(14,2)
    not null default 0
    check (total_amount >= 0),

  valid_until date,
  notes text,
  terms text,

  created_by uuid not null
    references auth.users(id) on delete restrict,

  sent_by uuid
    references auth.users(id) on delete set null,

  sent_at timestamptz,

  accepted_by uuid
    references auth.users(id) on delete set null,

  accepted_at timestamptz,

  cancelled_by uuid
    references auth.users(id) on delete set null,

  cancelled_at timestamptz,

  cancel_reason text,

  -- Kept as a plain UUID to avoid a circular restore dependency.
  converted_sale_id uuid,

  converted_by uuid
    references auth.users(id) on delete set null,

  converted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, quote_number),

  check (
    valid_until is null
    or valid_until >= created_at::date
  ),

  check (
    (status <> 'sent' or sent_at is not null)
    and
    (status <> 'accepted' or accepted_at is not null)
    and
    (status <> 'cancelled' or cancelled_at is not null)
    and
    (status <> 'converted' or converted_at is not null)
  )
);

create index if not exists sales_quotes_branch_created_idx
  on public.sales_quotes (
    organization_id,
    branch_id,
    created_at desc
  );

create index if not exists sales_quotes_customer_created_idx
  on public.sales_quotes (
    customer_id,
    created_at desc
  )
  where customer_id is not null;

create index if not exists sales_quotes_status_valid_idx
  on public.sales_quotes (
    organization_id,
    branch_id,
    status,
    valid_until
  );

drop trigger if exists set_sales_quotes_updated_at
  on public.sales_quotes;

create trigger set_sales_quotes_updated_at
before update on public.sales_quotes
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. QUOTATION ITEM SNAPSHOTS
-- ----------------------------------------------------------------------------

create table if not exists public.sales_quote_items (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  quote_id uuid not null
    references public.sales_quotes(id) on delete cascade,

  product_id uuid
    references public.products(id) on delete set null,

  product_unit_id uuid
    references public.product_units(id) on delete set null,

  product_name text not null,
  sku text,
  barcode text,

  quantity numeric(14,3) not null
    check (quantity > 0),

  base_quantity numeric(14,3) not null
    check (base_quantity > 0),

  sale_unit_name text not null,

  unit_factor numeric(14,3) not null default 1
    check (unit_factor > 0),

  unit_price numeric(14,2) not null
    check (unit_price >= 0),

  unit_cost numeric(14,4) not null default 0
    check (unit_cost >= 0),

  line_subtotal numeric(14,2) not null
    check (line_subtotal >= 0),

  discount_amount numeric(14,2) not null default 0
    check (discount_amount >= 0),

  line_total numeric(14,2) not null
    check (line_total >= 0),

  created_at timestamptz not null default now()
);

create index if not exists sales_quote_items_quote_idx
  on public.sales_quote_items (
    quote_id,
    created_at
  );

alter table public.sales
  add column if not exists source_quote_id uuid
    references public.sales_quotes(id) on delete set null;

create unique index if not exists sales_source_quote_uq
  on public.sales (source_quote_id)
  where source_quote_id is not null;

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table public.sales_quotes enable row level security;
alter table public.sales_quote_items enable row level security;

drop policy if exists sales_quotes_select_sales_staff
  on public.sales_quotes;

create policy sales_quotes_select_sales_staff
on public.sales_quotes
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
      'manager',
      'cashier'
    ]::public.app_role[]
  ))
);

drop policy if exists sales_quote_items_select_sales_staff
  on public.sales_quote_items;

create policy sales_quote_items_select_sales_staff
on public.sales_quote_items
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and exists (
    select 1
    from public.sales_quotes quote_row
    where quote_row.id = quote_id
      and quote_row.organization_id =
        (select private.current_organization_id())
      and quote_row.branch_id =
        (select private.current_branch_id())
  )
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager',
      'cashier'
    ]::public.app_role[]
  ))
);

revoke all on public.sales_quotes from anon;
revoke all on public.sales_quote_items from anon;

grant select on public.sales_quotes
  to authenticated;

grant select on public.sales_quote_items
  to authenticated;

grant all on public.sales_quotes
  to service_role;

grant all on public.sales_quote_items
  to service_role;

-- ----------------------------------------------------------------------------
-- 4. SAVE OR UPDATE A QUOTATION
-- Product and package prices are always loaded securely from product_units.
-- ----------------------------------------------------------------------------

create or replace function public.save_sales_quote(
  p_quote_id uuid,
  p_items jsonb,
  p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',
  p_manual_discount_value numeric default 0,
  p_coupon_code text default null,
  p_currency public.currency_code default 'USD',
  p_valid_until date default null,
  p_notes text default null,
  p_terms text default null,
  p_status public.sales_quote_status default 'draft'
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
  v_quote public.sales_quotes%rowtype;

  v_item record;
  v_product record;
  v_unit record;
  v_balance record;

  v_coupon jsonb;
  v_coupon_id uuid;
  v_coupon_code text;

  v_quote_id uuid;
  v_quote_number text;

  v_subtotal numeric(14,2) := 0;
  v_discount_amount numeric(14,2) := 0;
  v_tax_amount numeric(14,2) := 0;
  v_total numeric(14,2) := 0;

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
    'cashier'
  ) then
    raise exception 'Your role cannot create quotations';
  end if;

  if p_status not in ('draft', 'sent') then
    raise exception 'A saved quotation can only be Draft or Sent';
  end if;

  if p_valid_until is not null
     and p_valid_until < current_date then
    raise exception 'Quotation validity date cannot be in the past';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product';
  end if;

  if p_customer_id is not null
     and not exists (
       select 1
       from public.customers customer
       where customer.id = p_customer_id
         and customer.organization_id =
           v_profile.organization_id
         and customer.is_active = true
     ) then
    raise exception 'Customer not found or inactive';
  end if;

  select
    coalesce(settings.tax_percent, 0)
      as tax_percent
  into v_settings
  from public.app_settings settings
  where settings.organization_id =
    v_profile.organization_id;

  v_subtotal := private.secure_sale_subtotal(
    v_profile.organization_id,
    p_items,
    p_currency
  );

  if p_coupon_code is not null
     and length(trim(p_coupon_code)) > 0 then
    v_coupon := private.evaluate_coupon(
      v_profile.organization_id,
      v_profile.branch_id,
      p_coupon_code,
      v_subtotal,
      p_customer_id,
      p_currency,
      false
    );

    v_coupon_id :=
      (v_coupon ->> 'id')::uuid;

    v_coupon_code :=
      v_coupon ->> 'code';

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
        raise exception
          'Percentage discount cannot exceed 100';
      end if;

      v_discount_amount := round(
        v_subtotal
        * p_manual_discount_value
        / 100,
        2
      );

      v_display_discount_type := 'percent';
      v_display_discount_value :=
        p_manual_discount_value;

    elsif p_manual_discount_type = 'fixed' then
      v_discount_amount := least(
        v_subtotal,
        round(p_manual_discount_value, 2)
      );

      v_display_discount_type := 'fixed';
      v_display_discount_value :=
        p_manual_discount_value;

    else
      v_discount_amount := 0;
      v_display_discount_type := 'none';
      v_display_discount_value := 0;
    end if;
  end if;

  v_tax_amount := round(
    greatest(
      v_subtotal - v_discount_amount,
      0
    )
    * greatest(
        coalesce(v_settings.tax_percent, 0),
        0
      )
    / 100,
    2
  );

  v_total := greatest(
    round(
      v_subtotal
      - v_discount_amount
      + v_tax_amount,
      2
    ),
    0
  );

  select count(*)
  into v_item_count
  from (
    select
      item.product_id,
      item.product_unit_id
    from jsonb_to_recordset(p_items)
      as item(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric
      )
    group by
      item.product_id,
      item.product_unit_id
  ) grouped_items;

  if p_quote_id is null then
    v_quote_number :=
      private.next_document_number(
        v_profile.organization_id,
        v_profile.branch_id,
        'QTE'
      );

    insert into public.sales_quotes (
      organization_id,
      branch_id,
      quote_number,
      customer_id,
      status,
      currency,
      subtotal,
      discount_type,
      discount_value,
      discount_amount,
      coupon_id,
      coupon_code,
      tax_amount,
      total_amount,
      valid_until,
      notes,
      terms,
      created_by,
      sent_by,
      sent_at
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_quote_number,
      p_customer_id,
      p_status,
      p_currency,
      v_subtotal,
      v_display_discount_type,
      v_display_discount_value,
      v_discount_amount,
      v_coupon_id,
      v_coupon_code,
      v_tax_amount,
      v_total,
      p_valid_until,
      nullif(trim(p_notes), ''),
      nullif(trim(p_terms), ''),
      v_user_id,
      case
        when p_status = 'sent'
          then v_user_id
        else null
      end,
      case
        when p_status = 'sent'
          then now()
        else null
      end
    )
    returning *
    into v_quote;
  else
    select *
    into v_quote
    from public.sales_quotes
    where id = p_quote_id
      and organization_id =
        v_profile.organization_id
      and branch_id =
        v_profile.branch_id
    for update;

    if not found then
      raise exception 'Quotation not found';
    end if;

    if v_quote.status not in ('draft', 'sent') then
      raise exception
        'Only Draft or Sent quotations can be edited';
    end if;

    if v_quote.valid_until is not null
       and v_quote.valid_until < current_date then
      raise exception
        'This quotation has expired and cannot be edited';
    end if;

    update public.sales_quotes
    set
      customer_id = p_customer_id,
      status = p_status,
      currency = p_currency,
      subtotal = v_subtotal,
      discount_type =
        v_display_discount_type,
      discount_value =
        v_display_discount_value,
      discount_amount =
        v_discount_amount,
      coupon_id = v_coupon_id,
      coupon_code = v_coupon_code,
      tax_amount = v_tax_amount,
      total_amount = v_total,
      valid_until = p_valid_until,
      notes = nullif(trim(p_notes), ''),
      terms = nullif(trim(p_terms), ''),
      sent_by = case
        when p_status = 'sent'
          then coalesce(
            v_quote.sent_by,
            v_user_id
          )
        else null
      end,
      sent_at = case
        when p_status = 'sent'
          then coalesce(
            v_quote.sent_at,
            now()
          )
        else null
      end,
      accepted_by = null,
      accepted_at = null,
      updated_at = now()
    where id = v_quote.id
    returning *
    into v_quote;

    delete from public.sales_quote_items
    where quote_id = v_quote.id;
  end if;

  v_quote_id := v_quote.id;
  v_quote_number := v_quote.quote_number;

  for v_item in
    select
      item.product_id,
      item.product_unit_id,
      sum(item.quantity)::numeric(14,3)
        as quantity
    from jsonb_to_recordset(p_items)
      as item(
        product_id uuid,
        product_unit_id uuid,
        quantity numeric
      )
    group by
      item.product_id,
      item.product_unit_id
    order by
      item.product_id,
      item.product_unit_id
  loop
    v_item_index := v_item_index + 1;

    if v_item.product_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception
        'Every quotation item requires a valid quantity';
    end if;

    select
      product.id,
      product.name,
      product.sku,
      product.barcode,
      product.default_cost,
      product.currency,
      product.is_active
    into v_product
    from public.products product
    where product.id = v_item.product_id
      and product.organization_id =
        v_profile.organization_id;

    if not found
       or v_product.is_active is not true then
      raise exception
        'A quotation product is missing or inactive';
    end if;

    if v_product.currency <> p_currency then
      raise exception
        'Product "%" uses %, but the quotation uses %',
        v_product.name,
        v_product.currency,
        p_currency;
    end if;

    select
      unit_row.id,
      unit_row.name,
      unit_row.barcode,
      unit_row.conversion_factor,
      unit_row.selling_price,
      unit_row.is_active
    into v_unit
    from public.product_units unit_row
    where unit_row.organization_id =
        v_profile.organization_id
      and unit_row.product_id =
        v_product.id
      and (
        (
          v_item.product_unit_id is not null
          and unit_row.id =
            v_item.product_unit_id
        )
        or
        (
          v_item.product_unit_id is null
          and unit_row.is_base = true
        )
      )
    limit 1;

    if not found
       or v_unit.is_active is not true then
      raise exception
        'The selected selling unit for "%" is unavailable',
        v_product.name;
    end if;

    select
      balance.quantity,
      balance.average_cost
    into v_balance
    from public.inventory_balances balance
    where balance.branch_id =
        v_profile.branch_id
      and balance.product_id =
        v_product.id;

    v_base_quantity := round(
      v_item.quantity
      * v_unit.conversion_factor,
      3
    );

    v_line_subtotal := round(
      v_item.quantity
      * v_unit.selling_price,
      2
    );

    if v_item_index = v_item_count then
      v_line_discount :=
        v_discount_amount
        - v_allocated_discount;

    elsif v_subtotal > 0 then
      v_line_discount := round(
        v_discount_amount
        * v_line_subtotal
        / v_subtotal,
        2
      );

      v_allocated_discount :=
        v_allocated_discount
        + v_line_discount;

    else
      v_line_discount := 0;
    end if;

    v_line_total := greatest(
      v_line_subtotal
      - v_line_discount,
      0
    );

    v_base_unit_cost := coalesce(
      nullif(v_balance.average_cost, 0),
      v_product.default_cost,
      0
    );

    v_selected_unit_cost := round(
      v_base_unit_cost
      * v_unit.conversion_factor,
      4
    );

    insert into public.sales_quote_items (
      organization_id,
      quote_id,
      product_id,
      product_unit_id,
      product_name,
      sku,
      barcode,
      quantity,
      base_quantity,
      sale_unit_name,
      unit_factor,
      unit_price,
      unit_cost,
      line_subtotal,
      discount_amount,
      line_total
    )
    values (
      v_profile.organization_id,
      v_quote_id,
      v_product.id,
      v_unit.id,
      v_product.name,
      v_product.sku,
      coalesce(
        v_unit.barcode,
        v_product.barcode
      ),
      v_item.quantity,
      v_base_quantity,
      v_unit.name,
      v_unit.conversion_factor,
      v_unit.selling_price,
      v_selected_unit_cost,
      v_line_subtotal,
      v_line_discount,
      v_line_total
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
      when p_quote_id is null
        then 'create_sales_quote'
      else 'update_sales_quote'
    end,
    'sales_quote',
    v_quote_id,
    jsonb_build_object(
      'quote_number', v_quote_number,
      'status', p_status,
      'customer_id', p_customer_id,
      'item_count', v_item_count,
      'subtotal', v_subtotal,
      'discount_amount',
        v_discount_amount,
      'tax_amount', v_tax_amount,
      'total_amount', v_total,
      'currency', p_currency,
      'valid_until', p_valid_until
    )
  );

  return jsonb_build_object(
    'ok', true,
    'quote_id', v_quote_id,
    'quote_number', v_quote_number,
    'status', p_status,
    'subtotal', v_subtotal,
    'discount_amount',
      v_discount_amount,
    'tax_amount', v_tax_amount,
    'total_amount', v_total,
    'currency', p_currency,
    'valid_until', p_valid_until,
    'coupon_code', v_coupon_code
  );
end;
$$;

revoke all on function public.save_sales_quote(
  uuid,
  jsonb,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  date,
  text,
  text,
  public.sales_quote_status
) from public, anon;

grant execute on function public.save_sales_quote(
  uuid,
  jsonb,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  date,
  text,
  text,
  public.sales_quote_status
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. QUOTATION STATUS ACTIONS
-- ----------------------------------------------------------------------------

create or replace function public.update_sales_quote_status(
  p_quote_id uuid,
  p_status public.sales_quote_status,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_quote public.sales_quotes%rowtype;
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
    'cashier'
  ) then
    raise exception 'Your role cannot update quotations';
  end if;

  if p_status not in (
    'draft',
    'sent',
    'accepted',
    'cancelled'
  ) then
    raise exception
      'Unsupported quotation status action';
  end if;

  select *
  into v_quote
  from public.sales_quotes
  where id = p_quote_id
    and organization_id =
      v_profile.organization_id
    and branch_id =
      v_profile.branch_id
  for update;

  if not found then
    raise exception 'Quotation not found';
  end if;

  if v_quote.status in (
    'converted',
    'cancelled'
  ) then
    raise exception
      'This quotation is already %',
      v_quote.status;
  end if;

  if v_quote.valid_until is not null
     and v_quote.valid_until < current_date then
    update public.sales_quotes
    set
      status = 'expired',
      updated_at = now()
    where id = v_quote.id;

    raise exception
      'This quotation expired on %',
      v_quote.valid_until;
  end if;

  if p_status = 'cancelled'
     and (
       p_reason is null
       or length(trim(p_reason)) < 3
     ) then
    raise exception
      'A cancellation reason is required';
  end if;

  update public.sales_quotes
  set
    status = p_status,

    sent_by = case
      when p_status = 'sent'
        then coalesce(sent_by, v_user_id)
      when p_status = 'draft'
        then null
      else sent_by
    end,

    sent_at = case
      when p_status = 'sent'
        then coalesce(sent_at, now())
      when p_status = 'draft'
        then null
      else sent_at
    end,

    accepted_by = case
      when p_status = 'accepted'
        then v_user_id
      when p_status in ('draft', 'sent')
        then null
      else accepted_by
    end,

    accepted_at = case
      when p_status = 'accepted'
        then now()
      when p_status in ('draft', 'sent')
        then null
      else accepted_at
    end,

    cancelled_by = case
      when p_status = 'cancelled'
        then v_user_id
      else null
    end,

    cancelled_at = case
      when p_status = 'cancelled'
        then now()
      else null
    end,

    cancel_reason = case
      when p_status = 'cancelled'
        then trim(p_reason)
      else null
    end,

    updated_at = now()

  where id = v_quote.id
  returning *
  into v_quote;

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
    'update_sales_quote_status',
    'sales_quote',
    v_quote.id,
    jsonb_build_object(
      'quote_number',
        v_quote.quote_number,
      'status',
        v_quote.status,
      'reason',
        v_quote.cancel_reason
    )
  );

  return to_jsonb(v_quote)
    || jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.update_sales_quote_status(
  uuid,
  public.sales_quote_status,
  text
) from public, anon;

grant execute on function public.update_sales_quote_status(
  uuid,
  public.sales_quote_status,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. CHECKOUT WRAPPER WITH QUOTATION CONVERSION
-- complete_sale_v4 remains responsible for cash, non-cash, coupons, package
-- units, inventory, profit, and customer credit.
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v5(
  p_items jsonb,
  p_payment_method text,
  p_amount_received numeric,
  p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',
  p_manual_discount_value numeric default 0,
  p_coupon_code text default null,
  p_currency public.currency_code default 'USD',
  p_notes text default null,
  p_payment_reference text default null,
  p_idempotency_key text default null,
  p_source_quote_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_quote public.sales_quotes%rowtype;
  v_sale public.sales%rowtype;
  v_result jsonb;
  v_sale_id uuid;
  v_today date;
begin
  if p_source_quote_id is not null then
    if v_user_id is null then
      raise exception 'Authentication required';
    end if;

    select
      profile_row.organization_id,
      profile_row.branch_id,
      profile_row.role,
      profile_row.is_active
    into v_profile
    from public.profiles profile_row
    where profile_row.id = v_user_id;

    if not found
       or v_profile.is_active is not true
       or v_profile.branch_id is null then
      raise exception
        'Active POS profile and branch are required';
    end if;

    select
      (
        timezone(
          coalesce(
            nullif(trim(settings.timezone), ''),
            'Asia/Phnom_Penh'
          ),
          now()
        )
      )::date
    into v_today
    from public.app_settings settings
    where settings.organization_id =
      v_profile.organization_id;

    v_today := coalesce(
      v_today,
      current_date
    );

    select *
    into v_quote
    from public.sales_quotes
    where id = p_source_quote_id
      and organization_id =
        v_profile.organization_id
      and branch_id =
        v_profile.branch_id
    for update;

    if not found then
      raise exception 'Quotation not found';
    end if;

    if v_quote.status in (
      'cancelled',
      'expired'
    ) then
      raise exception
        'This quotation is % and cannot be converted',
        v_quote.status;
    end if;

    if v_quote.status = 'converted' then
      if v_quote.converted_sale_id is not null then
        select *
        into v_sale
        from public.sales
        where id =
          v_quote.converted_sale_id;

        if found
           and p_idempotency_key is not null
           and v_sale.idempotency_key =
             nullif(trim(p_idempotency_key), '') then
          return jsonb_build_object(
            'ok', true,
            'duplicate_request', true,
            'sale_id', v_sale.id,
            'invoice_number',
              v_sale.invoice_number,
            'subtotal', v_sale.subtotal,
            'discount_amount',
              v_sale.discount_amount,
            'tax_amount', v_sale.tax_amount,
            'total_amount',
              v_sale.total_amount,
            'change_amount',
              v_sale.change_amount,
            'cost_amount',
              v_sale.cost_amount,
            'gross_profit',
              v_sale.gross_profit,
            'source_quote_id',
              v_quote.id,
            'source_quote_number',
              v_quote.quote_number
          );
        end if;
      end if;

      raise exception
        'This quotation was already converted';
    end if;

    if v_quote.valid_until is not null
       and v_quote.valid_until < v_today then
      update public.sales_quotes
      set
        status = 'expired',
        updated_at = now()
      where id = v_quote.id;

      raise exception
        'This quotation expired on %',
        v_quote.valid_until;
    end if;

    if v_quote.currency <> p_currency then
      raise exception
        'Quotation currency is %, but the sale uses %',
        v_quote.currency,
        p_currency;
    end if;

    if v_quote.customer_id
       is distinct from p_customer_id then
      raise exception
        'The quotation customer cannot be changed during conversion';
    end if;
  end if;

  v_result := public.complete_sale_v4(
    p_items,
    p_payment_method,
    p_amount_received,
    p_customer_id,
    p_manual_discount_type,
    p_manual_discount_value,
    p_coupon_code,
    p_currency,
    p_notes,
    p_payment_reference,
    p_idempotency_key
  );

  if p_source_quote_id is null then
    return v_result;
  end if;

  v_sale_id :=
    (v_result ->> 'sale_id')::uuid;

  select *
  into v_sale
  from public.sales
  where id = v_sale_id
    and organization_id =
      v_profile.organization_id
  for update;

  if not found then
    raise exception
      'Completed sale could not be loaded';
  end if;

  if v_sale.source_quote_id is not null
     and v_sale.source_quote_id
       <> v_quote.id then
    raise exception
      'This invoice is already linked to another quotation';
  end if;

  update public.sales
  set
    source_quote_id = v_quote.id,
    updated_at = now()
  where id = v_sale.id
  returning *
  into v_sale;

  update public.sales_quotes
  set
    status = 'converted',
    converted_sale_id = v_sale.id,
    converted_by = v_user_id,
    converted_at = now(),
    updated_at = now()
  where id = v_quote.id
  returning *
  into v_quote;

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
    'convert_sales_quote',
    'sales_quote',
    v_quote.id,
    jsonb_build_object(
      'quote_number',
        v_quote.quote_number,
      'sale_id',
        v_sale.id,
      'invoice_number',
        v_sale.invoice_number,
      'quote_total',
        v_quote.total_amount,
      'sale_total',
        v_sale.total_amount
    )
  );

  return v_result
    || jsonb_build_object(
      'source_quote_id',
        v_quote.id,
      'source_quote_number',
        v_quote.quote_number
    );
end;
$$;

revoke all on function public.complete_sale_v5(
  jsonb,
  text,
  numeric,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  text,
  text,
  text,
  uuid
) from public, anon;

grant execute on function public.complete_sale_v5(
  jsonb,
  text,
  numeric,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  text,
  text,
  text,
  uuid
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 26
-- ============================================================================
