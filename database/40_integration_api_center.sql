-- ============================================================================
-- Tiny POS - Step 45: Integration and API Center
-- Run once in the NEW Supabase project after Step 44.
-- Existing sales, stock, customers, purchases and accounting data are preserved.
-- ============================================================================

begin;
create extension if not exists pgcrypto;

insert into public.permission_definitions (
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
) values
  ('integrations.view','Administration','View Integration Center',
   'View API clients, webhook endpoints, delivery history and integration documentation.',
   'sensitive',array['owner','admin']::public.app_role[],false,119),
  ('integrations.manage','Administration','Manage Integrations',
   'Manage integration configuration and retry failed deliveries.',
   'critical',array['owner','admin']::public.app_role[],false,120),
  ('integrations.keys.manage','Administration','Manage API Keys',
   'Create, rotate, disable and revoke external API credentials.',
   'critical',array['owner','admin']::public.app_role[],false,121),
  ('integrations.webhooks.manage','Administration','Manage Webhooks',
   'Create signed outgoing webhook endpoints and manage delivery retries.',
   'critical',array['owner','admin']::public.app_role[],false,122)
on conflict (permission_key) do update set
  module_key=excluded.module_key,label=excluded.label,description=excluded.description,
  risk_level=excluded.risk_level,default_roles=excluded.default_roles,
  approval_action=excluded.approval_action,sort_order=excluded.sort_order,
  is_active=true,updated_at=now();

create table if not exists public.integration_api_clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check(length(trim(name)) between 2 and 120),
  description text,
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default '{}'::text[],
  branch_ids uuid[] not null default '{}'::uuid[],
  allowed_origins text[] not null default '{}'::text[],
  rate_limit_per_minute integer not null default 60 check(rate_limit_per_minute between 1 and 600),
  is_active boolean not null default true,
  expires_at timestamptz,
  last_used_at timestamptz,
  last_request_path text,
  request_count bigint not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,key_prefix),
  check(cardinality(scopes)>0),
  check(expires_at is null or expires_at>created_at)
);
create index if not exists integration_api_clients_org_active_idx
  on public.integration_api_clients(organization_id,is_active,created_at desc);

create table if not exists public.integration_api_rate_windows (
  client_id uuid not null references public.integration_api_clients(id) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check(request_count>=0),
  updated_at timestamptz not null default now(),
  primary key(client_id,window_started_at)
);

create table if not exists public.integration_api_request_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.integration_api_clients(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  request_id text not null,
  method text not null,
  request_path text not null,
  status_code integer,
  duration_ms integer,
  response_count integer,
  ip_hash text,
  origin text,
  user_agent text,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(client_id,request_id)
);
create index if not exists integration_api_request_logs_org_created_idx
  on public.integration_api_request_logs(organization_id,created_at desc);
create index if not exists integration_api_request_logs_client_created_idx
  on public.integration_api_request_logs(client_id,created_at desc);

create table if not exists public.integration_external_references (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.integration_api_clients(id) on delete cascade,
  entity_type text not null check(entity_type in('customer','online_order')),
  external_id text not null check(length(trim(external_id)) between 1 and 200),
  internal_id uuid not null,
  payload_hash text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(client_id,entity_type,external_id)
);
create index if not exists integration_external_refs_internal_idx
  on public.integration_external_references(organization_id,entity_type,internal_id);

create table if not exists public.integration_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check(length(trim(name)) between 2 and 120),
  description text,
  endpoint_url text not null check(endpoint_url ~ '^https://'),
  event_types text[] not null default '{}'::text[],
  branch_ids uuid[] not null default '{}'::uuid[],
  is_active boolean not null default true,
  timeout_seconds integer not null default 10 check(timeout_seconds between 3 and 30),
  max_attempts integer not null default 8 check(max_attempts between 1 and 12),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(cardinality(event_types)>0)
);
create index if not exists integration_webhooks_org_active_idx
  on public.integration_webhook_endpoints(organization_id,is_active,created_at desc);

create table if not exists public.integration_webhook_secrets (
  endpoint_id uuid primary key references public.integration_webhook_endpoints(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  signing_secret text not null,
  rotated_at timestamptz not null default now()
);

create table if not exists public.integration_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  event_type text not null,
  object_type text not null,
  object_id uuid,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  expanded_at timestamptz
);
create index if not exists integration_events_unexpanded_idx on public.integration_events(occurred_at) where expanded_at is null;
create index if not exists integration_events_org_created_idx on public.integration_events(organization_id,occurred_at desc);

create table if not exists public.integration_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  endpoint_id uuid not null references public.integration_webhook_endpoints(id) on delete cascade,
  event_id uuid not null references public.integration_events(id) on delete cascade,
  status text not null default 'pending' check(status in('pending','delivering','retry','succeeded','dead')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  response_status integer,
  response_excerpt text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(endpoint_id,event_id)
);
create index if not exists integration_webhook_due_idx on public.integration_webhook_deliveries(next_attempt_at,created_at) where status in('pending','retry');
create index if not exists integration_webhook_org_created_idx on public.integration_webhook_deliveries(organization_id,created_at desc);

create table if not exists public.integration_webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  delivery_id uuid not null references public.integration_webhook_deliveries(id) on delete cascade,
  attempt_number integer not null check(attempt_number>0),
  status_code integer,
  duration_ms integer,
  response_excerpt text,
  error_message text,
  attempted_at timestamptz not null default now(),
  unique(delivery_id,attempt_number)
);
create index if not exists integration_webhook_attempts_delivery_idx on public.integration_webhook_attempts(delivery_id,attempted_at desc);

alter table public.telegram_notification_preferences
  add column if not exists integration_alerts boolean not null default true;

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
  if v_all and v_profile.role not in('owner','admin') then raise exception 'Only owners and admins can receive all-branch alerts'; end if;
  update public.telegram_notification_preferences set
    stock_alerts=coalesce((p_preferences->>'stock_alerts')::boolean,stock_alerts),
    forecast_alerts=coalesce((p_preferences->>'forecast_alerts')::boolean,forecast_alerts),
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
    integration_alerts=coalesce((p_preferences->>'integration_alerts')::boolean,integration_alerts),
    system_alerts=coalesce((p_preferences->>'system_alerts')::boolean,system_alerts),
    all_branches=v_all,
    daily_summary_hour=greatest(0,least(23,coalesce((p_preferences->>'daily_summary_hour')::integer,daily_summary_hour))),
    quiet_start_hour=case when p_preferences?'quiet_start_hour' and nullif(p_preferences->>'quiet_start_hour','') is not null then greatest(0,least(23,(p_preferences->>'quiet_start_hour')::integer)) else null end,
    quiet_end_hour=case when p_preferences?'quiet_end_hour' and nullif(p_preferences->>'quiet_end_hour','') is not null then greatest(0,least(23,(p_preferences->>'quiet_end_hour')::integer)) else null end,
    updated_by=v_user_id,updated_at=now()
  where user_id=v_user_id returning * into v_result;
  return to_jsonb(v_result);
end; $$;
revoke all on function public.save_my_telegram_preferences(jsonb) from public,anon;
grant execute on function public.save_my_telegram_preferences(jsonb) to authenticated;

drop trigger if exists set_integration_api_clients_updated_at on public.integration_api_clients;
create trigger set_integration_api_clients_updated_at before update on public.integration_api_clients for each row execute function public.set_updated_at();
drop trigger if exists set_integration_webhook_endpoints_updated_at on public.integration_webhook_endpoints;
create trigger set_integration_webhook_endpoints_updated_at before update on public.integration_webhook_endpoints for each row execute function public.set_updated_at();
drop trigger if exists set_integration_webhook_deliveries_updated_at on public.integration_webhook_deliveries;
create trigger set_integration_webhook_deliveries_updated_at before update on public.integration_webhook_deliveries for each row execute function public.set_updated_at();

alter table public.integration_api_clients enable row level security;
alter table public.integration_api_rate_windows enable row level security;
alter table public.integration_api_request_logs enable row level security;
alter table public.integration_external_references enable row level security;
alter table public.integration_webhook_endpoints enable row level security;
alter table public.integration_webhook_secrets enable row level security;
alter table public.integration_events enable row level security;
alter table public.integration_webhook_deliveries enable row level security;
alter table public.integration_webhook_attempts enable row level security;

revoke all on public.integration_api_clients,public.integration_api_rate_windows,
 public.integration_api_request_logs,public.integration_external_references,
 public.integration_webhook_endpoints,public.integration_webhook_secrets,
 public.integration_events,public.integration_webhook_deliveries,
 public.integration_webhook_attempts from anon,authenticated;
grant all on public.integration_api_clients,public.integration_api_rate_windows,
 public.integration_api_request_logs,public.integration_external_references,
 public.integration_webhook_endpoints,public.integration_webhook_secrets,
 public.integration_events,public.integration_webhook_deliveries,
 public.integration_webhook_attempts to service_role;

create or replace function public.integration_consume_api_key(
 p_key_hash text,p_request_id text,p_method text,p_request_path text,
 p_ip_hash text default null,p_origin text default null,p_user_agent text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
 v_client public.integration_api_clients%rowtype;
 v_window timestamptz:=date_trunc('minute',clock_timestamp());
 v_count integer; v_log_id uuid; v_origin text:=nullif(trim(coalesce(p_origin,'')),'');
begin
 select * into v_client from public.integration_api_clients where key_hash=p_key_hash for update;
 if not found then return jsonb_build_object('ok',false,'error','invalid_api_key'); end if;
 if not v_client.is_active or v_client.revoked_at is not null then return jsonb_build_object('ok',false,'error','api_key_disabled'); end if;
 if v_client.expires_at is not null and v_client.expires_at<=now() then return jsonb_build_object('ok',false,'error','api_key_expired'); end if;
 if v_origin is not null and (cardinality(v_client.allowed_origins)=0 or not(v_origin=any(v_client.allowed_origins))) then
   return jsonb_build_object('ok',false,'error','origin_not_allowed');
 end if;
 insert into public.integration_api_rate_windows(client_id,window_started_at,request_count,updated_at)
 values(v_client.id,v_window,1,now()) on conflict(client_id,window_started_at) do update set
 request_count=public.integration_api_rate_windows.request_count+1,updated_at=now()
 returning request_count into v_count;
 insert into public.integration_api_request_logs(organization_id,client_id,request_id,method,request_path,ip_hash,origin,user_agent,status_code,error_message)
 values(v_client.organization_id,v_client.id,left(coalesce(p_request_id,gen_random_uuid()::text),120),upper(left(coalesce(p_method,'GET'),12)),left(coalesce(p_request_path,'/'),500),
 nullif(left(coalesce(p_ip_hash,''),128),''),nullif(left(coalesce(v_origin,''),500),''),nullif(left(coalesce(p_user_agent,''),500),''),
 case when v_count>v_client.rate_limit_per_minute then 429 else null end,
 case when v_count>v_client.rate_limit_per_minute then 'Rate limit exceeded.' else null end)
 returning id into v_log_id;
 update public.integration_api_clients set last_used_at=now(),last_request_path=left(coalesce(p_request_path,'/'),500),request_count=request_count+1 where id=v_client.id;
 if v_count>v_client.rate_limit_per_minute then return jsonb_build_object('ok',false,'error','rate_limit_exceeded','request_log_id',v_log_id,'retry_after_seconds',60-extract(second from clock_timestamp())::integer); end if;
 return jsonb_build_object('ok',true,'request_log_id',v_log_id,'client_id',v_client.id,'organization_id',v_client.organization_id,
 'client_name',v_client.name,'scopes',to_jsonb(v_client.scopes),'branch_ids',to_jsonb(v_client.branch_ids),
 'allowed_origins',to_jsonb(v_client.allowed_origins),'rate_limit_per_minute',v_client.rate_limit_per_minute);
end; $$;
revoke all on function public.integration_consume_api_key(text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.integration_consume_api_key(text,text,text,text,text,text,text) to service_role;

create or replace function public.integration_finish_api_request(
 p_log_id uuid,p_status_code integer,p_duration_ms integer,p_response_count integer default null,
 p_branch_id uuid default null,p_error_message text default null
) returns void language sql security definer set search_path=public,private,auth,pg_temp as $$
 update public.integration_api_request_logs set status_code=p_status_code,duration_ms=greatest(0,coalesce(p_duration_ms,0)),
 response_count=p_response_count,branch_id=p_branch_id,error_message=nullif(left(coalesce(p_error_message,''),1000),''),completed_at=now()
 where id=p_log_id;
$$;
revoke all on function public.integration_finish_api_request(uuid,integer,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.integration_finish_api_request(uuid,integer,integer,integer,uuid,text) to service_role;

create or replace function private.capture_integration_event()
returns trigger language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare
 v_new jsonb:=case when tg_op<>'DELETE' then to_jsonb(new) else '{}'::jsonb end;
 v_old jsonb:=case when tg_op<>'INSERT' then to_jsonb(old) else '{}'::jsonb end;
 v_row jsonb:=case when tg_op='DELETE' then v_old else v_new end;
 v_org uuid; v_branch uuid; v_object_id uuid; v_event_type text; v_payload jsonb;
begin
 if current_setting('tiny_pos.suppress_integration_events',true)='on' then return case when tg_op='DELETE' then old else new end; end if;
 v_org:=nullif(v_row->>'organization_id','')::uuid; v_branch:=nullif(v_row->>'branch_id','')::uuid; v_object_id:=nullif(v_row->>'id','')::uuid;
 if v_org is null then return case when tg_op='DELETE' then old else new end; end if;
 case tg_table_name
  when 'products' then v_event_type:=case when tg_op='INSERT' then 'product.created' else 'product.updated' end;
   v_payload:=jsonb_strip_nulls(jsonb_build_object('id',v_row->'id','name',v_row->'name','name_km',v_row->'name_km','sku',v_row->'sku','barcode',v_row->'barcode','currency',v_row->'currency','selling_price',v_row->'selling_price','track_stock',v_row->'track_stock','is_active',v_row->'is_active','updated_at',v_row->'updated_at'));
  when 'inventory_balances' then
   if tg_op='UPDATE' and coalesce(v_new->>'quantity','0')=coalesce(v_old->>'quantity','0') then return new; end if;
   v_event_type:='inventory.changed'; v_payload:=jsonb_strip_nulls(jsonb_build_object('id',v_row->'id','branch_id',v_row->'branch_id','product_id',v_row->'product_id','quantity',v_row->'quantity','updated_at',v_row->'updated_at'));
  when 'customers' then v_event_type:=case when tg_op='INSERT' then 'customer.created' else 'customer.updated' end;
   v_payload:=jsonb_strip_nulls(jsonb_build_object('id',v_row->'id','customer_code',v_row->'customer_code','name',v_row->'name','phone',v_row->'phone','email',v_row->'email','customer_type',v_row->'customer_type','crm_status',v_row->'crm_status','is_active',v_row->'is_active','updated_at',v_row->'updated_at'));
  when 'sales' then
   if tg_op='INSERT' and coalesce(v_new->>'status','')='completed' then v_event_type:='sale.completed';
   elsif tg_op='UPDATE' and coalesce(v_old->>'status','')<>coalesce(v_new->>'status','') and coalesce(v_new->>'status','')='completed' then v_event_type:='sale.completed';
   elsif tg_op='UPDATE' and coalesce(v_old->>'status','')<>coalesce(v_new->>'status','') and coalesce(v_new->>'status','')='voided' then v_event_type:='sale.voided';
   else return case when tg_op='DELETE' then old else new end; end if;
   v_payload:=jsonb_strip_nulls(jsonb_build_object('id',v_row->'id','branch_id',v_row->'branch_id','invoice_number',v_row->'invoice_number','customer_id',v_row->'customer_id','status',v_row->'status','payment_status',v_row->'payment_status','currency',v_row->'currency','subtotal',v_row->'subtotal','discount_amount',v_row->'discount_amount','tax_amount',v_row->'tax_amount','total_amount',v_row->'total_amount','paid_amount',v_row->'paid_amount','completed_at',v_row->'completed_at','updated_at',v_row->'updated_at'));
  when 'returns' then
   if coalesce(v_new->>'status','')<>'completed' or (tg_op='UPDATE' and coalesce(v_old->>'status','')='completed') then return new; end if;
   v_event_type:='return.completed'; v_payload:=v_row-array['notes','reason_detail'];
  when 'online_orders' then v_event_type:=case when tg_op='INSERT' then 'online_order.created' else 'online_order.updated' end;
   v_payload:=v_row-array['tracking_token_hash','source_ip_hash','user_agent'];
  when 'sales_orders' then
   if tg_op='UPDATE' and coalesce(v_old->>'status','')=coalesce(v_new->>'status','') then return new; end if;
   v_event_type:='sales_order.updated'; v_payload:=v_row;
  when 'purchase_receipts' then v_event_type:='purchase.received'; v_payload:=v_row;
  else return case when tg_op='DELETE' then old else new end;
 end case;
 insert into public.integration_events(organization_id,branch_id,event_type,object_type,object_id,payload,occurred_at)
 values(v_org,v_branch,v_event_type,tg_table_name,v_object_id,coalesce(v_payload,'{}'::jsonb),now());
 return case when tg_op='DELETE' then old else new end;
end; $$;
revoke all on function private.capture_integration_event() from public;
grant execute on function private.capture_integration_event() to service_role;

drop trigger if exists integration_event_products on public.products;
create trigger integration_event_products after insert or update on public.products for each row execute function private.capture_integration_event();
drop trigger if exists integration_event_inventory on public.inventory_balances;
create trigger integration_event_inventory after insert or update on public.inventory_balances for each row execute function private.capture_integration_event();
drop trigger if exists integration_event_customers on public.customers;
create trigger integration_event_customers after insert or update on public.customers for each row execute function private.capture_integration_event();
drop trigger if exists integration_event_sales on public.sales;
create trigger integration_event_sales after insert or update on public.sales for each row execute function private.capture_integration_event();
drop trigger if exists integration_event_returns on public.returns;
create trigger integration_event_returns after insert or update on public.returns for each row execute function private.capture_integration_event();
drop trigger if exists integration_event_online_orders on public.online_orders;
create trigger integration_event_online_orders after insert or update on public.online_orders for each row execute function private.capture_integration_event();
drop trigger if exists integration_event_sales_orders on public.sales_orders;
create trigger integration_event_sales_orders after insert or update on public.sales_orders for each row execute function private.capture_integration_event();
drop trigger if exists integration_event_purchase_receipts on public.purchase_receipts;
create trigger integration_event_purchase_receipts after insert on public.purchase_receipts for each row execute function private.capture_integration_event();

insert into public.audit_logs(organization_id,user_id,action,entity_type,new_data)
select organization_id,auth.uid(),'install_step_45_integrations','system',jsonb_build_object('schema_step',45)
from public.profiles where id=auth.uid() on conflict do nothing;

commit;
-- ============================================================================
-- END STEP 45
-- ============================================================================
