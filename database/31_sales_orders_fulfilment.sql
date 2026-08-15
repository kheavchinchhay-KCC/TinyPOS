-- ============================================================================
-- Tiny POS - Step 36: Sales Orders, Stock Reservation, Delivery Notes,
-- Partial Fulfilment and Invoice Conversion
-- Run once in the NEW Supabase project after Step 35.
--
-- Confirmed orders reserve sellable stock. Regular checkout cannot consume the
-- reserved quantity. A partial delivery is prepared first, then completed in
-- New Sale so existing cash, bank, KHQR, card, other and customer-credit rules
-- remain the single payment source of truth.
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'sales_order_status') then
    create type public.sales_order_status as enum (
      'draft','confirmed','partially_delivered','delivered','cancelled'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'sales_order_delivery_status') then
    create type public.sales_order_delivery_status as enum ('draft','completed','cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'stock_reservation_status') then
    create type public.stock_reservation_status as enum ('active','fulfilled','released');
  end if;
end
$$;

insert into public.permission_definitions(
  permission_key,module_key,label,description,risk_level,default_roles,approval_action,sort_order
) values
  ('sales_orders.manage','Sales','Manage Sales Orders',
   'Create sales orders from quotations, confirm reservations and cancel remaining fulfilment.',
   'sensitive',array['owner','admin','manager']::public.app_role[],false,31),
  ('sales_orders.deliver','Sales','Deliver Sales Orders',
   'Prepare partial deliveries, create delivery notes and invoice reserved stock.',
   'sensitive',array['owner','admin','manager','cashier']::public.app_role[],false,32)
on conflict(permission_key) do update set
  module_key=excluded.module_key,label=excluded.label,description=excluded.description,
  risk_level=excluded.risk_level,default_roles=excluded.default_roles,
  approval_action=excluded.approval_action,sort_order=excluded.sort_order,
  is_active=true,updated_at=now();

create table if not exists public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  order_number text not null,
  source_quote_id uuid references public.sales_quotes(id) on delete set null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  status public.sales_order_status not null default 'draft',
  currency public.currency_code not null,
  subtotal numeric(14,2) not null default 0 check(subtotal>=0),
  discount_amount numeric(14,2) not null default 0 check(discount_amount>=0),
  tax_amount numeric(14,2) not null default 0 check(tax_amount>=0),
  total_amount numeric(14,2) not null default 0 check(total_amount>=0),
  price_list_id uuid references public.price_lists(id) on delete set null,
  price_list_name text,
  requested_delivery_date date,
  delivery_address text,
  notes text,
  terms text,
  created_by uuid not null references auth.users(id) on delete restrict,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,order_number),
  unique(source_quote_id)
);

create index if not exists sales_orders_branch_status_date_idx
  on public.sales_orders(organization_id,branch_id,status,requested_delivery_date,created_at desc);
create index if not exists sales_orders_customer_idx
  on public.sales_orders(customer_id,created_at desc);

drop trigger if exists set_sales_orders_updated_at on public.sales_orders;
create trigger set_sales_orders_updated_at before update on public.sales_orders
for each row execute function public.set_updated_at();

create table if not exists public.sales_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  order_id uuid not null references public.sales_orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_unit_id uuid references public.product_units(id) on delete set null,
  product_name text not null,
  sku text,
  barcode text,
  sale_unit_name text not null,
  unit_factor numeric(14,3) not null default 1 check(unit_factor>0),
  quantity numeric(14,3) not null check(quantity>0),
  base_quantity numeric(14,3) not null check(base_quantity>0),
  delivered_quantity numeric(14,3) not null default 0 check(delivered_quantity>=0),
  delivered_base_quantity numeric(14,3) not null default 0 check(delivered_base_quantity>=0),
  list_price numeric(14,2) not null default 0 check(list_price>=0),
  unit_price numeric(14,2) not null default 0 check(unit_price>=0),
  net_unit_price numeric(14,4) not null default 0 check(net_unit_price>=0),
  price_list_id uuid references public.price_lists(id) on delete set null,
  price_adjustment_amount numeric(14,2) not null default 0,
  line_subtotal numeric(14,2) not null default 0 check(line_subtotal>=0),
  discount_amount numeric(14,2) not null default 0 check(discount_amount>=0),
  line_total numeric(14,2) not null default 0 check(line_total>=0),
  created_at timestamptz not null default now(),
  unique(order_id,product_unit_id),
  check(delivered_quantity<=quantity+0.0005),
  check(delivered_base_quantity<=base_quantity+0.0005)
);
create index if not exists sales_order_items_order_idx on public.sales_order_items(order_id,created_at);

create table if not exists public.stock_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  sales_order_item_id uuid not null references public.sales_order_items(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  reserved_base_quantity numeric(14,3) not null check(reserved_base_quantity>0),
  delivered_base_quantity numeric(14,3) not null default 0 check(delivered_base_quantity>=0),
  released_base_quantity numeric(14,3) not null default 0 check(released_base_quantity>=0),
  status public.stock_reservation_status not null default 'active',
  reserved_by uuid references auth.users(id) on delete set null,
  reserved_at timestamptz not null default now(),
  released_by uuid references auth.users(id) on delete set null,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sales_order_item_id),
  check(delivered_base_quantity+released_base_quantity<=reserved_base_quantity+0.0005)
);
create index if not exists stock_reservations_product_active_idx
  on public.stock_reservations(branch_id,product_id,status)
  where status='active';

drop trigger if exists set_stock_reservations_updated_at on public.stock_reservations;
create trigger set_stock_reservations_updated_at before update on public.stock_reservations
for each row execute function public.set_updated_at();

create table if not exists public.sales_order_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  delivery_number text not null,
  status public.sales_order_delivery_status not null default 'draft',
  delivery_date date not null default current_date,
  delivery_address text,
  notes text,
  subtotal numeric(14,2) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  total_amount numeric(14,2) not null default 0,
  -- Plain UUID avoids a circular backup dependency with sales.source_sales_order_delivery_id.
  sale_id uuid,
  invoice_number text,
  created_by uuid not null references auth.users(id) on delete restrict,
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,delivery_number)
);
create unique index if not exists sales_order_one_draft_delivery_uq
  on public.sales_order_deliveries(sales_order_id) where status='draft';
create index if not exists sales_order_deliveries_order_idx
  on public.sales_order_deliveries(sales_order_id,created_at desc);

drop trigger if exists set_sales_order_deliveries_updated_at on public.sales_order_deliveries;
create trigger set_sales_order_deliveries_updated_at before update on public.sales_order_deliveries
for each row execute function public.set_updated_at();

create table if not exists public.sales_order_delivery_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  delivery_id uuid not null references public.sales_order_deliveries(id) on delete cascade,
  sales_order_item_id uuid not null references public.sales_order_items(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  product_unit_id uuid references public.product_units(id) on delete set null,
  product_name text not null,
  sku text,
  barcode text,
  sale_unit_name text not null,
  unit_factor numeric(14,3) not null check(unit_factor>0),
  quantity numeric(14,3) not null check(quantity>0),
  base_quantity numeric(14,3) not null check(base_quantity>0),
  list_price numeric(14,2) not null default 0,
  invoice_unit_price numeric(14,4) not null default 0,
  line_total numeric(14,2) not null default 0,
  -- Plain UUID avoids a circular backup dependency with sale_items.
  sale_item_id uuid,
  created_at timestamptz not null default now(),
  unique(delivery_id,sales_order_item_id)
);
create index if not exists sales_order_delivery_items_delivery_idx
  on public.sales_order_delivery_items(delivery_id,created_at);

alter table public.sales_quotes
  -- Plain UUID avoids a circular backup dependency with sales_orders.source_quote_id.
  add column if not exists converted_order_id uuid;

alter table public.sales
  add column if not exists source_sales_order_id uuid references public.sales_orders(id) on delete set null,
  add column if not exists source_sales_order_delivery_id uuid references public.sales_order_deliveries(id) on delete set null;

create unique index if not exists sales_source_order_delivery_uq
  on public.sales(source_sales_order_delivery_id)
  where source_sales_order_delivery_id is not null;

-- RLS: branch-scoped sales staff read access. Writes are RPC-only.
do $$
declare t text;
begin
  foreach t in array array[
    'sales_orders','sales_order_items','stock_reservations',
    'sales_order_deliveries','sales_order_delivery_items'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists %I_read on public.%I',t,t);
    execute format($p$
      create policy %I_read on public.%I for select to authenticated using (
        organization_id=(select private.current_organization_id())
        and branch_id=(select private.current_branch_id())
        and (
          private.has_permission('sales_orders.manage',auth.uid())
          or private.has_permission('sales_orders.deliver',auth.uid())
        )
      )
    $p$,t,t);
    execute format('revoke all on public.%I from anon',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end
$$;

-- New Sale must see aggregate active reservations even when a cashier is not
-- allowed to manage or prepare Sales Orders. The reservation rows are still
-- branch and organization scoped.
drop policy if exists stock_reservations_read
  on public.stock_reservations;

create policy stock_reservations_read
on public.stock_reservations
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and branch_id =
    (select private.current_branch_id())
  and (
    private.has_permission(
      'sales.create',
      auth.uid()
    )
    or private.has_permission(
      'sales_orders.manage',
      auth.uid()
    )
    or private.has_permission(
      'sales_orders.deliver',
      auth.uid()
    )
  )
);

-- Items inherit branch through their parent; duplicate branch columns simplify secure
-- frontend queries and backups. Keep them synchronized at creation only.

create or replace function private.sales_order_business_date(p_organization_id uuid)
returns date language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select (timezone(coalesce(nullif(trim(s.timezone),''),'Asia/Phnom_Penh'),now()))::date
  from public.app_settings s where s.organization_id=p_organization_id
$$;
revoke all on function private.sales_order_business_date(uuid) from public;
grant execute on function private.sales_order_business_date(uuid) to authenticated,service_role;

create or replace function private.sales_order_reserved_base(
  p_organization_id uuid,p_branch_id uuid,p_product_id uuid,p_exclude_order_id uuid default null
) returns numeric language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select coalesce(sum(r.reserved_base_quantity-r.delivered_base_quantity-r.released_base_quantity),0)
  from public.stock_reservations r
  join public.sales_orders o on o.id=r.sales_order_id
  where r.organization_id=p_organization_id and r.branch_id=p_branch_id
    and r.product_id=p_product_id and r.status='active'
    and o.status in('confirmed','partially_delivered')
    and (p_exclude_order_id is null or r.sales_order_id<>p_exclude_order_id)
$$;
revoke all on function private.sales_order_reserved_base(uuid,uuid,uuid,uuid) from public;
grant execute on function private.sales_order_reserved_base(uuid,uuid,uuid,uuid) to authenticated,service_role;

create or replace function private.sales_order_sellable_base(
  p_organization_id uuid,p_branch_id uuid,p_product_id uuid
) returns numeric language plpgsql stable security definer
set search_path=public,private,auth,pg_temp as $$
declare v_product public.products%rowtype; v_quantity numeric; v_today date;
begin
  select * into v_product from public.products
   where id=p_product_id and organization_id=p_organization_id;
  if not found then return 0; end if;
  if v_product.batch_tracking then
    v_today:=coalesce(private.sales_order_business_date(p_organization_id),current_date);
    select coalesce(sum(b.quantity),0) into v_quantity from public.inventory_batches b
     where b.organization_id=p_organization_id and b.branch_id=p_branch_id
       and b.product_id=p_product_id and b.status='active' and b.quantity>0
       and (b.expiry_date is null or b.expiry_date>=v_today);
  else
    select coalesce(i.quantity,0) into v_quantity from public.inventory_balances i
     where i.branch_id=p_branch_id and i.product_id=p_product_id;
  end if;
  return coalesce(v_quantity,0);
end; $$;
revoke all on function private.sales_order_sellable_base(uuid,uuid,uuid) from public;
grant execute on function private.sales_order_sellable_base(uuid,uuid,uuid) to authenticated,service_role;

-- Preserve the Step 27 normal resolver, then add a delivery-context override.
create or replace function private.resolve_standard_sales_unit_price(
  p_organization_id uuid,p_branch_id uuid,p_customer_id uuid,p_product_unit_id uuid,
  p_currency public.currency_code,p_at timestamptz default now()
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_unit record; v_customer public.customers%rowtype; v_list public.price_lists%rowtype; v_override numeric(14,2);
begin
  select u.id,u.product_id,u.selling_price,u.is_active,p.currency,p.is_active product_active
  into v_unit from public.product_units u join public.products p on p.id=u.product_id
  where u.id=p_product_unit_id and u.organization_id=p_organization_id and p.organization_id=p_organization_id;
  if not found or not v_unit.is_active or not v_unit.product_active then raise exception 'Selling unit is unavailable'; end if;
  if v_unit.currency<>p_currency then raise exception 'Selling unit currency does not match the sale currency'; end if;
  if p_customer_id is not null then
    select c.id,c.customer_type,c.price_list_id into v_customer from public.customers c
     where c.id=p_customer_id and c.organization_id=p_organization_id and c.is_active=true;
    if not found then raise exception 'Customer not found or inactive'; end if;
  end if;
  if v_customer.price_list_id is not null then
    select l.* into v_list from public.price_lists l
     where l.id=v_customer.price_list_id and l.organization_id=p_organization_id
       and l.currency=p_currency and l.is_active=true and (l.branch_id is null or l.branch_id=p_branch_id)
       and (l.starts_at is null or l.starts_at<=p_at) and (l.ends_at is null or l.ends_at>p_at) limit 1;
  end if;
  if v_list.id is null then
    select l.* into v_list from public.price_lists l
     where l.organization_id=p_organization_id and l.currency=p_currency and l.is_active=true
       and (l.branch_id is null or l.branch_id=p_branch_id)
       and l.customer_type in(coalesce(v_customer.customer_type,'all'),'all')
       and (l.starts_at is null or l.starts_at<=p_at) and (l.ends_at is null or l.ends_at>p_at)
     order by case when p_customer_id is not null and l.customer_type=v_customer.customer_type then 0
                   when l.customer_type='all' then 1 else 2 end,
              case when l.branch_id=p_branch_id then 0 else 1 end,l.priority desc,l.created_at desc limit 1;
  end if;
  if v_list.id is not null then
    select i.selling_price into v_override from public.price_list_items i
     where i.price_list_id=v_list.id and i.product_unit_id=v_unit.id limit 1;
  end if;
  return jsonb_build_object('product_unit_id',v_unit.id,'product_id',v_unit.product_id,
    'price_list_id',v_list.id,'price_list_code',v_list.code,'price_list_name',v_list.name,
    'list_price',v_unit.selling_price,'effective_price',coalesce(v_override,v_unit.selling_price),
    'price_adjustment',round(v_unit.selling_price-coalesce(v_override,v_unit.selling_price),2),
    'has_override',v_override is not null);
end; $$;
revoke all on function private.resolve_standard_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) from public,anon;
grant execute on function private.resolve_standard_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) to authenticated,service_role;

create or replace function private.resolve_sales_unit_price(
  p_organization_id uuid,p_branch_id uuid,p_customer_id uuid,p_product_unit_id uuid,
  p_currency public.currency_code,p_at timestamptz default now()
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_delivery_text text; v_row record;
begin
  v_delivery_text:=nullif(current_setting('tiny_pos.sales_order_delivery_id',true),'');
  if v_delivery_text is not null then
    select di.product_unit_id,di.product_id,di.list_price,di.invoice_unit_price,
      oi.price_list_id,o.price_list_name,o.customer_id,o.currency,o.organization_id,o.branch_id
    into v_row
    from public.sales_order_delivery_items di
    join public.sales_order_deliveries d on d.id=di.delivery_id
    join public.sales_orders o on o.id=d.sales_order_id
    join public.sales_order_items oi on oi.id=di.sales_order_item_id
    where d.id=v_delivery_text::uuid and di.product_unit_id=p_product_unit_id and d.status='draft';
    if not found then raise exception 'Delivery pricing item is unavailable'; end if;
    if v_row.organization_id<>p_organization_id or v_row.branch_id<>p_branch_id
       or v_row.customer_id is distinct from p_customer_id or v_row.currency<>p_currency then
      raise exception 'Delivery pricing context does not match checkout';
    end if;
    return jsonb_build_object('product_unit_id',v_row.product_unit_id,'product_id',v_row.product_id,
      'price_list_id',v_row.price_list_id,'price_list_code',null,'price_list_name',v_row.price_list_name,
      'list_price',v_row.list_price,'effective_price',v_row.invoice_unit_price,
      'price_adjustment',round(v_row.list_price-v_row.invoice_unit_price,2),'has_override',true);
  end if;
  return private.resolve_standard_sales_unit_price(
    p_organization_id,p_branch_id,p_customer_id,p_product_unit_id,p_currency,p_at
  );
end; $$;
revoke all on function private.resolve_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) from public,anon;
grant execute on function private.resolve_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) to authenticated,service_role;

create or replace function public.create_sales_order_from_quote(
  p_quote_id uuid,p_requested_delivery_date date default null,
  p_delivery_address text default null,p_notes text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_quote public.sales_quotes%rowtype; v_order_id uuid; v_number text; v_count integer;
begin
  perform private.require_permission('sales_orders.manage');
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  select * into v_quote from public.sales_quotes
   where id=p_quote_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'Quotation not found'; end if;
  if v_quote.customer_id is null then raise exception 'Choose a customer before creating a sales order'; end if;
  if v_quote.status in('cancelled','expired','converted') then raise exception 'This quotation cannot become a sales order'; end if;
  if v_quote.valid_until is not null and v_quote.valid_until<coalesce(private.sales_order_business_date(v_org),current_date) then
    raise exception 'This quotation has expired';
  end if;
  if exists(select 1 from public.sales_orders where source_quote_id=p_quote_id) then raise exception 'A sales order already exists for this quotation'; end if;
  v_number:=private.next_document_number(v_org,v_branch,'SO');
  insert into public.sales_orders(organization_id,branch_id,order_number,source_quote_id,customer_id,status,currency,
    subtotal,discount_amount,tax_amount,total_amount,price_list_id,price_list_name,requested_delivery_date,
    delivery_address,notes,terms,created_by)
  values(v_org,v_branch,v_number,v_quote.id,v_quote.customer_id,'draft',v_quote.currency,v_quote.subtotal,
    v_quote.discount_amount,v_quote.tax_amount,v_quote.total_amount,v_quote.price_list_id,v_quote.price_list_name,
    p_requested_delivery_date,coalesce(nullif(trim(p_delivery_address),''),(select address from public.customers where id=v_quote.customer_id)),
    coalesce(nullif(trim(p_notes),''),v_quote.notes),v_quote.terms,auth.uid()) returning id into v_order_id;
  insert into public.sales_order_items(organization_id,branch_id,order_id,product_id,product_unit_id,product_name,sku,barcode,
    sale_unit_name,unit_factor,quantity,base_quantity,list_price,unit_price,net_unit_price,price_list_id,
    price_adjustment_amount,line_subtotal,discount_amount,line_total)
  select v_org,v_branch,v_order_id,i.product_id,i.product_unit_id,i.product_name,i.sku,i.barcode,i.sale_unit_name,i.unit_factor,
    i.quantity,i.base_quantity,i.list_price,i.unit_price,
    case when i.quantity>0 then round(i.line_total/i.quantity,4) else 0 end,
    i.price_list_id,i.price_adjustment_amount,i.line_subtotal,i.discount_amount,i.line_total
  from public.sales_quote_items i where i.quote_id=v_quote.id order by i.created_at;
  get diagnostics v_count=row_count;
  if v_count=0 then raise exception 'Quotation has no products'; end if;
  update public.sales_quotes set status='converted',converted_order_id=v_order_id,converted_by=auth.uid(),converted_at=now(),updated_at=now()
   where id=v_quote.id;
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_branch,auth.uid(),'create_sales_order','sales_order',v_order_id,
    jsonb_build_object('order_number',v_number,'quote_id',v_quote.id,'quote_number',v_quote.quote_number,'item_count',v_count));
  return jsonb_build_object('ok',true,'order_id',v_order_id,'order_number',v_number,'status','draft');
end; $$;
revoke all on function public.create_sales_order_from_quote(uuid,date,text,text) from public,anon;
grant execute on function public.create_sales_order_from_quote(uuid,date,text,text) to authenticated,service_role;

create or replace function public.confirm_sales_order(p_order_id uuid)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_order public.sales_orders%rowtype; v_item record; v_product public.products%rowtype;
 v_sellable numeric; v_reserved numeric; v_available numeric; v_count integer:=0;
begin
  perform private.require_permission('sales_orders.manage');
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  select * into v_order from public.sales_orders where id=p_order_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'Sales order not found'; end if;
  if v_order.status<>'draft' then raise exception 'Only a Draft sales order can be confirmed'; end if;
  for v_item in select * from public.sales_order_items where order_id=v_order.id order by product_id loop
    select * into v_product from public.products where id=v_item.product_id and organization_id=v_org;
    if not found or not v_product.is_active then raise exception 'Product % is inactive or missing',v_item.product_name; end if;
    if v_product.track_stock then
      perform pg_advisory_xact_lock(hashtext('tiny-pos-reserve:'||v_branch::text||':'||v_product.id::text));
      v_sellable:=private.sales_order_sellable_base(v_org,v_branch,v_product.id);
      v_reserved:=private.sales_order_reserved_base(v_org,v_branch,v_product.id,null);
      v_available:=v_sellable-v_reserved;
      if v_available+0.0005<v_item.base_quantity then
        raise exception 'Insufficient available stock for %. Need %, available % after reservations',
          v_item.product_name,v_item.base_quantity,greatest(v_available,0);
      end if;
      insert into public.stock_reservations(organization_id,branch_id,sales_order_id,sales_order_item_id,product_id,
        reserved_base_quantity,status,reserved_by)
      values(v_org,v_branch,v_order.id,v_item.id,v_product.id,v_item.base_quantity,'active',auth.uid());
      v_count:=v_count+1;
    end if;
  end loop;
  update public.sales_orders set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now(),updated_at=now()
   where id=v_order.id returning * into v_order;
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_branch,auth.uid(),'confirm_sales_order','sales_order',v_order.id,
    jsonb_build_object('order_number',v_order.order_number,'reserved_products',v_count,'requested_delivery_date',v_order.requested_delivery_date));
  return to_jsonb(v_order)||jsonb_build_object('ok',true,'reserved_products',v_count);
end; $$;
revoke all on function public.confirm_sales_order(uuid) from public,anon;
grant execute on function public.confirm_sales_order(uuid) to authenticated,service_role;

create or replace function public.prepare_sales_order_delivery(
  p_order_id uuid,p_items jsonb,p_delivery_date date default current_date,
  p_delivery_address text default null,p_notes text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_order public.sales_orders%rowtype; v_input record; v_item public.sales_order_items%rowtype;
 v_res public.stock_reservations%rowtype; v_delivery_id uuid; v_number text; v_remaining numeric; v_base numeric;
 v_previous_line numeric; v_line numeric; v_unit_price numeric; v_subtotal numeric:=0; v_tax numeric:=0; v_total numeric:=0; v_tax_percent numeric:=0; v_count integer:=0;
begin
  perform private.require_permission('sales_orders.deliver');
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  select * into v_order from public.sales_orders where id=p_order_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'Sales order not found'; end if;
  if v_order.status not in('confirmed','partially_delivered') then raise exception 'Only a confirmed sales order can be delivered'; end if;
  if exists(select 1 from public.sales_order_deliveries where sales_order_id=v_order.id and status='draft') then
    raise exception 'This sales order already has a draft delivery';
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Select at least one delivery item'; end if;
  v_number:=private.next_document_number(v_org,v_branch,'DN');
  insert into public.sales_order_deliveries(organization_id,branch_id,sales_order_id,delivery_number,status,delivery_date,
    delivery_address,notes,created_by)
  values(v_org,v_branch,v_order.id,v_number,'draft',coalesce(p_delivery_date,current_date),
    coalesce(nullif(trim(p_delivery_address),''),v_order.delivery_address),nullif(trim(p_notes),''),auth.uid())
  returning id into v_delivery_id;
  for v_input in select x.sales_order_item_id,sum(x.quantity)::numeric(14,3) quantity
    from jsonb_to_recordset(p_items) x(sales_order_item_id uuid,quantity numeric)
    group by x.sales_order_item_id order by x.sales_order_item_id loop
    select * into v_item from public.sales_order_items where id=v_input.sales_order_item_id and order_id=v_order.id for update;
    if not found then raise exception 'A delivery item is invalid'; end if;
    v_remaining:=round(v_item.quantity-v_item.delivered_quantity,3);
    if v_input.quantity<=0 or v_input.quantity>v_remaining+0.0005 then
      raise exception 'Invalid delivery quantity for %. Remaining: % %',v_item.product_name,v_remaining,v_item.sale_unit_name;
    end if;
    v_base:=round(v_input.quantity*v_item.unit_factor,3);
    select * into v_res from public.stock_reservations where sales_order_item_id=v_item.id for update;
    if found and v_base>(v_res.reserved_base_quantity-v_res.delivered_base_quantity-v_res.released_base_quantity)+0.0005 then
      raise exception 'Delivery exceeds the remaining reservation for %',v_item.product_name;
    end if;
    select coalesce(sum(di.line_total),0) into v_previous_line
    from public.sales_order_delivery_items di join public.sales_order_deliveries d on d.id=di.delivery_id
    where di.sales_order_item_id=v_item.id and d.status='completed';
    if abs(v_input.quantity-v_remaining)<=0.0005 then
      v_line:=greatest(round(v_item.line_total-v_previous_line,2),0);
    else
      v_line:=round(v_item.line_total*v_input.quantity/v_item.quantity,2);
    end if;
    v_unit_price:=case when v_input.quantity>0 then round(v_line/v_input.quantity,4) else 0 end;
    insert into public.sales_order_delivery_items(organization_id,branch_id,delivery_id,sales_order_item_id,product_id,product_unit_id,
      product_name,sku,barcode,sale_unit_name,unit_factor,quantity,base_quantity,list_price,invoice_unit_price,line_total)
    values(v_org,v_branch,v_delivery_id,v_item.id,v_item.product_id,v_item.product_unit_id,v_item.product_name,v_item.sku,v_item.barcode,
      v_item.sale_unit_name,v_item.unit_factor,v_input.quantity,v_base,v_item.list_price,v_unit_price,v_line);
    v_subtotal:=v_subtotal+v_line; v_count:=v_count+1;
  end loop;
  select coalesce(tax_percent,0) into v_tax_percent from public.app_settings where organization_id=v_org;
  v_tax:=round(v_subtotal*greatest(v_tax_percent,0)/100,2); v_total:=round(v_subtotal+v_tax,2);
  update public.sales_order_deliveries set subtotal=v_subtotal,tax_amount=v_tax,total_amount=v_total where id=v_delivery_id;
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_branch,auth.uid(),'prepare_sales_order_delivery','sales_order_delivery',v_delivery_id,
    jsonb_build_object('delivery_number',v_number,'order_number',v_order.order_number,'item_count',v_count,'subtotal',v_subtotal,'total',v_total));
  return jsonb_build_object('ok',true,'delivery_id',v_delivery_id,'delivery_number',v_number,
    'order_id',v_order.id,'order_number',v_order.order_number,'item_count',v_count,'subtotal',v_subtotal,'tax_amount',v_tax,'total_amount',v_total);
end; $$;
revoke all on function public.prepare_sales_order_delivery(uuid,jsonb,date,text,text) from public,anon;
grant execute on function public.prepare_sales_order_delivery(uuid,jsonb,date,text,text) to authenticated,service_role;

create or replace function public.cancel_sales_order_delivery(p_delivery_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_delivery public.sales_order_deliveries%rowtype;
begin
  perform private.require_permission('sales_orders.deliver');
  if p_reason is null or length(trim(p_reason))<3 then raise exception 'A cancellation reason is required'; end if;
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  select * into v_delivery from public.sales_order_deliveries
   where id=p_delivery_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'Delivery not found'; end if;
  if v_delivery.status<>'draft' then raise exception 'Only a draft delivery can be cancelled'; end if;
  update public.sales_order_deliveries set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),
    cancel_reason=trim(p_reason),updated_at=now() where id=v_delivery.id returning * into v_delivery;
  return to_jsonb(v_delivery)||jsonb_build_object('ok',true);
end; $$;
revoke all on function public.cancel_sales_order_delivery(uuid,text) from public,anon;
grant execute on function public.cancel_sales_order_delivery(uuid,text) to authenticated,service_role;

create or replace function public.cancel_sales_order(p_order_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_order public.sales_orders%rowtype; v_completed integer;
begin
  perform private.require_permission('sales_orders.manage');
  if p_reason is null or length(trim(p_reason))<3 then raise exception 'A cancellation reason is required'; end if;
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  select * into v_order from public.sales_orders where id=p_order_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'Sales order not found'; end if;
  if v_order.status in('delivered','cancelled') then raise exception 'This sales order cannot be cancelled'; end if;
  select count(*) into v_completed from public.sales_order_deliveries where sales_order_id=v_order.id and status='completed';
  update public.stock_reservations set
    released_base_quantity=reserved_base_quantity-delivered_base_quantity,
    status='released',released_by=auth.uid(),released_at=now(),updated_at=now()
   where sales_order_id=v_order.id and status='active';
  update public.sales_order_deliveries set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),
    cancel_reason='Order cancelled: '||trim(p_reason),updated_at=now()
   where sales_order_id=v_order.id and status='draft';
  update public.sales_orders set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),cancel_reason=trim(p_reason),updated_at=now()
   where id=v_order.id returning * into v_order;
  if v_completed=0 and v_order.source_quote_id is not null then
    update public.sales_quotes set status='accepted',converted_order_id=null,converted_by=null,converted_at=null,updated_at=now()
     where id=v_order.source_quote_id;
  end if;
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_branch,auth.uid(),'cancel_sales_order','sales_order',v_order.id,
    jsonb_build_object('order_number',v_order.order_number,'reason',trim(p_reason),'completed_deliveries',v_completed));
  return to_jsonb(v_order)||jsonb_build_object('ok',true,'completed_deliveries',v_completed);
end; $$;
revoke all on function public.cancel_sales_order(uuid,text) from public,anon;
grant execute on function public.cancel_sales_order(uuid,text) to authenticated,service_role;

-- Reservation-aware checkout. For a prepared order delivery, locked order prices
-- are supplied by private.resolve_sales_unit_price through the local delivery ID.
create or replace function public.complete_sale_v9(
  p_items jsonb,p_payment_method text,p_amount_received numeric,p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',p_manual_discount_value numeric default 0,
  p_coupon_code text default null,p_currency public.currency_code default 'USD',p_notes text default null,
  p_payment_reference text default null,p_idempotency_key text default null,p_source_quote_id uuid default null,
  p_approval_request_id uuid default null,p_source_sales_order_delivery_id uuid default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_delivery public.sales_order_deliveries%rowtype; v_order public.sales_orders%rowtype;
 v_input record; v_product public.products%rowtype; v_unit public.product_units%rowtype; v_need numeric; v_sellable numeric; v_reserved numeric;
 v_expected integer; v_matches integer; v_result jsonb; v_sale_id uuid; v_sale public.sales%rowtype; v_di record; v_res public.stock_reservations%rowtype;
 v_remaining_orders integer; v_shop_negative boolean:=false;
begin
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  select coalesce(allow_negative_stock,false) into v_shop_negative from public.app_settings where organization_id=v_org;
  if p_source_sales_order_delivery_id is null then
    for v_input in select x.product_id,x.product_unit_id,sum(x.quantity)::numeric quantity
      from jsonb_to_recordset(p_items) x(product_id uuid,product_unit_id uuid,quantity numeric)
      group by x.product_id,x.product_unit_id order by x.product_id loop
      select * into v_product from public.products where id=v_input.product_id and organization_id=v_org;
      if not found then raise exception 'Product not found'; end if;
      if v_product.track_stock and not v_product.allow_negative_stock and not v_shop_negative then
        select * into v_unit from public.product_units where id=v_input.product_unit_id and product_id=v_product.id;
        if not found then select * into v_unit from public.product_units where product_id=v_product.id and is_base=true limit 1; end if;
        v_need:=round(v_input.quantity*coalesce(v_unit.conversion_factor,1),3);
        perform pg_advisory_xact_lock(hashtext('tiny-pos-reserve:'||v_branch::text||':'||v_product.id::text));
        v_sellable:=private.sales_order_sellable_base(v_org,v_branch,v_product.id);
        v_reserved:=private.sales_order_reserved_base(v_org,v_branch,v_product.id,null);
        if v_sellable-v_reserved+0.0005<v_need then
          raise exception '% has only % available after sales-order reservations',v_product.name,greatest(v_sellable-v_reserved,0);
        end if;
      end if;
    end loop;
    return public.complete_sale_v8(p_items,p_payment_method,p_amount_received,p_customer_id,
      p_manual_discount_type,p_manual_discount_value,p_coupon_code,p_currency,p_notes,p_payment_reference,
      p_idempotency_key,p_source_quote_id,p_approval_request_id);
  end if;

  perform private.require_permission('sales_orders.deliver');
  select * into v_delivery from public.sales_order_deliveries
   where id=p_source_sales_order_delivery_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'Sales-order delivery not found'; end if;
  select * into v_order from public.sales_orders where id=v_delivery.sales_order_id for update;
  if v_delivery.status='completed' and v_delivery.sale_id is not null then
    select * into v_sale from public.sales where id=v_delivery.sale_id;
    if found and v_sale.idempotency_key=nullif(trim(p_idempotency_key),'') then
      return jsonb_build_object('ok',true,'duplicate_request',true,'sale_id',v_sale.id,'invoice_number',v_sale.invoice_number,
        'subtotal',v_sale.subtotal,'discount_amount',v_sale.discount_amount,'tax_amount',v_sale.tax_amount,
        'total_amount',v_sale.total_amount,'change_amount',v_sale.change_amount,'source_sales_order_id',v_order.id,
        'source_sales_order_number',v_order.order_number,'source_delivery_id',v_delivery.id,'source_delivery_number',v_delivery.delivery_number);
    end if;
    raise exception 'This delivery was already invoiced';
  end if;
  if v_delivery.status<>'draft' then raise exception 'This delivery is no longer active'; end if;
  if v_order.status not in('confirmed','partially_delivered') then raise exception 'Sales order is not available for delivery'; end if;
  if v_order.customer_id is distinct from p_customer_id or v_order.currency<>p_currency then
    raise exception 'Customer or currency does not match the sales order';
  end if;
  select count(*) into v_expected from public.sales_order_delivery_items where delivery_id=v_delivery.id;
  select count(*) into v_matches from public.sales_order_delivery_items di
   where di.delivery_id=v_delivery.id and exists(
     select 1 from jsonb_to_recordset(p_items) x(product_id uuid,product_unit_id uuid,quantity numeric)
      where x.product_id=di.product_id and x.product_unit_id is not distinct from di.product_unit_id
        and abs(x.quantity-di.quantity)<=0.0005
   );
  if v_expected=0 or v_matches<>v_expected or jsonb_array_length(p_items)<>v_expected then
    raise exception 'Delivery items or quantities changed. Reopen the prepared delivery';
  end if;
  for v_di in select * from public.sales_order_delivery_items where delivery_id=v_delivery.id order by product_id loop
    select * into v_product from public.products where id=v_di.product_id;
    if v_product.track_stock then
      perform pg_advisory_xact_lock(hashtext('tiny-pos-reserve:'||v_branch::text||':'||v_product.id::text));
      select * into v_res from public.stock_reservations where sales_order_item_id=v_di.sales_order_item_id for update;
      if not found or v_res.status<>'active' or
         v_di.base_quantity>(v_res.reserved_base_quantity-v_res.delivered_base_quantity-v_res.released_base_quantity)+0.0005 then
        raise exception 'Reserved stock is no longer available for %',v_di.product_name;
      end if;
    end if;
  end loop;
  perform set_config('tiny_pos.sales_order_delivery_id',v_delivery.id::text,true);
  v_result:=public.complete_sale_v8(p_items,p_payment_method,p_amount_received,p_customer_id,
    'none',0,null,p_currency,concat_ws(' · ',nullif(trim(p_notes),''),v_order.order_number,v_delivery.delivery_number),
    p_payment_reference,p_idempotency_key,null,p_approval_request_id);
  v_sale_id:=(v_result->>'sale_id')::uuid;
  update public.sales set source_sales_order_id=v_order.id,source_sales_order_delivery_id=v_delivery.id,updated_at=now()
   where id=v_sale_id returning * into v_sale;
  for v_di in select * from public.sales_order_delivery_items where delivery_id=v_delivery.id loop
    update public.sales_order_items set delivered_quantity=round(delivered_quantity+v_di.quantity,3),
      delivered_base_quantity=round(delivered_base_quantity+v_di.base_quantity,3)
     where id=v_di.sales_order_item_id;
    update public.stock_reservations set delivered_base_quantity=round(delivered_base_quantity+v_di.base_quantity,3),
      status=case when delivered_base_quantity+v_di.base_quantity>=reserved_base_quantity-released_base_quantity-0.0005
                  then 'fulfilled'::public.stock_reservation_status else status end,updated_at=now()
     where sales_order_item_id=v_di.sales_order_item_id;
    update public.sales_order_delivery_items di set sale_item_id=si.id
     from public.sale_items si where di.id=v_di.id and si.sale_id=v_sale_id
       and si.product_id=v_di.product_id and si.product_unit_id is not distinct from v_di.product_unit_id;
  end loop;
  update public.sales_order_deliveries set status='completed',sale_id=v_sale_id,invoice_number=v_sale.invoice_number,
    subtotal=v_sale.subtotal,tax_amount=v_sale.tax_amount,total_amount=v_sale.total_amount,
    completed_by=auth.uid(),completed_at=now(),updated_at=now() where id=v_delivery.id;
  select count(*) into v_remaining_orders from public.sales_order_items
   where order_id=v_order.id and delivered_quantity<quantity-0.0005;
  update public.sales_orders set status=case when v_remaining_orders=0 then 'delivered'::public.sales_order_status
                                            else 'partially_delivered'::public.sales_order_status end,
    completed_at=case when v_remaining_orders=0 then now() else null end,updated_at=now()
   where id=v_order.id returning * into v_order;
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_branch,auth.uid(),'complete_sales_order_delivery','sales_order_delivery',v_delivery.id,
    jsonb_build_object('delivery_number',v_delivery.delivery_number,'order_number',v_order.order_number,
      'invoice_number',v_sale.invoice_number,'sale_id',v_sale_id,'order_status',v_order.status));
  return v_result||jsonb_build_object('source_sales_order_id',v_order.id,'source_sales_order_number',v_order.order_number,
    'source_delivery_id',v_delivery.id,'source_delivery_number',v_delivery.delivery_number,'sales_order_status',v_order.status);
end; $$;
revoke all on function public.complete_sale_v9(jsonb,text,numeric,uuid,public.discount_type,numeric,text,public.currency_code,text,text,text,uuid,uuid,uuid) from public,anon;
grant execute on function public.complete_sale_v9(jsonb,text,numeric,uuid,public.discount_type,numeric,text,public.currency_code,text,text,text,uuid,uuid,uuid) to authenticated,service_role;
revoke execute on function public.complete_sale_v8(jsonb,text,numeric,uuid,public.discount_type,numeric,text,public.currency_code,text,text,text,uuid,uuid) from authenticated;

-- Telegram sales-order preference. Existing and future preference rows default on.
alter table public.telegram_notification_preferences
  add column if not exists sales_order_alerts boolean not null default true;

create or replace function public.save_my_telegram_preferences(p_preferences jsonb)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_user_id uuid:=auth.uid(); v_profile public.profiles%rowtype; v_result public.telegram_notification_preferences%rowtype; v_all boolean;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_profile from public.profiles where id=v_user_id and is_active=true;
  if not found then raise exception 'Active POS profile required'; end if;
  perform private.ensure_telegram_preferences(v_user_id);
  v_all:=coalesce((p_preferences->>'all_branches')::boolean,false);
  if v_all and v_profile.role not in('owner','admin') then raise exception 'Only owners and admins can receive all-branch alerts'; end if;
  update public.telegram_notification_preferences set
    stock_alerts=coalesce((p_preferences->>'stock_alerts')::boolean,stock_alerts),
    sales_summary=coalesce((p_preferences->>'sales_summary')::boolean,sales_summary),
    credit_alerts=coalesce((p_preferences->>'credit_alerts')::boolean,credit_alerts),
    supplier_alerts=coalesce((p_preferences->>'supplier_alerts')::boolean,supplier_alerts),
    purchase_alerts=coalesce((p_preferences->>'purchase_alerts')::boolean,purchase_alerts),
    transfer_alerts=coalesce((p_preferences->>'transfer_alerts')::boolean,transfer_alerts),
    quotation_alerts=coalesce((p_preferences->>'quotation_alerts')::boolean,quotation_alerts),
    sales_order_alerts=coalesce((p_preferences->>'sales_order_alerts')::boolean,sales_order_alerts),
    cash_register_alerts=coalesce((p_preferences->>'cash_register_alerts')::boolean,cash_register_alerts),
    system_alerts=coalesce((p_preferences->>'system_alerts')::boolean,system_alerts),
    all_branches=v_all,daily_summary_hour=greatest(0,least(23,coalesce((p_preferences->>'daily_summary_hour')::integer,daily_summary_hour))),
    quiet_start_hour=case when p_preferences?'quiet_start_hour' and nullif(p_preferences->>'quiet_start_hour','') is not null
      then greatest(0,least(23,(p_preferences->>'quiet_start_hour')::integer)) else null end,
    quiet_end_hour=case when p_preferences?'quiet_end_hour' and nullif(p_preferences->>'quiet_end_hour','') is not null
      then greatest(0,least(23,(p_preferences->>'quiet_end_hour')::integer)) else null end,
    updated_by=v_user_id,updated_at=now()
  where user_id=v_user_id returning * into v_result;
  return to_jsonb(v_result);
end; $$;
revoke all on function public.save_my_telegram_preferences(jsonb) from public,anon;
grant execute on function public.save_my_telegram_preferences(jsonb) to authenticated;

commit;
-- ============================================================================
-- END STEP 36
-- ============================================================================
