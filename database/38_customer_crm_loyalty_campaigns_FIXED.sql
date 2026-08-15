-- ============================================================================
-- Tiny POS - Step 43: Customer CRM, Loyalty Campaigns and Telegram Messaging
-- Run once in the NEW Supabase project after Step 42.
-- This migration preserves existing customers, sales, loyalty balances and bot links.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. CUSTOMER CRM AND CONSENT FIELDS
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists preferred_language text not null default 'en'
    check (preferred_language in ('en','km')),
  add column if not exists marketing_opt_in boolean not null default false,
  add column if not exists marketing_opt_in_at timestamptz,
  add column if not exists marketing_opt_out_at timestamptz,
  add column if not exists crm_status text not null default 'prospect'
    check (crm_status in ('prospect','active','at_risk','inactive','do_not_contact')),
  add column if not exists last_contacted_at timestamptz,
  add column if not exists next_follow_up_at timestamptz;

create table if not exists public.crm_tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.crm_customer_tags (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  tag_id uuid not null references public.crm_tags(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (customer_id, tag_id)
);

create table if not exists public.crm_segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  description text,
  rules jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.loyalty_program_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  started_at timestamptz not null default now(),
  usd_points_per_unit numeric(14,4) not null default 1 check (usd_points_per_unit >= 0),
  khr_points_per_1000 numeric(14,4) not null default 1 check (khr_points_per_1000 >= 0),
  award_on_tax boolean not null default false,
  award_on_discounted_total boolean not null default true,
  points_expire_after_days integer check (points_expire_after_days is null or points_expire_after_days >= 30),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.loyalty_program_settings (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. CUSTOMER TELEGRAM LINKS
-- ---------------------------------------------------------------------------

create table if not exists public.customer_telegram_link_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_telegram_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  telegram_user_id bigint not null,
  chat_id bigint not null,
  username text,
  first_name text,
  last_name text,
  language_code text,
  marketing_opt_in boolean not null default true,
  is_active boolean not null default true,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id),
  unique (organization_id, telegram_user_id)
);

-- ---------------------------------------------------------------------------
-- 3. CRM CONTACT LOGS AND CAMPAIGNS
-- ---------------------------------------------------------------------------

create table if not exists public.customer_contact_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  customer_id uuid not null references public.customers(id) on delete cascade,
  channel text not null check (channel in ('phone','telegram','email','visit','other')),
  direction text not null default 'outbound' check (direction in ('inbound','outbound')),
  subject text,
  note text not null,
  follow_up_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  segment_id uuid references public.crm_segments(id) on delete set null,
  name text not null,
  campaign_type text not null default 'message'
    check (campaign_type in ('message','coupon','bonus_points','mixed')),
  title_en text not null,
  title_km text,
  message_en text not null,
  message_km text,
  coupon_id uuid references public.coupons(id) on delete set null,
  bonus_points numeric(14,2) not null default 0 check (bonus_points >= 0),
  scheduled_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft','scheduled','sending','completed','cancelled')),
  recipient_count integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  launched_by uuid references auth.users(id) on delete set null,
  launched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.customer_campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  customer_telegram_link_id uuid references public.customer_telegram_links(id) on delete set null,
  chat_id bigint,
  language text not null default 'en' check (language in ('en','km')),
  status text not null default 'pending'
    check (status in ('pending','sent','failed','skipped')),
  telegram_message_id bigint,
  error_message text,
  loyalty_awarded_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, customer_id)
);

create index if not exists crm_customer_tags_tag_idx on public.crm_customer_tags(tag_id, customer_id);
create index if not exists crm_segments_org_active_idx on public.crm_segments(organization_id, is_active);
create index if not exists customer_telegram_links_chat_idx on public.customer_telegram_links(chat_id) where is_active;
create index if not exists customer_campaigns_due_idx on public.customer_campaigns(status, scheduled_at);
create index if not exists campaign_recipients_pending_idx on public.customer_campaign_recipients(campaign_id, status);
create index if not exists customer_contact_logs_customer_idx on public.customer_contact_logs(customer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. PERMISSIONS
-- ---------------------------------------------------------------------------

insert into public.permission_definitions (
  permission_key,
  module_key,
  label,
  description,
  risk_level,
  default_roles,
  approval_action,
  sort_order
) values
  (
    'crm.view',
    'Customers',
    'View CRM',
    'View customer lifecycle, tags, contact history and campaigns.',
    'normal',
    array['owner','admin','manager']::public.app_role[],
    false,
    415
  ),
  (
    'crm.manage',
    'Customers',
    'Manage CRM',
    'Manage tags, segments, follow-ups and loyalty settings.',
    'sensitive',
    array['owner','admin','manager']::public.app_role[],
    false,
    416
  ),
  (
    'crm.campaigns.send',
    'Customers',
    'Send Customer Campaigns',
    'Schedule and send Telegram customer campaigns.',
    'critical',
    array['owner','admin','manager']::public.app_role[],
    false,
    417
  )
on conflict (permission_key) do update set
  module_key = excluded.module_key,
  label = excluded.label,
  description = excluded.description,
  risk_level = excluded.risk_level,
  default_roles = excluded.default_roles,
  approval_action = excluded.approval_action,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------

alter table public.crm_tags enable row level security;
alter table public.crm_customer_tags enable row level security;
alter table public.crm_segments enable row level security;
alter table public.loyalty_program_settings enable row level security;
alter table public.customer_telegram_link_codes enable row level security;
alter table public.customer_telegram_links enable row level security;
alter table public.customer_contact_logs enable row level security;
alter table public.customer_campaigns enable row level security;
alter table public.customer_campaign_recipients enable row level security;

create or replace function private.crm_org_allowed(p_organization_id uuid, p_permission text)
returns boolean language sql stable security definer set search_path=public,private,auth,pg_temp as $$
  select auth.uid() is not null
    and p_organization_id = private.current_organization_id()
    and private.has_permission(p_permission, auth.uid());
$$;

revoke all on function private.crm_org_allowed(uuid,text) from public,anon;
grant execute on function private.crm_org_allowed(uuid,text) to authenticated,service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'crm_tags','crm_customer_tags','crm_segments','loyalty_program_settings',
    'customer_contact_logs','customer_campaigns','customer_campaign_recipients',
    'customer_telegram_link_codes','customer_telegram_links'
  ] loop
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.crm_org_allowed(organization_id,''crm.view''))', t||'_select', t);
  end loop;
end $$;

drop policy if exists crm_tags_write on public.crm_tags;
create policy crm_tags_write on public.crm_tags for all to authenticated
using (private.crm_org_allowed(organization_id,'crm.manage'))
with check (private.crm_org_allowed(organization_id,'crm.manage'));
drop policy if exists crm_customer_tags_write on public.crm_customer_tags;
create policy crm_customer_tags_write on public.crm_customer_tags for all to authenticated
using (private.crm_org_allowed(organization_id,'crm.manage'))
with check (private.crm_org_allowed(organization_id,'crm.manage'));
drop policy if exists crm_segments_write on public.crm_segments;
create policy crm_segments_write on public.crm_segments for all to authenticated
using (private.crm_org_allowed(organization_id,'crm.manage'))
with check (private.crm_org_allowed(organization_id,'crm.manage'));
drop policy if exists loyalty_settings_write on public.loyalty_program_settings;
create policy loyalty_settings_write on public.loyalty_program_settings for all to authenticated
using (private.crm_org_allowed(organization_id,'crm.manage'))
with check (private.crm_org_allowed(organization_id,'crm.manage'));
drop policy if exists contact_logs_write on public.customer_contact_logs;
create policy contact_logs_write on public.customer_contact_logs for all to authenticated
using (private.crm_org_allowed(organization_id,'crm.manage'))
with check (private.crm_org_allowed(organization_id,'crm.manage'));
drop policy if exists customer_campaigns_write on public.customer_campaigns;
create policy customer_campaigns_write on public.customer_campaigns for all to authenticated
using (private.crm_org_allowed(organization_id,'crm.campaigns.send'))
with check (private.crm_org_allowed(organization_id,'crm.campaigns.send'));

revoke all on public.crm_tags, public.crm_customer_tags, public.crm_segments,
  public.loyalty_program_settings, public.customer_telegram_link_codes,
  public.customer_telegram_links, public.customer_contact_logs,
  public.customer_campaigns, public.customer_campaign_recipients from anon;
grant select on public.crm_tags, public.crm_customer_tags, public.crm_segments,
  public.loyalty_program_settings, public.customer_telegram_link_codes,
  public.customer_telegram_links, public.customer_contact_logs,
  public.customer_campaigns, public.customer_campaign_recipients to authenticated;
grant insert,update,delete on public.crm_tags, public.crm_customer_tags, public.crm_segments,
  public.loyalty_program_settings, public.customer_contact_logs,
  public.customer_campaigns to authenticated;
grant all on public.crm_tags, public.crm_customer_tags, public.crm_segments,
  public.loyalty_program_settings, public.customer_telegram_link_codes,
  public.customer_telegram_links, public.customer_contact_logs,
  public.customer_campaigns, public.customer_campaign_recipients to service_role;

-- ---------------------------------------------------------------------------
-- 6. CRM DIRECTORY
-- ---------------------------------------------------------------------------

create or replace view public.crm_customer_directory
with (security_invoker=true) as
select
  c.*,
  coalesce(s.sale_count,0)::bigint as sale_count,
  coalesce(s.orders_90d,0)::bigint as orders_90d,
  coalesce(s.net_spent_365d,0)::numeric(14,2) as net_spent_365d,
  coalesce(cd.net_spent,0)::numeric(14,2) as lifetime_spend,
  cd.summary_currency,
  s.first_purchase_at,
  s.last_purchase_at,
  s.last_branch_id,
  case when s.last_purchase_at is null then null
       else greatest(0, floor(extract(epoch from (now()-s.last_purchase_at))/86400))::integer end as days_since_purchase,
  case
    when c.crm_status='do_not_contact' then 'do_not_contact'
    when s.last_purchase_at is null then 'prospect'
    when s.last_purchase_at >= now()-interval '30 days' then 'active'
    when s.last_purchase_at >= now()-interval '90 days' then 'at_risk'
    else 'inactive'
  end as lifecycle,
  exists(select 1 from public.customer_telegram_links ctl where ctl.customer_id=c.id and ctl.is_active) as telegram_connected,
  coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name)
            from public.crm_customer_tags ct join public.crm_tags t on t.id=ct.tag_id
            where ct.customer_id=c.id and t.is_active),'[]'::jsonb) as tags
from public.customers c
left join public.customer_directory cd on cd.id=c.id
left join lateral (
  select
    count(*) filter (where x.status in ('completed','partially_refunded','refunded')) as sale_count,
    count(*) filter (where coalesce(x.completed_at,x.created_at)>=now()-interval '90 days') as orders_90d,
    sum(case when coalesce(x.completed_at,x.created_at)>=now()-interval '365 days' then x.total_amount else 0 end) as net_spent_365d,
    min(coalesce(x.completed_at,x.created_at)) as first_purchase_at,
    max(coalesce(x.completed_at,x.created_at)) as last_purchase_at,
    (array_agg(x.branch_id order by coalesce(x.completed_at,x.created_at) desc))[1] as last_branch_id
  from public.sales x
  where x.organization_id=c.organization_id and x.customer_id=c.id
    and x.status in ('completed','partially_refunded','refunded')
) s on true;

revoke all on public.crm_customer_directory from anon;
grant select on public.crm_customer_directory to authenticated,service_role;

-- ---------------------------------------------------------------------------
-- 7. SECURE CRM FUNCTIONS
-- ---------------------------------------------------------------------------

create or replace function private.crm_require(p_permission text)
returns public.profiles language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v record;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v from public.profiles where id=auth.uid() and is_active;
  if not found then raise exception 'Active POS profile required'; end if;
  if not private.has_permission(p_permission,auth.uid()) then
    raise exception 'Permission required: %',p_permission;
  end if;
  return v;
end $$;

create or replace function public.get_crm_dashboard(p_branch_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v public.profiles%rowtype; r jsonb;
begin
  v:=private.crm_require('crm.view');
  select jsonb_build_object(
    'customers',count(*),
    'active',count(*) filter(where d.lifecycle='active'),
    'at_risk',count(*) filter(where d.lifecycle='at_risk'),
    'inactive',count(*) filter(where d.lifecycle='inactive'),
    'vip',count(*) filter(where d.customer_type='vip'),
    'telegram_linked',count(*) filter(where d.telegram_connected),
    'marketing_opt_in',count(*) filter(where d.marketing_opt_in and d.telegram_connected),
    'birthdays_this_month',count(*) filter(where extract(month from d.date_of_birth)=extract(month from current_date)),
    'loyalty_points',coalesce(sum(d.loyalty_points),0),
    'follow_ups_due',count(*) filter(where d.next_follow_up_at is not null and d.next_follow_up_at<=now())
  ) into r
  from public.crm_customer_directory d
  where d.organization_id=v.organization_id
    and (p_branch_id is null or d.last_branch_id=p_branch_id or exists(
      select 1 from public.sales s where s.customer_id=d.id and s.branch_id=p_branch_id));
  return r;
end $$;

create or replace function private.crm_rule_match(p_customer_id uuid,p_rules jsonb,p_branch_id uuid default null)
returns boolean language plpgsql stable security definer set search_path=public,private,pg_temp as $$
declare d public.crm_customer_directory%rowtype;
begin
  select * into d from public.crm_customer_directory where id=p_customer_id;
  if not found then return false; end if;
  if p_branch_id is not null and not exists(select 1 from public.sales s where s.customer_id=d.id and s.branch_id=p_branch_id) then return false; end if;
  if jsonb_array_length(coalesce(p_rules->'customer_types','[]'::jsonb))>0 and not (p_rules->'customer_types' ? d.customer_type) then return false; end if;
  if jsonb_array_length(coalesce(p_rules->'lifecycles','[]'::jsonb))>0 and not (p_rules->'lifecycles' ? d.lifecycle) then return false; end if;
  if coalesce((p_rules->>'min_lifetime_spend')::numeric,0)>coalesce(d.lifetime_spend,0) then return false; end if;
  if coalesce((p_rules->>'min_loyalty_points')::numeric,0)>coalesce(d.loyalty_points,0) then return false; end if;
  if p_rules ? 'inactive_days_min' and coalesce(d.days_since_purchase,999999)<(p_rules->>'inactive_days_min')::integer then return false; end if;
  if p_rules ? 'inactive_days_max' and coalesce(d.days_since_purchase,999999)>(p_rules->>'inactive_days_max')::integer then return false; end if;
  if p_rules ? 'birthday_month' and (d.date_of_birth is null or extract(month from d.date_of_birth)::integer<>(p_rules->>'birthday_month')::integer) then return false; end if;
  if coalesce((p_rules->>'marketing_opt_in')::boolean,false) and not d.marketing_opt_in then return false; end if;
  if jsonb_array_length(coalesce(p_rules->'tag_ids','[]'::jsonb))>0 and not exists(
    select 1 from public.crm_customer_tags ct
    where ct.customer_id=d.id and p_rules->'tag_ids' ? ct.tag_id::text) then return false; end if;
  return true;
end $$;

create or replace function public.preview_crm_segment(p_rules jsonb,p_branch_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v public.profiles%rowtype; r jsonb;
begin
  v:=private.crm_require('crm.view');
  select jsonb_build_object(
    'count',count(*),
    'telegram_eligible',count(*) filter(where d.marketing_opt_in and d.telegram_connected),
    'sample',coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'code',d.customer_code,'lifecycle',d.lifecycle,'phone',d.phone)) filter(where rn<=20),'[]'::jsonb)
  ) into r
  from (
    select d.*,row_number() over(order by d.name) rn
    from public.crm_customer_directory d
    where d.organization_id=v.organization_id and private.crm_rule_match(d.id,coalesce(p_rules,'{}'::jsonb),p_branch_id)
  ) d;
  return r;
end $$;

create or replace function public.create_customer_telegram_link_code(p_customer_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v public.profiles%rowtype; c public.customers%rowtype; raw text; h text; row_id uuid;
begin
  v:=private.crm_require('crm.manage');
  select * into c from public.customers where id=p_customer_id and organization_id=v.organization_id and is_active;
  if not found then raise exception 'Active customer not found'; end if;
  raw:=upper(encode(gen_random_bytes(4),'hex'));
  h:=encode(digest(raw,'sha256'),'hex');
  update public.customer_telegram_link_codes set used_at=now()
    where customer_id=c.id and used_at is null;
  insert into public.customer_telegram_link_codes(organization_id,customer_id,code_hash,expires_at,created_by)
  values(v.organization_id,c.id,h,now()+interval '10 minutes',auth.uid()) returning id into row_id;
  return jsonb_build_object('id',row_id,'code',raw,'expires_at',now()+interval '10 minutes','customer_id',c.id,'customer_name',c.name);
end $$;

create or replace function public.record_customer_contact(
  p_customer_id uuid,p_channel text,p_direction text,p_subject text,p_note text,p_follow_up_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v public.profiles%rowtype; row_id uuid;
begin
  v:=private.crm_require('crm.manage');
  if length(trim(coalesce(p_note,'')))<2 then raise exception 'Contact note is required'; end if;
  insert into public.customer_contact_logs(organization_id,branch_id,customer_id,channel,direction,subject,note,follow_up_at,created_by)
  select v.organization_id,v.branch_id,c.id,p_channel,p_direction,nullif(trim(p_subject),''),trim(p_note),p_follow_up_at,auth.uid()
  from public.customers c where c.id=p_customer_id and c.organization_id=v.organization_id
  returning id into row_id;
  if row_id is null then raise exception 'Customer not found'; end if;
  update public.customers set last_contacted_at=now(),next_follow_up_at=p_follow_up_at,updated_at=now() where id=p_customer_id;
  return jsonb_build_object('ok',true,'id',row_id);
end $$;

create or replace function public.save_loyalty_program_settings(p_values jsonb)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v public.profiles%rowtype; r public.loyalty_program_settings%rowtype;
begin
  v:=private.crm_require('crm.manage');
  insert into public.loyalty_program_settings(organization_id,enabled,usd_points_per_unit,khr_points_per_1000,award_on_tax,award_on_discounted_total,points_expire_after_days,updated_by,updated_at)
  values(v.organization_id,coalesce((p_values->>'enabled')::boolean,true),coalesce((p_values->>'usd_points_per_unit')::numeric,1),coalesce((p_values->>'khr_points_per_1000')::numeric,1),coalesce((p_values->>'award_on_tax')::boolean,false),coalesce((p_values->>'award_on_discounted_total')::boolean,true),nullif(p_values->>'points_expire_after_days','')::integer,auth.uid(),now())
  on conflict(organization_id) do update set enabled=excluded.enabled,usd_points_per_unit=excluded.usd_points_per_unit,khr_points_per_1000=excluded.khr_points_per_1000,award_on_tax=excluded.award_on_tax,award_on_discounted_total=excluded.award_on_discounted_total,points_expire_after_days=excluded.points_expire_after_days,updated_by=auth.uid(),updated_at=now()
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.save_customer_campaign(p_values jsonb)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v public.profiles%rowtype; r public.customer_campaigns%rowtype; cid uuid;
begin
  v:=private.crm_require('crm.campaigns.send');
  cid:=nullif(p_values->>'id','')::uuid;
  if cid is null then
    insert into public.customer_campaigns(organization_id,branch_id,segment_id,name,campaign_type,title_en,title_km,message_en,message_km,coupon_id,bonus_points,scheduled_at,status,created_by)
    values(v.organization_id,nullif(p_values->>'branch_id','')::uuid,nullif(p_values->>'segment_id','')::uuid,trim(p_values->>'name'),coalesce(nullif(p_values->>'campaign_type',''),'message'),trim(p_values->>'title_en'),nullif(trim(p_values->>'title_km'),''),trim(p_values->>'message_en'),nullif(trim(p_values->>'message_km'),''),nullif(p_values->>'coupon_id','')::uuid,coalesce((p_values->>'bonus_points')::numeric,0),nullif(p_values->>'scheduled_at','')::timestamptz,coalesce(nullif(p_values->>'status',''),'draft'),auth.uid()) returning * into r;
  else
    update public.customer_campaigns set branch_id=nullif(p_values->>'branch_id','')::uuid,segment_id=nullif(p_values->>'segment_id','')::uuid,name=trim(p_values->>'name'),campaign_type=coalesce(nullif(p_values->>'campaign_type',''),'message'),title_en=trim(p_values->>'title_en'),title_km=nullif(trim(p_values->>'title_km'),''),message_en=trim(p_values->>'message_en'),message_km=nullif(trim(p_values->>'message_km'),''),coupon_id=nullif(p_values->>'coupon_id','')::uuid,bonus_points=coalesce((p_values->>'bonus_points')::numeric,0),scheduled_at=nullif(p_values->>'scheduled_at','')::timestamptz,status=coalesce(nullif(p_values->>'status',''),status),updated_at=now()
    where id=cid and organization_id=v.organization_id and status in('draft','scheduled') returning * into r;
  end if;
  if r.id is null then raise exception 'Campaign not found or cannot be edited'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.prepare_customer_campaign_recipients(p_campaign_id uuid)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare camp public.customer_campaigns%rowtype; rules jsonb:='{}'::jsonb; added integer;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then
    perform private.crm_require('crm.campaigns.send');
  end if;
  select * into camp from public.customer_campaigns where id=p_campaign_id for update;
  if not found then raise exception 'Campaign not found'; end if;
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' and camp.organization_id<>private.current_organization_id() then
    raise exception 'Campaign not found';
  end if;
  if camp.segment_id is not null then select s.rules into rules from public.crm_segments s where s.id=camp.segment_id; end if;
  insert into public.customer_campaign_recipients(organization_id,campaign_id,customer_id,customer_telegram_link_id,chat_id,language)
  select camp.organization_id,camp.id,c.id,l.id,l.chat_id,case when c.preferred_language='km' then 'km' else 'en' end
  from public.customers c join public.customer_telegram_links l on l.customer_id=c.id and l.is_active and l.marketing_opt_in
  where c.organization_id=camp.organization_id and c.is_active and c.marketing_opt_in and c.crm_status<>'do_not_contact'
    and private.crm_rule_match(c.id,coalesce(rules,'{}'::jsonb),camp.branch_id)
  on conflict(campaign_id,customer_id) do nothing;
  get diagnostics added=row_count;
  update public.customer_campaigns set status='sending',launched_at=coalesce(launched_at,now()),recipient_count=(select count(*) from public.customer_campaign_recipients where campaign_id=camp.id),updated_at=now() where id=camp.id;
  return jsonb_build_object('ok',true,'added',added,'total',(select count(*) from public.customer_campaign_recipients where campaign_id=camp.id));
end $$;

create or replace function private.apply_loyalty_delta(p_org uuid,p_customer uuid,p_delta numeric,p_reason text,p_table text,p_id uuid,p_actor uuid default null)
returns numeric language plpgsql security definer set search_path=public,pg_temp as $$
declare before_points numeric; after_points numeric;
begin
  select loyalty_points into before_points from public.customers where id=p_customer and organization_id=p_org for update;
  if not found or p_delta=0 then return coalesce(before_points,0); end if;
  after_points:=greatest(0,round(coalesce(before_points,0)+p_delta,2));
  if after_points=before_points then return after_points; end if;
  update public.customers set loyalty_points=after_points,updated_at=now() where id=p_customer;
  insert into public.customer_loyalty_movements(organization_id,customer_id,points_change,points_before,points_after,reason,reference_table,reference_id,created_by)
  values(p_org,p_customer,after_points-before_points,before_points,after_points,p_reason,p_table,p_id,coalesce(p_actor,(select created_by from public.customers where id=p_customer),(select id from public.profiles where organization_id=p_org and role='owner' and is_active order by created_at limit 1)));
  return after_points;
end $$;

create or replace function public.mark_customer_campaign_recipient(
  p_recipient_id uuid,p_status text,p_message_id bigint default null,p_error text default null
) returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare rec public.customer_campaign_recipients%rowtype; camp public.customer_campaigns%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'Service role required'; end if;
  select * into rec from public.customer_campaign_recipients where id=p_recipient_id for update;
  if not found then raise exception 'Recipient not found'; end if;
  select * into camp from public.customer_campaigns where id=rec.campaign_id;
  update public.customer_campaign_recipients set status=p_status,telegram_message_id=p_message_id,error_message=nullif(p_error,''),sent_at=case when p_status='sent' then now() else sent_at end,updated_at=now() where id=rec.id;
  if p_status='sent' and camp.bonus_points>0 and rec.loyalty_awarded_at is null then
    perform private.apply_loyalty_delta(rec.organization_id,rec.customer_id,camp.bonus_points,'Campaign bonus: '||camp.name,'customer_campaign',camp.id,camp.created_by);
    update public.customer_campaign_recipients set loyalty_awarded_at=now() where id=rec.id;
  end if;
  update public.customer_campaigns set sent_count=(select count(*) from public.customer_campaign_recipients where campaign_id=camp.id and status='sent'),failed_count=(select count(*) from public.customer_campaign_recipients where campaign_id=camp.id and status='failed'),updated_at=now() where id=camp.id;
  if not exists(select 1 from public.customer_campaign_recipients where campaign_id=camp.id and status='pending') then
    update public.customer_campaigns set status='completed',completed_at=now(),updated_at=now() where id=camp.id;
  end if;
  return jsonb_build_object('ok',true);
end $$;

-- Automatic loyalty earning and return reversal.
create or replace function private.crm_award_sale_loyalty()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare cfg public.loyalty_program_settings%rowtype; basis numeric; points numeric;
begin
  if new.customer_id is null or new.status not in('completed','partially_refunded','refunded') then return new; end if;
  if exists(select 1 from public.customer_loyalty_movements where reference_table='sale' and reference_id=new.id) then return new; end if;
  select * into cfg from public.loyalty_program_settings where organization_id=new.organization_id;
  if not found or not cfg.enabled then return new; end if;
  if coalesce(new.completed_at,new.created_at)<cfg.started_at then return new; end if;
  basis:=case when cfg.award_on_discounted_total then new.total_amount else new.subtotal end;
  if not cfg.award_on_tax then basis:=greatest(0,basis-coalesce(new.tax_amount,0)); end if;
  points:=case when new.currency='KHR' then floor(basis/1000*cfg.khr_points_per_1000) else floor(basis*cfg.usd_points_per_unit) end;
  if points>0 then perform private.apply_loyalty_delta(new.organization_id,new.customer_id,points,'Automatic points from '||new.invoice_number,'sale',new.id,new.created_by); end if;
  return new;
end $$;

drop trigger if exists crm_award_sale_loyalty on public.sales;
create trigger crm_award_sale_loyalty after insert or update of status on public.sales
for each row execute function private.crm_award_sale_loyalty();

create or replace function private.crm_reverse_return_loyalty()
returns trigger language plpgsql security definer set search_path=public,private,pg_temp as $$
declare earned numeric; sale_total numeric; reverse_points numeric;
begin
  if new.status<>'completed' or new.customer_id is null then return new; end if;
  if exists(select 1 from public.customer_loyalty_movements where reference_table='return' and reference_id=new.id) then return new; end if;
  select coalesce(sum(points_change),0) into earned from public.customer_loyalty_movements where reference_table='sale' and reference_id=new.original_sale_id and points_change>0;
  select total_amount into sale_total from public.sales where id=new.original_sale_id;
  if earned>0 and sale_total>0 then
    reverse_points:=-least(earned,ceil(earned*new.refund_amount/sale_total));
    perform private.apply_loyalty_delta(new.organization_id,new.customer_id,reverse_points,'Points reversal for '||new.return_number,'return',new.id,new.processed_by);
  end if;
  return new;
end $$;

drop trigger if exists crm_reverse_return_loyalty on public.returns;
create trigger crm_reverse_return_loyalty after insert or update of status on public.returns
for each row execute function private.crm_reverse_return_loyalty();

-- Grants
revoke all on function public.get_crm_dashboard(uuid),public.preview_crm_segment(jsonb,uuid),public.create_customer_telegram_link_code(uuid),public.record_customer_contact(uuid,text,text,text,text,timestamptz),public.save_loyalty_program_settings(jsonb),public.save_customer_campaign(jsonb),public.prepare_customer_campaign_recipients(uuid),public.mark_customer_campaign_recipient(uuid,text,bigint,text) from public,anon;
grant execute on function public.get_crm_dashboard(uuid),public.preview_crm_segment(jsonb,uuid),public.create_customer_telegram_link_code(uuid),public.record_customer_contact(uuid,text,text,text,text,timestamptz),public.save_loyalty_program_settings(jsonb),public.save_customer_campaign(jsonb),public.prepare_customer_campaign_recipients(uuid) to authenticated,service_role;
grant execute on function public.mark_customer_campaign_recipient(uuid,text,bigint,text) to service_role;

insert into public.audit_logs(organization_id,user_id,action,entity_type,new_data)
select organization_id,auth.uid(),'install_step_43_crm','system',jsonb_build_object('schema_step',43)
from public.profiles where id=auth.uid();

commit;
