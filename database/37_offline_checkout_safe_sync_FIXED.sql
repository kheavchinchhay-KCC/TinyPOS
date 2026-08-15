-- ============================================================================
-- Tiny POS - Step 42: Fully Offline Checkout and Safe Synchronization
-- Run once in the NEW Supabase project after Step 41.
--
-- Offline sales use a server-prepared catalog snapshot. The device may complete
-- payments without a network connection, issue a pending-sync receipt and later
-- synchronize with an idempotent UUID. Stock, batches, permissions and register
-- rules are checked again during synchronization. Unsafe records become explicit
-- conflicts and are never silently posted or duplicated.
-- ============================================================================

create extension if not exists pgcrypto;

begin;

insert into public.permission_definitions(
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
) values
  ('offline_checkout.use','Sales','Use Offline Checkout',
   'Prepare this device for offline checkout, create pending-sync receipts and synchronize them later.',
   'sensitive',array['owner','admin','manager','cashier']::public.app_role[],false,36),
  ('offline_checkout.manage','Sales','Manage Offline Checkout',
   'Review conflicts, revoke device sessions and cancel failed offline records.',
   'critical',array['owner','admin','manager']::public.app_role[],false,37)
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

create table if not exists public.offline_checkout_sessions(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  device_name text not null,
  status text not null default 'active'
    check(status in('active','revoked','expired')),
  register_session_id uuid references public.cash_register_sessions(id) on delete set null,
  catalog_snapshot jsonb not null,
  snapshot_hash text not null,
  prepared_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoke_reason text,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,user_id,device_id,id),
  check(length(trim(device_id)) between 8 and 160),
  check(length(trim(device_name)) between 1 and 120),
  check(expires_at>prepared_at)
);

create index if not exists offline_checkout_sessions_user_idx
  on public.offline_checkout_sessions(organization_id,user_id,status,expires_at desc);
create index if not exists offline_checkout_sessions_branch_idx
  on public.offline_checkout_sessions(organization_id,branch_id,status,expires_at desc);

drop trigger if exists set_offline_checkout_sessions_updated_at
  on public.offline_checkout_sessions;
create trigger set_offline_checkout_sessions_updated_at
before update on public.offline_checkout_sessions
for each row execute function public.set_updated_at();

create table if not exists public.offline_sale_syncs(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  session_id uuid not null references public.offline_checkout_sessions(id) on delete restrict,
  offline_sale_id uuid not null,
  local_receipt_number text not null,
  offline_created_at timestamptz not null,
  payload jsonb not null,
  payload_hash text not null,
  status text not null default 'pending'
    check(status in('pending','syncing','synced','conflict','cancelled')),
  sale_id uuid references public.sales(id) on delete set null,
  invoice_number text,
  error_code text,
  error_message text,
  attempt_count integer not null default 0,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,
  synced_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,offline_sale_id),
  unique(session_id,local_receipt_number)
);

create index if not exists offline_sale_syncs_branch_status_idx
  on public.offline_sale_syncs(organization_id,branch_id,status,offline_created_at desc);
create index if not exists offline_sale_syncs_user_idx
  on public.offline_sale_syncs(user_id,status,offline_created_at desc);

drop trigger if exists set_offline_sale_syncs_updated_at
  on public.offline_sale_syncs;
create trigger set_offline_sale_syncs_updated_at
before update on public.offline_sale_syncs
for each row execute function public.set_updated_at();

alter table public.offline_checkout_sessions enable row level security;
alter table public.offline_sale_syncs enable row level security;

drop policy if exists offline_checkout_sessions_read on public.offline_checkout_sessions;
create policy offline_checkout_sessions_read on public.offline_checkout_sessions
for select to authenticated using(
  organization_id=(select private.current_organization_id())
  and (
    user_id=auth.uid()
    or private.has_permission('offline_checkout.manage',auth.uid())
  )
);

drop policy if exists offline_sale_syncs_read on public.offline_sale_syncs;
create policy offline_sale_syncs_read on public.offline_sale_syncs
for select to authenticated using(
  organization_id=(select private.current_organization_id())
  and (
    user_id=auth.uid()
    or private.has_permission('offline_checkout.manage',auth.uid())
  )
);

-- Build a compact, trusted checkout bundle. Customer-specific price lists,
-- coupons, credit sales and manual discounts intentionally stay online-only.
create or replace function private.build_offline_checkout_catalog(
  p_organization_id uuid,
  p_branch_id uuid
) returns jsonb
language sql security definer
set search_path=public,private,auth,pg_temp as $$
  select jsonb_build_object(
    'generated_at',now(),
    'organization_id',p_organization_id,
    'branch_id',p_branch_id,
    'categories',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',c.id,'name',c.name,'sort_order',c.sort_order
      ) order by c.sort_order,c.name)
      from public.categories c
      where c.organization_id=p_organization_id and c.is_active=true
    ),'[]'::jsonb),
    'customers',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',c.id,'customer_code',c.customer_code,'customer_type',c.customer_type,
        'name',c.name,'company_name',c.company_name,'phone',c.phone,'email',c.email,
        'loyalty_points',c.loyalty_points,'is_active',c.is_active
      ) order by c.name)
      from public.customers c
      where c.organization_id=p_organization_id and c.is_active=true
    ),'[]'::jsonb),
    'products',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'organization_id',p.organization_id,'category_id',p.category_id,
        'name',p.name,'name_km',p.name_km,'sku',p.sku,'barcode',p.barcode,
        'unit_name',p.unit_name,'selling_price',p.selling_price,'default_cost',p.default_cost,
        'currency',p.currency,'track_stock',p.track_stock,
        'allow_negative_stock',p.allow_negative_stock,'low_stock_threshold',p.low_stock_threshold,
        'is_active',p.is_active,
        'stock_quantity',greatest(0,
          coalesce((select ib.quantity from public.inventory_balances ib
                    where ib.branch_id=p_branch_id and ib.product_id=p.id),0)
          - coalesce((select sum(greatest(0,sr.reserved_base_quantity-sr.delivered_base_quantity-sr.released_base_quantity))
                      from public.stock_reservations sr
                      where sr.organization_id=p_organization_id and sr.branch_id=p_branch_id
                        and sr.product_id=p.id and sr.status='active'),0)
        ),
        'physical_stock_quantity',coalesce((select ib.quantity from public.inventory_balances ib
                    where ib.branch_id=p_branch_id and ib.product_id=p.id),0),
        'reserved_stock_quantity',coalesce((select sum(greatest(0,sr.reserved_base_quantity-sr.delivered_base_quantity-sr.released_base_quantity))
                      from public.stock_reservations sr
                      where sr.organization_id=p_organization_id and sr.branch_id=p_branch_id
                        and sr.product_id=p.id and sr.status='active'),0),
        'average_cost',coalesce((select ib.average_cost from public.inventory_balances ib
                    where ib.branch_id=p_branch_id and ib.product_id=p.id),p.default_cost,0),
        'categories',case when c.id is null then null else jsonb_build_object('id',c.id,'name',c.name) end,
        'product_images',coalesce((select jsonb_agg(jsonb_build_object(
          'id',pi.id,'secure_url',pi.secure_url,'cloudinary_public_id',pi.cloudinary_public_id,
          'is_primary',pi.is_primary,'sort_order',pi.sort_order
        ) order by pi.is_primary desc,pi.sort_order,pi.created_at)
          from public.product_images pi where pi.product_id=p.id),'[]'::jsonb),
        'product_units',coalesce((select jsonb_agg(jsonb_build_object(
          'id',u.id,'name',u.name,'short_name',u.short_name,
          'conversion_factor',u.conversion_factor,'selling_price',u.selling_price,
          'barcode',u.barcode,'is_base',u.is_base,'is_active',u.is_active,'sort_order',u.sort_order
        ) order by u.is_base desc,u.sort_order,u.name)
          from public.product_units u
          where u.product_id=p.id and (u.is_active=true or u.is_base=true)),'[]'::jsonb)
      ) order by p.name)
      from public.products p
      left join public.categories c on c.id=p.category_id
      where p.organization_id=p_organization_id and p.is_active=true
    ),'[]'::jsonb)
  );
$$;

revoke all on function private.build_offline_checkout_catalog(uuid,uuid) from public,anon;
grant execute on function private.build_offline_checkout_catalog(uuid,uuid) to authenticated,service_role;

create or replace function public.prepare_offline_checkout_session(
  p_device_id text,
  p_device_name text,
  p_valid_hours integer default 24
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid;
  v_branch uuid;
  v_catalog jsonb;
  v_settings jsonb;
  v_register_id uuid;
  v_session public.offline_checkout_sessions%rowtype;
  v_hours integer;
begin
  perform private.require_permission('offline_checkout.use');
  v_org:=private.current_organization_id();
  v_branch:=private.current_branch_id();

  if length(trim(coalesce(p_device_id,'')))<8 then
    raise exception 'A valid device ID is required';
  end if;
  if length(trim(coalesce(p_device_name,'')))<1 then
    raise exception 'A device name is required';
  end if;

  v_hours:=greatest(1,least(72,coalesce(p_valid_hours,24)));
  v_catalog:=private.build_offline_checkout_catalog(v_org,v_branch);

  select id into v_register_id
  from public.cash_register_sessions
  where organization_id=v_org and branch_id=v_branch and status='open'
  order by opened_at desc limit 1;

  select jsonb_build_object(
    'shop_name',s.shop_name,'shop_phone',s.shop_phone,'shop_address',s.shop_address,
    'receipt_footer',s.receipt_footer,'tax_percent',coalesce(s.tax_percent,0),
    'allow_negative_stock',coalesce(s.allow_negative_stock,false),
    'default_language',coalesce(s.default_language,'en'),
    'cash_register_open',v_register_id is not null,
    'register_session_id',v_register_id
  ) into v_settings
  from public.app_settings s where s.organization_id=v_org;

  update public.offline_checkout_sessions
  set status='revoked',revoked_at=now(),revoked_by=auth.uid(),
      revoke_reason='Replaced by a newer offline session',updated_at=now()
  where organization_id=v_org and user_id=auth.uid()
    and device_id=trim(p_device_id) and status='active';

  insert into public.offline_checkout_sessions(
    organization_id,branch_id,user_id,device_id,device_name,status,
    register_session_id,catalog_snapshot,snapshot_hash,expires_at
  ) values(
    v_org,v_branch,auth.uid(),trim(p_device_id),trim(p_device_name),'active',
    v_register_id,v_catalog,
    encode(digest(v_catalog::text,'sha256'),'hex'),
    now()+make_interval(hours=>v_hours)
  ) returning * into v_session;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_org,v_branch,auth.uid(),'prepare_offline_checkout','offline_checkout_session',v_session.id,
    jsonb_build_object('device_id',v_session.device_id,'device_name',v_session.device_name,
      'expires_at',v_session.expires_at,'cash_register_open',v_register_id is not null,
      'product_count',jsonb_array_length(v_catalog->'products'))
  );

  return jsonb_build_object(
    'ok',true,
    'session',to_jsonb(v_session)-'catalog_snapshot',
    'catalog',v_catalog,
    'settings',coalesce(v_settings,'{}'::jsonb)
  );
end;
$$;

revoke all on function public.prepare_offline_checkout_session(text,text,integer) from public,anon;
grant execute on function public.prepare_offline_checkout_session(text,text,integer) to authenticated,service_role;

-- Use the signed server snapshot price while synchronizing an offline receipt.
create or replace function private.resolve_sales_unit_price(
  p_organization_id uuid,p_branch_id uuid,p_customer_id uuid,p_product_unit_id uuid,
  p_currency public.currency_code,p_at timestamptz default now()
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_offline_text text;
  v_delivery_text text;
  v_session public.offline_checkout_sessions%rowtype;
  v_product jsonb;
  v_unit jsonb;
  v_row record;
begin
  v_offline_text:=nullif(current_setting('tiny_pos.offline_session_id',true),'');
  if v_offline_text is not null then
    select * into v_session from public.offline_checkout_sessions
    where id=v_offline_text::uuid and status='active';
    if not found then raise exception 'Offline checkout session is unavailable'; end if;
    if v_session.organization_id<>p_organization_id or v_session.branch_id<>p_branch_id then
      raise exception 'Offline checkout session does not match this branch';
    end if;

    select p into v_product
    from jsonb_array_elements(v_session.catalog_snapshot->'products') p
    where (p->>'currency')=p_currency::text
      and exists(
        select 1 from jsonb_array_elements(p->'product_units') u
        where (u->>'id')::uuid=p_product_unit_id
      ) limit 1;
    if v_product is null then raise exception 'Product unit is not available in the offline snapshot'; end if;

    select u into v_unit
    from jsonb_array_elements(v_product->'product_units') u
    where (u->>'id')::uuid=p_product_unit_id limit 1;

    return jsonb_build_object(
      'product_unit_id',p_product_unit_id,
      'product_id',(v_product->>'id')::uuid,
      'price_list_id',null,
      'price_list_code',null,
      'price_list_name','Offline snapshot',
      'list_price',coalesce((v_unit->>'selling_price')::numeric,0),
      'effective_price',coalesce((v_unit->>'selling_price')::numeric,0),
      'price_adjustment',0,
      'has_override',false
    );
  end if;

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
end;
$$;

revoke all on function private.resolve_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) from public,anon;
grant execute on function private.resolve_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) to authenticated,service_role;

create or replace function public.sync_offline_sale(
  p_session_id uuid,
  p_offline_sale_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid;
  v_branch uuid;
  v_session public.offline_checkout_sessions%rowtype;
  v_sync public.offline_sale_syncs%rowtype;
  v_existing public.offline_sale_syncs%rowtype;
  v_result jsonb;
  v_items jsonb;
  v_payment_method text;
  v_offline_created timestamptz;
  v_local_number text;
  v_customer_id uuid;
  v_currency public.currency_code;
  v_amount_received numeric;
  v_reference text;
  v_notes text;
  v_payload_hash text;
  v_sale_id uuid;
begin
  perform private.require_permission('offline_checkout.use');
  v_org:=private.current_organization_id();
  v_branch:=private.current_branch_id();

  select * into v_existing
  from public.offline_sale_syncs
  where organization_id=v_org and offline_sale_id=p_offline_sale_id;

  if found then
    if v_existing.payload_hash<>encode(digest(p_payload::text,'sha256'),'hex') then
      raise exception 'Offline sale ID was already used with different data';
    end if;
    return jsonb_build_object(
      'ok',v_existing.status='synced',
      'duplicate_request',true,
      'status',v_existing.status,
      'offline_sale_id',v_existing.offline_sale_id,
      'sale_id',v_existing.sale_id,
      'invoice_number',v_existing.invoice_number,
      'error_code',v_existing.error_code,
      'error_message',v_existing.error_message
    );
  end if;

  select * into v_session from public.offline_checkout_sessions
  where id=p_session_id and organization_id=v_org and branch_id=v_branch
    and user_id=auth.uid() for update;
  if not found then raise exception 'Offline checkout session not found for this user and branch'; end if;
  if v_session.status<>'active' then raise exception 'Offline checkout session is not active'; end if;
  if now()>v_session.expires_at+interval '7 days' then
    raise exception 'Offline checkout session is too old to synchronize safely';
  end if;

  v_items:=coalesce(p_payload->'items','[]'::jsonb);
  v_payment_method:=coalesce(p_payload->>'payment_method','');
  v_offline_created:=coalesce((p_payload->>'offline_created_at')::timestamptz,now());
  v_local_number:=trim(coalesce(p_payload->>'local_receipt_number',''));
  v_customer_id:=nullif(p_payload->>'customer_id','')::uuid;
  v_currency:=coalesce(nullif(p_payload->>'currency',''),'USD')::public.currency_code;
  v_amount_received:=coalesce((p_payload->>'amount_received')::numeric,0);
  v_reference:=nullif(trim(coalesce(p_payload->>'payment_reference','')), '');
  v_notes:=nullif(trim(coalesce(p_payload->>'notes','')), '');
  v_payload_hash:=encode(digest(p_payload::text,'sha256'),'hex');

  if jsonb_typeof(v_items)<>'array' or jsonb_array_length(v_items)<1 or jsonb_array_length(v_items)>100 then
    raise exception 'Offline sale must contain between 1 and 100 product lines';
  end if;
  if v_payment_method not in('cash','bank','khqr','card','other') then
    raise exception 'Credit and unsupported payment methods cannot synchronize from offline mode';
  end if;
  if v_local_number='' then raise exception 'Local receipt number is required'; end if;
  if v_offline_created<v_session.prepared_at-interval '5 minutes'
     or v_offline_created>least(now()+interval '10 minutes',v_session.expires_at+interval '7 days') then
    raise exception 'Offline sale time is outside the prepared session';
  end if;
  if coalesce(p_payload->>'coupon_code','')<>''
     or coalesce(p_payload->>'discount_type','none')<>'none'
     or coalesce((p_payload->>'discount_value')::numeric,0)<>0 then
    raise exception 'Coupons and manual discounts are online-only';
  end if;
  if p_payload ? 'source_sales_order_delivery_id' or p_payload ? 'source_quote_id' then
    raise exception 'Quotations and Sales Order deliveries are online-only';
  end if;
  if v_customer_id is not null and not exists(
    select 1 from jsonb_array_elements(v_session.catalog_snapshot->'customers') c
    where (c->>'id')::uuid=v_customer_id
  ) then
    raise exception 'Selected customer is not in the prepared offline snapshot';
  end if;

  insert into public.offline_sale_syncs(
    organization_id,branch_id,user_id,session_id,offline_sale_id,
    local_receipt_number,offline_created_at,payload,payload_hash,status,
    attempt_count,first_attempt_at,last_attempt_at
  ) values(
    v_org,v_branch,auth.uid(),v_session.id,p_offline_sale_id,
    v_local_number,v_offline_created,p_payload,v_payload_hash,'syncing',1,now(),now()
  ) returning * into v_sync;

  begin
    perform set_config('tiny_pos.offline_session_id',v_session.id::text,true);

    v_result:=public.complete_sale_v9(
      v_items,
      v_payment_method,
      v_amount_received,
      v_customer_id,
      'none',
      0,
      null,
      v_currency,
      concat_ws(' · ',v_notes,'Offline receipt '||v_local_number,
        'Created '||to_char(v_offline_created at time zone 'Asia/Phnom_Penh','YYYY-MM-DD HH24:MI')),
      coalesce(v_reference,v_local_number),
      p_offline_sale_id::text,
      null,
      null,
      null
    );

    v_sale_id:=(v_result->>'sale_id')::uuid;

    update public.offline_sale_syncs set
      status='synced',sale_id=v_sale_id,invoice_number=v_result->>'invoice_number',
      error_code=null,error_message=null,synced_at=now(),updated_at=now()
    where id=v_sync.id returning * into v_sync;

    update public.offline_checkout_sessions set last_sync_at=now(),updated_at=now()
    where id=v_session.id;

    insert into public.audit_logs(
      organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
    ) values(
      v_org,v_branch,auth.uid(),'sync_offline_sale','offline_sale_sync',v_sync.id,
      jsonb_build_object('offline_sale_id',p_offline_sale_id,'local_receipt_number',v_local_number,
        'sale_id',v_sale_id,'invoice_number',v_sync.invoice_number,
        'offline_created_at',v_offline_created)
    );

    return v_result||jsonb_build_object(
      'ok',true,'status','synced','offline_sale_id',p_offline_sale_id,
      'local_receipt_number',v_local_number,'offline_created_at',v_offline_created
    );
  exception when others then
    update public.offline_sale_syncs set
      status='conflict',error_code=sqlstate,error_message=sqlerrm,
      last_attempt_at=now(),updated_at=now()
    where id=v_sync.id returning * into v_sync;

    return jsonb_build_object(
      'ok',false,'status','conflict','offline_sale_id',p_offline_sale_id,
      'local_receipt_number',v_local_number,'error_code',sqlstate,'error_message',sqlerrm
    );
  end;
end;
$$;

revoke all on function public.sync_offline_sale(uuid,uuid,jsonb) from public,anon;
grant execute on function public.sync_offline_sale(uuid,uuid,jsonb) to authenticated,service_role;

create or replace function public.cancel_offline_sale_conflict(
  p_offline_sale_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_row public.offline_sale_syncs%rowtype;
begin
  perform private.require_permission('offline_checkout.manage');
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'A cancellation reason is required'; end if;

  select * into v_row from public.offline_sale_syncs
  where organization_id=private.current_organization_id()
    and offline_sale_id=p_offline_sale_id for update;
  if not found then raise exception 'Offline sale record not found'; end if;
  if v_row.status<>'conflict' then raise exception 'Only a conflict can be cancelled'; end if;

  update public.offline_sale_syncs set
    status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),
    cancel_reason=trim(p_reason),updated_at=now()
  where id=v_row.id returning * into v_row;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_row.organization_id,v_row.branch_id,auth.uid(),'cancel_offline_sale_conflict',
    'offline_sale_sync',v_row.id,jsonb_build_object(
      'offline_sale_id',v_row.offline_sale_id,
      'local_receipt_number',v_row.local_receipt_number,
      'reason',trim(p_reason)
    )
  );

  return jsonb_build_object('ok',true,'status','cancelled','offline_sale_id',v_row.offline_sale_id);
end;
$$;

revoke all on function public.cancel_offline_sale_conflict(uuid,text) from public,anon;
grant execute on function public.cancel_offline_sale_conflict(uuid,text) to authenticated,service_role;

create or replace function public.revoke_offline_checkout_session(
  p_session_id uuid,
  p_reason text default 'Revoked by manager'
) returns jsonb
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_row public.offline_checkout_sessions%rowtype;
begin
  perform private.require_permission('offline_checkout.manage');
  update public.offline_checkout_sessions set
    status='revoked',revoked_at=now(),revoked_by=auth.uid(),
    revoke_reason=coalesce(nullif(trim(p_reason),''),'Revoked by manager'),updated_at=now()
  where id=p_session_id and organization_id=private.current_organization_id()
    and status='active'
  returning * into v_row;
  if not found then raise exception 'Active offline session not found'; end if;
  return jsonb_build_object('ok',true,'session_id',v_row.id,'status',v_row.status);
end;
$$;

revoke all on function public.revoke_offline_checkout_session(uuid,text) from public,anon;
grant execute on function public.revoke_offline_checkout_session(uuid,text) to authenticated,service_role;

-- Expire sessions lazily whenever they are read or prepared.
create or replace function public.expire_offline_checkout_sessions()
returns integer language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_count integer;
begin
  update public.offline_checkout_sessions set status='expired',updated_at=now()
  where status='active' and expires_at<now();
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_offline_checkout_sessions() from public,anon;
grant execute on function public.expire_offline_checkout_sessions() to authenticated,service_role;

commit;
-- ============================================================================
-- END STEP 42
-- ============================================================================
