-- ============================================================================
-- Tiny POS - Step 46.4.14: Online Store & Online Orders Recovery
-- Run once after Step 49 / Patch 46.4.13.
--
-- Adds:
--   * Safe public tracking-token generation (fixes gen_random_bytes error)
--   * Storefront advertising banners with adjustable auto-scroll duration
--   * Bank QR image/comment settings and customer bank-slip evidence
--   * Cashier/fulfilment-role online-order receiving into reserved Sales Orders
--   * Immediate Telegram operational event outbox for new online orders
-- ============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- The original Step 41 order RPC uses unqualified pgcrypto functions while
-- its secure search_path excludes the extensions schema. Extend only that
-- function search path; no public crypto wrapper is exposed.
alter function public.submit_online_order(text,jsonb,text,text)
  set search_path=public,private,auth,extensions,pg_temp;
alter function public.track_online_order(text,text,text)
  set search_path=public,private,auth,extensions,pg_temp;

alter table if exists public.online_store_settings
  add column if not exists banner_images jsonb not null default '[]'::jsonb,
  add column if not exists banner_interval_seconds integer not null default 5,
  add column if not exists bank_qr_url text,
  add column if not exists bank_qr_public_id text,
  add column if not exists bank_comment text;

alter table if exists public.online_orders
  add column if not exists bank_slip_url text,
  add column if not exists bank_slip_public_id text,
  add column if not exists bank_slip_uploaded_at timestamptz,
  add column if not exists bank_reference text;

alter table public.online_store_settings
  drop constraint if exists online_store_settings_banner_interval_check;
alter table public.online_store_settings
  add constraint online_store_settings_banner_interval_check
  check(banner_interval_seconds between 2 and 30);

create index if not exists online_orders_payment_created_idx
  on public.online_orders(organization_id,branch_id,payment_method,payment_status,created_at desc);

-- ---------------------------------------------------------------------------
-- Public storefront payload
-- ---------------------------------------------------------------------------
create or replace function public.get_public_storefront(p_slug text)
returns jsonb
language plpgsql stable security definer
set search_path=public,private,auth,extensions,pg_temp as $$
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
      'bank_qr_url',v_store.bank_qr_url,
      'bank_comment',v_store.bank_comment,
      'banner_images',coalesce(v_store.banner_images,'[]'::jsonb),
      'banner_interval_seconds',v_store.banner_interval_seconds,
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

-- ---------------------------------------------------------------------------
-- Store settings save RPC including banners and bank QR
-- ---------------------------------------------------------------------------
create or replace function public.save_online_store_settings(p_values jsonb)
returns jsonb
language plpgsql security definer
set search_path=public,private,auth,extensions,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_branch uuid:=private.current_branch_id();
  v_slug text;
  v_title text;
  v_banners jsonb;
  v_row public.online_store_settings%rowtype;
begin
  perform private.require_permission('online_store.manage');
  v_slug:=lower(trim(coalesce(p_values->>'slug','')));
  v_title:=trim(coalesce(p_values->>'store_title',''));
  v_banners:=case
    when jsonb_typeof(p_values->'banner_images')='array'
      then p_values->'banner_images'
    else '[]'::jsonb
  end;

  if v_slug !~ '^[a-z0-9][a-z0-9-]{2,59}$' then
    raise exception 'Store slug must use 3-60 lowercase letters, numbers or dashes';
  end if;
  if length(v_title) not between 1 and 160 then raise exception 'Store title is required'; end if;
  if jsonb_array_length(v_banners)>12 then raise exception 'A maximum of 12 advertising pictures is allowed'; end if;
  if not (
    coalesce((p_values->>'allow_pickup')::boolean,true)
    or coalesce((p_values->>'allow_delivery')::boolean,false)
  ) then raise exception 'Enable pickup or delivery'; end if;
  if not (
    coalesce((p_values->>'allow_pay_at_store')::boolean,true)
    or coalesce((p_values->>'allow_cash_on_delivery')::boolean,true)
    or coalesce((p_values->>'allow_bank_transfer')::boolean,false)
  ) then raise exception 'Enable at least one payment method'; end if;
  if coalesce((p_values->>'allow_delivery')::boolean,false)
     and not coalesce((p_values->>'allow_pickup')::boolean,true)
     and not (
       coalesce((p_values->>'allow_cash_on_delivery')::boolean,true)
       or coalesce((p_values->>'allow_bank_transfer')::boolean,false)
     ) then
    raise exception 'Delivery-only stores require cash on delivery or bank transfer';
  end if;

  insert into public.online_store_settings(
    organization_id,branch_id,slug,is_published,store_title,store_description,
    contact_phone,address,allow_pickup,allow_delivery,delivery_fee_usd,
    delivery_fee_khr,minimum_order_usd,minimum_order_khr,
    allow_pay_at_store,allow_cash_on_delivery,allow_bank_transfer,bank_instructions,
    customer_message,expected_ready_days,banner_images,banner_interval_seconds,
    bank_qr_url,bank_qr_public_id,bank_comment,created_by,updated_by
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
    v_banners,
    greatest(2,least(30,coalesce((p_values->>'banner_interval_seconds')::integer,5))),
    nullif(trim(coalesce(p_values->>'bank_qr_url','')),''),
    nullif(trim(coalesce(p_values->>'bank_qr_public_id','')),''),
    nullif(trim(coalesce(p_values->>'bank_comment','')),''),
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
    banner_images=excluded.banner_images,
    banner_interval_seconds=excluded.banner_interval_seconds,
    bank_qr_url=excluded.bank_qr_url,
    bank_qr_public_id=excluded.bank_qr_public_id,
    bank_comment=excluded.bank_comment,
    updated_by=auth.uid(),
    updated_at=now()
  returning * into v_row;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_org,v_branch,auth.uid(),'save_online_store','online_store_settings',v_row.id,
    jsonb_build_object(
      'slug',v_row.slug,
      'is_published',v_row.is_published,
      'banner_count',jsonb_array_length(coalesce(v_row.banner_images,'[]'::jsonb)),
      'bank_qr',v_row.bank_qr_url is not null
    )
  );

  return to_jsonb(v_row)||jsonb_build_object('ok',true);
end
$$;
revoke all on function public.save_online_store_settings(jsonb) from public,anon;
grant execute on function public.save_online_store_settings(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Cashier/fulfilment permission can receive a pending web order. This converts
-- it to the existing reserved Sales Order workflow; New Sale later creates the
-- invoice/receipt when delivery payment is completed.
-- ---------------------------------------------------------------------------
create or replace function public.receive_online_order(p_order_id uuid)
returns jsonb
language plpgsql security definer
set search_path=public,private,auth,extensions,pg_temp as $$
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
  if not (
    private.has_permission('online_orders.manage',auth.uid())
    or private.has_permission('online_orders.fulfill',auth.uid())
  ) then
    raise exception 'Permission required: online_orders.fulfill';
  end if;

  select * into v_online from public.online_orders
  where id=p_order_id and organization_id=v_org and branch_id=v_branch
  for update;
  if not found then raise exception 'Online order not found in the active branch'; end if;
  if v_online.status<>'pending' then raise exception 'Only a Pending online order can be received'; end if;

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
      case when v_online.payment_method='bank_transfer' then 'Bank transfer evidence attached in Online Store.' end,
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
    'Received and converted to reserved Sales Order '||v_sales_number,auth.uid()
  );

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_org,v_branch,auth.uid(),'receive_online_order','online_order',v_online.id,
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
revoke all on function public.receive_online_order(uuid) from public,anon;
grant execute on function public.receive_online_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Telegram operational event for immediate new-order alerts.
-- ---------------------------------------------------------------------------
create or replace function private.queue_online_order_telegram_event()
returns trigger
language plpgsql
security definer
set search_path=public,private,auth,extensions,pg_temp
as $$
begin
  insert into public.telegram_operational_events(
    organization_id,branch_id,actor_user_id,event_type,event_key,entity_type,entity_id,payload
  ) values(
    new.organization_id,new.branch_id,null,'online_order_requested',
    'online_order_requested:'||new.id::text,'online_order',new.id,
    jsonb_build_object(
      'order_number',new.order_number,
      'customer_name',new.customer_name,
      'customer_phone',new.customer_phone,
      'currency',new.currency,
      'total_amount',new.total_amount,
      'payment_method',new.payment_method,
      'payment_status',new.payment_status,
      'fulfilment_type',new.fulfilment_type,
      'bank_slip_url',new.bank_slip_url,
      'created_at',new.created_at
    )
  ) on conflict(event_key) do nothing;
  return new;
end;
$$;

drop trigger if exists queue_online_order_telegram_event on public.online_orders;
create trigger queue_online_order_telegram_event
after insert on public.online_orders
for each row execute function private.queue_online_order_telegram_event();

notify pgrst,'reload schema';
