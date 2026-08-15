-- ============================================================================
-- Tiny POS - Step 37: Production Hardening, System Health and Error Recovery
-- Run once in the NEW Supabase project after Step 36.
--
-- Adds:
--   * System health and data-integrity checks
--   * Authenticated frontend error logging with duplicate suppression
--   * Safe housekeeping for expired operational records
--   * Owner/admin diagnostics history
--
-- Health checks never modify business quantities. Safe maintenance only expires
-- or cleans temporary operational records; it does not repair stock or money.
-- ============================================================================

begin;

insert into public.permission_definitions (
  permission_key,module_key,label,description,risk_level,
  default_roles,approval_action,sort_order
)
values (
  'system_health.manage','System','Manage System Health',
  'Run production diagnostics, review application errors and perform safe housekeeping.',
  'critical',array['owner','admin']::public.app_role[],false,260
)
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

create table if not exists public.system_error_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  severity text not null default 'error'
    check(severity in('info','warning','error','critical')),
  source text not null default 'frontend'
    check(length(trim(source)) between 2 and 40),
  fingerprint text not null,
  message text not null check(length(trim(message)) between 1 and 4000),
  stack text,
  route text,
  release text,
  user_agent text,
  context jsonb not null default '{}'::jsonb,
  occurrence_count integer not null default 1 check(occurrence_count>0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists system_error_logs_org_open_idx
  on public.system_error_logs(organization_id,resolved_at,last_seen_at desc);
create index if not exists system_error_logs_fingerprint_idx
  on public.system_error_logs(organization_id,fingerprint,last_seen_at desc);

drop trigger if exists set_system_error_logs_updated_at on public.system_error_logs;
create trigger set_system_error_logs_updated_at
before update on public.system_error_logs
for each row execute function public.set_updated_at();

create table if not exists public.system_health_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  all_branches boolean not null default false,
  requested_by uuid references public.profiles(id) on delete set null,
  trigger_source text not null default 'manual'
    check(trigger_source in('manual','scheduled','deployment')),
  release text,
  overall_status text not null
    check(overall_status in('healthy','warning','critical')),
  score integer not null check(score between 0 and 100),
  check_count integer not null default 0,
  passed_count integer not null default 0,
  warning_count integer not null default 0,
  critical_count integer not null default 0,
  checks jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists system_health_runs_org_date_idx
  on public.system_health_runs(organization_id,generated_at desc);

alter table public.system_error_logs enable row level security;
alter table public.system_health_runs enable row level security;

drop policy if exists system_error_logs_read_admin on public.system_error_logs;
create policy system_error_logs_read_admin on public.system_error_logs
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and private.has_permission('system_health.manage',auth.uid())
);

drop policy if exists system_health_runs_read_admin on public.system_health_runs;
create policy system_health_runs_read_admin on public.system_health_runs
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and private.has_permission('system_health.manage',auth.uid())
);

revoke all on public.system_error_logs from anon;
revoke all on public.system_health_runs from anon;
grant select on public.system_error_logs to authenticated;
grant select on public.system_health_runs to authenticated;
grant all on public.system_error_logs to service_role;
grant all on public.system_health_runs to service_role;

create or replace function private.system_health_check(
  p_key text,p_label text,p_count bigint,p_severity text,p_detail text,p_path text
) returns jsonb language sql immutable set search_path=public,private,auth,pg_temp as $$
  select jsonb_build_object(
    'key',p_key,'label',p_label,'count',coalesce(p_count,0),
    'severity',p_severity,
    'status',case when coalesce(p_count,0)=0 then 'pass' else 'fail' end,
    'detail',p_detail,'path',p_path
  )
$$;
revoke all on function private.system_health_check(text,text,bigint,text,text,text) from public;
grant execute on function private.system_health_check(text,text,bigint,text,text,text) to authenticated,service_role;

create or replace function public.log_client_error(
  p_message text,
  p_stack text default null,
  p_route text default null,
  p_release text default null,
  p_user_agent text default null,
  p_context jsonb default '{}'::jsonb,
  p_severity text default 'error',
  p_source text default 'frontend'
) returns uuid
language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_user uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_fingerprint text;
  v_existing uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select * into v_profile from public.profiles where id=v_user and is_active=true;
  if not found then raise exception 'Active POS profile required'; end if;
  if p_message is null or length(trim(p_message))=0 then raise exception 'Error message required'; end if;
  if p_severity not in('info','warning','error','critical') then p_severity:='error'; end if;
  v_fingerprint:=md5(
    left(coalesce(p_source,'frontend'),40)||'|'||
    left(trim(p_message),1000)||'|'||
    left(coalesce(p_stack,''),2000)||'|'||
    left(coalesce(p_route,''),300)
  );
  select id into v_existing from public.system_error_logs
   where organization_id=v_profile.organization_id
     and fingerprint=v_fingerprint and resolved_at is null
     and last_seen_at>=now()-interval '10 minutes'
   order by last_seen_at desc limit 1 for update;
  if found then
    update public.system_error_logs set
      occurrence_count=occurrence_count+1,last_seen_at=now(),
      context=coalesce(p_context,'{}'::jsonb),
      release=nullif(left(trim(coalesce(p_release,'')),120),''),
      user_agent=nullif(left(trim(coalesce(p_user_agent,'')),1000),''),
      updated_at=now()
    where id=v_existing;
    return v_existing;
  end if;
  insert into public.system_error_logs(
    organization_id,branch_id,user_id,severity,source,fingerprint,message,stack,
    route,release,user_agent,context
  ) values(
    v_profile.organization_id,v_profile.branch_id,v_user,p_severity,
    left(coalesce(nullif(trim(p_source),''),'frontend'),40),v_fingerprint,
    left(trim(p_message),4000),nullif(left(coalesce(p_stack,''),12000),''),
    nullif(left(coalesce(p_route,''),500),''),
    nullif(left(coalesce(p_release,''),120),''),
    nullif(left(coalesce(p_user_agent,''),1000),''),coalesce(p_context,'{}'::jsonb)
  ) returning id into v_existing;
  return v_existing;
end $$;
revoke all on function public.log_client_error(text,text,text,text,text,jsonb,text,text) from public,anon;
grant execute on function public.log_client_error(text,text,text,text,text,jsonb,text,text) to authenticated,service_role;

create or replace function public.resolve_system_error(
  p_error_id uuid,p_note text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_user uuid:=auth.uid(); v_profile public.profiles%rowtype; v_row public.system_error_logs%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('system_health.manage');
  select * into v_profile from public.profiles where id=v_user and is_active=true;
  update public.system_error_logs set resolved_at=now(),resolved_by=v_user,
    resolution_note=nullif(trim(p_note),''),updated_at=now()
   where id=p_error_id and organization_id=v_profile.organization_id
   returning * into v_row;
  if not found then raise exception 'System error not found'; end if;
  return to_jsonb(v_row)||jsonb_build_object('ok',true);
end $$;
revoke all on function public.resolve_system_error(uuid,text) from public,anon;
grant execute on function public.resolve_system_error(uuid,text) to authenticated,service_role;

create or replace function private.perform_system_health_check(
  p_organization_id uuid,p_branch_id uuid,p_all_branches boolean,
  p_requested_by uuid,p_trigger_source text,p_release text
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_checks jsonb:='[]'::jsonb;
  v_count bigint;
  v_warning integer:=0;
  v_critical integer:=0;
  v_total integer:=0;
  v_status text;
  v_score integer;
  v_run public.system_health_runs%rowtype;
  v_today date:=current_date;
begin
  select (timezone(coalesce(nullif(trim(s.timezone),''),'Asia/Phnom_Penh'),now()))::date
    into v_today from public.app_settings s where s.organization_id=p_organization_id;
  v_today:=coalesce(v_today,current_date);

  select count(*) into v_count
  from public.inventory_balances b
  join public.products p on p.id=b.product_id
  join public.app_settings s on s.organization_id=b.organization_id
  where b.organization_id=p_organization_id
    and (p_all_branches or b.branch_id=p_branch_id)
    and b.quantity < -0.0005
    and coalesce(p.allow_negative_stock,false)=false
    and coalesce(s.allow_negative_stock,false)=false;
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'illegal_negative_inventory','Illegal negative inventory',v_count,'critical',
    'Stock is below zero where negative inventory is not allowed.','/inventory'));
  if v_count>0 then v_critical:=v_critical+1; end if; v_total:=v_total+1;

  select count(*) into v_count from (
    select p.id,b.branch_id,b.quantity,coalesce(sum(batch.quantity),0) batch_quantity
    from public.products p
    join public.inventory_balances b on b.product_id=p.id
    left join public.inventory_batches batch
      on batch.product_id=p.id and batch.branch_id=b.branch_id
    where p.organization_id=p_organization_id and p.batch_tracking=true
      and (p_all_branches or b.branch_id=p_branch_id)
    group by p.id,b.branch_id,b.quantity
    having abs(b.quantity-coalesce(sum(batch.quantity),0))>0.0005
  ) mismatches;
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'batch_balance_mismatch','Batch totals do not match inventory',v_count,'critical',
    'Aggregate stock and traceable batch quantities differ. Assign or correct batches before selling.','/batches'));
  if v_count>0 then v_critical:=v_critical+1; end if; v_total:=v_total+1;

  select count(*) into v_count from public.inventory_batches b
   where b.organization_id=p_organization_id and (p_all_branches or b.branch_id=p_branch_id)
     and b.status='active' and b.quantity>0 and b.expiry_date is not null and b.expiry_date<v_today;
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'expired_active_batches','Expired batches still active',v_count,'warning',
    'Expired stock should be quarantined, returned or written off.','/batches'));
  if v_count>0 then v_warning:=v_warning+1; end if; v_total:=v_total+1;

  select count(*) into v_count from (
    select r.branch_id,r.product_id,
      sum(r.reserved_base_quantity-r.delivered_base_quantity-r.released_base_quantity) reserved,
      private.sales_order_sellable_base(p_organization_id,r.branch_id,r.product_id) sellable
    from public.stock_reservations r
    join public.sales_orders o on o.id=r.sales_order_id
    where r.organization_id=p_organization_id and (p_all_branches or r.branch_id=p_branch_id)
      and r.status='active' and o.status in('confirmed','partially_delivered')
    group by r.branch_id,r.product_id
    having sum(r.reserved_base_quantity-r.delivered_base_quantity-r.released_base_quantity)
      > private.sales_order_sellable_base(p_organization_id,r.branch_id,r.product_id)+0.0005
  ) over_reserved;
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'over_reserved_stock','Reservations exceed sellable stock',v_count,'critical',
    'Customer-order reservations are greater than currently sellable inventory.','/sales-orders'));
  if v_count>0 then v_critical:=v_critical+1; end if; v_total:=v_total+1;

  select count(*) into v_count from public.sales_order_deliveries d
   where d.organization_id=p_organization_id and (p_all_branches or d.branch_id=p_branch_id)
     and d.status='draft' and d.created_at<now()-interval '24 hours';
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'stale_draft_deliveries','Draft deliveries older than 24 hours',v_count,'warning',
    'Review or cancel abandoned delivery notes.','/sales-orders'));
  if v_count>0 then v_warning:=v_warning+1; end if; v_total:=v_total+1;

  select count(*) into v_count from public.purchase_items i
  join public.purchases p on p.id=i.purchase_id
  where p.organization_id=p_organization_id and (p_all_branches or p.branch_id=p_branch_id)
    and (i.received_quantity>i.quantity+0.0005 or i.base_received_quantity>i.base_quantity+0.0005);
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'purchase_receipt_overage','Purchase received quantity exceeds order',v_count,'critical',
    'A purchase line contains more received stock than ordered.','/purchase-orders'));
  if v_count>0 then v_critical:=v_critical+1; end if; v_total:=v_total+1;

  select count(*) into v_count from (
    select a.id,a.balance_due,coalesce(sum(e.amount_change),0) ledger_balance
    from public.customer_credit_accounts a
    left join public.customer_credit_entries e on e.account_id=a.id
    where a.organization_id=p_organization_id
    group by a.id,a.balance_due
    having abs(a.balance_due-coalesce(sum(e.amount_change),0))>0.01
  ) credit_mismatch;
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'credit_ledger_mismatch','Customer credit ledger mismatch',v_count,'critical',
    'Stored customer balance does not equal the credit ledger total.','/credit-accounts'));
  if v_count>0 then v_critical:=v_critical+1; end if; v_total:=v_total+1;

  select count(*) into v_count from public.cash_register_sessions s
   where s.organization_id=p_organization_id and (p_all_branches or s.branch_id=p_branch_id)
     and s.status='open' and s.opened_at<now()-interval '24 hours';
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'long_open_registers','Cash registers open over 24 hours',v_count,'warning',
    'Close and reconcile registers that were left open.','/cash-register'));
  if v_count>0 then v_warning:=v_warning+1; end if; v_total:=v_total+1;

  select count(*) into v_count from public.approval_requests a
   where a.organization_id=p_organization_id and (p_all_branches or a.branch_id=p_branch_id)
     and a.status='pending' and a.expires_at<now();
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'expired_pending_approvals','Expired approvals still pending',v_count,'warning',
    'Run safe maintenance to close expired one-time approvals.','/access-control'));
  if v_count>0 then v_warning:=v_warning+1; end if; v_total:=v_total+1;

  select count(*) into v_count from public.system_error_logs e
   where e.organization_id=p_organization_id and e.resolved_at is null
     and e.last_seen_at>=now()-interval '24 hours'
     and e.severity in('error','critical');
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'recent_application_errors','Unresolved application errors in 24 hours',v_count,'warning',
    'Review captured frontend errors and mark verified issues resolved.','/system-health'));
  if v_count>0 then v_warning:=v_warning+1; end if; v_total:=v_total+1;

  select count(*) into v_count from public.telegram_notification_deliveries d
   where d.organization_id=p_organization_id and d.status='failed'
     and d.created_at>=now()-interval '24 hours';
  v_checks:=v_checks||jsonb_build_array(private.system_health_check(
    'failed_telegram_deliveries','Failed Telegram deliveries in 24 hours',v_count,'warning',
    'Check Telegram bot configuration and inactive or blocked chats.','/telegram'));
  if v_count>0 then v_warning:=v_warning+1; end if; v_total:=v_total+1;

  v_status:=case when v_critical>0 then 'critical' when v_warning>0 then 'warning' else 'healthy' end;
  v_score:=greatest(0,100-v_critical*18-v_warning*7);

  insert into public.system_health_runs(
    organization_id,branch_id,all_branches,requested_by,trigger_source,release,
    overall_status,score,check_count,passed_count,warning_count,critical_count,checks
  ) values(
    p_organization_id,case when p_all_branches then null else p_branch_id end,
    p_all_branches,p_requested_by,coalesce(p_trigger_source,'manual'),nullif(trim(p_release),''),
    v_status,v_score,v_total,v_total-v_warning-v_critical,v_warning,v_critical,v_checks
  ) returning * into v_run;
  return to_jsonb(v_run)||jsonb_build_object('ok',true);
end $$;
revoke all on function private.perform_system_health_check(uuid,uuid,boolean,uuid,text,text) from public;
grant execute on function private.perform_system_health_check(uuid,uuid,boolean,uuid,text,text) to authenticated,service_role;

create or replace function public.run_system_health_check(
  p_all_branches boolean default false,p_release text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_user uuid:=auth.uid(); v_profile public.profiles%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('system_health.manage');
  select * into v_profile from public.profiles where id=v_user and is_active=true;
  if not found then raise exception 'Active POS profile required'; end if;
  if p_all_branches and v_profile.role not in('owner','admin') then
    raise exception 'Only an owner or admin can check all branches';
  end if;
  return private.perform_system_health_check(
    v_profile.organization_id,v_profile.branch_id,coalesce(p_all_branches,false),
    v_user,'manual',p_release
  );
end $$;
revoke all on function public.run_system_health_check(boolean,text) from public,anon;
grant execute on function public.run_system_health_check(boolean,text) to authenticated,service_role;

create or replace function public.run_system_health_check_service(
  p_organization_id uuid,p_release text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
begin
  return private.perform_system_health_check(
    p_organization_id,null,true,null,'scheduled',p_release
  );
end $$;
revoke all on function public.run_system_health_check_service(uuid,text) from public,anon,authenticated;
grant execute on function public.run_system_health_check_service(uuid,text) to service_role;

create or replace function public.run_safe_system_maintenance()
returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_user uuid:=auth.uid(); v_profile public.profiles%rowtype;
  v_approvals integer:=0; v_quotes integer:=0; v_codes integer:=0; v_deliveries integer:=0;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('system_health.manage');
  select * into v_profile from public.profiles where id=v_user and is_active=true;
  if not found then raise exception 'Active POS profile required'; end if;

  update public.approval_requests set status='expired',updated_at=now()
   where organization_id=v_profile.organization_id and status='pending' and expires_at<now();
  get diagnostics v_approvals=row_count;

  update public.sales_quotes set status='expired',updated_at=now()
   where organization_id=v_profile.organization_id
     and status in('draft','sent','accepted') and valid_until is not null and valid_until<current_date;
  get diagnostics v_quotes=row_count;

  delete from public.telegram_link_codes
   where organization_id=v_profile.organization_id
     and (expires_at<now()-interval '7 days' or used_at<now()-interval '7 days');
  get diagnostics v_codes=row_count;

  update public.telegram_notification_deliveries set
    status='failed',error_message=coalesce(error_message,'Delivery remained pending for over one hour')
   where organization_id=v_profile.organization_id and status='pending'
     and created_at<now()-interval '1 hour';
  get diagnostics v_deliveries=row_count;

  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_profile.organization_id,v_profile.branch_id,v_user,'run_safe_system_maintenance',
    'system_health',v_profile.organization_id,jsonb_build_object(
      'expired_approvals',v_approvals,'expired_quotes',v_quotes,
      'deleted_link_codes',v_codes,'failed_stale_deliveries',v_deliveries));

  return jsonb_build_object('ok',true,'expired_approvals',v_approvals,
    'expired_quotes',v_quotes,'deleted_link_codes',v_codes,
    'failed_stale_deliveries',v_deliveries);
end $$;
revoke all on function public.run_safe_system_maintenance() from public,anon;
grant execute on function public.run_safe_system_maintenance() to authenticated,service_role;

commit;
-- ============================================================================
-- END STEP 37
-- ============================================================================
