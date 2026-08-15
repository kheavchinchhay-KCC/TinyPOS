-- ============================================================================
-- Tiny POS - Step 46.4.5: Telegram identity isolation, role alerts, leave flow,
-- attendance mobile/report recovery
-- Run once after migration 46. Do not rerun migrations 01-46.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Permissions and personal Telegram preferences
-- ---------------------------------------------------------------------------

insert into public.permission_definitions (
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
)
values
  ('leave.request','Staff','Request Leave',
   'Submit and track personal leave requests.',
   'normal',array['owner','admin','manager','cashier','viewer']::public.app_role[],false,275),
  ('leave.manage','Staff','Approve Leave',
   'Review and approve or reject staff leave requests for accessible branches.',
   'sensitive',array['owner','admin','manager']::public.app_role[],false,276)
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

alter table public.telegram_notification_preferences
  add column if not exists sale_alerts boolean not null default true,
  add column if not exists leave_alerts boolean not null default true;

create or replace function public.save_my_telegram_preferences(p_preferences jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
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
    forecast_alerts=coalesce((p_preferences->>'forecast_alerts')::boolean,forecast_alerts),
    sale_alerts=coalesce((p_preferences->>'sale_alerts')::boolean,sale_alerts),
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
    leave_alerts=coalesce((p_preferences->>'leave_alerts')::boolean,leave_alerts),
    payroll_alerts=coalesce((p_preferences->>'payroll_alerts')::boolean,payroll_alerts),
    integration_alerts=coalesce((p_preferences->>'integration_alerts')::boolean,integration_alerts),
    system_alerts=coalesce((p_preferences->>'system_alerts')::boolean,system_alerts),
    all_branches=v_all,
    daily_summary_hour=greatest(0,least(23,coalesce((p_preferences->>'daily_summary_hour')::integer,daily_summary_hour))),
    quiet_start_hour=case
      when p_preferences?'quiet_start_hour' and nullif(p_preferences->>'quiet_start_hour','') is not null
      then greatest(0,least(23,(p_preferences->>'quiet_start_hour')::integer))
      else null
    end,
    quiet_end_hour=case
      when p_preferences?'quiet_end_hour' and nullif(p_preferences->>'quiet_end_hour','') is not null
      then greatest(0,least(23,(p_preferences->>'quiet_end_hour')::integer))
      else null
    end,
    updated_by=v_user_id,
    updated_at=now()
  where user_id=v_user_id
  returning * into v_result;

  return to_jsonb(v_result);
end;
$$;

revoke all on function public.save_my_telegram_preferences(jsonb) from public,anon;
grant execute on function public.save_my_telegram_preferences(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Leave requests. Day-off scheduling remains a separate attendance override.
-- ---------------------------------------------------------------------------

create table if not exists public.staff_leave_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  date_from date not null,
  date_to date not null,
  leave_type text not null default 'personal'
    check(leave_type in('annual','sick','personal','unpaid','other')),
  reason text not null check(length(trim(reason)) between 2 and 2000),
  image_url text,
  image_public_id text,
  status text not null default 'pending'
    check(status in('pending','approved','rejected','cancelled')),
  review_note text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(date_to>=date_from),
  check(date_to-date_from<=90)
);

create index if not exists staff_leave_requests_user_date_idx
  on public.staff_leave_requests(organization_id,user_id,date_from desc,status);
create index if not exists staff_leave_requests_branch_status_idx
  on public.staff_leave_requests(organization_id,branch_id,status,created_at desc);

drop trigger if exists set_staff_leave_requests_updated_at on public.staff_leave_requests;
create trigger set_staff_leave_requests_updated_at
before update on public.staff_leave_requests
for each row execute function public.set_updated_at();

alter table public.staff_attendance_day_overrides
  add column if not exists leave_request_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='staff_attendance_override_leave_request_fk'
  ) then
    alter table public.staff_attendance_day_overrides
      add constraint staff_attendance_override_leave_request_fk
      foreign key(leave_request_id)
      references public.staff_leave_requests(id)
      on delete set null;
  end if;
end;
$$;

alter table public.staff_leave_requests enable row level security;

drop policy if exists staff_leave_requests_read on public.staff_leave_requests;
create policy staff_leave_requests_read
on public.staff_leave_requests
for select to authenticated
using (
  organization_id=(select private.current_organization_id())
  and (
    user_id=(select auth.uid())
    or (
      (select private.has_permission('leave.manage',auth.uid()))
      and (select private.staff_branch_allowed(branch_id))
    )
  )
);

revoke all on public.staff_leave_requests from anon;
grant select on public.staff_leave_requests to authenticated;
grant all on public.staff_leave_requests to service_role;

create or replace function private.create_staff_leave_request(
  p_user_id uuid,
  p_date_from date,
  p_date_to date,
  p_leave_type text,
  p_reason text,
  p_image_url text default null,
  p_image_public_id text default null
)
returns public.staff_leave_requests
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_row public.staff_leave_requests%rowtype;
begin
  select * into v_profile
  from public.profiles
  where id=p_user_id and is_active=true;
  if not found then raise exception 'Active staff profile not found'; end if;
  if v_profile.branch_id is null then raise exception 'Staff branch is required before requesting leave'; end if;
  if p_date_from is null or p_date_to is null or p_date_to<p_date_from then
    raise exception 'Choose a valid leave date range';
  end if;
  if p_date_to-p_date_from>90 then raise exception 'One leave request is limited to 91 days'; end if;
  if coalesce(p_leave_type,'') not in('annual','sick','personal','unpaid','other') then
    raise exception 'Invalid leave type';
  end if;
  if length(trim(coalesce(p_reason,'')))<2 then raise exception 'Leave reason is required'; end if;

  if exists(
    select 1 from public.staff_leave_requests r
    where r.organization_id=v_profile.organization_id
      and r.user_id=p_user_id
      and r.status in('pending','approved')
      and daterange(r.date_from,r.date_to,'[]') && daterange(p_date_from,p_date_to,'[]')
  ) then
    raise exception 'A pending or approved leave request already overlaps these dates';
  end if;

  insert into public.staff_leave_requests(
    organization_id,branch_id,user_id,date_from,date_to,leave_type,reason,
    image_url,image_public_id,status
  ) values(
    v_profile.organization_id,v_profile.branch_id,p_user_id,p_date_from,p_date_to,
    p_leave_type,trim(p_reason),nullif(trim(coalesce(p_image_url,'')),''),
    nullif(trim(coalesce(p_image_public_id,'')),''),'pending'
  ) returning * into v_row;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_profile.organization_id,v_profile.branch_id,p_user_id,
    'request_leave','staff_leave_request',v_row.id,
    jsonb_build_object('date_from',p_date_from,'date_to',p_date_to,'leave_type',p_leave_type)
  );

  return v_row;
end;
$$;

revoke all on function private.create_staff_leave_request(uuid,date,date,text,text,text,text) from public;
grant execute on function private.create_staff_leave_request(uuid,date,date,text,text,text,text) to service_role;

create or replace function public.submit_my_leave_request(
  p_date_from date,
  p_date_to date,
  p_leave_type text,
  p_reason text,
  p_image_url text default null,
  p_image_public_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_row public.staff_leave_requests%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if not private.has_permission('leave.request',v_user)
     and not private.has_permission('staff_operations.self',v_user) then
    raise exception 'Permission required: leave.request';
  end if;
  v_row:=private.create_staff_leave_request(
    v_user,p_date_from,p_date_to,p_leave_type,p_reason,p_image_url,p_image_public_id
  );
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.submit_my_leave_request(date,date,text,text,text,text) from public,anon;
grant execute on function public.submit_my_leave_request(date,date,text,text,text,text) to authenticated;

create or replace function public.submit_leave_request_for_user(
  p_user_id uuid,
  p_date_from date,
  p_date_to date,
  p_leave_type text,
  p_reason text,
  p_image_url text default null,
  p_image_public_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_row public.staff_leave_requests%rowtype;
begin
  v_row:=private.create_staff_leave_request(
    p_user_id,p_date_from,p_date_to,p_leave_type,p_reason,p_image_url,p_image_public_id
  );
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.submit_leave_request_for_user(uuid,date,date,text,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_leave_request_for_user(uuid,date,date,text,text,text,text) to service_role;

create or replace function public.cancel_my_leave_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user uuid:=auth.uid();
  v_row public.staff_leave_requests%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  update public.staff_leave_requests
  set status='cancelled',updated_at=now()
  where id=p_request_id and user_id=v_user and status='pending'
  returning * into v_row;
  if not found then raise exception 'Only your pending leave request can be cancelled'; end if;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.cancel_my_leave_request(uuid) from public,anon;
grant execute on function public.cancel_my_leave_request(uuid) to authenticated;

create or replace function public.review_leave_request(
  p_request_id uuid,
  p_status text,
  p_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_actor uuid:=auth.uid();
  v_row public.staff_leave_requests%rowtype;
  v_date date;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if not private.has_permission('leave.manage',v_actor)
     and not private.has_permission('attendance.manage',v_actor) then
    raise exception 'Permission required: leave.manage';
  end if;
  if p_status not in('approved','rejected') then raise exception 'Review status must be approved or rejected'; end if;

  select * into v_row
  from public.staff_leave_requests
  where id=p_request_id
  for update;
  if not found then raise exception 'Leave request not found'; end if;
  if v_row.organization_id<>private.current_organization_id() then raise exception 'Leave request not found'; end if;
  if not private.staff_branch_allowed(v_row.branch_id) then raise exception 'You cannot review this branch'; end if;
  if v_row.status<>'pending' then raise exception 'This leave request has already been reviewed'; end if;

  update public.staff_leave_requests
  set status=p_status,
      review_note=nullif(left(trim(coalesce(p_review_note,'')),2000),''),
      reviewed_by=v_actor,
      reviewed_at=now(),
      updated_at=now()
  where id=v_row.id
  returning * into v_row;

  if p_status='approved' then
    for v_date in select generate_series(v_row.date_from,v_row.date_to,interval '1 day')::date loop
      insert into public.staff_attendance_day_overrides(
        organization_id,branch_id,user_id,business_date,day_type,note,created_by,leave_request_id
      ) values(
        v_row.organization_id,v_row.branch_id,v_row.user_id,v_date,'leave',
        concat('Approved leave: ',v_row.reason),v_actor,v_row.id
      )
      on conflict(organization_id,user_id,business_date) do update set
        branch_id=excluded.branch_id,
        day_type='leave',
        note=excluded.note,
        created_by=v_actor,
        leave_request_id=v_row.id,
        updated_at=now();
    end loop;
  end if;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_row.organization_id,v_row.branch_id,v_actor,
    'review_leave_request','staff_leave_request',v_row.id,
    jsonb_build_object('status',p_status,'staff_user_id',v_row.user_id,'review_note',p_review_note)
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.review_leave_request(uuid,text,text) from public,anon;
grant execute on function public.review_leave_request(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Durable Telegram operational event outbox
-- ---------------------------------------------------------------------------

create table if not exists public.telegram_operational_events(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  event_key text not null unique,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check(status in('pending','processing','sent','failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists telegram_operational_events_pending_idx
  on public.telegram_operational_events(status,created_at)
  where status in('pending','failed');

alter table public.telegram_operational_events enable row level security;
revoke all on public.telegram_operational_events from anon,authenticated;
grant all on public.telegram_operational_events to service_role;

create or replace function private.queue_sale_telegram_event()
returns trigger
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
begin
  if tg_op='INSERT' then
    if new.status::text<>'completed' then return new; end if;
  elsif not (
    new.status::text='completed'
    and old.status::text is distinct from 'completed'
  ) then
    return new;
  end if;

  insert into public.telegram_operational_events(
    organization_id,branch_id,actor_user_id,event_type,event_key,entity_type,entity_id,payload
  ) values(
    new.organization_id,new.branch_id,new.cashier_id,'sale_completed',
    'sale_completed:'||new.id::text,'sale',new.id,
    jsonb_build_object(
      'invoice_number',new.invoice_number,
      'currency',new.currency,
      'total_amount',new.total_amount,
      'payment_status',new.payment_status,
      'completed_at',new.completed_at,
      'customer_id',new.customer_id
    )
  ) on conflict(event_key) do nothing;
  return new;
end;
$$;

drop trigger if exists queue_sale_telegram_event on public.sales;
create trigger queue_sale_telegram_event
after insert or update of status on public.sales
for each row execute function private.queue_sale_telegram_event();

create or replace function private.queue_register_telegram_event()
returns trigger
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_type text;
  v_actor uuid;
  v_key text;
begin
  if tg_op='INSERT' and new.status='open' then
    v_type:='cash_register_opened';
    v_actor:=new.opened_by;
    v_key:=v_type||':'||new.id::text;
  elsif tg_op='UPDATE' and new.status='closed' and old.status is distinct from 'closed' then
    v_type:='cash_register_closed';
    v_actor:=coalesce(new.closed_by,new.opened_by);
    v_key:=v_type||':'||new.id::text;
  else
    return new;
  end if;

  insert into public.telegram_operational_events(
    organization_id,branch_id,actor_user_id,event_type,event_key,entity_type,entity_id,payload
  ) values(
    new.organization_id,new.branch_id,v_actor,v_type,v_key,'cash_register_session',new.id,
    jsonb_build_object(
      'session_number',new.session_number,
      'register_name',new.register_name,
      'opened_at',new.opened_at,
      'closed_at',new.closed_at,
      'variance_usd',new.variance_usd,
      'variance_khr',new.variance_khr
    )
  ) on conflict(event_key) do nothing;
  return new;
end;
$$;

drop trigger if exists queue_register_telegram_event on public.cash_register_sessions;
create trigger queue_register_telegram_event
after insert or update of status on public.cash_register_sessions
for each row execute function private.queue_register_telegram_event();

create or replace function private.queue_leave_telegram_event()
returns trigger
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_type text;
  v_actor uuid;
  v_key text;
begin
  if tg_op='INSERT' then
    v_type:='leave_requested';
    v_actor:=new.user_id;
    v_key:=v_type||':'||new.id::text;
  elsif tg_op='UPDATE' and new.status is distinct from old.status
        and new.status in('approved','rejected','cancelled') then
    v_type:='leave_'||new.status;
    v_actor:=coalesce(new.reviewed_by,new.user_id);
    v_key:=v_type||':'||new.id::text;
  else
    return new;
  end if;

  insert into public.telegram_operational_events(
    organization_id,branch_id,actor_user_id,event_type,event_key,entity_type,entity_id,payload
  ) values(
    new.organization_id,new.branch_id,v_actor,v_type,v_key,'staff_leave_request',new.id,
    jsonb_build_object(
      'user_id',new.user_id,
      'date_from',new.date_from,
      'date_to',new.date_to,
      'leave_type',new.leave_type,
      'reason',new.reason,
      'status',new.status,
      'review_note',new.review_note,
      'reviewed_by',new.reviewed_by
    )
  ) on conflict(event_key) do nothing;
  return new;
end;
$$;

drop trigger if exists queue_leave_telegram_event on public.staff_leave_requests;
create trigger queue_leave_telegram_event
after insert or update of status on public.staff_leave_requests
for each row execute function private.queue_leave_telegram_event();

commit;

-- ============================================================================
-- END STEP 46.4.5
-- ============================================================================
