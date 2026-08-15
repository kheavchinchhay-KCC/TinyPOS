-- ============================================================================
-- Tiny POS - Step 46.4.16: Login Session & Public Store Checkout Recovery
-- Run once after Step 51 / Patch 46.4.15.
--
-- Fixes:
--   * Online order checkout enum assignment for payment_status
--   * Explicit pgcrypto schema usage for public tracking tokens
--
-- Safe additive migration. Do not rerun older migrations.
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.submit_online_order(
  p_slug text,
  p_payload jsonb,
  p_source_ip_hash text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,extensions,pg_temp as $$
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
  v_token:=encode(extensions.gen_random_bytes(24),'hex');
  v_token_hash:=encode(extensions.digest(v_token,'sha256'),'hex');

  insert into public.online_orders(
    organization_id,branch_id,order_number,tracking_token_hash,status,
    payment_status,payment_method,fulfilment_type,currency,customer_name,
    customer_phone,customer_email,delivery_address,requested_date,customer_note,
    subtotal,delivery_fee,total_amount,source_ip_hash,user_agent
  ) values(
    v_store.organization_id,v_store.branch_id,v_order_number,v_token_hash,'pending',
    (case when v_payment='bank_transfer' then 'pending_confirmation' else 'unpaid' end)::public.online_payment_status,
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
