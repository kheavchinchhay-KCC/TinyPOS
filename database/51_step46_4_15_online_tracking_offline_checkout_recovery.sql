-- ==========================================================================
-- Tiny POS - Step 46.4.15: Online Tracking & Offline Checkout Recovery
-- Run once after Step 50 / Patch 46.4.14.
--
-- Fixes:
--   * Offline Checkout pgcrypto digest() lookup in Supabase's extensions schema
--   * Combined offline snapshot + Sales Order delivery unit-price resolver
--   * Customer order tracking shows Sales Order and final invoice when available
--   * Safe phone-number order lookup returns masked, limited order summaries only
-- ==========================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Existing secure functions intentionally use a restricted search_path. Add the
-- extension schema so unqualified pgcrypto digest(text,text) resolves correctly.
alter function public.prepare_offline_checkout_session(text,text,integer)
  set search_path=public,private,auth,extensions,pg_temp;
alter function public.sync_offline_sale(uuid,uuid,jsonb)
  set search_path=public,private,auth,extensions,pg_temp;

-- Keep both special pricing contexts. Step 37 added offline snapshot pricing,
-- while later recovery migrations restored Sales Order delivery pricing. This
-- combined resolver supports both and then falls back to normal price lists.
create or replace function private.resolve_sales_unit_price(
  p_organization_id uuid,
  p_branch_id uuid,
  p_customer_id uuid,
  p_product_unit_id uuid,
  p_currency public.currency_code,
  p_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,extensions,pg_temp
as $$
declare
  v_offline_text text;
  v_delivery_text text;
  v_session public.offline_checkout_sessions%rowtype;
  v_product jsonb;
  v_unit jsonb;
  v_row record;
  v_list_price numeric(14,2);
begin
  v_offline_text:=nullif(current_setting('tiny_pos.offline_session_id',true),'');

  if v_offline_text is not null then
    select * into v_session
    from public.offline_checkout_sessions
    where id=v_offline_text::uuid
      and organization_id=p_organization_id
      and branch_id=p_branch_id
      and user_id=auth.uid();

    if not found then
      raise exception 'Offline checkout session is unavailable for this user and branch';
    end if;

    select product_row into v_product
    from jsonb_array_elements(coalesce(v_session.catalog_snapshot->'products','[]'::jsonb)) product_row
    where (product_row->>'currency')=p_currency::text
      and exists(
        select 1
        from jsonb_array_elements(coalesce(product_row->'product_units','[]'::jsonb)) unit_row
        where (unit_row->>'id')::uuid=p_product_unit_id
      )
    limit 1;

    if v_product is null then
      raise exception 'Product unit is not available in the offline snapshot';
    end if;

    select unit_row into v_unit
    from jsonb_array_elements(coalesce(v_product->'product_units','[]'::jsonb)) unit_row
    where (unit_row->>'id')::uuid=p_product_unit_id
    limit 1;

    if v_unit is null
       or coalesce((v_unit->>'is_active')::boolean,false) is not true then
      raise exception 'Selling unit is unavailable in the offline snapshot';
    end if;

    v_list_price:=coalesce((v_unit->>'selling_price')::numeric,0);

    return jsonb_build_object(
      'product_unit_id',p_product_unit_id,
      'product_id',(v_product->>'id')::uuid,
      'price_list_id',null,
      'price_list_code',null,
      'price_list_name','Offline snapshot',
      'list_price',v_list_price,
      'effective_price',v_list_price,
      'price_adjustment',0,
      'has_override',true
    );
  end if;

  v_delivery_text:=nullif(current_setting('tiny_pos.sales_order_delivery_id',true),'');

  if v_delivery_text is not null then
    select
      di.product_unit_id,
      di.product_id,
      di.list_price,
      di.invoice_unit_price,
      oi.price_list_id,
      o.price_list_name,
      o.customer_id,
      o.currency,
      o.organization_id,
      o.branch_id
    into v_row
    from public.sales_order_delivery_items di
    join public.sales_order_deliveries d on d.id=di.delivery_id
    join public.sales_orders o on o.id=d.sales_order_id
    join public.sales_order_items oi on oi.id=di.sales_order_item_id
    where d.id=v_delivery_text::uuid
      and di.product_unit_id=p_product_unit_id
      and d.status='draft';

    if not found then
      raise exception 'Delivery pricing item is unavailable';
    end if;

    if v_row.organization_id<>p_organization_id
       or v_row.branch_id<>p_branch_id
       or v_row.customer_id is distinct from p_customer_id
       or v_row.currency<>p_currency then
      raise exception 'Delivery pricing context does not match checkout';
    end if;

    return jsonb_build_object(
      'product_unit_id',v_row.product_unit_id,
      'product_id',v_row.product_id,
      'price_list_id',v_row.price_list_id,
      'price_list_code',null,
      'price_list_name',v_row.price_list_name,
      'list_price',v_row.list_price,
      'effective_price',v_row.invoice_unit_price,
      'price_adjustment',round(v_row.list_price-v_row.invoice_unit_price,2),
      'has_override',true
    );
  end if;

  return private.resolve_standard_sales_unit_price(
    p_organization_id,
    p_branch_id,
    p_customer_id,
    p_product_unit_id,
    p_currency,
    p_at
  );
end;
$$;

revoke all on function private.resolve_sales_unit_price(
  uuid,uuid,uuid,uuid,public.currency_code,timestamptz
) from public,anon;
grant execute on function private.resolve_sales_unit_price(
  uuid,uuid,uuid,uuid,public.currency_code,timestamptz
) to authenticated,service_role;

-- Secure full tracking still requires the private token. Add the connected
-- Sales Order and final invoice identifiers when they exist.
create or replace function public.track_online_order(
  p_slug text,
  p_order_number text,
  p_tracking_token text
) returns jsonb
language plpgsql
stable
security definer
set search_path=public,private,auth,extensions,pg_temp
as $$
declare
  v_store public.online_store_settings%rowtype;
  v_order public.online_orders%rowtype;
  v_hash text;
  v_sales_order_number text;
  v_invoice_number text;
  v_sale_id uuid;
begin
  select * into v_store
  from public.online_store_settings
  where slug=lower(trim(p_slug));

  if not found then raise exception 'Order not found'; end if;

  v_hash:=encode(digest(trim(p_tracking_token),'sha256'),'hex');

  select * into v_order
  from public.online_orders
  where organization_id=v_store.organization_id
    and branch_id=v_store.branch_id
    and upper(order_number)=upper(trim(p_order_number))
    and tracking_token_hash=v_hash;

  if not found then raise exception 'Order not found'; end if;

  if v_order.sales_order_id is not null then
    select order_number into v_sales_order_number
    from public.sales_orders
    where id=v_order.sales_order_id;

    select id,invoice_number
    into v_sale_id,v_invoice_number
    from public.sales
    where source_sales_order_id=v_order.sales_order_id
    order by completed_at desc nulls last,created_at desc
    limit 1;
  end if;

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
    'sales_order_number',v_sales_order_number,
    'sale_id',v_sale_id,
    'invoice_number',v_invoice_number,
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
      from public.online_order_items i
      where i.online_order_id=v_order.id
    ),
    'history',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'status',h.to_status,
        'note',h.note,
        'changed_at',h.changed_at
      ) order by h.changed_at),'[]'::jsonb)
      from public.online_order_status_history h
      where h.online_order_id=v_order.id
    )
  );
end;
$$;

revoke all on function public.track_online_order(text,text,text)
  from public,anon,authenticated;
grant execute on function public.track_online_order(text,text,text)
  to service_role;

-- Phone-only recovery intentionally returns masked summaries. Full order data,
-- address and payment evidence still require the private tracking token.
create or replace function public.find_public_orders_by_phone(
  p_slug text,
  p_phone text
) returns jsonb
language plpgsql
stable
security definer
set search_path=public,private,auth,extensions,pg_temp
as $$
declare
  v_store public.online_store_settings%rowtype;
  v_digits text;
  v_match_digits integer;
begin
  select * into v_store
  from public.online_store_settings
  where slug=lower(trim(p_slug))
    and is_published=true;

  if not found then raise exception 'Storefront not found'; end if;

  v_digits:=regexp_replace(coalesce(p_phone,''),'[^0-9]','','g');
  if length(v_digits)<7 then
    raise exception 'Enter a valid phone number';
  end if;
  v_match_digits:=least(9,length(v_digits));

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'masked_order_number',
        case
          when length(o.order_number)>7
            then left(o.order_number,4)||repeat('•',greatest(length(o.order_number)-9,3))||right(o.order_number,5)
          else o.order_number
        end,
      'status',o.status,
      'payment_status',o.payment_status,
      'currency',o.currency,
      'total_amount',o.total_amount,
      'created_at',o.created_at,
      'updated_at',o.updated_at
    ) order by o.created_at desc)
    from (
      select order_row.*
      from public.online_orders order_row
      where order_row.organization_id=v_store.organization_id
        and order_row.branch_id=v_store.branch_id
        and right(regexp_replace(coalesce(order_row.customer_phone,''),'[^0-9]','','g'),v_match_digits)
          =right(v_digits,v_match_digits)
      order by order_row.created_at desc
      limit 10
    ) o
  ),'[]'::jsonb);
end;
$$;

revoke all on function public.find_public_orders_by_phone(text,text)
  from public,anon,authenticated;
grant execute on function public.find_public_orders_by_phone(text,text)
  to service_role;
