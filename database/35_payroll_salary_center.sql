-- ============================================================================
-- Tiny POS - Step 40: Payroll, Salaries, Payslips and Staff Payments
-- Run once in the NEW Supabase project after Step 39.
--
-- Adds:
--   * Salary/hourly compensation profiles with USD or KHR payroll
--   * Attendance-based work minutes, overtime, allowances and deductions
--   * Refund-adjusted unpaid commission brought into payroll automatically
--   * Draft, approved, partially paid and paid payroll runs
--   * Partial payments, printable payslips and Telegram self-service summaries
--   * Cash-register-aware salary payments and double-entry accounting output
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PERMISSIONS
-- ----------------------------------------------------------------------------
insert into public.permission_definitions(
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
)
values
  ('payroll.view_self','Payroll','View My Payroll',
   'View personal payroll runs, payslips and salary payment history.',
   'normal',array['owner','admin','manager','cashier','viewer']::public.app_role[],false,290),
  ('payroll.manage','Payroll','Manage Payroll',
   'Manage compensation profiles and calculate branch payroll runs.',
   'sensitive',array['owner','admin']::public.app_role[],false,291),
  ('payroll.approve','Payroll','Approve Payroll',
   'Approve calculated payroll so liabilities and payslips become final.',
   'critical',array['owner','admin']::public.app_role[],false,292),
  ('payroll.pay','Payroll','Pay Payroll',
   'Record salary payments and payroll settlement references.',
   'critical',array['owner','admin']::public.app_role[],false,293)
on conflict(permission_key) do update set
  module_key=excluded.module_key,label=excluded.label,description=excluded.description,
  risk_level=excluded.risk_level,default_roles=excluded.default_roles,
  approval_action=excluded.approval_action,sort_order=excluded.sort_order,
  is_active=true,updated_at=now();

-- ----------------------------------------------------------------------------
-- 2. TABLES
-- ----------------------------------------------------------------------------
create table if not exists public.payroll_compensation_profiles(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  currency public.currency_code not null default 'USD',
  pay_basis text not null default 'monthly' check(pay_basis in('monthly','hourly')),
  base_salary numeric(14,2) not null default 0 check(base_salary>=0),
  hourly_rate numeric(14,4) not null default 0 check(hourly_rate>=0),
  overtime_rate numeric(14,4) not null default 0 check(overtime_rate>=0),
  standard_minutes_per_day integer not null default 480 check(standard_minutes_per_day between 60 and 1440),
  fixed_allowance numeric(14,2) not null default 0 check(fixed_allowance>=0),
  fixed_deduction numeric(14,2) not null default 0 check(fixed_deduction>=0),
  prorate_monthly_by_attendance boolean not null default false,
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,user_id),
  check(effective_to is null or effective_to>=effective_from),
  check((pay_basis='monthly' and base_salary>=0) or (pay_basis='hourly' and hourly_rate>=0))
);

create table if not exists public.payroll_runs(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete restrict,
  run_number text not null,
  period_start date not null,
  period_end date not null,
  pay_date date not null,
  currency public.currency_code not null,
  status text not null default 'draft'
    check(status in('draft','approved','partially_paid','paid','void')),
  notes text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,run_number),
  check(period_end>=period_start)
);

create unique index if not exists payroll_runs_scope_period_uq
  on public.payroll_runs(
    organization_id,
    coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid),
    period_start,period_end,currency
  ) where status<>'void';

create table if not exists public.payroll_run_lines(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payroll_run_id uuid not null references public.payroll_runs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  compensation_profile_id uuid references public.payroll_compensation_profiles(id) on delete set null,
  currency public.currency_code not null,
  pay_basis text not null check(pay_basis in('monthly','hourly')),
  work_minutes integer not null default 0 check(work_minutes>=0),
  standard_minutes integer not null default 0 check(standard_minutes>=0),
  overtime_minutes integer not null default 0 check(overtime_minutes>=0),
  paid_days integer not null default 0 check(paid_days>=0),
  scheduled_days integer not null default 0 check(scheduled_days>=0),
  absent_days integer not null default 0 check(absent_days>=0),
  base_pay numeric(14,2) not null default 0 check(base_pay>=0),
  overtime_pay numeric(14,2) not null default 0 check(overtime_pay>=0),
  fixed_allowance numeric(14,2) not null default 0 check(fixed_allowance>=0),
  manual_allowance numeric(14,2) not null default 0 check(manual_allowance>=0),
  allowances numeric(14,2) generated always as (fixed_allowance+manual_allowance) stored,
  commission_earned numeric(14,2) not null default 0 check(commission_earned>=0),
  commission_paid_elsewhere numeric(14,2) not null default 0 check(commission_paid_elsewhere>=0),
  commission_due numeric(14,2) not null default 0 check(commission_due>=0),
  fixed_deduction numeric(14,2) not null default 0 check(fixed_deduction>=0),
  manual_deduction numeric(14,2) not null default 0 check(manual_deduction>=0),
  deductions numeric(14,2) generated always as (fixed_deduction+manual_deduction) stored,
  gross_pay numeric(14,2) not null default 0 check(gross_pay>=0),
  net_pay numeric(14,2) not null default 0 check(net_pay>=0),
  paid_amount numeric(14,2) not null default 0 check(paid_amount>=0),
  status text not null default 'draft' check(status in('draft','approved','partially_paid','paid','void')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(payroll_run_id,user_id)
);

create table if not exists public.payroll_payments(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payroll_run_id uuid not null references public.payroll_runs(id) on delete restrict,
  payroll_line_id uuid not null references public.payroll_run_lines(id) on delete restrict,
  payment_number text not null,
  amount numeric(14,2) not null check(amount>0),
  payment_method text not null default 'cash' check(payment_method in('cash','bank','other')),
  reference_number text,
  notes text,
  status text not null default 'active' check(status in('active','void')),
  paid_at timestamptz not null default now(),
  paid_by uuid not null references public.profiles(id) on delete restrict,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now(),
  unique(organization_id,payment_number)
);

create index if not exists payroll_profiles_org_branch_idx
  on public.payroll_compensation_profiles(organization_id,branch_id,is_active,currency,user_id);
create index if not exists payroll_runs_org_period_idx
  on public.payroll_runs(organization_id,period_end desc,branch_id,currency,status);
create index if not exists payroll_lines_run_user_idx
  on public.payroll_run_lines(payroll_run_id,user_id,status);
create index if not exists payroll_payments_line_date_idx
  on public.payroll_payments(payroll_line_id,paid_at desc,status);

do $$
begin
  execute 'drop trigger if exists set_payroll_compensation_profiles_updated_at on public.payroll_compensation_profiles';
  execute 'create trigger set_payroll_compensation_profiles_updated_at before update on public.payroll_compensation_profiles for each row execute function public.set_updated_at()';
  execute 'drop trigger if exists set_payroll_runs_updated_at on public.payroll_runs';
  execute 'create trigger set_payroll_runs_updated_at before update on public.payroll_runs for each row execute function public.set_updated_at()';
  execute 'drop trigger if exists set_payroll_run_lines_updated_at on public.payroll_run_lines';
  execute 'create trigger set_payroll_run_lines_updated_at before update on public.payroll_run_lines for each row execute function public.set_updated_at()';
end $$;

alter table public.telegram_notification_preferences
  add column if not exists payroll_alerts boolean not null default true;


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
end $$;
revoke all on function public.save_my_telegram_preferences(jsonb) from public,anon;
grant execute on function public.save_my_telegram_preferences(jsonb) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. RLS
-- ----------------------------------------------------------------------------
alter table public.payroll_compensation_profiles enable row level security;
alter table public.payroll_runs enable row level security;
alter table public.payroll_run_lines enable row level security;
alter table public.payroll_payments enable row level security;

create or replace function private.payroll_branch_allowed(p_branch_id uuid)
returns boolean language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select coalesce(
    private.has_permission('branches.all',auth.uid())
    or p_branch_id=(select private.current_branch_id()),false
  )
$$;
revoke all on function private.payroll_branch_allowed(uuid) from public;
grant execute on function private.payroll_branch_allowed(uuid) to authenticated,service_role;

do $$ declare r record; begin
  for r in select schemaname,tablename,policyname from pg_policies
    where schemaname='public' and tablename in(
      'payroll_compensation_profiles','payroll_runs','payroll_run_lines','payroll_payments'
    )
  loop execute format('drop policy if exists %I on %I.%I',r.policyname,r.schemaname,r.tablename); end loop;
end $$;

create policy payroll_profiles_read on public.payroll_compensation_profiles
for select to authenticated using(
  organization_id=(select private.current_organization_id()) and(
    (user_id=auth.uid() and private.has_permission('payroll.view_self',auth.uid()))
    or(private.has_permission('payroll.manage',auth.uid()) and private.payroll_branch_allowed(branch_id))
  )
);
create policy payroll_runs_read on public.payroll_runs
for select to authenticated using(
  organization_id=(select private.current_organization_id()) and(
    (private.has_permission('payroll.manage',auth.uid()) and (branch_id is null or private.payroll_branch_allowed(branch_id)))
    or(private.has_permission('payroll.view_self',auth.uid()) and exists(
      select 1 from public.payroll_run_lines l where l.payroll_run_id=payroll_runs.id and l.user_id=auth.uid()
    ))
  )
);
create policy payroll_lines_read on public.payroll_run_lines
for select to authenticated using(
  organization_id=(select private.current_organization_id()) and(
    (user_id=auth.uid() and private.has_permission('payroll.view_self',auth.uid()))
    or(private.has_permission('payroll.manage',auth.uid()) and private.payroll_branch_allowed(branch_id))
  )
);
create policy payroll_payments_read on public.payroll_payments
for select to authenticated using(
  organization_id=(select private.current_organization_id()) and exists(
    select 1 from public.payroll_run_lines l where l.id=payroll_line_id and(
      (l.user_id=auth.uid() and private.has_permission('payroll.view_self',auth.uid()))
      or(private.has_permission('payroll.manage',auth.uid()) and private.payroll_branch_allowed(l.branch_id))
    )
  )
);

revoke all on public.payroll_compensation_profiles,public.payroll_runs,
  public.payroll_run_lines,public.payroll_payments from anon;
grant select on public.payroll_compensation_profiles,public.payroll_runs,
  public.payroll_run_lines,public.payroll_payments to authenticated;
grant all on public.payroll_compensation_profiles,public.payroll_runs,
  public.payroll_run_lines,public.payroll_payments to service_role;

-- ----------------------------------------------------------------------------
-- 4. CALCULATION HELPERS
-- ----------------------------------------------------------------------------
create or replace function private.payroll_weekdays(p_from date,p_to date)
returns integer language sql immutable as $$
  select count(*)::integer from generate_series(p_from,p_to,interval '1 day') d
  where extract(isodow from d)<6
$$;

create or replace function private.recalculate_payroll_run(p_run_id uuid)
returns void language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_run public.payroll_runs%rowtype;
  r record;
  v_work integer; v_days integer; v_scheduled integer; v_standard integer;
  v_regular integer; v_overtime integer;
  v_base numeric; v_ot numeric; v_commission numeric; v_commission_paid numeric;
  v_gross numeric; v_net numeric;
begin
  select * into v_run from public.payroll_runs where id=p_run_id for update;
  if not found then raise exception 'Payroll run not found'; end if;
  if v_run.status<>'draft' then raise exception 'Only a draft payroll run can be recalculated'; end if;
  delete from public.payroll_run_lines where payroll_run_id=v_run.id;

  for r in
    select cp.*,p.full_name,p.role,p.is_active
    from public.payroll_compensation_profiles cp
    join public.profiles p on p.id=cp.user_id
    where cp.organization_id=v_run.organization_id and cp.is_active=true and p.is_active=true
      and cp.currency=v_run.currency
      and cp.effective_from<=v_run.period_end
      and (cp.effective_to is null or cp.effective_to>=v_run.period_start)
      and (v_run.branch_id is null or cp.branch_id=v_run.branch_id)
    order by p.full_name
  loop
    select coalesce(sum(a.total_minutes),0)::integer,
           count(distinct a.business_date)::integer
      into v_work,v_days
    from public.attendance_sessions a
    where a.organization_id=v_run.organization_id and a.user_id=r.user_id
      and a.status='closed' and a.business_date between v_run.period_start and v_run.period_end
      and (v_run.branch_id is null or a.branch_id=v_run.branch_id);

    v_scheduled:=private.payroll_weekdays(v_run.period_start,v_run.period_end);
    v_standard:=v_scheduled*r.standard_minutes_per_day;
    v_regular:=least(v_work,v_standard);
    v_overtime:=greatest(v_work-v_standard,0);

    if r.pay_basis='hourly' then
      v_base:=round((v_regular::numeric/60)*r.hourly_rate,2);
    elsif r.prorate_monthly_by_attendance and v_standard>0 then
      v_base:=round(r.base_salary*least(v_work::numeric/v_standard,1),2);
    else
      v_base:=r.base_salary;
    end if;
    v_ot:=round((v_overtime::numeric/60)*r.overtime_rate,2);

    select coalesce(sum(sc.commission_amount),0) into v_commission
    from public.sales_commissions sc
    where sc.organization_id=v_run.organization_id and sc.cashier_id=r.user_id
      and sc.currency=v_run.currency and sc.status<>'void'
      and timezone('Asia/Bangkok',sc.sale_completed_at)::date between v_run.period_start and v_run.period_end
      and (v_run.branch_id is null or sc.branch_id=v_run.branch_id);

    select coalesce(sum(cp.amount),0) into v_commission_paid
    from public.commission_payouts cp
    where cp.organization_id=v_run.organization_id and cp.user_id=r.user_id
      and cp.currency=v_run.currency
      and cp.period_start>=v_run.period_start and cp.period_end<=v_run.period_end
      and (v_run.branch_id is null or cp.branch_id=v_run.branch_id);

    v_gross:=round(v_base+v_ot+r.fixed_allowance+greatest(v_commission-v_commission_paid,0),2);
    v_net:=greatest(round(v_gross-r.fixed_deduction,2),0);

    insert into public.payroll_run_lines(
      organization_id,payroll_run_id,user_id,branch_id,compensation_profile_id,currency,pay_basis,
      work_minutes,standard_minutes,overtime_minutes,paid_days,scheduled_days,absent_days,
      base_pay,overtime_pay,fixed_allowance,commission_earned,commission_paid_elsewhere,
      commission_due,fixed_deduction,gross_pay,net_pay,status
    ) values(
      v_run.organization_id,v_run.id,r.user_id,r.branch_id,r.id,v_run.currency,r.pay_basis,
      v_work,v_standard,v_overtime,v_days,v_scheduled,greatest(v_scheduled-v_days,0),
      v_base,v_ot,r.fixed_allowance,v_commission,v_commission_paid,
      greatest(v_commission-v_commission_paid,0),r.fixed_deduction,v_gross,v_net,'draft'
    );
  end loop;
end $$;
revoke all on function private.recalculate_payroll_run(uuid) from public;
grant execute on function private.recalculate_payroll_run(uuid) to authenticated,service_role;

-- ----------------------------------------------------------------------------
-- 5. SECURE PAYROLL RPCS
-- ----------------------------------------------------------------------------
create or replace function public.save_payroll_compensation_profile(
  p_profile_id uuid,p_user_id uuid,p_branch_id uuid,p_currency public.currency_code,
  p_pay_basis text,p_base_salary numeric,p_hourly_rate numeric,p_overtime_rate numeric,
  p_standard_minutes_per_day integer,p_fixed_allowance numeric,p_fixed_deduction numeric,
  p_prorate_monthly_by_attendance boolean,p_effective_from date,p_effective_to date,
  p_is_active boolean,p_notes text
)
returns public.payroll_compensation_profiles language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_row public.payroll_compensation_profiles%rowtype;
begin
  perform private.require_permission('payroll.manage');
  if not private.payroll_branch_allowed(p_branch_id) then raise exception 'Branch access denied'; end if;
  if not exists(select 1 from public.profiles where id=p_user_id and organization_id=v_org and is_active=true) then
    raise exception 'Active staff user not found';
  end if;
  if p_pay_basis not in('monthly','hourly') then raise exception 'Invalid pay basis'; end if;

  insert into public.payroll_compensation_profiles(
    id,organization_id,user_id,branch_id,currency,pay_basis,base_salary,hourly_rate,
    overtime_rate,standard_minutes_per_day,fixed_allowance,fixed_deduction,
    prorate_monthly_by_attendance,effective_from,effective_to,is_active,notes,created_by,updated_by
  ) values(
    coalesce(p_profile_id,gen_random_uuid()),v_org,p_user_id,p_branch_id,p_currency,p_pay_basis,
    greatest(coalesce(p_base_salary,0),0),greatest(coalesce(p_hourly_rate,0),0),
    greatest(coalesce(p_overtime_rate,0),0),coalesce(p_standard_minutes_per_day,480),
    greatest(coalesce(p_fixed_allowance,0),0),greatest(coalesce(p_fixed_deduction,0),0),
    coalesce(p_prorate_monthly_by_attendance,false),coalesce(p_effective_from,current_date),
    p_effective_to,coalesce(p_is_active,true),nullif(trim(p_notes),''),auth.uid(),auth.uid()
  ) on conflict(organization_id,user_id) do update set
    branch_id=excluded.branch_id,currency=excluded.currency,pay_basis=excluded.pay_basis,
    base_salary=excluded.base_salary,hourly_rate=excluded.hourly_rate,overtime_rate=excluded.overtime_rate,
    standard_minutes_per_day=excluded.standard_minutes_per_day,fixed_allowance=excluded.fixed_allowance,
    fixed_deduction=excluded.fixed_deduction,prorate_monthly_by_attendance=excluded.prorate_monthly_by_attendance,
    effective_from=excluded.effective_from,effective_to=excluded.effective_to,is_active=excluded.is_active,
    notes=excluded.notes,updated_by=auth.uid(),updated_at=now()
  returning * into v_row;
  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'save_payroll_compensation','payroll_compensation_profile',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.create_payroll_run(
  p_branch_id uuid,p_period_start date,p_period_end date,p_pay_date date,
  p_currency public.currency_code,p_notes text
)
returns public.payroll_runs language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id(); v_counter_branch uuid; v_row public.payroll_runs%rowtype;
begin
  perform private.require_permission('payroll.manage');
  if p_period_end<p_period_start then raise exception 'Payroll period is invalid'; end if;
  if p_branch_id is null and not private.has_permission('branches.all',auth.uid()) then
    raise exception 'All-branch payroll requires all-branch access';
  end if;
  if p_branch_id is not null and not private.payroll_branch_allowed(p_branch_id) then raise exception 'Branch access denied'; end if;
  v_counter_branch:=coalesce(p_branch_id,private.current_branch_id());
  insert into public.payroll_runs(
    organization_id,branch_id,run_number,period_start,period_end,pay_date,currency,notes,created_by
  ) values(
    v_org,p_branch_id,private.next_document_number(v_org,v_counter_branch,'PAY'),p_period_start,p_period_end,
    p_pay_date,p_currency,nullif(trim(p_notes),''),auth.uid()
  ) returning * into v_row;
  perform private.recalculate_payroll_run(v_row.id);
  if not exists(select 1 from public.payroll_run_lines where payroll_run_id=v_row.id) then
    delete from public.payroll_runs where id=v_row.id;
    raise exception 'No active compensation profiles match this payroll run';
  end if;
  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'create_payroll_run','payroll_run',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.refresh_payroll_run(p_payroll_run_id uuid)
returns public.payroll_runs language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_row public.payroll_runs%rowtype;
begin
  perform private.require_permission('payroll.manage');
  select * into v_row from public.payroll_runs where id=p_payroll_run_id and organization_id=v_org for update;
  if not found then raise exception 'Payroll run not found'; end if;
  if v_row.branch_id is not null and not private.payroll_branch_allowed(v_row.branch_id) then raise exception 'Branch access denied'; end if;
  perform private.recalculate_payroll_run(v_row.id);
  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id)
  values(v_org,auth.uid(),'refresh_payroll_run','payroll_run',v_row.id);
  return v_row;
end $$;

create or replace function public.update_payroll_line_adjustment(
  p_payroll_line_id uuid,p_manual_allowance numeric,p_manual_deduction numeric,p_notes text
)
returns public.payroll_run_lines language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_line public.payroll_run_lines%rowtype; v_run public.payroll_runs%rowtype; v_gross numeric;
begin
  perform private.require_permission('payroll.manage');
  select l.* into v_line from public.payroll_run_lines l where l.id=p_payroll_line_id and l.organization_id=v_org for update;
  if not found then raise exception 'Payroll line not found'; end if;
  select * into v_run from public.payroll_runs where id=v_line.payroll_run_id;
  if v_run.status<>'draft' then raise exception 'Only draft payroll can be adjusted'; end if;
  if not private.payroll_branch_allowed(v_line.branch_id) then raise exception 'Branch access denied'; end if;
  v_gross:=round(v_line.base_pay+v_line.overtime_pay+v_line.fixed_allowance+greatest(coalesce(p_manual_allowance,0),0)+v_line.commission_due,2);
  update public.payroll_run_lines set
    manual_allowance=greatest(coalesce(p_manual_allowance,0),0),
    manual_deduction=greatest(coalesce(p_manual_deduction,0),0),
    gross_pay=v_gross,
    net_pay=greatest(round(v_gross-fixed_deduction-greatest(coalesce(p_manual_deduction,0),0),2),0),
    notes=nullif(trim(p_notes),''),updated_at=now()
  where id=v_line.id returning * into v_line;
  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'adjust_payroll_line','payroll_run_line',v_line.id,to_jsonb(v_line));
  return v_line;
end $$;

create or replace function public.approve_payroll_run(p_payroll_run_id uuid)
returns public.payroll_runs language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_row public.payroll_runs%rowtype;
begin
  perform private.require_permission('payroll.approve');
  select * into v_row from public.payroll_runs where id=p_payroll_run_id and organization_id=v_org for update;
  if not found then raise exception 'Payroll run not found'; end if;
  if v_row.status<>'draft' then raise exception 'Only draft payroll can be approved'; end if;
  if v_row.branch_id is not null and not private.payroll_branch_allowed(v_row.branch_id) then raise exception 'Branch access denied'; end if;
  if private.accounting_period_closed(v_org,v_row.branch_id,v_row.pay_date) then raise exception 'The accounting period for this pay date is closed'; end if;
  if not exists(select 1 from public.payroll_run_lines where payroll_run_id=v_row.id) then raise exception 'Payroll run has no staff lines'; end if;
  update public.payroll_run_lines set status=case when net_pay<=0.005 then 'paid' else 'approved' end where payroll_run_id=v_row.id;
  update public.payroll_runs set
    status=case when not exists(select 1 from public.payroll_run_lines l where l.payroll_run_id=v_row.id and l.status<>'paid') then 'paid' else 'approved' end,
    approved_by=auth.uid(),approved_at=now()
    where id=v_row.id returning * into v_row;
  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'approve_payroll_run','payroll_run',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.record_payroll_payment(
  p_payroll_line_id uuid,p_amount numeric,p_payment_method text,
  p_reference_number text,p_notes text,p_paid_at timestamptz default now()
)
returns public.payroll_payments language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_org uuid:=private.current_organization_id(); v_line public.payroll_run_lines%rowtype;
  v_run public.payroll_runs%rowtype; v_row public.payroll_payments%rowtype;
  v_outstanding numeric; v_category uuid; v_entry_number text;
begin
  perform private.require_permission('payroll.pay');
  if p_payment_method not in('cash','bank','other') then raise exception 'Unsupported payroll payment method'; end if;
  select * into v_line from public.payroll_run_lines where id=p_payroll_line_id and organization_id=v_org for update;
  if not found then raise exception 'Payroll line not found'; end if;
  select * into v_run from public.payroll_runs where id=v_line.payroll_run_id for update;
  if v_run.status not in('approved','partially_paid') then raise exception 'Payroll must be approved before payment'; end if;
  if not private.payroll_branch_allowed(v_line.branch_id) then raise exception 'Branch access denied'; end if;
  if private.accounting_period_closed(v_org,v_line.branch_id,timezone('Asia/Bangkok',p_paid_at)::date) then
    raise exception 'The accounting period for this payment is closed';
  end if;
  v_outstanding:=round(v_line.net_pay-v_line.paid_amount,2);
  if coalesce(p_amount,0)<=0 or p_amount>v_outstanding+0.005 then
    raise exception 'Payment exceeds outstanding payroll amount of %',v_outstanding;
  end if;

  insert into public.payroll_payments(
    organization_id,payroll_run_id,payroll_line_id,payment_number,amount,payment_method,
    reference_number,notes,paid_at,paid_by
  ) values(
    v_org,v_run.id,v_line.id,private.next_document_number(v_org,v_line.branch_id,'SAL'),round(p_amount,2),
    p_payment_method,nullif(trim(p_reference_number),''),nullif(trim(p_notes),''),coalesce(p_paid_at,now()),auth.uid()
  ) returning * into v_row;

  if p_payment_method='cash' then
    select id into v_category from public.cash_categories
      where organization_id=v_org and direction::text='expense' and lower(name)=lower('Salary & Wages') and is_active=true
      order by is_system desc limit 1;
    if v_category is null then raise exception 'Salary & Wages cash category is missing'; end if;
    v_entry_number:=private.next_document_number(v_org,v_line.branch_id,'CEX');
    insert into public.cash_entries(
      organization_id,branch_id,entry_number,direction,category_id,method,currency,amount,
      entry_at,reference_number,remark,status,created_by,updated_by
    ) values(
      v_org,v_line.branch_id,v_entry_number,'expense',v_category,'cash',v_run.currency,v_row.amount,
      v_row.paid_at,'PAYROLL:'||v_row.id::text,'Payroll payment '||v_row.payment_number,'active',auth.uid(),auth.uid()
    );
  end if;

  update public.payroll_run_lines set
    paid_amount=round(paid_amount+v_row.amount,2),
    status=case when round(paid_amount+v_row.amount,2)>=net_pay-0.005 then 'paid' else 'partially_paid' end,
    updated_at=now()
  where id=v_line.id;

  update public.payroll_runs r set status=case
    when not exists(select 1 from public.payroll_run_lines l where l.payroll_run_id=r.id and l.status<>'paid') then 'paid'
    else 'partially_paid' end
  where r.id=v_run.id returning * into v_run;

  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'record_payroll_payment','payroll_payment',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.void_payroll_run(p_payroll_run_id uuid,p_reason text)
returns public.payroll_runs language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_row public.payroll_runs%rowtype;
begin
  perform private.require_permission('payroll.approve');
  select * into v_row from public.payroll_runs where id=p_payroll_run_id and organization_id=v_org for update;
  if not found then raise exception 'Payroll run not found'; end if;
  if exists(select 1 from public.payroll_payments where payroll_run_id=v_row.id and status='active') then
    raise exception 'A payroll run with active payments cannot be voided';
  end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'A void reason is required'; end if;
  update public.payroll_run_lines set status='void' where payroll_run_id=v_row.id;
  update public.payroll_runs set status='void',voided_by=auth.uid(),voided_at=now(),void_reason=trim(p_reason)
    where id=v_row.id returning * into v_row;
  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'void_payroll_run','payroll_run',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function public.telegram_my_payroll_summary(p_user_id uuid)
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_result jsonb;
begin
  select organization_id into v_org from public.profiles where id=p_user_id and is_active=true;
  if v_org is null then raise exception 'Active POS user not found'; end if;
  select jsonb_build_object(
    'latest',coalesce((select to_jsonb(x) from(
      select r.run_number,r.period_start,r.period_end,r.pay_date,r.currency,r.status,
        l.base_pay,l.overtime_pay,l.allowances,l.commission_due,l.deductions,l.gross_pay,
        l.net_pay,l.paid_amount,greatest(l.net_pay-l.paid_amount,0) as outstanding
      from public.payroll_run_lines l join public.payroll_runs r on r.id=l.payroll_run_id
      where l.organization_id=v_org and l.user_id=p_user_id and r.status in('approved','partially_paid','paid')
      order by r.period_end desc,r.created_at desc limit 1
    )x),'null'::jsonb),
    'year_paid',coalesce((select jsonb_object_agg(currency,total) from(
      select r.currency,sum(pp.amount)::numeric as total
      from public.payroll_payments pp join public.payroll_runs r on r.id=pp.payroll_run_id
      join public.payroll_run_lines l on l.id=pp.payroll_line_id
      where pp.organization_id=v_org and l.user_id=p_user_id and pp.status='active'
        and extract(year from timezone('Asia/Bangkok',pp.paid_at))=extract(year from timezone('Asia/Bangkok',now()))
      group by r.currency
    )y),'{}'::jsonb)
  ) into v_result;
  return v_result;
end $$;

revoke all on function public.save_payroll_compensation_profile(uuid,uuid,uuid,public.currency_code,text,numeric,numeric,numeric,integer,numeric,numeric,boolean,date,date,boolean,text) from public;
revoke all on function public.create_payroll_run(uuid,date,date,date,public.currency_code,text) from public;
revoke all on function public.refresh_payroll_run(uuid) from public;
revoke all on function public.update_payroll_line_adjustment(uuid,numeric,numeric,text) from public;
revoke all on function public.approve_payroll_run(uuid) from public;
revoke all on function public.record_payroll_payment(uuid,numeric,text,text,text,timestamptz) from public;
revoke all on function public.void_payroll_run(uuid,text) from public;
revoke all on function public.telegram_my_payroll_summary(uuid) from public;
grant execute on function public.save_payroll_compensation_profile(uuid,uuid,uuid,public.currency_code,text,numeric,numeric,numeric,integer,numeric,numeric,boolean,date,date,boolean,text) to authenticated,service_role;
grant execute on function public.create_payroll_run(uuid,date,date,date,public.currency_code,text) to authenticated,service_role;
grant execute on function public.refresh_payroll_run(uuid) to authenticated,service_role;
grant execute on function public.update_payroll_line_adjustment(uuid,numeric,numeric,text) to authenticated,service_role;
grant execute on function public.approve_payroll_run(uuid) to authenticated,service_role;
grant execute on function public.record_payroll_payment(uuid,numeric,text,text,text,timestamptz) to authenticated,service_role;
grant execute on function public.void_payroll_run(uuid,text) to authenticated,service_role;
grant execute on function public.telegram_my_payroll_summary(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 6. ACCOUNTING DEFAULTS AND PAYROLL POSTING
-- ----------------------------------------------------------------------------
insert into public.accounting_accounts(
  organization_id,code,name,account_type,normal_balance,is_system,is_active,description,created_by,updated_by
)
select o.id,x.code,x.name,x.account_type,x.normal_balance,true,true,x.description,o.created_by,o.created_by
from public.organizations o cross join(values
  ('2110','Payroll Payable','liability','credit','Approved net salaries and wages awaiting payment.'),
  ('2120','Payroll Deductions Payable','liability','credit','Payroll deductions retained for later settlement.'),
  ('5210','Salaries & Wages','expense','debit','Base salary, hourly pay, overtime and allowances.')
) x(code,name,account_type,normal_balance,description)
on conflict(organization_id,code) do nothing;

insert into public.accounting_mappings(organization_id,mapping_key,account_id,description,created_by,updated_by)
select a.organization_id,x.mapping_key,a.id,x.description,a.created_by,a.created_by
from public.accounting_accounts a join(values
  ('payroll_payable','2110','Net approved payroll liabilities.'),
  ('payroll_deductions','2120','Payroll deductions retained.'),
  ('payroll_expense','5210','Salary, hourly, overtime and allowance expense.')
) x(mapping_key,code,description) on x.code=a.code
on conflict(organization_id,mapping_key) do nothing;

create or replace function public.save_accounting_mapping(p_mapping_key text,p_account_id uuid)
returns public.accounting_mappings language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid:=private.current_organization_id(); v_row public.accounting_mappings%rowtype;
begin
  perform private.require_permission('accounting.manage');
  if not exists(select 1 from public.accounting_accounts a where a.id=p_account_id and a.organization_id=v_org and a.is_active=true) then
    raise exception 'Active accounting account not found'; end if;
  if p_mapping_key not in(
    'cash_on_hand','bank','card_clearing','khqr_clearing','other_payment','accounts_receivable','inventory',
    'accounts_payable','tax_payable','owner_equity','sales_revenue','other_income','sales_returns',
    'cost_of_goods_sold','operating_expense','commission_expense','inventory_adjustment_loss',
    'inventory_adjustment_gain','payroll_payable','payroll_deductions','payroll_expense'
  ) then raise exception 'Unknown accounting mapping'; end if;
  insert into public.accounting_mappings(organization_id,mapping_key,account_id,created_by,updated_by)
  values(v_org,p_mapping_key,p_account_id,auth.uid(),auth.uid())
  on conflict(organization_id,mapping_key) do update set account_id=excluded.account_id,updated_by=auth.uid(),updated_at=now()
  returning * into v_row;
  insert into public.audit_logs(organization_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,auth.uid(),'update_accounting_mapping','accounting_mapping',v_row.id,to_jsonb(v_row));
  return v_row;
end $$;

create or replace function private.accounting_source_lines(
  p_organization_id uuid,p_branch_id uuid,p_from date,p_to date
)
returns table(
  entry_date date,branch_id uuid,branch_name text,currency public.currency_code,
  source_type text,source_id uuid,source_number text,description text,
  account_id uuid,account_code text,account_name text,account_type text,
  normal_balance text,debit numeric,credit numeric
)
language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
with mappings as (
  select m.mapping_key,m.account_id
  from public.accounting_mappings m
  where m.organization_id=p_organization_id
),
sales_scope as (
  select s.*,
    timezone('Asia/Bangkok',coalesce(s.completed_at,s.created_at))::date as business_date,
    coalesce((select sum(p.amount) from public.payments p where p.sale_id=s.id and p.credit_payment_id is null),0)::numeric as immediate_paid
  from public.sales s
  where s.organization_id=p_organization_id and s.status::text='completed'
    and timezone('Asia/Bangkok',coalesce(s.completed_at,s.created_at))::date between p_from and p_to
    and (p_branch_id is null or s.branch_id=p_branch_id)
),
return_scope as (
  select r.*,
    timezone('Asia/Bangkok',r.processed_at)::date as business_date,
    least(
      r.refund_amount,
      greatest(
        round(r.refund_amount*coalesce(s.tax_amount,0)/nullif(s.total_amount,0),2),
        0
      )
    )::numeric as tax_reversal
  from public.returns r
  join public.sales s on s.id=r.original_sale_id
  where r.organization_id=p_organization_id and r.status::text='completed'
    and timezone('Asia/Bangkok',r.processed_at)::date between p_from and p_to
    and (p_branch_id is null or r.branch_id=p_branch_id)
),
return_costs as (
  select r.id as return_id,coalesce(sum(ri.quantity*si.unit_cost) filter(where ri.restock),0)::numeric as restock_cost
  from public.returns r
  join public.return_items ri on ri.return_id=r.id
  join public.sale_items si on si.id=ri.sale_item_id
  where r.organization_id=p_organization_id and r.status::text='completed'
  group by r.id
),
receipt_totals as (
  select pr.id,coalesce(sum(pri.line_total),0)::numeric as amount
  from public.purchase_receipts pr
  join public.purchase_receipt_items pri on pri.receipt_id=pr.id
  where pr.organization_id=p_organization_id group by pr.id
),
adjustment_values as (
  select a.id,coalesce(sum(ai.quantity_change*ai.unit_cost),0)::numeric as value
  from public.inventory_adjustments a
  join public.inventory_adjustment_items ai on ai.adjustment_id=a.id
  where a.organization_id=p_organization_id group by a.id
),
raw(entry_date,branch_id,currency,source_type,source_id,source_number,description,mapping_key,direct_account_id,debit,credit) as (
  -- Completed sale payment debits.
  select s.business_date,s.branch_id,s.currency,'sale'::text,s.id,s.invoice_number,
    'Sale '||s.invoice_number,
    case p.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,p.amount::numeric,0::numeric
  from sales_scope s join public.payments p on p.sale_id=s.id and p.credit_payment_id is null
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sale '||s.invoice_number,
    'accounts_receivable',null::uuid,s.credit_amount::numeric,0::numeric
  from sales_scope s where s.credit_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sale '||s.invoice_number,
    'other_payment',null::uuid,greatest(s.total_amount-s.credit_amount-s.immediate_paid,0)::numeric,
    greatest(s.credit_amount+s.immediate_paid-s.total_amount,0)::numeric
  from sales_scope s where abs(s.total_amount-s.credit_amount-s.immediate_paid)>0.005
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sale revenue '||s.invoice_number,
    'sales_revenue',null::uuid,0::numeric,greatest(s.total_amount-s.tax_amount,0)::numeric
  from sales_scope s where s.total_amount-s.tax_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Sales tax '||s.invoice_number,
    'tax_payable',null::uuid,0::numeric,s.tax_amount::numeric
  from sales_scope s where s.tax_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Cost of goods sold '||s.invoice_number,
    'cost_of_goods_sold',null::uuid,s.cost_amount::numeric,0::numeric
  from sales_scope s where s.cost_amount>0
  union all
  select s.business_date,s.branch_id,s.currency,'sale',s.id,s.invoice_number,'Inventory issued '||s.invoice_number,
    'inventory',null::uuid,0::numeric,s.cost_amount::numeric
  from sales_scope s where s.cost_amount>0

  -- Customer credit collections.
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'credit_payment',cp.id,cp.payment_number,
    'Customer credit collection '||cp.payment_number,
    case cp.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,cp.amount::numeric,0::numeric
  from public.customer_credit_payments cp
  where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'credit_payment',cp.id,cp.payment_number,
    'Customer credit collection '||cp.payment_number,'accounts_receivable',null::uuid,0::numeric,cp.amount::numeric
  from public.customer_credit_payments cp
  where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)

  -- Customer returns, tax reversal and restocking cost reversal.
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Customer return '||r.return_number,'sales_returns',null::uuid,
    greatest(r.refund_amount-r.tax_reversal,0)::numeric,0::numeric
  from return_scope r where r.refund_amount-r.tax_reversal>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Sales tax reversal '||r.return_number,'tax_payable',null::uuid,r.tax_reversal::numeric,0::numeric
  from return_scope r where r.tax_reversal>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Credit refund '||r.return_number,'accounts_receivable',null::uuid,0::numeric,r.credit_refund_amount::numeric
  from return_scope r where r.credit_refund_amount>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Refund payment '||r.return_number,
    case coalesce(r.refund_method::text,'other') when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,0::numeric,greatest(r.refund_amount-r.credit_refund_amount,0)::numeric
  from return_scope r where r.refund_amount-r.credit_refund_amount>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'Returned inventory '||r.return_number,'inventory',null::uuid,rc.restock_cost,0::numeric
  from return_scope r join return_costs rc on rc.return_id=r.id where rc.restock_cost>0
  union all
  select r.business_date,r.branch_id,r.currency,'return',r.id,r.return_number,
    'COGS reversal '||r.return_number,'cost_of_goods_sold',null::uuid,0::numeric,rc.restock_cost
  from return_scope r join return_costs rc on rc.return_id=r.id where rc.restock_cost>0

  -- Goods received and supplier liabilities.
  union all
  select timezone('Asia/Bangkok',pr.received_at)::date,pr.branch_id,p.currency,'purchase_receipt',pr.id,pr.receipt_number,
    'Goods received '||pr.receipt_number,'inventory',null::uuid,rt.amount,0::numeric
  from public.purchase_receipts pr join receipt_totals rt on rt.id=pr.id join public.purchases p on p.id=pr.purchase_id
  where pr.organization_id=p_organization_id and timezone('Asia/Bangkok',pr.received_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and rt.amount>0
  union all
  select timezone('Asia/Bangkok',pr.received_at)::date,pr.branch_id,p.currency,'purchase_receipt',pr.id,pr.receipt_number,
    'Supplier liability '||pr.receipt_number,'accounts_payable',null::uuid,0::numeric,rt.amount
  from public.purchase_receipts pr join receipt_totals rt on rt.id=pr.id join public.purchases p on p.id=pr.purchase_id
  where pr.organization_id=p_organization_id and timezone('Asia/Bangkok',pr.received_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and rt.amount>0

  -- Supplier payments.
  union all
  select timezone('Asia/Bangkok',sp.paid_at)::date,sp.branch_id,sp.currency,'supplier_payment',sp.id,sp.payment_number,
    'Supplier payment '||sp.payment_number,'accounts_payable',null::uuid,sp.amount::numeric,0::numeric
  from public.supplier_payment_batches sp where sp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',sp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or sp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',sp.paid_at)::date,sp.branch_id,sp.currency,'supplier_payment',sp.id,sp.payment_number,
    'Supplier payment '||sp.payment_number,
    case sp.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,0::numeric,sp.amount::numeric
  from public.supplier_payment_batches sp where sp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',sp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or sp.branch_id=p_branch_id)

  -- Legacy or directly recorded purchase payments not attached to a payment batch.
  union all
  select timezone('Asia/Bangkok',pp.paid_at)::date,pp.branch_id,pp.currency,'purchase_payment',pp.id,
    p.purchase_number,'Purchase payment '||p.purchase_number,'accounts_payable',null::uuid,pp.amount::numeric,0::numeric
  from public.purchase_payments pp join public.purchases p on p.id=pp.purchase_id
  where pp.organization_id=p_organization_id and pp.payment_batch_id is null
    and timezone('Asia/Bangkok',pp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or pp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',pp.paid_at)::date,pp.branch_id,pp.currency,'purchase_payment',pp.id,
    p.purchase_number,'Purchase payment '||p.purchase_number,
    case pp.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,0::numeric,pp.amount::numeric
  from public.purchase_payments pp join public.purchases p on p.id=pp.purchase_id
  where pp.organization_id=p_organization_id and pp.payment_batch_id is null
    and timezone('Asia/Bangkok',pp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or pp.branch_id=p_branch_id)

  -- Supplier returns.
  union all
  select timezone('Asia/Bangkok',pr.created_at)::date,pr.branch_id,pr.currency,'supplier_return',pr.id,pr.return_number,
    'Supplier return '||pr.return_number,'accounts_payable',null::uuid,pr.total_amount::numeric,0::numeric
  from public.purchase_returns pr where pr.organization_id=p_organization_id and pr.status::text='completed'
    and timezone('Asia/Bangkok',pr.created_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and pr.total_amount>0
  union all
  select timezone('Asia/Bangkok',pr.created_at)::date,pr.branch_id,pr.currency,'supplier_return',pr.id,pr.return_number,
    'Inventory returned to supplier '||pr.return_number,'inventory',null::uuid,0::numeric,pr.total_amount::numeric
  from public.purchase_returns pr where pr.organization_id=p_organization_id and pr.status::text='completed'
    and timezone('Asia/Bangkok',pr.created_at)::date between p_from and p_to
    and (p_branch_id is null or pr.branch_id=p_branch_id) and pr.total_amount>0

  -- Cash income and expenses.
  union all
  select timezone('Asia/Bangkok',ce.entry_at)::date,ce.branch_id,ce.currency,'cash_entry',ce.id,ce.entry_number,
    coalesce(cc.name,'Cash entry')||' '||ce.entry_number,
    case ce.method::text when 'cash' then 'cash_on_hand' when 'bank' then 'bank'
      when 'khqr' then 'khqr_clearing' when 'card' then 'card_clearing' else 'other_payment' end,
    null::uuid,case when ce.direction::text='income' then ce.amount else 0 end::numeric,
    case when ce.direction::text='expense' then ce.amount else 0 end::numeric
  from public.cash_entries ce join public.cash_categories cc on cc.id=ce.category_id
  where ce.organization_id=p_organization_id and ce.status::text='active'
    and coalesce(ce.reference_number,'') not like 'PAYROLL:%'
    and timezone('Asia/Bangkok',ce.entry_at)::date between p_from and p_to
    and (p_branch_id is null or ce.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',ce.entry_at)::date,ce.branch_id,ce.currency,'cash_entry',ce.id,ce.entry_number,
    coalesce(cc.name,'Cash entry')||' '||ce.entry_number,
    case when cc.affects_profit and ce.direction::text='income' then 'other_income'
      when cc.affects_profit and ce.direction::text='expense' then 'operating_expense'
      else 'owner_equity' end,
    null::uuid,case when ce.direction::text='expense' then ce.amount else 0 end::numeric,
    case when ce.direction::text='income' then ce.amount else 0 end::numeric
  from public.cash_entries ce join public.cash_categories cc on cc.id=ce.category_id
  where ce.organization_id=p_organization_id and ce.status::text='active'
    and coalesce(ce.reference_number,'') not like 'PAYROLL:%'
    and timezone('Asia/Bangkok',ce.entry_at)::date between p_from and p_to
    and (p_branch_id is null or ce.branch_id=p_branch_id)

  -- Commission payouts.
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'commission_payout',cp.id,
    'COM-'||left(cp.id::text,8),'Commission payout','commission_expense',null::uuid,cp.amount::numeric,0::numeric
  from public.commission_payouts cp where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',cp.paid_at)::date,cp.branch_id,cp.currency,'commission_payout',cp.id,
    'COM-'||left(cp.id::text,8),'Commission payout',
    case cp.payment_method when 'cash' then 'cash_on_hand' when 'bank' then 'bank' else 'other_payment' end,
    null::uuid,0::numeric,cp.amount::numeric
  from public.commission_payouts cp where cp.organization_id=p_organization_id
    and timezone('Asia/Bangkok',cp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or cp.branch_id=p_branch_id)


  -- Approved payroll accruals.
  union all
  select pr.pay_date,pl.branch_id,pr.currency,'payroll_accrual',pl.id,pr.run_number,
    'Payroll salary accrual '||pr.run_number,'payroll_expense',null::uuid,
    (pl.base_pay+pl.overtime_pay+pl.allowances)::numeric,0::numeric
  from public.payroll_run_lines pl
  join public.payroll_runs pr on pr.id=pl.payroll_run_id
  where pr.organization_id=p_organization_id
    and pr.status in('approved','partially_paid','paid')
    and pr.pay_date between p_from and p_to
    and (p_branch_id is null or pl.branch_id=p_branch_id)
    and pl.base_pay+pl.overtime_pay+pl.allowances>0
  union all
  select pr.pay_date,pl.branch_id,pr.currency,'payroll_accrual',pl.id,pr.run_number,
    'Payroll commission accrual '||pr.run_number,'commission_expense',null::uuid,
    pl.commission_due::numeric,0::numeric
  from public.payroll_run_lines pl
  join public.payroll_runs pr on pr.id=pl.payroll_run_id
  where pr.organization_id=p_organization_id
    and pr.status in('approved','partially_paid','paid')
    and pr.pay_date between p_from and p_to
    and (p_branch_id is null or pl.branch_id=p_branch_id)
    and pl.commission_due>0
  union all
  select pr.pay_date,pl.branch_id,pr.currency,'payroll_accrual',pl.id,pr.run_number,
    'Payroll deductions '||pr.run_number,'payroll_deductions',null::uuid,
    0::numeric,pl.deductions::numeric
  from public.payroll_run_lines pl
  join public.payroll_runs pr on pr.id=pl.payroll_run_id
  where pr.organization_id=p_organization_id
    and pr.status in('approved','partially_paid','paid')
    and pr.pay_date between p_from and p_to
    and (p_branch_id is null or pl.branch_id=p_branch_id)
    and pl.deductions>0
  union all
  select pr.pay_date,pl.branch_id,pr.currency,'payroll_accrual',pl.id,pr.run_number,
    'Net payroll payable '||pr.run_number,'payroll_payable',null::uuid,
    0::numeric,pl.net_pay::numeric
  from public.payroll_run_lines pl
  join public.payroll_runs pr on pr.id=pl.payroll_run_id
  where pr.organization_id=p_organization_id
    and pr.status in('approved','partially_paid','paid')
    and pr.pay_date between p_from and p_to
    and (p_branch_id is null or pl.branch_id=p_branch_id)
    and pl.net_pay>0

  -- Payroll payments settle the payroll liability.
  union all
  select timezone('Asia/Bangkok',pp.paid_at)::date,pl.branch_id,pr.currency,
    'payroll_payment',pp.id,pp.payment_number,'Payroll payment '||pp.payment_number,
    'payroll_payable',null::uuid,pp.amount::numeric,0::numeric
  from public.payroll_payments pp
  join public.payroll_run_lines pl on pl.id=pp.payroll_line_id
  join public.payroll_runs pr on pr.id=pp.payroll_run_id
  where pp.organization_id=p_organization_id and pp.status='active'
    and timezone('Asia/Bangkok',pp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or pl.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',pp.paid_at)::date,pl.branch_id,pr.currency,
    'payroll_payment',pp.id,pp.payment_number,'Payroll payment '||pp.payment_number,
    case pp.payment_method when 'cash' then 'cash_on_hand' when 'bank' then 'bank' else 'other_payment' end,
    null::uuid,0::numeric,pp.amount::numeric
  from public.payroll_payments pp
  join public.payroll_run_lines pl on pl.id=pp.payroll_line_id
  join public.payroll_runs pr on pr.id=pp.payroll_run_id
  where pp.organization_id=p_organization_id and pp.status='active'
    and timezone('Asia/Bangkok',pp.paid_at)::date between p_from and p_to
    and (p_branch_id is null or pl.branch_id=p_branch_id)

  -- Inventory adjustments.
  union all
  select timezone('Asia/Bangkok',a.created_at)::date,a.branch_id,'USD'::public.currency_code,'inventory_adjustment',a.id,a.adjustment_number,
    'Inventory adjustment '||a.adjustment_number,
    case when av.value>0 then 'inventory' else 'inventory_adjustment_loss' end,
    null::uuid,abs(av.value)::numeric,0::numeric
  from public.inventory_adjustments a join adjustment_values av on av.id=a.id
  where a.organization_id=p_organization_id and av.value<>0
    and timezone('Asia/Bangkok',a.created_at)::date between p_from and p_to
    and (p_branch_id is null or a.branch_id=p_branch_id)
  union all
  select timezone('Asia/Bangkok',a.created_at)::date,a.branch_id,'USD'::public.currency_code,'inventory_adjustment',a.id,a.adjustment_number,
    'Inventory adjustment '||a.adjustment_number,
    case when av.value>0 then 'inventory_adjustment_gain' else 'inventory' end,
    null::uuid,0::numeric,abs(av.value)::numeric
  from public.inventory_adjustments a join adjustment_values av on av.id=a.id
  where a.organization_id=p_organization_id and av.value<>0
    and timezone('Asia/Bangkok',a.created_at)::date between p_from and p_to
    and (p_branch_id is null or a.branch_id=p_branch_id)

  -- Manual/opening/adjustment journals.
  union all
  select e.entry_date,e.branch_id,e.currency,'manual_journal',e.id,e.journal_number,e.description,
    null::text,l.account_id,l.debit::numeric,l.credit::numeric
  from public.accounting_journal_entries e
  join public.accounting_journal_lines l on l.journal_entry_id=e.id
  where e.organization_id=p_organization_id and e.status='posted'
    and e.entry_date between p_from and p_to
    and (p_branch_id is null or e.branch_id=p_branch_id)
),
resolved as (
  select r.*,coalesce(r.direct_account_id,m.account_id) as resolved_account_id
  from raw r left join mappings m on m.mapping_key=r.mapping_key
)
select r.entry_date,r.branch_id,b.name,r.currency,r.source_type,r.source_id,r.source_number,r.description,
  a.id,a.code,a.name,a.account_type,a.normal_balance,round(r.debit,2),round(r.credit,2)
from resolved r
join public.accounting_accounts a on a.id=r.resolved_account_id and a.organization_id=p_organization_id
left join public.branches b on b.id=r.branch_id
where r.debit<>0 or r.credit<>0
$$;

revoke all on function private.accounting_source_lines(uuid,uuid,date,date) from public;
grant execute on function private.accounting_source_lines(uuid,uuid,date,date) to authenticated,service_role;

commit;
