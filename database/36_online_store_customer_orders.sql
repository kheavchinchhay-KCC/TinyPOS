-- ============================================================================
-- Tiny POS - Step 41: Online Store, Public Catalog and Customer Web Orders
-- Run once in the NEW Supabase project after Step 40.
--
-- This migration publishes selected products through a public Netlify-backed
-- storefront. Public requests never receive Supabase service-role credentials.
-- Submitted orders are recalculated in PostgreSQL, tracked with a secret token,
-- and may be converted into the existing Sales Order reservation workflow.
-- ============================================================================

create extension if not exists pgcrypto;

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname='online_order_status') then
    create type public.online_order_status as enum(
      'pending','confirmed','preparing','ready','partially_fulfilled',
      'fulfilled','cancelled','rejected'
    );
  end if;
  if not exists (select 1 from pg_type where typname='online_fulfilment_type') then
    create type public.online_fulfilment_type as enum('pickup','delivery');
  end if;
  if not exists (select 1 from pg_type where typname='online_payment_method') then
    create type public.online_payment_method as enum(
      'cash_on_delivery','bank_transfer','pay_at_store'
    );
  end if;
  if not exists (select 1 from pg_type where typname='online_payment_status') then
    create type public.online_payment_status as enum(
      'unpaid','pending_confirmation','paid','failed','refunded'
    );
  end if;
end
$$;

insert into public.permission_definitions(
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
) values
  ('online_store.manage','Sales','Manage Online Store',
   'Publish the branch storefront, configure ordering and choose public products.',
   'sensitive',array['owner','admin','manager']::public.app_role[],false,33),
  ('online_orders.manage','Sales','Manage Online Orders',
   'Review, confirm, reject and update customer web orders.',
   'sensitive',array['owner','admin','manager']::public.app_role[],false,34),
  ('online_orders.fulfill','Sales','Fulfil Online Orders',
   'Prepare confirmed web orders through the Sales Order delivery workflow.',
   'sensitive',array['owner','admin','manager','cashier']::public.app_role[],false,35)
on conflict(permission_key) do update set
  module_key=excluded.module_key,
  label=excluded.label,
  description=excluded.description,
  risk_level=excluded.risk_level,
  default_roles=excluded.default_roles,
  approval_action=excluded.approval_action,
  sort_order=excluded.sort_order,
  is_active=true,
  updated_at=now();

alter table public.products
  add column if not exists online_enabled boolean not null default false,
  add column if not exists online_featured boolean not null default false,
  add column if not exists online_description text,
  add column if not exists online_sort_order integer not null default 0;

create index if not exists products_online_catalog_idx
  on public.products(organization_id,online_enabled,online_featured,online_sort_order,name)
  where is_active=true and online_enabled=true;

create table if not exists public.online_store_settings(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  slug text not null,
  is_published boolean not null default false,
  store_title text not null,
  store_description text,
  contact_phone text,
  address text,
  allow_pickup boolean not null default true,
  allow_delivery boolean not null default false,
  delivery_fee_usd numeric(14,2) not null default 0 check(delivery_fee_usd>=0),
  delivery_fee_khr numeric(14,2) not null default 0 check(delivery_fee_khr>=0),
  minimum_order_usd numeric(14,2) not null default 0 check(minimum_order_usd>=0),
  minimum_order_khr numeric(14,2) not null default 0 check(minimum_order_khr>=0),
  allow_pay_at_store boolean not null default true,
  allow_cash_on_delivery boolean not null default true,
  allow_bank_transfer boolean not null default false,
  bank_instructions text,
  customer_message text,
  expected_ready_days integer not null default 1 check(expected_ready_days between 0 and 60),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,branch_id),
  unique(slug),
  check(slug ~ '^[a-z0-9][a-z0-9-]{2,59}$'),
  check(allow_pickup or allow_delivery),
  check(allow_pay_at_store or allow_cash_on_delivery or allow_bank_transfer)
);

drop trigger if exists set_online_store_settings_updated_at
  on public.online_store_settings;
create trigger set_online_store_settings_updated_at
before update on public.online_store_settings
for each row execute function public.set_updated_at();

create table if not exists public.online_orders(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  order_number text not null,
  tracking_token_hash text not null,
  status public.online_order_status not null default 'pending',
  payment_status public.online_payment_status not null default 'unpaid',
  payment_method public.online_payment_method not null,
  fulfilment_type public.online_fulfilment_type not null,
  currency public.currency_code not null,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null check(length(trim(customer_name)) between 1 and 160),
  customer_phone text not null check(length(trim(customer_phone)) between 3 and 40),
  customer_email text,
  delivery_address text,
  requested_date date,
  customer_note text,
  subtotal numeric(14,2) not null default 0 check(subtotal>=0),
  delivery_fee numeric(14,2) not null default 0 check(delivery_fee>=0),
  total_amount numeric(14,2) not null default 0 check(total_amount>=0),
  sales_order_id uuid references public.sales_orders(id) on delete set null,
  source_ip_hash text,
  user_agent text,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,order_number),
  unique(tracking_token_hash),
  check(
    fulfilment_type<>'delivery'
    or length(trim(coalesce(delivery_address,'')))>=4
  )
);

create index if not exists online_orders_branch_status_created_idx
  on public.online_orders(organization_id,branch_id,status,created_at desc);
create index if not exists online_orders_phone_idx
  on public.online_orders(organization_id,customer_phone,created_at desc);
create index if not exists online_orders_sales_order_idx
  on public.online_orders(sales_order_id)
  where sales_order_id is not null;

drop trigger if exists set_online_orders_updated_at on public.online_orders;
create trigger set_online_orders_updated_at
before update on public.online_orders
for each row execute function public.set_updated_at();

create table if not exists public.online_order_items(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  online_order_id uuid not null references public.online_orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  product_unit_id uuid not null references public.product_units(id) on delete restrict,
  product_name text not null,
  sku text,
  barcode text,
  unit_name text not null,
  unit_factor numeric(14,3) not null check(unit_factor>0),
  quantity numeric(14,3) not null check(quantity>0),
  base_quantity numeric(14,3) not null check(base_quantity>0),
  list_price numeric(14,2) not null default 0 check(list_price>=0),
  unit_price numeric(14,2) not null default 0 check(unit_price>=0),
  line_total numeric(14,2) not null default 0 check(line_total>=0),
  created_at timestamptz not null default now(),
  unique(online_order_id,product_unit_id)
);

create index if not exists online_order_items_order_idx
  on public.online_order_items(online_order_id,created_at);

create table if not exists public.online_order_status_history(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  online_order_id uuid not null references public.online_orders(id) on delete cascade,
  from_status public.online_order_status,
  to_status public.online_order_status not null,
  note text,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists online_order_status_history_order_idx
  on public.online_order_status_history(online_order_id,changed_at);

alter table public.telegram_notification_preferences
  add column if not exists online_order_alerts boolean not null default true;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

alter table public.online_store_settings enable row level security;
alter table public.online_orders enable row level security;
alter table public.online_order_items enable row level security;
alter table public.online_order_status_history enable row level security;

drop policy if exists online_store_settings_read on public.online_store_settings;
create policy online_store_settings_read on public.online_store_settings
for select to authenticated using(
  organization_id=(select private.current_organization_id())
  and (
    branch_id=(select private.current_branch_id())
    or private.has_permission('branches.all',auth.uid())
  )
  and private.has_permission('online_store.manage',auth.uid())
);

drop policy if exists online_orders_read on public.online_orders;
create policy online_orders_read on public.online_orders
for select to authenticated using(
  organization_id=(select private.current_organization_id())
  and (
    branch_id=(select private.current_branch_id())
    or private.has_permission('branches.all',auth.uid())
  )
  and (
    private.has_permission('online_orders.manage',auth.uid())
    or private.has_permission('online_orders.fulfill',auth.uid())
  )
);

drop policy if exists online_order_items_read on public.online_order_items;
create policy online_order_items_read on public.online_order_items
for select to authenticated using(
  exists(
    select 1 from public.online_orders o
    where o.id=online_order_id
      and o.organization_id=(select private.current_organization_id())
      and (
        o.branch_id=(select private.current_branch_id())
        or private.has_permission('branches.all',auth.uid())
      )
      and (
        private.has_permission('online_orders.manage',auth.uid())
        or private.has_permission('online_orders.fulfill',auth.uid())
      )
  )
);

drop policy if exists online_order_history_read on public.online_order_status_history;
create policy online_order_history_read on public.online_order_status_history
for select to authenticated using(
  exists(
    select 1 from public.online_orders o
    where o.id=online_order_id
      and o.organization_id=(select private.current_organization_id())
      and (
        o.branch_id=(select private.current_branch_id())
        or private.has_permission('branches.all',auth.uid())
      )
      and (
        private.has_permission('online_orders.manage',auth.uid())
        or private.has_permission('online_orders.fulfill',auth.uid())
      )
  )
);

revoke all on public.online_store_settings,public.online_orders,
  public.online_order_items,public.online_order_status_history from anon;
grant select on public.online_store_settings,public.online_orders,
  public.online_order_items,public.online_order_status_history to authenticated;
grant all on public.online_store_settings,public.online_orders,
  public.online_order_items,public.online_order_status_history to service_role;

-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------

create or replace function private.online_available_base(
  p_organization_id uuid,
  p_branch_id uuid,
  p_product_id uuid
) returns numeric
language plpgsql stable security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_product public.products%rowtype;
  v_sellable numeric:=0;
  v_reserved numeric:=0;
begin
  select * into v_product
  from public.products
  where id=p_product_id
    and organization_id=p_organization_id
    and is_active=true;

  if not found then return 0; end if;
  if not v_product.track_stock then return 999999999; end if;

  v_sellable:=private.sales_order_sellable_base(
    p_organization_id,p_branch_id,p_product_id
  );
  v_reserved:=private.sales_order_reserved_base(
    p_organization_id,p_branch_id,p_product_id,null
  );

  return greatest(0,coalesce(v_sellable,0)-coalesce(v_reserved,0));
end
$$;
revoke all on function private.online_available_base(uuid,uuid,uuid) from public;
grant execute on function private.online_available_base(uuid,uuid,uuid)
  to authenticated,service_role;

create or replace function private.ensure_online_delivery_unit(
  p_organization_id uuid,
  p_currency public.currency_code
) returns uuid
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_product_id uuid;
  v_unit_id uuid;
  v_sku text:='ONLINE-DELIVERY-'||p_currency::text;
begin
  select id into v_product_id
  from public.products
  where organization_id=p_organization_id and sku=v_sku
  limit 1;

  if v_product_id is null then
    insert into public.products(
      organization_id,name,name_km,sku,description,unit_name,
      selling_price,default_cost,currency,tax_percent,track_stock,
      allow_negative_stock,is_active,created_by
    ) values(
      p_organization_id,
      'Online Delivery Fee',
      'ថ្លៃដឹកជញ្ជូនអនឡាញ',
      v_sku,
      'System service item used by confirmed online orders.',
      'Delivery',
      0,0,p_currency,0,false,true,true,auth.uid()
    ) returning id into v_product_id;
  end if;

  select id into v_unit_id
  from public.product_units
  where product_id=v_product_id and is_base=true
  limit 1;

  if v_unit_id is null then
    insert into public.product_units(
      organization_id,product_id,name,short_name,conversion_factor,
      selling_price,is_base,is_active,sort_order,created_by
    ) values(
      p_organization_id,v_product_id,'Delivery','Delivery',1,
      0,true,true,0,auth.uid()
    ) returning id into v_unit_id;
  end if;

  return v_unit_id;
end
$$;
revoke all on function private.ensure_online_delivery_unit(uuid,public.currency_code) from public;
grant execute on function private.ensure_online_delivery_unit(uuid,public.currency_code)
  to authenticated,service_role;

-- ----------------------------------------------------------------------------
-- Public service-role functions used only by Netlify Functions
-- ----------------------------------------------------------------------------

create or replace function public.get_public_storefront(p_slug text)
returns jsonb
language plpgsql stable security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_store public.online_store_settings%rowtype;
  v_shop public.app_settings%rowtype;
  v_branch public.branches%rowtype;
  v_products jsonb;
  v_categories jsonb;
begin
  select * into v_store
  from public.online_store_settings
  where slug=lower(trim(p_slug)) and is_published=true;

  if not found then raise exception 'Storefront not found'; end if;

  select * into v_shop from public.app_settings
  where organization_id=v_store.organization_id;

  select * into v_branch from public.branches
  where id=v_store.branch_id and is_active=true;

  if not found then raise exception 'Storefront branch is inactive'; end if;

  select coalesce(jsonb_agg(category_row order by category_row->>'name'),'[]'::jsonb)
  into v_categories
  from(
    select jsonb_build_object('id',c.id,'name',c.name) category_row
    from public.categories c
    where c.organization_id=v_store.organization_id
      and c.is_active=true
      and exists(
        select 1 from public.products p
        where p.category_id=c.id
          and p.organization_id=v_store.organization_id
          and p.is_active=true and p.online_enabled=true
      )
  ) q;

  select coalesce(jsonb_agg(product_row order by
    (product_row->>'featured')::boolean desc,
    (product_row->>'sort_order')::integer,
    product_row->>'name'
  ),'[]'::jsonb)
  into v_products
  from(
    select jsonb_build_object(
      'id',p.id,
      'category_id',p.category_id,
      'name',p.name,
      'name_km',p.name_km,
      'description',coalesce(p.online_description,p.description),
      'currency',p.currency,
      'featured',p.online_featured,
      'sort_order',p.online_sort_order,
      'track_stock',p.track_stock,
      'available_base',private.online_available_base(
        v_store.organization_id,v_store.branch_id,p.id
      ),
      'image_url',(
        select pi.secure_url from public.product_images pi
        where pi.product_id=p.id
        order by pi.is_primary desc,pi.sort_order,pi.created_at
        limit 1
      ),
      'units',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',u.id,
          'name',u.name,
          'short_name',u.short_name,
          'factor',u.conversion_factor,
          'list_price',price_data.list_price,
          'price',price_data.unit_price,
          'available_quantity',case when p.track_stock then
            floor(private.online_available_base(
              v_store.organization_id,v_store.branch_id,p.id
            )/u.conversion_factor)
            else 999999999 end
        ) order by u.is_base desc,u.sort_order,u.name),'[]'::jsonb)
        from public.product_units u
        cross join lateral(
          select
            coalesce((private.resolve_sales_unit_price(
              v_store.organization_id,v_store.branch_id,null,u.id,p.currency,now()
            )->>'list_price')::numeric,u.selling_price) list_price,
            coalesce((private.resolve_sales_unit_price(
              v_store.organization_id,v_store.branch_id,null,u.id,p.currency,now()
            )->>'unit_price')::numeric,u.selling_price) unit_price
        ) price_data
        where u.product_id=p.id and u.is_active=true
      )
    ) product_row
    from public.products p
    where p.organization_id=v_store.organization_id
      and p.is_active=true and p.online_enabled=true
      and exists(
        select 1 from public.product_units u
        where u.product_id=p.id and u.is_active=true
      )
  ) q;

  return jsonb_build_object(
    'store',jsonb_build_object(
      'slug',v_store.slug,
      'title',v_store.store_title,
      'description',v_store.store_description,
      'contact_phone',v_store.contact_phone,
      'address',coalesce(v_store.address,v_branch.address),
      'shop_name',v_shop.shop_name,
      'shop_logo_url',v_shop.shop_logo_url,
      'branch_name',v_branch.name,
      'allow_pickup',v_store.allow_pickup,
      'allow_delivery',v_store.allow_delivery,
      'delivery_fee_usd',v_store.delivery_fee_usd,
      'delivery_fee_khr',v_store.delivery_fee_khr,
      'minimum_order_usd',v_store.minimum_order_usd,
      'minimum_order_khr',v_store.minimum_order_khr,
      'allow_pay_at_store',v_store.allow_pay_at_store,
      'allow_cash_on_delivery',v_store.allow_cash_on_delivery,
      'allow_bank_transfer',v_store.allow_bank_transfer,
      'bank_instructions',v_store.bank_instructions,
      'customer_message',v_store.customer_message,
      'expected_ready_days',v_store.expected_ready_days
    ),
    'categories',v_categories,
    'products',v_products
  );
end
$$;
revoke all on function public.get_public_storefront(text) from public,anon,authenticated;
grant execute on function public.get_public_storefront(text) to service_role;

create or replace function public.submit_online_order(
  p_slug text,
  p_payload jsonb,
  p_source_ip_hash text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_store public.online_store_settings%rowtype;
  v_order_id uuid;
  v_order_number text;
  v_token text;
  v_token_hash text;
  v_item jsonb;
  v_stock record;
  v_product public.products%rowtype;
  v_unit public.product_units%rowtype;
  v_price jsonb;
  v_currency public.currency_code;
  v_item_currency public.currency_code;
  v_quantity numeric;
  v_base_quantity numeric;
  v_available numeric;
  v_list_price numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric:=0;
  v_delivery_fee numeric:=0;
  v_total numeric:=0;
  v_minimum numeric:=0;
  v_fulfilment public.online_fulfilment_type;
  v_payment public.online_payment_method;
  v_name text;
  v_phone text;
  v_email text;
  v_address text;
  v_note text;
  v_requested date;
  v_count integer:=0;
begin
  select * into v_store
  from public.online_store_settings
  where slug=lower(trim(p_slug)) and is_published=true
  for share;
  if not found then raise exception 'Storefront not found'; end if;

  if jsonb_typeof(p_payload->'items')<>'array'
     or jsonb_array_length(p_payload->'items')=0 then
    raise exception 'Choose at least one product';
  end if;
  if jsonb_array_length(p_payload->'items')>60 then
    raise exception 'Too many order lines';
  end if;

  if (
    select count(*)<>count(distinct item->>'product_unit_id')
    from jsonb_array_elements(p_payload->'items') item
  ) then
    raise exception 'Duplicate selling units are not allowed';
  end if;

  v_name:=trim(coalesce(p_payload->>'customer_name',''));
  v_phone:=trim(coalesce(p_payload->>'customer_phone',''));
  v_email:=nullif(lower(trim(coalesce(p_payload->>'customer_email',''))),'');
  v_address:=nullif(trim(coalesce(p_payload->>'delivery_address','')),'');
  v_note:=nullif(left(trim(coalesce(p_payload->>'customer_note','')),1000),'');
  v_requested:=nullif(p_payload->>'requested_date','')::date;

  if length(v_name) not between 1 and 160 then raise exception 'Customer name is required'; end if;
  if length(v_phone) not between 3 and 40 then raise exception 'Customer phone is required'; end if;
  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Customer email is invalid';
  end if;

  if p_source_ip_hash is not null and (
    select count(*)>=10
    from public.online_orders o
    where o.organization_id=v_store.organization_id
      and o.branch_id=v_store.branch_id
      and o.source_ip_hash=p_source_ip_hash
      and o.created_at>now()-interval '15 minutes'
  ) then
    raise exception 'Too many recent order requests. Please try again later';
  end if;

  if (
    select count(*)>=5
    from public.online_orders o
    where o.organization_id=v_store.organization_id
      and o.branch_id=v_store.branch_id
      and o.customer_phone=v_phone
      and o.status='pending'
      and o.created_at>now()-interval '1 hour'
  ) then
    raise exception 'Too many pending orders for this phone number';
  end if;

  v_fulfilment:=coalesce(nullif(p_payload->>'fulfilment_type',''),'pickup')::public.online_fulfilment_type;
  if v_fulfilment='pickup' and not v_store.allow_pickup then raise exception 'Pickup is unavailable'; end if;
  if v_fulfilment='delivery' and not v_store.allow_delivery then raise exception 'Delivery is unavailable'; end if;
  if v_fulfilment='delivery' and length(coalesce(v_address,''))<4 then raise exception 'Delivery address is required'; end if;

  v_payment:=coalesce(nullif(p_payload->>'payment_method',''),'pay_at_store')::public.online_payment_method;
  if v_payment='cash_on_delivery' and not v_store.allow_cash_on_delivery then raise exception 'Cash on delivery is unavailable'; end if;
  if v_payment='bank_transfer' and not v_store.allow_bank_transfer then raise exception 'Bank transfer is unavailable'; end if;
  if v_payment='pay_at_store' and not v_store.allow_pay_at_store then raise exception 'Pay at store is unavailable'; end if;
  if v_payment='pay_at_store' and v_fulfilment<>'pickup' then raise exception 'Pay at store requires pickup'; end if;

  -- First pass validates currency and current stock.
  for v_item in select * from jsonb_array_elements(p_payload->'items') loop
    v_quantity:=round(coalesce((v_item->>'quantity')::numeric,0),3);
    if v_quantity<=0 or v_quantity>99999 then raise exception 'Invalid item quantity'; end if;

    select * into v_unit from public.product_units
    where id=(v_item->>'product_unit_id')::uuid
      and organization_id=v_store.organization_id and is_active=true;
    if not found then raise exception 'Selling unit is unavailable'; end if;

    select * into v_product from public.products
    where id=v_unit.product_id and organization_id=v_store.organization_id
      and is_active=true and online_enabled=true;
    if not found then raise exception 'Product is unavailable online'; end if;

    v_item_currency:=v_product.currency;
    if v_currency is null then v_currency:=v_item_currency; end if;
    if v_item_currency<>v_currency then raise exception 'One order cannot mix USD and KHR products'; end if;

    v_base_quantity:=round(v_quantity*v_unit.conversion_factor,3);
    v_available:=private.online_available_base(v_store.organization_id,v_store.branch_id,v_product.id);
    if v_product.track_stock and v_base_quantity>v_available+0.0005 then
      raise exception 'Insufficient available stock for %',v_product.name;
    end if;

    v_price:=private.resolve_sales_unit_price(
      v_store.organization_id,v_store.branch_id,null,v_unit.id,v_currency,now()
    );
    v_list_price:=round(coalesce((v_price->>'list_price')::numeric,v_unit.selling_price),2);
    v_unit_price:=round(coalesce((v_price->>'unit_price')::numeric,v_unit.selling_price),2);
    v_line_total:=round(v_quantity*v_unit_price,2);
    v_subtotal:=v_subtotal+v_line_total;
    v_count:=v_count+1;
  end loop;

  -- Validate the combined requirement when the same product is ordered
  -- through more than one selling unit.
  for v_stock in
    select
      u.product_id,
      sum(
        round(
          (item->>'quantity')::numeric
          * u.conversion_factor,
          3
        )
      ) as required_base
    from jsonb_array_elements(p_payload->'items') item
    join public.product_units u
      on u.id=(item->>'product_unit_id')::uuid
    group by u.product_id
  loop
    select * into v_product
    from public.products
    where id=v_stock.product_id
      and organization_id=v_store.organization_id
      and is_active=true
      and online_enabled=true;

    if not found then
      raise exception 'Product is unavailable online';
    end if;

    if v_product.track_stock then
      v_available:=private.online_available_base(
        v_store.organization_id,
        v_store.branch_id,
        v_product.id
      );

      if v_stock.required_base>v_available+0.0005 then
        raise exception
          'Insufficient combined stock for %',
          v_product.name;
      end if;
    end if;
  end loop;

  if v_currency is null then raise exception 'Order currency is required'; end if;

  if v_fulfilment='delivery' then
    v_delivery_fee:=case when v_currency='KHR' then v_store.delivery_fee_khr else v_store.delivery_fee_usd end;
  end if;
  v_minimum:=case when v_currency='KHR' then v_store.minimum_order_khr else v_store.minimum_order_usd end;
  if v_subtotal+0.005<v_minimum then raise exception 'Order is below the minimum amount'; end if;
  v_total:=round(v_subtotal+v_delivery_fee,2);

  v_order_number:=private.next_document_number(
    v_store.organization_id,v_store.branch_id,'WEB'
  );
  v_token:=encode(gen_random_bytes(24),'hex');
  v_token_hash:=encode(digest(v_token,'sha256'),'hex');

  insert into public.online_orders(
    organization_id,branch_id,order_number,tracking_token_hash,status,
    payment_status,payment_method,fulfilment_type,currency,customer_name,
    customer_phone,customer_email,delivery_address,requested_date,customer_note,
    subtotal,delivery_fee,total_amount,source_ip_hash,user_agent
  ) values(
    v_store.organization_id,v_store.branch_id,v_order_number,v_token_hash,'pending',
    case when v_payment='bank_transfer' then 'pending_confirmation' else 'unpaid' end,
    v_payment,v_fulfilment,v_currency,v_name,v_phone,v_email,v_address,v_requested,
    v_note,round(v_subtotal,2),v_delivery_fee,v_total,
    nullif(left(coalesce(p_source_ip_hash,''),128),''),
    nullif(left(coalesce(p_user_agent,''),500),'')
  ) returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_payload->'items') loop
    v_quantity:=round((v_item->>'quantity')::numeric,3);
    select * into v_unit from public.product_units
      where id=(v_item->>'product_unit_id')::uuid;
    select * into v_product from public.products where id=v_unit.product_id;
    v_price:=private.resolve_sales_unit_price(
      v_store.organization_id,v_store.branch_id,null,v_unit.id,v_currency,now()
    );
    v_list_price:=round(coalesce((v_price->>'list_price')::numeric,v_unit.selling_price),2);
    v_unit_price:=round(coalesce((v_price->>'unit_price')::numeric,v_unit.selling_price),2);
    v_base_quantity:=round(v_quantity*v_unit.conversion_factor,3);
    v_line_total:=round(v_quantity*v_unit_price,2);

    insert into public.online_order_items(
      organization_id,branch_id,online_order_id,product_id,product_unit_id,
      product_name,sku,barcode,unit_name,unit_factor,quantity,base_quantity,
      list_price,unit_price,line_total
    ) values(
      v_store.organization_id,v_store.branch_id,v_order_id,v_product.id,v_unit.id,
      v_product.name,v_product.sku,coalesce(v_unit.barcode,v_product.barcode),
      v_unit.name,v_unit.conversion_factor,v_quantity,v_base_quantity,
      v_list_price,v_unit_price,v_line_total
    );
  end loop;

  insert into public.online_order_status_history(
    organization_id,branch_id,online_order_id,from_status,to_status,note
  ) values(
    v_store.organization_id,v_store.branch_id,v_order_id,null,'pending',
    'Order submitted through the public storefront'
  );

  return jsonb_build_object(
    'ok',true,
    'order_id',v_order_id,
    'order_number',v_order_number,
    'tracking_token',v_token,
    'status','pending',
    'currency',v_currency,
    'subtotal',round(v_subtotal,2),
    'delivery_fee',v_delivery_fee,
    'total_amount',v_total,
    'bank_instructions',case when v_payment='bank_transfer' then v_store.bank_instructions else null end,
    'customer_message',v_store.customer_message
  );
end
$$;
revoke all on function public.submit_online_order(text,jsonb,text,text)
  from public,anon,authenticated;
grant execute on function public.submit_online_order(text,jsonb,text,text)
  to service_role;

create or replace function public.track_online_order(
  p_slug text,p_order_number text,p_tracking_token text
) returns jsonb
language plpgsql stable security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_store public.online_store_settings%rowtype;
  v_order public.online_orders%rowtype;
  v_hash text;
begin
  select * into v_store from public.online_store_settings
  where slug=lower(trim(p_slug));
  if not found then raise exception 'Order not found'; end if;

  v_hash:=encode(digest(trim(p_tracking_token),'sha256'),'hex');
  select * into v_order from public.online_orders
  where organization_id=v_store.organization_id
    and branch_id=v_store.branch_id
    and upper(order_number)=upper(trim(p_order_number))
    and tracking_token_hash=v_hash;
  if not found then raise exception 'Order not found'; end if;

  return jsonb_build_object(
    'order_number',v_order.order_number,
    'status',v_order.status,
    'payment_status',v_order.payment_status,
    'payment_method',v_order.payment_method,
    'fulfilment_type',v_order.fulfilment_type,
    'currency',v_order.currency,
    'customer_name',v_order.customer_name,
    'requested_date',v_order.requested_date,
    'subtotal',v_order.subtotal,
    'delivery_fee',v_order.delivery_fee,
    'total_amount',v_order.total_amount,
    'confirmed_for_fulfilment',(v_order.sales_order_id is not null),
    'created_at',v_order.created_at,
    'updated_at',v_order.updated_at,
    'items',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'product_name',i.product_name,
        'unit_name',i.unit_name,
        'quantity',i.quantity,
        'unit_price',i.unit_price,
        'line_total',i.line_total
      ) order by i.created_at),'[]'::jsonb)
      from public.online_order_items i where i.online_order_id=v_order.id
    ),
    'history',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'status',h.to_status,'note',h.note,'changed_at',h.changed_at
      ) order by h.changed_at),'[]'::jsonb)
      from public.online_order_status_history h where h.online_order_id=v_order.id
    )
  );
end
$$;
revoke all on function public.track_online_order(text,text,text)
  from public,anon,authenticated;
grant execute on function public.track_online_order(text,text,text)
  to service_role;

-- ----------------------------------------------------------------------------
-- Authenticated management RPCs
-- ----------------------------------------------------------------------------

create or replace function public.save_online_store_settings(p_values jsonb)
returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_branch uuid:=private.current_branch_id();
  v_slug text;
  v_title text;
  v_row public.online_store_settings%rowtype;
begin
  perform private.require_permission('online_store.manage');
  v_slug:=lower(trim(coalesce(p_values->>'slug','')));
  v_title:=trim(coalesce(p_values->>'store_title',''));
  if v_slug !~ '^[a-z0-9][a-z0-9-]{2,59}$' then
    raise exception 'Store slug must use 3-60 lowercase letters, numbers or dashes';
  end if;
  if length(v_title) not between 1 and 160 then raise exception 'Store title is required'; end if;

  insert into public.online_store_settings(
    organization_id,branch_id,slug,is_published,store_title,store_description,
    contact_phone,address,allow_pickup,allow_delivery,delivery_fee_usd,
    delivery_fee_khr,minimum_order_usd,minimum_order_khr,
    allow_pay_at_store,allow_cash_on_delivery,allow_bank_transfer,bank_instructions,
    customer_message,expected_ready_days,created_by,updated_by
  ) values(
    v_org,v_branch,v_slug,coalesce((p_values->>'is_published')::boolean,false),
    v_title,nullif(trim(coalesce(p_values->>'store_description','')),''),
    nullif(trim(coalesce(p_values->>'contact_phone','')),''),
    nullif(trim(coalesce(p_values->>'address','')),''),
    coalesce((p_values->>'allow_pickup')::boolean,true),
    coalesce((p_values->>'allow_delivery')::boolean,false),
    greatest(0,coalesce((p_values->>'delivery_fee_usd')::numeric,0)),
    greatest(0,coalesce((p_values->>'delivery_fee_khr')::numeric,0)),
    greatest(0,coalesce((p_values->>'minimum_order_usd')::numeric,0)),
    greatest(0,coalesce((p_values->>'minimum_order_khr')::numeric,0)),
    coalesce((p_values->>'allow_pay_at_store')::boolean,true),
    coalesce((p_values->>'allow_cash_on_delivery')::boolean,true),
    coalesce((p_values->>'allow_bank_transfer')::boolean,false),
    nullif(trim(coalesce(p_values->>'bank_instructions','')),''),
    nullif(trim(coalesce(p_values->>'customer_message','')),''),
    greatest(0,least(60,coalesce((p_values->>'expected_ready_days')::integer,1))),
    auth.uid(),auth.uid()
  )
  on conflict(organization_id,branch_id) do update set
    slug=excluded.slug,
    is_published=excluded.is_published,
    store_title=excluded.store_title,
    store_description=excluded.store_description,
    contact_phone=excluded.contact_phone,
    address=excluded.address,
    allow_pickup=excluded.allow_pickup,
    allow_delivery=excluded.allow_delivery,
    delivery_fee_usd=excluded.delivery_fee_usd,
    delivery_fee_khr=excluded.delivery_fee_khr,
    minimum_order_usd=excluded.minimum_order_usd,
    minimum_order_khr=excluded.minimum_order_khr,
    allow_pay_at_store=excluded.allow_pay_at_store,
    allow_cash_on_delivery=excluded.allow_cash_on_delivery,
    allow_bank_transfer=excluded.allow_bank_transfer,
    bank_instructions=excluded.bank_instructions,
    customer_message=excluded.customer_message,
    expected_ready_days=excluded.expected_ready_days,
    updated_by=auth.uid(),
    updated_at=now()
  returning * into v_row;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_org,v_branch,auth.uid(),'save_online_store','online_store_settings',v_row.id,
    jsonb_build_object('slug',v_row.slug,'is_published',v_row.is_published)
  );

  return to_jsonb(v_row)||jsonb_build_object('ok',true);
end
$$;
revoke all on function public.save_online_store_settings(jsonb) from public,anon;
grant execute on function public.save_online_store_settings(jsonb) to authenticated;

create or replace function public.save_online_product_settings(
  p_product_id uuid,p_values jsonb
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_product public.products%rowtype;
begin
  perform private.require_permission('online_store.manage');
  update public.products set
    online_enabled=coalesce((p_values->>'online_enabled')::boolean,online_enabled),
    online_featured=coalesce((p_values->>'online_featured')::boolean,online_featured),
    online_description=case when p_values?'online_description'
      then nullif(trim(coalesce(p_values->>'online_description','')),'')
      else online_description end,
    online_sort_order=coalesce((p_values->>'online_sort_order')::integer,online_sort_order),
    updated_at=now()
  where id=p_product_id and organization_id=v_org
  returning * into v_product;

  if not found then raise exception 'Product not found'; end if;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_org,private.current_branch_id(),auth.uid(),'save_online_product','product',
    v_product.id,jsonb_build_object(
      'online_enabled',v_product.online_enabled,
      'online_featured',v_product.online_featured,
      'online_sort_order',v_product.online_sort_order
    )
  );
  return to_jsonb(v_product)||jsonb_build_object('ok',true);
end
$$;
revoke all on function public.save_online_product_settings(uuid,jsonb) from public,anon;
grant execute on function public.save_online_product_settings(uuid,jsonb) to authenticated;

create or replace function public.confirm_online_order(p_order_id uuid)
returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_branch uuid:=private.current_branch_id();
  v_online public.online_orders%rowtype;
  v_customer_id uuid;
  v_sales_order_id uuid;
  v_sales_number text;
  v_item record;
  v_delivery_unit uuid;
begin
  perform private.require_permission('online_orders.manage');

  select * into v_online from public.online_orders
  where id=p_order_id and organization_id=v_org and branch_id=v_branch
  for update;
  if not found then raise exception 'Online order not found in the active branch'; end if;
  if v_online.status<>'pending' then raise exception 'Only a Pending online order can be confirmed'; end if;

  select id into v_customer_id from public.customers
  where organization_id=v_org and is_active=true
    and (
      nullif(trim(phone),'')=nullif(trim(v_online.customer_phone),'')
      or (
        v_online.customer_email is not null
        and lower(email)=lower(v_online.customer_email)
      )
    )
  order by created_at limit 1;

  if v_customer_id is null then
    insert into public.customers(
      organization_id,name,phone,email,address,notes,is_active,created_by
    ) values(
      v_org,v_online.customer_name,v_online.customer_phone,
      v_online.customer_email,v_online.delivery_address,
      'Created from online order '||v_online.order_number,true,auth.uid()
    ) returning id into v_customer_id;
  end if;

  v_sales_number:=private.next_document_number(v_org,v_branch,'SO');
  insert into public.sales_orders(
    organization_id,branch_id,order_number,customer_id,status,currency,
    subtotal,discount_amount,tax_amount,total_amount,requested_delivery_date,
    delivery_address,notes,terms,created_by
  ) values(
    v_org,v_branch,v_sales_number,v_customer_id,'draft',v_online.currency,
    v_online.subtotal+v_online.delivery_fee,0,0,v_online.total_amount,
    coalesce(v_online.requested_date,current_date+1),
    v_online.delivery_address,
    concat_ws(E'\n',
      'Online order: '||v_online.order_number,
      v_online.customer_note
    ),
    'Prices captured from the public storefront. Stock is reserved on confirmation.',
    auth.uid()
  ) returning id into v_sales_order_id;

  for v_item in select * from public.online_order_items
    where online_order_id=v_online.id order by created_at
  loop
    insert into public.sales_order_items(
      organization_id,branch_id,order_id,product_id,product_unit_id,
      product_name,sku,barcode,sale_unit_name,unit_factor,quantity,
      base_quantity,list_price,unit_price,net_unit_price,price_adjustment_amount,
      line_subtotal,discount_amount,line_total
    ) values(
      v_org,v_branch,v_sales_order_id,v_item.product_id,v_item.product_unit_id,
      v_item.product_name,v_item.sku,v_item.barcode,v_item.unit_name,
      v_item.unit_factor,v_item.quantity,v_item.base_quantity,
      v_item.list_price,v_item.unit_price,v_item.unit_price,
      round((v_item.unit_price-v_item.list_price)*v_item.quantity,2),
      v_item.line_total,0,v_item.line_total
    );
  end loop;

  if v_online.delivery_fee>0 then
    v_delivery_unit:=private.ensure_online_delivery_unit(v_org,v_online.currency);
    insert into public.sales_order_items(
      organization_id,branch_id,order_id,product_id,product_unit_id,
      product_name,sku,barcode,sale_unit_name,unit_factor,quantity,
      base_quantity,list_price,unit_price,net_unit_price,price_adjustment_amount,
      line_subtotal,discount_amount,line_total
    )
    select
      v_org,v_branch,v_sales_order_id,p.id,u.id,
      p.name,p.sku,u.barcode,u.name,1,1,1,
      v_online.delivery_fee,v_online.delivery_fee,v_online.delivery_fee,0,
      v_online.delivery_fee,0,v_online.delivery_fee
    from public.product_units u
    join public.products p on p.id=u.product_id
    where u.id=v_delivery_unit;
  end if;

  perform public.confirm_sales_order(v_sales_order_id);

  update public.online_orders set
    customer_id=v_customer_id,
    sales_order_id=v_sales_order_id,
    status='confirmed',
    confirmed_by=auth.uid(),
    confirmed_at=now(),
    updated_at=now()
  where id=v_online.id returning * into v_online;

  insert into public.online_order_status_history(
    organization_id,branch_id,online_order_id,from_status,to_status,note,changed_by
  ) values(
    v_org,v_branch,v_online.id,'pending','confirmed',
    'Confirmed and converted to reserved Sales Order '||v_sales_number,auth.uid()
  );

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_org,v_branch,auth.uid(),'confirm_online_order','online_order',v_online.id,
    jsonb_build_object(
      'online_order_number',v_online.order_number,
      'sales_order_id',v_sales_order_id,
      'sales_order_number',v_sales_number
    )
  );

  return jsonb_build_object(
    'ok',true,'online_order_id',v_online.id,'status',v_online.status,
    'sales_order_id',v_sales_order_id,'sales_order_number',v_sales_number
  );
end
$$;
revoke all on function public.confirm_online_order(uuid) from public,anon;
grant execute on function public.confirm_online_order(uuid) to authenticated;

create or replace function public.update_online_order_status(
  p_order_id uuid,p_status public.online_order_status,p_note text default null
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_branch uuid:=private.current_branch_id();
  v_order public.online_orders%rowtype;
  v_from public.online_order_status;
begin
  perform private.require_permission('online_orders.manage');
  select * into v_order from public.online_orders
  where id=p_order_id and organization_id=v_org and branch_id=v_branch
  for update;
  if not found then raise exception 'Online order not found in the active branch'; end if;

  v_from:=v_order.status;
  if p_status=v_from then return to_jsonb(v_order)||jsonb_build_object('ok',true); end if;

  if v_from in('fulfilled','cancelled','rejected') then
    raise exception 'This online order is closed';
  end if;

  if p_status='confirmed' then
    raise exception 'Use Confirm Order to reserve stock';
  end if;

  if p_status in('cancelled','rejected') and v_order.sales_order_id is not null then
    perform public.cancel_sales_order(
      v_order.sales_order_id,
      coalesce(nullif(trim(p_note),''),'Online order cancelled')
    );
  end if;

  if p_status not in('preparing','ready','partially_fulfilled','fulfilled','cancelled','rejected') then
    raise exception 'Unsupported status change';
  end if;

  update public.online_orders set
    status=p_status,
    cancelled_by=case when p_status in('cancelled','rejected') then auth.uid() else cancelled_by end,
    cancelled_at=case when p_status in('cancelled','rejected') then now() else cancelled_at end,
    cancel_reason=case when p_status in('cancelled','rejected') then nullif(trim(p_note),'') else cancel_reason end,
    completed_at=case when p_status='fulfilled' then now() else completed_at end,
    updated_at=now()
  where id=v_order.id returning * into v_order;

  insert into public.online_order_status_history(
    organization_id,branch_id,online_order_id,from_status,to_status,note,changed_by
  ) values(v_org,v_branch,v_order.id,v_from,p_status,nullif(trim(p_note),''),auth.uid());

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_org,v_branch,auth.uid(),'update_online_order_status','online_order',v_order.id,
    jsonb_build_object('from_status',v_from,'to_status',p_status,'note',p_note)
  );

  return to_jsonb(v_order)||jsonb_build_object('ok',true);
end
$$;
revoke all on function public.update_online_order_status(uuid,public.online_order_status,text)
  from public,anon;
grant execute on function public.update_online_order_status(uuid,public.online_order_status,text)
  to authenticated;

-- Keep Telegram preference saving compatible with the new category.
create or replace function public.save_my_telegram_preferences(p_preferences jsonb)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_user_id uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_result public.telegram_notification_preferences%rowtype;
  v_all boolean;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_profile from public.profiles where id=v_user_id and is_active=true;
  if not found then raise exception 'Active POS profile required'; end if;
  perform private.ensure_telegram_preferences(v_user_id);
  v_all:=coalesce((p_preferences->>'all_branches')::boolean,false);
  if v_all and v_profile.role not in('owner','admin') then
    raise exception 'Only owners and admins can receive all-branch alerts';
  end if;
  update public.telegram_notification_preferences set
    stock_alerts=coalesce((p_preferences->>'stock_alerts')::boolean,stock_alerts),
    sales_summary=coalesce((p_preferences->>'sales_summary')::boolean,sales_summary),
    credit_alerts=coalesce((p_preferences->>'credit_alerts')::boolean,credit_alerts),
    supplier_alerts=coalesce((p_preferences->>'supplier_alerts')::boolean,supplier_alerts),
    purchase_alerts=coalesce((p_preferences->>'purchase_alerts')::boolean,purchase_alerts),
    transfer_alerts=coalesce((p_preferences->>'transfer_alerts')::boolean,transfer_alerts),
    quotation_alerts=coalesce((p_preferences->>'quotation_alerts')::boolean,quotation_alerts),
    sales_order_alerts=coalesce((p_preferences->>'sales_order_alerts')::boolean,sales_order_alerts),
    online_order_alerts=coalesce((p_preferences->>'online_order_alerts')::boolean,online_order_alerts),
    cash_register_alerts=coalesce((p_preferences->>'cash_register_alerts')::boolean,cash_register_alerts),
    attendance_alerts=coalesce((p_preferences->>'attendance_alerts')::boolean,attendance_alerts),
    payroll_alerts=coalesce((p_preferences->>'payroll_alerts')::boolean,payroll_alerts),
    system_alerts=coalesce((p_preferences->>'system_alerts')::boolean,system_alerts),
    all_branches=v_all,
    daily_summary_hour=greatest(0,least(23,coalesce((p_preferences->>'daily_summary_hour')::integer,daily_summary_hour))),
    quiet_start_hour=case when p_preferences?'quiet_start_hour' and nullif(p_preferences->>'quiet_start_hour','') is not null
      then greatest(0,least(23,(p_preferences->>'quiet_start_hour')::integer)) else null end,
    quiet_end_hour=case when p_preferences?'quiet_end_hour' and nullif(p_preferences->>'quiet_end_hour','') is not null
      then greatest(0,least(23,(p_preferences->>'quiet_end_hour')::integer)) else null end,
    updated_by=v_user_id,updated_at=now()
  where user_id=v_user_id returning * into v_result;
  return to_jsonb(v_result);
end
$$;
revoke all on function public.save_my_telegram_preferences(jsonb) from public,anon;
grant execute on function public.save_my_telegram_preferences(jsonb) to authenticated;

commit;

-- ============================================================================
-- END STEP 41
-- ============================================================================
