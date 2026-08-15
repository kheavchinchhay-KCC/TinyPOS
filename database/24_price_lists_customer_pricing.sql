-- ============================================================================
-- Tiny POS - Step 27: Price Lists and Customer Pricing
-- Run once in the NEW Supabase project after Step 26.
--
-- Price priority:
--   1. A price list assigned directly to the customer.
--   2. A matching customer-type list (Regular, VIP, Wholesale).
--   3. An All Customers list.
--   4. The normal product-unit selling price.
--
-- Branch-specific lists take priority over organization-wide lists at the same
-- customer level. Existing sales and quotations keep price snapshots.
--
-- This migration does not delete existing business data.
-- ============================================================================

begin;

create table if not exists public.price_lists (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid
    references public.branches(id) on delete cascade,

  code text not null,
  name text not null,

  currency public.currency_code
    not null default 'USD',

  customer_type text not null default 'all'
    check (
      customer_type in (
        'all',
        'regular',
        'vip',
        'wholesale'
      )
    ),

  priority integer not null default 0
    check (priority between -100000 and 100000),

  starts_at timestamptz,
  ends_at timestamptz,

  is_active boolean not null default true,
  notes text,

  created_by uuid
    references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, code),

  check (
    length(trim(code)) between 1 and 40
  ),

  check (
    length(trim(name)) between 1 and 120
  ),

  check (
    starts_at is null
    or ends_at is null
    or ends_at > starts_at
  )
);

create index if not exists price_lists_resolution_idx
  on public.price_lists (
    organization_id,
    currency,
    customer_type,
    is_active,
    priority desc
  );

create index if not exists price_lists_branch_idx
  on public.price_lists (
    organization_id,
    branch_id,
    is_active
  );

drop trigger if exists set_price_lists_updated_at
  on public.price_lists;

create trigger set_price_lists_updated_at
before update on public.price_lists
for each row execute function public.set_updated_at();

create table if not exists public.price_list_items (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  price_list_id uuid not null
    references public.price_lists(id) on delete cascade,

  product_id uuid not null
    references public.products(id) on delete cascade,

  product_unit_id uuid not null
    references public.product_units(id) on delete cascade,

  selling_price numeric(14,2) not null
    check (selling_price >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (price_list_id, product_unit_id)
);

create index if not exists price_list_items_list_idx
  on public.price_list_items (
    price_list_id,
    product_id,
    product_unit_id
  );

create index if not exists price_list_items_unit_idx
  on public.price_list_items (
    organization_id,
    product_unit_id
  );

drop trigger if exists set_price_list_items_updated_at
  on public.price_list_items;

create trigger set_price_list_items_updated_at
before update on public.price_list_items
for each row execute function public.set_updated_at();

alter table public.customers
  add column if not exists price_list_id uuid
    references public.price_lists(id) on delete set null;

create index if not exists customers_price_list_idx
  on public.customers (
    organization_id,
    price_list_id
  )
  where price_list_id is not null;

alter table public.sales
  add column if not exists price_list_id uuid
    references public.price_lists(id) on delete set null,
  add column if not exists price_list_name text,
  add column if not exists price_adjustment_amount numeric(14,2)
    not null default 0;

alter table public.sale_items
  add column if not exists list_price numeric(14,2),
  add column if not exists price_list_id uuid
    references public.price_lists(id) on delete set null,
  add column if not exists price_adjustment_amount numeric(14,2)
    not null default 0;

update public.sale_items
set list_price = unit_price
where list_price is null;

alter table public.sale_items
  alter column list_price set not null;

alter table public.sales_quotes
  add column if not exists price_list_id uuid
    references public.price_lists(id) on delete set null,
  add column if not exists price_list_name text,
  add column if not exists price_adjustment_amount numeric(14,2)
    not null default 0;

alter table public.sales_quote_items
  add column if not exists list_price numeric(14,2),
  add column if not exists price_list_id uuid
    references public.price_lists(id) on delete set null,
  add column if not exists price_adjustment_amount numeric(14,2)
    not null default 0;

update public.sales_quote_items
set list_price = unit_price
where list_price is null;

alter table public.sales_quote_items
  alter column list_price set not null;

alter table public.price_lists enable row level security;
alter table public.price_list_items enable row level security;

drop policy if exists price_lists_select_sales_staff
  on public.price_lists;

create policy price_lists_select_sales_staff
on public.price_lists
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and (
    branch_id is null
    or branch_id =
      (select private.current_branch_id())
    or (select private.has_any_role(
      array[
        'owner',
        'admin'
      ]::public.app_role[]
    ))
  )
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager',
      'cashier',
      'viewer'
    ]::public.app_role[]
  ))
);

drop policy if exists price_lists_manage_management
  on public.price_lists;

create policy price_lists_manage_management
on public.price_lists
for all to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
)
with check (
  organization_id =
    (select private.current_organization_id())
  and (
    branch_id is null
    or exists (
      select 1
      from public.branches branch_row
      where branch_row.id = branch_id
        and branch_row.organization_id =
          (select private.current_organization_id())
    )
  )
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

drop policy if exists price_list_items_select_sales_staff
  on public.price_list_items;

create policy price_list_items_select_sales_staff
on public.price_list_items
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and exists (
    select 1
    from public.price_lists list_row
    where list_row.id = price_list_id
      and list_row.organization_id =
        (select private.current_organization_id())
      and (
        list_row.branch_id is null
        or list_row.branch_id =
          (select private.current_branch_id())
        or (select private.has_any_role(
          array[
            'owner',
            'admin'
          ]::public.app_role[]
        ))
      )
  )
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager',
      'cashier',
      'viewer'
    ]::public.app_role[]
  ))
);

drop policy if exists price_list_items_manage_management
  on public.price_list_items;

create policy price_list_items_manage_management
on public.price_list_items
for all to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
)
with check (
  organization_id =
    (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

revoke all on public.price_lists from anon;
revoke all on public.price_list_items from anon;

grant select on public.price_lists
  to authenticated;

grant select on public.price_list_items
  to authenticated;

grant all on public.price_lists
  to service_role;

grant all on public.price_list_items
  to service_role;

-- ----------------------------------------------------------------------------
-- Normalize list codes.
-- ----------------------------------------------------------------------------

create or replace function private.normalize_price_list()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.code := upper(trim(new.code));
  new.name := trim(new.name);

  if new.notes is not null then
    new.notes := nullif(trim(new.notes), '');
  end if;

  return new;
end;
$$;

drop trigger if exists normalize_price_list
  on public.price_lists;

create trigger normalize_price_list
before insert or update on public.price_lists
for each row execute function private.normalize_price_list();

-- ----------------------------------------------------------------------------
-- Resolve one secure selling price.
-- ----------------------------------------------------------------------------

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

revoke all on function private.resolve_sales_unit_price(
  uuid,
  uuid,
  uuid,
  uuid,
  public.currency_code,
  timestamptz
) from public, anon;

grant execute on function private.resolve_sales_unit_price(
  uuid,
  uuid,
  uuid,
  uuid,
  public.currency_code,
  timestamptz
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Price-list-aware secure subtotal.
-- ----------------------------------------------------------------------------

create or replace function private.secure_sale_subtotal_v2(
  p_organization_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_currency public.currency_code
)
returns numeric
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_item record;
  v_product record;
  v_unit record;
  v_price jsonb;
  v_subtotal numeric(14,2) := 0;
begin
  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'The cart is empty';
  end if;

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
    if v_item.product_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception
        'Every cart item requires a valid product and quantity';
    end if;

    select
      product.id,
      product.name,
      product.currency,
      product.is_active
    into v_product
    from public.products product
    where product.id = v_item.product_id
      and product.organization_id = p_organization_id;

    if not found
       or v_product.is_active is not true then
      raise exception
        'Product % is missing or inactive',
        v_item.product_id;
    end if;

    if v_product.currency <> p_currency then
      raise exception
        'Product "%" uses %, but this sale uses %',
        v_product.name,
        v_product.currency,
        p_currency;
    end if;

    select unit_row.*
    into v_unit
    from public.product_units unit_row
    where unit_row.organization_id = p_organization_id
      and unit_row.product_id = v_product.id
      and (
        (
          v_item.product_unit_id is not null
          and unit_row.id = v_item.product_unit_id
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

    v_price := private.resolve_sales_unit_price(
      p_organization_id,
      p_branch_id,
      p_customer_id,
      v_unit.id,
      p_currency,
      now()
    );

    v_subtotal := v_subtotal
      + round(
          (v_price ->> 'effective_price')::numeric
          * v_item.quantity,
          2
        );
  end loop;

  return round(v_subtotal, 2);
end;
$$;

revoke all on function private.secure_sale_subtotal_v2(
  uuid,
  uuid,
  uuid,
  jsonb,
  public.currency_code
) from public, anon;

grant execute on function private.secure_sale_subtotal_v2(
  uuid,
  uuid,
  uuid,
  jsonb,
  public.currency_code
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Management RPCs.
-- ----------------------------------------------------------------------------

create or replace function public.save_price_list(
  p_price_list_id uuid,
  p_code text,
  p_name text,
  p_currency public.currency_code,
  p_customer_type text default 'all',
  p_branch_id uuid default null,
  p_priority integer default 0,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_is_active boolean default true,
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
  v_list public.price_lists%rowtype;
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
     or v_profile.is_active is not true then
    raise exception 'Active POS profile is required';
  end if;

  if v_profile.role not in (
    'owner',
    'admin',
    'manager'
  ) then
    raise exception 'Your role cannot manage price lists';
  end if;

  if p_code is null
     or length(trim(p_code)) = 0 then
    raise exception 'Price-list code is required';
  end if;

  if p_name is null
     or length(trim(p_name)) = 0 then
    raise exception 'Price-list name is required';
  end if;

  if p_customer_type not in (
    'all',
    'regular',
    'vip',
    'wholesale'
  ) then
    raise exception 'Unsupported customer type';
  end if;

  if p_ends_at is not null
     and p_starts_at is not null
     and p_ends_at <= p_starts_at then
    raise exception 'End time must be after start time';
  end if;

  if v_profile.role = 'manager'
     and p_branch_id is distinct from v_profile.branch_id then
    raise exception
      'Managers can only manage price lists for their assigned branch';
  end if;

  if p_branch_id is not null
     and not exists (
       select 1
       from public.branches branch_row
       where branch_row.id = p_branch_id
         and branch_row.organization_id =
           v_profile.organization_id
     ) then
    raise exception 'Branch not found';
  end if;

  if p_price_list_id is null then
    insert into public.price_lists (
      organization_id,
      branch_id,
      code,
      name,
      currency,
      customer_type,
      priority,
      starts_at,
      ends_at,
      is_active,
      notes,
      created_by
    )
    values (
      v_profile.organization_id,
      p_branch_id,
      p_code,
      p_name,
      p_currency,
      p_customer_type,
      coalesce(p_priority, 0),
      p_starts_at,
      p_ends_at,
      coalesce(p_is_active, true),
      nullif(trim(p_notes), ''),
      v_user_id
    )
    returning * into v_list;
  else
    if exists (
      select 1
      from public.price_lists existing_list
      join public.price_list_items existing_item
        on existing_item.price_list_id = existing_list.id
      where existing_list.id = p_price_list_id
        and existing_list.organization_id = v_profile.organization_id
        and existing_list.currency <> p_currency
    ) then
      raise exception
        'Clear unit prices before changing the price-list currency';
    end if;

    update public.price_lists
    set
      branch_id = p_branch_id,
      code = p_code,
      name = p_name,
      currency = p_currency,
      customer_type = p_customer_type,
      priority = coalesce(p_priority, 0),
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      is_active = coalesce(p_is_active, true),
      notes = nullif(trim(p_notes), ''),
      updated_at = now()
    where id = p_price_list_id
      and organization_id =
        v_profile.organization_id
    returning * into v_list;

    if not found then
      raise exception 'Price list not found';
    end if;
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
    coalesce(p_branch_id, v_profile.branch_id),
    v_user_id,
    case
      when p_price_list_id is null
        then 'create_price_list'
      else 'update_price_list'
    end,
    'price_list',
    v_list.id,
    to_jsonb(v_list)
  );

  return to_jsonb(v_list)
    || jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.save_price_list(
  uuid,
  text,
  text,
  public.currency_code,
  text,
  uuid,
  integer,
  timestamptz,
  timestamptz,
  boolean,
  text
) from public, anon;

grant execute on function public.save_price_list(
  uuid,
  text,
  text,
  public.currency_code,
  text,
  uuid,
  integer,
  timestamptz,
  timestamptz,
  boolean,
  text
) to authenticated, service_role;

create or replace function public.save_price_list_items(
  p_price_list_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_list public.price_lists%rowtype;
  v_item record;
  v_unit record;
  v_count integer := 0;
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
     or v_profile.is_active is not true then
    raise exception 'Active POS profile is required';
  end if;

  if v_profile.role not in (
    'owner',
    'admin',
    'manager'
  ) then
    raise exception 'Your role cannot manage price lists';
  end if;

  select *
  into v_list
  from public.price_lists
  where id = p_price_list_id
    and organization_id =
      v_profile.organization_id
  for update;

  if not found then
    raise exception 'Price list not found';
  end if;

  if v_profile.role = 'manager'
     and v_list.branch_id is distinct from v_profile.branch_id then
    raise exception
      'Managers can only edit prices for their assigned branch';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Price-list items must be an array';
  end if;

  delete from public.price_list_items
  where price_list_id = v_list.id;

  for v_item in
    select
      item.product_unit_id,
      item.selling_price
    from jsonb_to_recordset(p_items)
      as item(
        product_unit_id uuid,
        selling_price numeric
      )
  loop
    if v_item.product_unit_id is null
       or v_item.selling_price is null
       or v_item.selling_price < 0 then
      raise exception 'Every price row requires a unit and non-negative price';
    end if;

    select
      unit_row.id,
      unit_row.product_id,
      product.currency,
      product.is_active as product_active,
      unit_row.is_active as unit_active
    into v_unit
    from public.product_units unit_row
    join public.products product
      on product.id = unit_row.product_id
    where unit_row.id = v_item.product_unit_id
      and unit_row.organization_id =
        v_profile.organization_id
      and product.organization_id =
        v_profile.organization_id;

    if not found
       or v_unit.product_active is not true
       or v_unit.unit_active is not true then
      raise exception 'A selected product unit is unavailable';
    end if;

    if v_unit.currency <> v_list.currency then
      raise exception
        'A product unit uses %, but the price list uses %',
        v_unit.currency,
        v_list.currency;
    end if;

    insert into public.price_list_items (
      organization_id,
      price_list_id,
      product_id,
      product_unit_id,
      selling_price
    )
    values (
      v_profile.organization_id,
      v_list.id,
      v_unit.product_id,
      v_unit.id,
      round(v_item.selling_price, 2)
    );

    v_count := v_count + 1;
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
    coalesce(v_list.branch_id, v_profile.branch_id),
    v_user_id,
    'replace_price_list_items',
    'price_list',
    v_list.id,
    jsonb_build_object(
      'price_list_code', v_list.code,
      'item_count', v_count
    )
  );

  return jsonb_build_object(
    'ok', true,
    'price_list_id', v_list.id,
    'item_count', v_count
  );
end;
$$;

revoke all on function public.save_price_list_items(
  uuid,
  jsonb
) from public, anon;

grant execute on function public.save_price_list_items(
  uuid,
  jsonb
) to authenticated, service_role;

create or replace function public.assign_customer_price_list(
  p_customer_id uuid,
  p_price_list_id uuid default null
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
     or v_profile.is_active is not true then
    raise exception 'Active POS profile is required';
  end if;

  if v_profile.role not in (
    'owner',
    'admin',
    'manager'
  ) then
    raise exception 'Your role cannot assign customer pricing';
  end if;

  if p_price_list_id is not null then
    select *
    into v_list
    from public.price_lists
    where id = p_price_list_id
      and organization_id =
        v_profile.organization_id;

    if not found then
      raise exception 'Price list not found';
    end if;

    if v_profile.role = 'manager'
       and v_list.branch_id is not null
       and v_list.branch_id <> v_profile.branch_id then
      raise exception
        'Managers cannot assign another branch price list';
    end if;
  end if;

  update public.customers
  set
    price_list_id = p_price_list_id,
    updated_at = now()
  where id = p_customer_id
    and organization_id =
      v_profile.organization_id
  returning * into v_customer;

  if not found then
    raise exception 'Customer not found';
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
    'assign_customer_price_list',
    'customer',
    v_customer.id,
    jsonb_build_object(
      'customer_name', v_customer.name,
      'price_list_id', p_price_list_id,
      'price_list_name', v_list.name
    )
  );

  return jsonb_build_object(
    'ok', true,
    'customer_id', v_customer.id,
    'price_list_id', p_price_list_id,
    'price_list_name', v_list.name
  );
end;
$$;

revoke all on function public.assign_customer_price_list(
  uuid,
  uuid
) from public, anon;

grant execute on function public.assign_customer_price_list(
  uuid,
  uuid
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Frontend-safe price catalog for the current branch.
-- ----------------------------------------------------------------------------

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

revoke all on function public.get_customer_price_catalog(
  uuid,
  public.currency_code
) from public, anon;

grant execute on function public.get_customer_price_catalog(
  uuid,
  public.currency_code
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Price-list-aware coupon preview.
-- ----------------------------------------------------------------------------

create or replace function public.preview_coupon_v2(
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

  v_subtotal := private.secure_sale_subtotal_v2(
    v_profile.organization_id,
    v_profile.branch_id,
    p_customer_id,
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

revoke all on function public.preview_coupon_v2(
  text, jsonb, uuid, public.currency_code
) from public, anon;

grant execute on function public.preview_coupon_v2(
  text, jsonb, uuid, public.currency_code
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Price-list-aware checkout core.
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v3_price(
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
  v_price jsonb;

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
  v_list_unit_price numeric(14,2);
  v_effective_unit_price numeric(14,2);
  v_line_price_adjustment numeric(14,2);

  v_price_list_id uuid;
  v_price_list_name text;
  v_price_adjustment_total numeric(14,2) := 0;

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
      s.price_list_id,
      s.price_list_name,
      s.price_adjustment_amount,
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
        'price_list_id', v_existing.price_list_id,
        'price_list_name', v_existing.price_list_name,
        'price_adjustment_amount',
          v_existing.price_adjustment_amount,
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

  v_subtotal := private.secure_sale_subtotal_v2(
    v_profile.organization_id,
    v_profile.branch_id,
    p_customer_id,
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
    price_list_id,
    price_list_name,
    price_adjustment_amount,
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
    null,
    null,
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

    v_price := private.resolve_sales_unit_price(
      v_profile.organization_id,
      v_profile.branch_id,
      p_customer_id,
      v_unit.id,
      p_currency,
      now()
    );

    v_list_unit_price :=
      (v_price ->> 'list_price')::numeric;

    v_effective_unit_price :=
      (v_price ->> 'effective_price')::numeric;

    if v_price_list_id is null
       and nullif(v_price ->> 'price_list_id', '') is not null then
      v_price_list_id :=
        (v_price ->> 'price_list_id')::uuid;
      v_price_list_name :=
        v_price ->> 'price_list_name';
    end if;

    v_base_quantity := round(
      v_item.quantity * v_unit.conversion_factor,
      3
    );

    v_line_subtotal := round(
      v_effective_unit_price * v_item.quantity,
      2
    );

    v_line_price_adjustment := round(
      (v_list_unit_price - v_effective_unit_price)
      * v_item.quantity,
      2
    );

    v_price_adjustment_total :=
      v_price_adjustment_total
      + v_line_price_adjustment;

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
      list_price,
      price_list_id,
      price_adjustment_amount,
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
      v_effective_unit_price,
      v_list_unit_price,
      case
        when nullif(v_price ->> 'price_list_id', '') is null
          then null
        else (v_price ->> 'price_list_id')::uuid
      end,
      v_line_price_adjustment,
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
    price_list_id = v_price_list_id,
    price_list_name = v_price_list_name,
    price_adjustment_amount =
      round(v_price_adjustment_total, 2),
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
      'price_list_id', v_price_list_id,
      'price_list_name', v_price_list_name,
      'price_adjustment_amount',
        round(v_price_adjustment_total, 2),
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
    'price_list_id', v_price_list_id,
    'price_list_name', v_price_list_name,
    'price_adjustment_amount',
      round(v_price_adjustment_total, 2),
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
        s.price_list_id,
        s.price_list_name,
        s.price_adjustment_amount,
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
          'price_list_id', v_existing.price_list_id,
          'price_list_name', v_existing.price_list_name,
          'price_adjustment_amount',
            v_existing.price_adjustment_amount,
          'coupon_code', v_existing.coupon_code,
          'coupon_discount_amount',
            v_existing.coupon_discount_amount
        );
      end if;
    end if;

    raise;
end;
$$;

revoke all on function public.complete_sale_v3_price(
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

grant execute on function public.complete_sale_v3_price(
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
-- Price-list-aware credit checkout.
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v4_price(
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
  v_account public.customer_credit_accounts%rowtype;
  v_sale public.sales%rowtype;
  v_result jsonb;
  v_sale_id uuid;
  v_total numeric(14,2);
  v_balance_before numeric(14,2);
  v_balance_after numeric(14,2);
  v_due_date date;
  v_today date;
  v_method text := lower(trim(coalesce(p_payment_method, '')));
begin
  if v_method <> 'credit' then
    if v_method not in ('cash','bank','khqr','card','other') then
      raise exception 'Unsupported payment method';
    end if;

    return public.complete_sale_v3_price(
      p_items,
      v_method::public.payment_method,
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
  end if;

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

  if v_profile.role not in ('owner','admin','manager','cashier') then
    raise exception 'Your role cannot complete sales';
  end if;

  select (
    timezone(
      coalesce(nullif(trim(settings.timezone), ''), 'Asia/Phnom_Penh'),
      now()
    )
  )::date
  into v_today
  from public.app_settings settings
  where settings.organization_id = v_profile.organization_id;

  v_today := coalesce(v_today, current_date);

  if p_customer_id is null then
    raise exception 'Choose a customer before using Credit Account';
  end if;

  select account.*
  into v_account
  from public.customer_credit_accounts account
  join public.customers customer
    on customer.id = account.customer_id
  where account.organization_id = v_profile.organization_id
    and account.customer_id = p_customer_id
    and account.currency = p_currency
    and customer.is_active = true
  for update of account;

  if not found then
    raise exception 'This customer has no % credit account', p_currency;
  end if;

  if v_account.is_on_hold then
    raise exception 'This customer credit account is on hold';
  end if;

  if v_account.credit_limit <= 0 then
    raise exception 'This customer has no available credit limit';
  end if;

  -- Use a non-cash temporary payment. It is removed before commit.
  v_result := public.complete_sale_v3_price(
    p_items,
    'other'::public.payment_method,
    999999999999999::numeric,
    p_customer_id,
    p_manual_discount_type,
    p_manual_discount_value,
    p_coupon_code,
    p_currency,
    p_notes,
    'CREDIT-TEMPORARY',
    p_idempotency_key
  );

  v_sale_id := (v_result ->> 'sale_id')::uuid;

  select *
  into v_sale
  from public.sales
  where id = v_sale_id
    and organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Completed sale could not be loaded';
  end if;

  if coalesce((v_result ->> 'duplicate_request')::boolean, false) then
    if v_sale.credit_account_id is null then
      raise exception 'This request was already completed with another payment method';
    end if;

    return v_result || jsonb_build_object(
      'payment_method', 'credit',
      'amount_received', 0,
      'change_amount', 0,
      'credit_account_id', v_sale.credit_account_id,
      'credit_due_date', v_sale.credit_due_date,
      'credit_amount', v_sale.credit_amount,
      'credit_balance_after', v_account.balance_due,
      'credit_available_after', greatest(
        v_account.credit_limit - v_account.balance_due,
        0
      )
    );
  end if;

  v_total := round(v_sale.total_amount, 2);

  if v_total <= 0 then
    raise exception 'Credit sale total must be greater than zero';
  end if;

  v_balance_before := v_account.balance_due;
  v_balance_after := round(v_balance_before + v_total, 2);

  if v_balance_after > v_account.credit_limit then
    raise exception
      'Credit limit exceeded. Available credit: %, invoice total: %',
      greatest(v_account.credit_limit - v_balance_before, 0),
      v_total;
  end if;

  v_due_date := v_today + v_account.payment_terms_days;

  delete from public.payments
  where sale_id = v_sale.id;

  update public.sales
  set
    payment_status = 'unpaid',
    paid_amount = 0,
    change_amount = 0,
    credit_account_id = v_account.id,
    credit_due_date = v_due_date,
    credit_amount = v_total,
    updated_at = now()
  where id = v_sale.id
  returning * into v_sale;

  update public.customer_credit_accounts
  set
    balance_due = v_balance_after,
    last_activity_at = now(),
    updated_at = now()
  where id = v_account.id;

  insert into public.customer_credit_entries (
    organization_id,
    branch_id,
    account_id,
    entry_type,
    amount_change,
    balance_before,
    balance_after,
    sale_id,
    description,
    created_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_account.id,
    'sale',
    v_total,
    v_balance_before,
    v_balance_after,
    v_sale.id,
    'Credit invoice ' || v_sale.invoice_number,
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
    'complete_credit_sale',
    'sale',
    v_sale.id,
    jsonb_build_object(
      'invoice_number', v_sale.invoice_number,
      'customer_id', p_customer_id,
      'credit_account_id', v_account.id,
      'credit_amount', v_total,
      'credit_due_date', v_due_date,
      'balance_before', v_balance_before,
      'balance_after', v_balance_after
    )
  );

  return v_result || jsonb_build_object(
    'payment_method', 'credit',
    'amount_received', 0,
    'change_amount', 0,
    'credit_account_id', v_account.id,
    'credit_due_date', v_due_date,
    'credit_amount', v_total,
    'credit_balance_after', v_balance_after,
    'credit_available_after', greatest(
      v_account.credit_limit - v_balance_after,
      0
    )
  );
end;
$$;

revoke all on function public.complete_sale_v4_price(
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
  text
) from public, anon;

grant execute on function public.complete_sale_v4_price(
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
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Price-list-aware quotation save.
-- ----------------------------------------------------------------------------

create or replace function public.save_sales_quote_v2(
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
  v_price jsonb;

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
  v_list_unit_price numeric(14,2);
  v_effective_unit_price numeric(14,2);
  v_line_price_adjustment numeric(14,2);

  v_price_list_id uuid;
  v_price_list_name text;
  v_price_adjustment_total numeric(14,2) := 0;
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

  v_subtotal := private.secure_sale_subtotal_v2(
    v_profile.organization_id,
    v_profile.branch_id,
    p_customer_id,
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
      price_list_id,
      price_list_name,
      price_adjustment_amount,
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
      null,
      null,
      0,
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
      price_list_id = null,
      price_list_name = null,
      price_adjustment_amount = 0,
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

    v_price := private.resolve_sales_unit_price(
      v_profile.organization_id,
      v_profile.branch_id,
      p_customer_id,
      v_unit.id,
      p_currency,
      now()
    );

    v_list_unit_price :=
      (v_price ->> 'list_price')::numeric;

    v_effective_unit_price :=
      (v_price ->> 'effective_price')::numeric;

    if v_price_list_id is null
       and nullif(v_price ->> 'price_list_id', '') is not null then
      v_price_list_id :=
        (v_price ->> 'price_list_id')::uuid;
      v_price_list_name :=
        v_price ->> 'price_list_name';
    end if;

    v_base_quantity := round(
      v_item.quantity
      * v_unit.conversion_factor,
      3
    );

    v_line_subtotal := round(
      v_item.quantity
      * v_effective_unit_price,
      2
    );

    v_line_price_adjustment := round(
      (v_list_unit_price - v_effective_unit_price)
      * v_item.quantity,
      2
    );

    v_price_adjustment_total :=
      v_price_adjustment_total
      + v_line_price_adjustment;

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
      list_price,
      price_list_id,
      price_adjustment_amount,
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
      v_effective_unit_price,
      v_list_unit_price,
      case
        when nullif(v_price ->> 'price_list_id', '') is null
          then null
        else (v_price ->> 'price_list_id')::uuid
      end,
      v_line_price_adjustment,
      v_selected_unit_cost,
      v_line_subtotal,
      v_line_discount,
      v_line_total
    );
  end loop;

  update public.sales_quotes
  set
    price_list_id = v_price_list_id,
    price_list_name = v_price_list_name,
    price_adjustment_amount =
      round(v_price_adjustment_total, 2),
    updated_at = now()
  where id = v_quote_id;

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
      'price_list_id', v_price_list_id,
      'price_list_name', v_price_list_name,
      'price_adjustment_amount',
        round(v_price_adjustment_total, 2),
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
    'price_list_id', v_price_list_id,
    'price_list_name', v_price_list_name,
    'price_adjustment_amount',
      round(v_price_adjustment_total, 2),
    'currency', p_currency,
    'valid_until', p_valid_until,
    'coupon_code', v_coupon_code
  );
end;
$$;

revoke all on function public.save_sales_quote_v2(
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

grant execute on function public.save_sales_quote_v2(
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
-- Final quotation + credit + price-list checkout.
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v6(
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

  v_result := public.complete_sale_v4_price(
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

revoke all on function public.complete_sale_v6(
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

grant execute on function public.complete_sale_v6(
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
-- END STEP 27
-- ============================================================================
