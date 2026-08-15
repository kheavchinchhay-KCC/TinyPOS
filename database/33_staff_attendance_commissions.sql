-- ============================================================================
-- Tiny POS - Step 38: Staff Attendance, Timesheets and Sales Commissions
-- Run once in the NEW Supabase project after Step 37.
--
-- Adds:
--   * Staff check-in / check-out from POS and Telegram
--   * Branch-aware attendance history and corrections
--   * Per-user USD/KHR commission plans
--   * Automatic commission reduction after customer refunds
--   * Commission payouts and outstanding balances
--   * Relevant Telegram attendance reminders
--
-- Existing sales, returns, users, inventory and accounting records are preserved.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PERMISSIONS
-- ----------------------------------------------------------------------------

insert into public.permission_definitions (
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
)
values
  ('staff_operations.self','Staff','Use My Attendance',
   'Check in, check out and view personal attendance and commission records.',
   'normal',array['owner','admin','manager','cashier','viewer']::public.app_role[],false,270),
  ('attendance.manage','Staff','Manage Attendance',
   'View branch attendance and correct staff check-in or check-out records.',
   'sensitive',array['owner','admin','manager']::public.app_role[],false,271),
  ('commissions.view_self','Staff','View My Commission',
   'View personal earned, adjusted, paid and outstanding sales commission.',
   'normal',array['owner','admin','manager','cashier']::public.app_role[],false,272),
  ('commissions.manage','Staff','Manage Commission Plans',
   'Create staff commission plans and review organization commission records.',
   'critical',array['owner','admin']::public.app_role[],false,273),
  ('commissions.pay','Staff','Record Commission Payouts',
   'Record commission payouts to staff and reduce outstanding balances.',
   'critical',array['owner','admin']::public.app_role[],false,274)
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

-- ----------------------------------------------------------------------------
-- 2. ATTENDANCE TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  business_date date not null,
  status text not null default 'open' check(status in('open','closed')),
  check_in_at timestamptz not null default now(),
  check_out_at timestamptz,
  check_in_source text not null default 'pos'
    check(check_in_source in('pos','telegram','admin')),
  check_out_source text
    check(check_out_source is null or check_out_source in('pos','telegram','admin')),
  check_in_note text,
  check_out_note text,
  total_minutes integer not null default 0 check(total_minutes>=0),
  corrected_at timestamptz,
  corrected_by uuid references public.profiles(id) on delete set null,
  correction_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(check_out_at is null or check_out_at>=check_in_at),
  check((status='open' and check_out_at is null) or (status='closed' and check_out_at is not null))
);

create unique index if not exists attendance_one_open_session_uq
  on public.attendance_sessions(user_id)
  where status='open';
create index if not exists attendance_org_date_idx
  on public.attendance_sessions(organization_id,business_date desc,branch_id,user_id);
create index if not exists attendance_user_date_idx
  on public.attendance_sessions(user_id,business_date desc,check_in_at desc);

drop trigger if exists set_attendance_sessions_updated_at on public.attendance_sessions;
create trigger set_attendance_sessions_updated_at
before update on public.attendance_sessions
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. COMMISSION TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.commission_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check(length(trim(name)) between 1 and 120),
  currency public.currency_code not null,
  base_type text not null default 'net_sales'
    check(base_type in('net_sales','gross_profit')),
  rate_percent numeric(9,4) not null default 0 check(rate_percent between 0 and 100),
  fixed_per_sale numeric(14,2) not null default 0 check(fixed_per_sale>=0),
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(effective_to is null or effective_to>=effective_from)
);

create index if not exists commission_plans_resolve_idx
  on public.commission_plans(
    organization_id,user_id,currency,is_active,effective_from desc,branch_id
  );

drop trigger if exists set_commission_plans_updated_at on public.commission_plans;
create trigger set_commission_plans_updated_at
before update on public.commission_plans
for each row execute function public.set_updated_at();

create table if not exists public.sales_commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete cascade,
  cashier_id uuid not null references public.profiles(id) on delete cascade,
  commission_plan_id uuid references public.commission_plans(id) on delete set null,
  currency public.currency_code not null,
  base_type text not null check(base_type in('net_sales','gross_profit')),
  original_sale_amount numeric(14,4) not null default 0,
  refunded_amount numeric(14,4) not null default 0,
  commissionable_amount numeric(14,4) not null default 0,
  rate_percent numeric(9,4) not null default 0,
  fixed_per_sale numeric(14,2) not null default 0,
  commission_amount numeric(14,2) not null default 0,
  sale_completed_at timestamptz not null,
  status text not null default 'earned' check(status in('earned','adjusted','void')),
  calculated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sale_id)
);

create index if not exists sales_commissions_staff_date_idx
  on public.sales_commissions(organization_id,cashier_id,sale_completed_at desc,currency);

drop trigger if exists set_sales_commissions_updated_at on public.sales_commissions;
create trigger set_sales_commissions_updated_at
before update on public.sales_commissions
for each row execute function public.set_updated_at();

create table if not exists public.commission_payouts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  currency public.currency_code not null,
  period_start date not null,
  period_end date not null,
  amount numeric(14,2) not null check(amount>0),
  payment_method text not null default 'cash'
    check(payment_method in('cash','bank','other')),
  reference_number text,
  notes text,
  paid_at timestamptz not null default now(),
  paid_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check(period_end>=period_start)
);

create index if not exists commission_payouts_staff_period_idx
  on public.commission_payouts(organization_id,user_id,period_start,period_end,currency);

alter table public.telegram_notification_preferences
  add column if not exists attendance_alerts boolean not null default true;

-- ----------------------------------------------------------------------------
-- 4. RLS
-- ----------------------------------------------------------------------------

alter table public.attendance_sessions enable row level security;
alter table public.commission_plans enable row level security;
alter table public.sales_commissions enable row level security;
alter table public.commission_payouts enable row level security;

create or replace function private.staff_branch_allowed(p_branch_id uuid)
returns boolean language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select coalesce(
    private.has_permission('branches.all',auth.uid())
    or p_branch_id=(select private.current_branch_id()),
    false
  )
$$;
revoke all on function private.staff_branch_allowed(uuid) from public;
grant execute on function private.staff_branch_allowed(uuid) to authenticated,service_role;

drop policy if exists attendance_sessions_read on public.attendance_sessions;
create policy attendance_sessions_read on public.attendance_sessions
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and (
    (user_id=auth.uid() and private.has_permission('staff_operations.self',auth.uid()))
    or (
      private.has_permission('attendance.manage',auth.uid())
      and private.staff_branch_allowed(branch_id)
    )
  )
);

drop policy if exists commission_plans_read on public.commission_plans;
create policy commission_plans_read on public.commission_plans
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and (
    (user_id=auth.uid() and private.has_permission('commissions.view_self',auth.uid()))
    or (
      private.has_permission('commissions.manage',auth.uid())
      and (branch_id is null or private.staff_branch_allowed(branch_id))
    )
  )
);

drop policy if exists sales_commissions_read on public.sales_commissions;
create policy sales_commissions_read on public.sales_commissions
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and (
    (cashier_id=auth.uid() and private.has_permission('commissions.view_self',auth.uid()))
    or (
      private.has_permission('commissions.manage',auth.uid())
      and private.staff_branch_allowed(branch_id)
    )
  )
);

drop policy if exists commission_payouts_read on public.commission_payouts;
create policy commission_payouts_read on public.commission_payouts
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and (
    (user_id=auth.uid() and private.has_permission('commissions.view_self',auth.uid()))
    or (
      private.has_permission('commissions.manage',auth.uid())
      and private.staff_branch_allowed(branch_id)
    )
  )
);

revoke all on public.attendance_sessions from anon;
revoke all on public.commission_plans from anon;
revoke all on public.sales_commissions from anon;
revoke all on public.commission_payouts from anon;
grant select on public.attendance_sessions to authenticated;
grant select on public.commission_plans to authenticated;
grant select on public.sales_commissions to authenticated;
grant select on public.commission_payouts to authenticated;
grant all on public.attendance_sessions to service_role;
grant all on public.commission_plans to service_role;
grant all on public.sales_commissions to service_role;
grant all on public.commission_payouts to service_role;

-- ----------------------------------------------------------------------------
-- 5. ATTENDANCE FUNCTIONS
-- ----------------------------------------------------------------------------

create or replace function private.staff_business_date(
  p_organization_id uuid,
  p_moment timestamptz default now()
) returns date language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select (timezone(
    coalesce(nullif(trim(s.timezone),''),'Asia/Phnom_Penh'),
    p_moment
  ))::date
  from public.app_settings s
  where s.organization_id=p_organization_id
$$;
revoke all on function private.staff_business_date(uuid,timestamptz) from public;
grant execute on function private.staff_business_date(uuid,timestamptz) to authenticated,service_role;

create or replace function private.attendance_status_json(p_user_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=public,private,auth,pg_temp as $$
declare v_session public.attendance_sessions%rowtype;
begin
  select * into v_session from public.attendance_sessions
  where user_id=p_user_id and status='open'
  order by check_in_at desc limit 1;
  if not found then
    return jsonb_build_object('checked_in',false,'session',null);
  end if;
  return jsonb_build_object(
    'checked_in',true,
    'session',to_jsonb(v_session),
    'elapsed_minutes',greatest(0,floor(extract(epoch from(now()-v_session.check_in_at))/60)::integer)
  );
end $$;
revoke all on function private.attendance_status_json(uuid) from public;
grant execute on function private.attendance_status_json(uuid) to authenticated,service_role;

create or replace function private.perform_attendance_action(
  p_user_id uuid,
  p_action text,
  p_branch_id uuid default null,
  p_note text default null,
  p_source text default 'pos',
  p_actor_id uuid default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_profile public.profiles%rowtype;
  v_branch uuid;
  v_session public.attendance_sessions%rowtype;
  v_now timestamptz:=now();
  v_actor uuid:=coalesce(p_actor_id,p_user_id);
begin
  select * into v_profile from public.profiles
  where id=p_user_id and is_active=true;
  if not found then raise exception 'Active POS user not found'; end if;

  if p_action not in('check_in','check_out') then
    raise exception 'Invalid attendance action';
  end if;
  if p_source not in('pos','telegram','admin') then
    p_source:='pos';
  end if;

  if p_action='check_in' then
    if exists(select 1 from public.attendance_sessions where user_id=p_user_id and status='open') then
      raise exception 'You are already checked in';
    end if;
    v_branch:=coalesce(p_branch_id,v_profile.branch_id);
    if v_branch is null then raise exception 'A branch is required for check-in'; end if;
    if not exists(
      select 1 from public.branches b
      where b.id=v_branch and b.organization_id=v_profile.organization_id and b.is_active=true
    ) then raise exception 'Active branch not found'; end if;

    insert into public.attendance_sessions(
      organization_id,branch_id,user_id,business_date,status,
      check_in_at,check_in_source,check_in_note
    ) values(
      v_profile.organization_id,v_branch,p_user_id,
      private.staff_business_date(v_profile.organization_id,v_now),'open',
      v_now,p_source,nullif(left(trim(coalesce(p_note,'')),500),'')
    ) returning * into v_session;

    insert into public.audit_logs(
      organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
    ) values(
      v_profile.organization_id,v_branch,v_actor,'attendance_check_in',
      'attendance_session',v_session.id,to_jsonb(v_session)
    );
  else
    select * into v_session from public.attendance_sessions
    where user_id=p_user_id and status='open'
    order by check_in_at desc limit 1 for update;
    if not found then raise exception 'You are not currently checked in'; end if;

    update public.attendance_sessions set
      status='closed',check_out_at=v_now,check_out_source=p_source,
      check_out_note=nullif(left(trim(coalesce(p_note,'')),500),''),
      total_minutes=greatest(0,floor(extract(epoch from(v_now-check_in_at))/60)::integer),
      updated_at=v_now
    where id=v_session.id returning * into v_session;

    insert into public.audit_logs(
      organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
    ) values(
      v_profile.organization_id,v_session.branch_id,v_actor,'attendance_check_out',
      'attendance_session',v_session.id,to_jsonb(v_session)
    );
  end if;

  return jsonb_build_object('ok',true,'action',p_action,'session',to_jsonb(v_session));
end $$;
revoke all on function private.perform_attendance_action(uuid,text,uuid,text,text,uuid) from public;
grant execute on function private.perform_attendance_action(uuid,text,uuid,text,text,uuid) to authenticated,service_role;

create or replace function public.get_my_attendance_status()
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('staff_operations.self');
  return private.attendance_status_json(auth.uid());
end $$;
revoke all on function public.get_my_attendance_status() from public,anon;
grant execute on function public.get_my_attendance_status() to authenticated;

create or replace function public.attendance_check_in(
  p_branch_id uuid default null,p_note text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('staff_operations.self');
  select * into v_profile from public.profiles where id=auth.uid() and is_active=true;
  if p_branch_id is not null and p_branch_id<>v_profile.branch_id
     and not private.has_permission('branches.all',auth.uid()) then
    raise exception 'You cannot check in to another branch';
  end if;
  return private.perform_attendance_action(auth.uid(),'check_in',p_branch_id,p_note,'pos',auth.uid());
end $$;
revoke all on function public.attendance_check_in(uuid,text) from public,anon;
grant execute on function public.attendance_check_in(uuid,text) to authenticated;

create or replace function public.attendance_check_out(p_note text default null)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('staff_operations.self');
  return private.perform_attendance_action(auth.uid(),'check_out',null,p_note,'pos',auth.uid());
end $$;
revoke all on function public.attendance_check_out(text) from public,anon;
grant execute on function public.attendance_check_out(text) to authenticated;

create or replace function public.correct_attendance_session(
  p_session_id uuid,p_check_in_at timestamptz,p_check_out_at timestamptz,
  p_correction_note text
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_row public.attendance_sessions%rowtype; v_old jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('attendance.manage');
  if p_check_in_at is null then raise exception 'Check-in time is required'; end if;
  if p_check_out_at is not null and p_check_out_at<p_check_in_at then
    raise exception 'Check-out cannot be before check-in';
  end if;
  if length(trim(coalesce(p_correction_note,'')))<3 then
    raise exception 'Correction reason is required';
  end if;

  select * into v_row from public.attendance_sessions
  where id=p_session_id and organization_id=private.current_organization_id()
  for update;
  if not found then raise exception 'Attendance session not found'; end if;
  if not private.staff_branch_allowed(v_row.branch_id) then
    raise exception 'You cannot correct another branch';
  end if;
  v_old:=to_jsonb(v_row);

  update public.attendance_sessions set
    check_in_at=p_check_in_at,
    check_out_at=p_check_out_at,
    status=case when p_check_out_at is null then 'open' else 'closed' end,
    total_minutes=case when p_check_out_at is null then 0 else greatest(0,floor(extract(epoch from(p_check_out_at-p_check_in_at))/60)::integer) end,
    business_date=private.staff_business_date(organization_id,p_check_in_at),
    corrected_at=now(),corrected_by=auth.uid(),
    correction_note=left(trim(p_correction_note),1000),updated_at=now()
  where id=p_session_id returning * into v_row;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,old_data,new_data
  ) values(
    v_row.organization_id,v_row.branch_id,auth.uid(),'correct_attendance',
    'attendance_session',v_row.id,v_old,to_jsonb(v_row)
  );
  return jsonb_build_object('ok',true,'session',to_jsonb(v_row));
end $$;
revoke all on function public.correct_attendance_session(uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.correct_attendance_session(uuid,timestamptz,timestamptz,text) to authenticated;

-- Service-role functions used only by the verified Telegram webhook.
create or replace function public.telegram_attendance_action(
  p_user_id uuid,p_action text
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
begin
  return private.perform_attendance_action(
    p_user_id,p_action,null,null,'telegram',p_user_id
  );
end $$;
revoke all on function public.telegram_attendance_action(uuid,text) from public,anon,authenticated;
grant execute on function public.telegram_attendance_action(uuid,text) to service_role;

create or replace function public.telegram_attendance_status(p_user_id uuid)
returns jsonb language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select private.attendance_status_json(p_user_id)
$$;
revoke all on function public.telegram_attendance_status(uuid) from public,anon,authenticated;
grant execute on function public.telegram_attendance_status(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 6. COMMISSION CALCULATION
-- ----------------------------------------------------------------------------

create or replace function private.resolve_commission_plan(p_sale public.sales)
returns public.commission_plans language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select plan.*
  from public.commission_plans plan
  where plan.organization_id=p_sale.organization_id
    and plan.user_id=p_sale.cashier_id
    and plan.currency=p_sale.currency
    and plan.is_active=true
    and (plan.branch_id is null or plan.branch_id=p_sale.branch_id)
    and plan.effective_from<=coalesce(p_sale.completed_at::date,p_sale.created_at::date)
    and (plan.effective_to is null or plan.effective_to>=coalesce(p_sale.completed_at::date,p_sale.created_at::date))
  order by (plan.branch_id is not null) desc,plan.effective_from desc,plan.created_at desc
  limit 1
$$;
revoke all on function private.resolve_commission_plan(public.sales) from public;
grant execute on function private.resolve_commission_plan(public.sales) to authenticated,service_role;

create or replace function private.recalculate_sale_commission(p_sale_id uuid)
returns void language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_sale public.sales%rowtype;
  v_plan public.commission_plans%rowtype;
  v_refund numeric(14,4):=0;
  v_return_profit numeric(14,4):=0;
  v_base numeric(14,4):=0;
  v_commission numeric(14,2):=0;
  v_status text:='earned';
begin
  select * into v_sale from public.sales where id=p_sale_id;
  if not found or v_sale.completed_at is null
     or v_sale.status not in('completed','partially_refunded','refunded') then
    delete from public.sales_commissions where sale_id=p_sale_id;
    return;
  end if;

  v_plan:=private.resolve_commission_plan(v_sale);
  if v_plan.id is null then
    delete from public.sales_commissions where sale_id=p_sale_id;
    return;
  end if;

  select coalesce(sum(r.refund_amount),0),
         coalesce(sum((ri.unit_refund-si.unit_cost)*ri.quantity),0)
    into v_refund,v_return_profit
  from public.returns r
  left join public.return_items ri on ri.return_id=r.id
  left join public.sale_items si on si.id=ri.sale_item_id
  where r.original_sale_id=v_sale.id and r.status='completed';

  if v_plan.base_type='gross_profit' then
    v_base:=greatest(0,coalesce(v_sale.gross_profit,0)-coalesce(v_return_profit,0));
  else
    v_base:=greatest(0,coalesce(v_sale.total_amount,0)-coalesce(v_refund,0));
  end if;

  v_commission:=round(
    (v_base*coalesce(v_plan.rate_percent,0)/100)
    + case when v_base>0 then coalesce(v_plan.fixed_per_sale,0) else 0 end,
    2
  );
  if v_refund>0 then v_status:='adjusted'; end if;
  if v_base<=0 then v_status:='void'; end if;

  insert into public.sales_commissions(
    organization_id,branch_id,sale_id,cashier_id,commission_plan_id,
    currency,base_type,original_sale_amount,refunded_amount,
    commissionable_amount,rate_percent,fixed_per_sale,commission_amount,
    sale_completed_at,status,calculated_at,updated_at
  ) values(
    v_sale.organization_id,v_sale.branch_id,v_sale.id,v_sale.cashier_id,v_plan.id,
    v_sale.currency,v_plan.base_type,
    case when v_plan.base_type='gross_profit' then v_sale.gross_profit else v_sale.total_amount end,
    v_refund,v_base,v_plan.rate_percent,v_plan.fixed_per_sale,v_commission,
    v_sale.completed_at,v_status,now(),now()
  )
  on conflict(sale_id) do update set
    organization_id=excluded.organization_id,
    branch_id=excluded.branch_id,
    cashier_id=excluded.cashier_id,
    commission_plan_id=excluded.commission_plan_id,
    currency=excluded.currency,
    base_type=excluded.base_type,
    original_sale_amount=excluded.original_sale_amount,
    refunded_amount=excluded.refunded_amount,
    commissionable_amount=excluded.commissionable_amount,
    rate_percent=excluded.rate_percent,
    fixed_per_sale=excluded.fixed_per_sale,
    commission_amount=excluded.commission_amount,
    sale_completed_at=excluded.sale_completed_at,
    status=excluded.status,
    calculated_at=now(),updated_at=now();
end $$;
revoke all on function private.recalculate_sale_commission(uuid) from public;
grant execute on function private.recalculate_sale_commission(uuid) to authenticated,service_role;

create or replace function private.sales_commission_trigger()
returns trigger language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
begin
  perform private.recalculate_sale_commission(coalesce(new.id,old.id));
  return coalesce(new,old);
end $$;

create or replace function private.return_commission_trigger()
returns trigger language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
begin
  perform private.recalculate_sale_commission(coalesce(new.original_sale_id,old.original_sale_id));
  return coalesce(new,old);
end $$;

drop trigger if exists recalculate_commission_after_sale on public.sales;
create trigger recalculate_commission_after_sale
after insert or update of status,total_amount,gross_profit,completed_at,cashier_id,currency,branch_id
on public.sales for each row execute function private.sales_commission_trigger();

drop trigger if exists recalculate_commission_after_return on public.returns;
create trigger recalculate_commission_after_return
after insert or update or delete on public.returns
for each row execute function private.return_commission_trigger();

create or replace function public.save_commission_plan(
  p_plan_id uuid,
  p_user_id uuid,
  p_branch_id uuid,
  p_name text,
  p_currency public.currency_code,
  p_base_type text,
  p_rate_percent numeric,
  p_fixed_per_sale numeric,
  p_effective_from date,
  p_effective_to date,
  p_is_active boolean,
  p_notes text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_plan public.commission_plans%rowtype;
  v_sale record;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('commissions.manage');
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.organization_id=v_org and p.is_active=true) then
    raise exception 'Active staff member not found';
  end if;
  if p_branch_id is not null then
    if not exists(select 1 from public.branches b where b.id=p_branch_id and b.organization_id=v_org and b.is_active=true) then
      raise exception 'Active branch not found';
    end if;
    if not private.staff_branch_allowed(p_branch_id) then raise exception 'Branch access denied'; end if;
  end if;
  if p_base_type not in('net_sales','gross_profit') then raise exception 'Invalid commission base'; end if;
  if coalesce(p_rate_percent,0)<0 or coalesce(p_rate_percent,0)>100 then raise exception 'Rate must be between 0 and 100'; end if;
  if coalesce(p_fixed_per_sale,0)<0 then raise exception 'Fixed amount cannot be negative'; end if;
  if p_effective_to is not null and p_effective_to<p_effective_from then raise exception 'Invalid effective date range'; end if;

  if p_plan_id is null then
    insert into public.commission_plans(
      organization_id,branch_id,user_id,name,currency,base_type,
      rate_percent,fixed_per_sale,effective_from,effective_to,is_active,
      notes,created_by,updated_by
    ) values(
      v_org,p_branch_id,p_user_id,trim(p_name),p_currency,p_base_type,
      coalesce(p_rate_percent,0),coalesce(p_fixed_per_sale,0),p_effective_from,p_effective_to,
      coalesce(p_is_active,true),nullif(trim(coalesce(p_notes,'')),''),auth.uid(),auth.uid()
    ) returning * into v_plan;
  else
    update public.commission_plans set
      branch_id=p_branch_id,user_id=p_user_id,name=trim(p_name),currency=p_currency,
      base_type=p_base_type,rate_percent=coalesce(p_rate_percent,0),
      fixed_per_sale=coalesce(p_fixed_per_sale,0),effective_from=p_effective_from,
      effective_to=p_effective_to,is_active=coalesce(p_is_active,true),
      notes=nullif(trim(coalesce(p_notes,'')),''),updated_by=auth.uid(),updated_at=now()
    where id=p_plan_id and organization_id=v_org
    returning * into v_plan;
    if not found then raise exception 'Commission plan not found'; end if;
  end if;

  for v_sale in
    select s.id from public.sales s
    where s.organization_id=v_org and s.cashier_id=p_user_id and s.currency=p_currency
      and (p_branch_id is null or s.branch_id=p_branch_id)
      and s.completed_at::date>=p_effective_from
      and (p_effective_to is null or s.completed_at::date<=p_effective_to)
      and s.status in('completed','partially_refunded','refunded')
  loop
    perform private.recalculate_sale_commission(v_sale.id);
  end loop;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(v_org,p_branch_id,auth.uid(),'save_commission_plan','commission_plan',v_plan.id,to_jsonb(v_plan));
  return jsonb_build_object('ok',true,'plan',to_jsonb(v_plan));
end $$;
revoke all on function public.save_commission_plan(uuid,uuid,uuid,text,public.currency_code,text,numeric,numeric,date,date,boolean,text) from public,anon;
grant execute on function public.save_commission_plan(uuid,uuid,uuid,text,public.currency_code,text,numeric,numeric,date,date,boolean,text) to authenticated;

create or replace function public.record_commission_payout(
  p_user_id uuid,p_branch_id uuid,p_currency public.currency_code,
  p_period_start date,p_period_end date,p_amount numeric,
  p_payment_method text,p_reference_number text default null,p_notes text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id();
  v_earned numeric(14,2):=0;
  v_paid numeric(14,2):=0;
  v_row public.commission_payouts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('commissions.pay');
  if p_amount is null or p_amount<=0 then raise exception 'Payout amount must be greater than zero'; end if;
  if p_period_end<p_period_start then raise exception 'Invalid payout period'; end if;
  if p_payment_method not in('cash','bank','other') then raise exception 'Invalid payment method'; end if;
  if not private.staff_branch_allowed(p_branch_id) then raise exception 'Branch access denied'; end if;
  if not exists(select 1 from public.profiles p where p.id=p_user_id and p.organization_id=v_org and p.is_active=true) then
    raise exception 'Active staff member not found';
  end if;

  select coalesce(sum(c.commission_amount),0) into v_earned
  from public.sales_commissions c
  where c.organization_id=v_org and c.cashier_id=p_user_id and c.branch_id=p_branch_id
    and c.currency=p_currency and c.sale_completed_at::date between p_period_start and p_period_end;

  if exists(
    select 1 from public.commission_payouts p
    where p.organization_id=v_org and p.user_id=p_user_id and p.branch_id=p_branch_id
      and p.currency=p_currency
      and daterange(p.period_start,p.period_end,'[]') && daterange(p_period_start,p_period_end,'[]')
      and (p.period_start<>p_period_start or p.period_end<>p_period_end)
  ) then
    raise exception 'Payout period overlaps a previously recorded payout period';
  end if;

  select coalesce(sum(p.amount),0) into v_paid
  from public.commission_payouts p
  where p.organization_id=v_org and p.user_id=p_user_id and p.branch_id=p_branch_id
    and p.currency=p_currency
    and p.period_start=p_period_start and p.period_end=p_period_end;

  if p_amount>round(greatest(v_earned-v_paid,0),2)+0.01 then
    raise exception 'Payout exceeds outstanding commission';
  end if;

  insert into public.commission_payouts(
    organization_id,branch_id,user_id,currency,period_start,period_end,
    amount,payment_method,reference_number,notes,paid_by
  ) values(
    v_org,p_branch_id,p_user_id,p_currency,p_period_start,p_period_end,
    round(p_amount,2),p_payment_method,nullif(trim(coalesce(p_reference_number,'')),''),
    nullif(trim(coalesce(p_notes,'')),''),auth.uid()
  ) returning * into v_row;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(v_org,p_branch_id,auth.uid(),'record_commission_payout','commission_payout',v_row.id,to_jsonb(v_row));
  return jsonb_build_object('ok',true,'payout',to_jsonb(v_row),'earned',v_earned,'previously_paid',v_paid);
end $$;
revoke all on function public.record_commission_payout(uuid,uuid,public.currency_code,date,date,numeric,text,text,text) from public,anon;
grant execute on function public.record_commission_payout(uuid,uuid,public.currency_code,date,date,numeric,text,text,text) to authenticated;

create or replace function public.telegram_my_commission_summary(p_user_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_profile public.profiles%rowtype;
  v_start date;
  v_end date;
  v_earned_usd numeric:=0; v_earned_khr numeric:=0;
  v_paid_usd numeric:=0; v_paid_khr numeric:=0;
begin
  select * into v_profile from public.profiles where id=p_user_id and is_active=true;
  if not found then raise exception 'Active POS user not found'; end if;
  v_start:=date_trunc('month',private.staff_business_date(v_profile.organization_id,now()))::date;
  v_end:=(v_start+interval '1 month-1 day')::date;
  select coalesce(sum(commission_amount) filter(where currency='USD'),0),
         coalesce(sum(commission_amount) filter(where currency='KHR'),0)
    into v_earned_usd,v_earned_khr
  from public.sales_commissions
  where cashier_id=p_user_id and sale_completed_at::date between v_start and v_end;
  select coalesce(sum(amount) filter(where currency='USD'),0),
         coalesce(sum(amount) filter(where currency='KHR'),0)
    into v_paid_usd,v_paid_khr
  from public.commission_payouts
  where user_id=p_user_id and period_start>=v_start and period_end<=v_end;
  return jsonb_build_object(
    'period_start',v_start,'period_end',v_end,
    'earned_usd',round(v_earned_usd,2),'earned_khr',round(v_earned_khr,0),
    'paid_usd',round(v_paid_usd,2),'paid_khr',round(v_paid_khr,0),
    'outstanding_usd',round(greatest(v_earned_usd-v_paid_usd,0),2),
    'outstanding_khr',round(greatest(v_earned_khr-v_paid_khr,0),0)
  );
end $$;
revoke all on function public.telegram_my_commission_summary(uuid) from public,anon,authenticated;
grant execute on function public.telegram_my_commission_summary(uuid) to service_role;

commit;
