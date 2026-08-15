-- ============================================================================
-- Tiny POS NEW - Step 4 migration
-- Categories, products, automatic P000001 codes, and opening stock
-- Run once AFTER Step 1 was completed successfully.
-- ============================================================================

begin;

create table if not exists public.product_counters (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_number bigint not null default 0 check (last_number >= 0),
  updated_at timestamptz not null default now()
);

alter table public.product_counters enable row level security;
revoke all on public.product_counters from anon, authenticated;
grant all on public.product_counters to service_role;

create or replace function private.next_product_sku(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number bigint;
begin
  insert into public.product_counters (organization_id, last_number)
  values (p_organization_id, 1)
  on conflict (organization_id)
  do update set
    last_number = public.product_counters.last_number + 1,
    updated_at = now()
  returning last_number into v_number;

  return 'P' || lpad(v_number::text, 6, '0');
end;
$$;

revoke all on function private.next_product_sku(uuid) from public;
grant execute on function private.next_product_sku(uuid) to authenticated, service_role;

create or replace function public.create_pos_product(
  p_name text,
  p_category_id uuid default null,
  p_name_km text default null,
  p_sku text default null,
  p_barcode text default null,
  p_description text default null,
  p_unit_name text default 'pcs',
  p_selling_price numeric default 0,
  p_default_cost numeric default 0,
  p_currency public.currency_code default 'USD',
  p_track_stock boolean default true,
  p_allow_negative_stock boolean default false,
  p_low_stock_threshold numeric default 5,
  p_opening_quantity numeric default 0,
  p_is_active boolean default true
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
  v_sku text;
  v_barcode text;
  v_category_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role
  into v_organization_id, v_branch_id, v_role
  from public.profiles
  where id = v_user_id and is_active = true;

  if v_organization_id is null or v_branch_id is null then
    raise exception 'Active user profile and branch are required';
  end if;

  if v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot create products';
  end if;

  if nullif(trim(p_name), '') is null then
    raise exception 'Product name is required';
  end if;

  if nullif(trim(p_unit_name), '') is null then
    raise exception 'Unit name is required';
  end if;

  if coalesce(p_selling_price, -1) < 0 or coalesce(p_default_cost, -1) < 0 then
    raise exception 'Price and cost cannot be negative';
  end if;

  if coalesce(p_low_stock_threshold, -1) < 0 then
    raise exception 'Low-stock threshold cannot be negative';
  end if;

  if coalesce(p_opening_quantity, -1) < 0 then
    raise exception 'Opening stock cannot be negative';
  end if;

  if p_category_id is not null then
    select id into v_category_id
    from public.categories
    where id = p_category_id
      and organization_id = v_organization_id;

    if v_category_id is null then
      raise exception 'Category not found';
    end if;
  end if;

  v_sku := nullif(upper(trim(p_sku)), '');
  if v_sku is null then
    v_sku := private.next_product_sku(v_organization_id);
  end if;

  v_barcode := nullif(trim(p_barcode), '');

  insert into public.products (
    organization_id,
    category_id,
    name,
    name_km,
    sku,
    barcode,
    description,
    unit_name,
    selling_price,
    default_cost,
    currency,
    track_stock,
    allow_negative_stock,
    low_stock_threshold,
    is_active,
    created_by
  ) values (
    v_organization_id,
    p_category_id,
    trim(p_name),
    nullif(trim(p_name_km), ''),
    v_sku,
    v_barcode,
    nullif(trim(p_description), ''),
    trim(p_unit_name),
    round(p_selling_price, 2),
    round(p_default_cost, 4),
    p_currency,
    coalesce(p_track_stock, true),
    coalesce(p_allow_negative_stock, false),
    round(p_low_stock_threshold, 3),
    coalesce(p_is_active, true),
    v_user_id
  ) returning * into v_product;

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
    case when v_product.track_stock then round(p_opening_quantity, 3) else 0 end,
    v_product.default_cost
  )
  on conflict (branch_id, product_id) do nothing;

  if v_product.track_stock and p_opening_quantity > 0 then
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
      'opening',
      round(p_opening_quantity, 3),
      0,
      round(p_opening_quantity, 3),
      v_product.default_cost,
      'products',
      v_product.id,
      'Opening stock from product creation',
      v_user_id
    );
  end if;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_organization_id,
    v_branch_id,
    v_user_id,
    'create_product',
    'product',
    v_product.id,
    to_jsonb(v_product)
  );

  return jsonb_build_object(
    'ok', true,
    'product_id', v_product.id,
    'sku', v_product.sku,
    'barcode', v_product.barcode
  );
exception
  when unique_violation then
    if v_barcode is not null and exists (
      select 1 from public.products
      where organization_id = v_organization_id and barcode = v_barcode
    ) then
      raise exception 'This barcode is already used by another product';
    end if;
    if v_sku is not null and exists (
      select 1 from public.products
      where organization_id = v_organization_id and sku = v_sku
    ) then
      raise exception 'This product code is already used';
    end if;
    raise;
end;
$$;

create or replace function public.update_pos_product(
  p_product_id uuid,
  p_name text,
  p_category_id uuid default null,
  p_name_km text default null,
  p_sku text default null,
  p_barcode text default null,
  p_description text default null,
  p_unit_name text default 'pcs',
  p_selling_price numeric default 0,
  p_default_cost numeric default 0,
  p_currency public.currency_code default 'USD',
  p_track_stock boolean default true,
  p_allow_negative_stock boolean default false,
  p_low_stock_threshold numeric default 5,
  p_is_active boolean default true
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
  v_old public.products%rowtype;
  v_new public.products%rowtype;
  v_sku text;
  v_barcode text;
begin
  select organization_id, branch_id, role
  into v_organization_id, v_branch_id, v_role
  from public.profiles
  where id = v_user_id and is_active = true;

  if v_organization_id is null or v_role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot update products';
  end if;

  select * into v_old
  from public.products
  where id = p_product_id and organization_id = v_organization_id;

  if not found then
    raise exception 'Product not found';
  end if;

  if nullif(trim(p_name), '') is null or nullif(trim(p_unit_name), '') is null then
    raise exception 'Product name and unit are required';
  end if;

  if coalesce(p_selling_price, -1) < 0
     or coalesce(p_default_cost, -1) < 0
     or coalesce(p_low_stock_threshold, -1) < 0 then
    raise exception 'Price, cost, and low-stock threshold cannot be negative';
  end if;

  if p_category_id is not null and not exists (
    select 1 from public.categories
    where id = p_category_id and organization_id = v_organization_id
  ) then
    raise exception 'Category not found';
  end if;

  v_sku := coalesce(nullif(upper(trim(p_sku)), ''), v_old.sku);
  v_barcode := nullif(trim(p_barcode), '');

  update public.products set
    category_id = p_category_id,
    name = trim(p_name),
    name_km = nullif(trim(p_name_km), ''),
    sku = v_sku,
    barcode = v_barcode,
    description = nullif(trim(p_description), ''),
    unit_name = trim(p_unit_name),
    selling_price = round(p_selling_price, 2),
    default_cost = round(p_default_cost, 4),
    currency = p_currency,
    track_stock = coalesce(p_track_stock, true),
    allow_negative_stock = coalesce(p_allow_negative_stock, false),
    low_stock_threshold = round(p_low_stock_threshold, 3),
    is_active = coalesce(p_is_active, true),
    updated_at = now()
  where id = p_product_id
  returning * into v_new;

  insert into public.inventory_balances (
    organization_id, branch_id, product_id, quantity, average_cost
  ) values (
    v_organization_id, v_branch_id, p_product_id, 0, v_new.default_cost
  )
  on conflict (branch_id, product_id)
  do update set
    average_cost = case
      when public.inventory_balances.quantity = 0 then excluded.average_cost
      else public.inventory_balances.average_cost
    end,
    updated_at = now();

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) values (
    v_organization_id,
    v_branch_id,
    v_user_id,
    'update_product',
    'product',
    p_product_id,
    to_jsonb(v_old),
    to_jsonb(v_new)
  );

  return jsonb_build_object('ok', true, 'product_id', v_new.id, 'sku', v_new.sku);
exception
  when unique_violation then
    if v_barcode is not null and exists (
      select 1 from public.products
      where organization_id = v_organization_id
        and barcode = v_barcode
        and id <> p_product_id
    ) then
      raise exception 'This barcode is already used by another product';
    end if;
    if v_sku is not null and exists (
      select 1 from public.products
      where organization_id = v_organization_id
        and sku = v_sku
        and id <> p_product_id
    ) then
      raise exception 'This product code is already used';
    end if;
    raise;
end;
$$;

revoke all on function public.create_pos_product(
  text, uuid, text, text, text, text, text, numeric, numeric,
  public.currency_code, boolean, boolean, numeric, numeric, boolean
) from public, anon;

grant execute on function public.create_pos_product(
  text, uuid, text, text, text, text, text, numeric, numeric,
  public.currency_code, boolean, boolean, numeric, numeric, boolean
) to authenticated, service_role;

revoke all on function public.update_pos_product(
  uuid, text, uuid, text, text, text, text, text, numeric, numeric,
  public.currency_code, boolean, boolean, numeric, boolean
) from public, anon;

grant execute on function public.update_pos_product(
  uuid, text, uuid, text, text, text, text, text, numeric, numeric,
  public.currency_code, boolean, boolean, numeric, boolean
) to authenticated, service_role;

commit;
