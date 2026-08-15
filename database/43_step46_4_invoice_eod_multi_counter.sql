-- ============================================================================
-- Tiny POS - Step 46.4: Invoice user filter, End-of-Day, multi-counter register
-- Run ONCE after database/42_step46_stock_count_bulk_save.sql.
-- Additive migration. Do not rerun older migrations.
-- ============================================================================
begin;

alter table public.payments add column if not exists register_session_id uuid references public.cash_register_sessions(id) on delete set null;
alter table public.returns add column if not exists register_session_id uuid references public.cash_register_sessions(id) on delete set null;
alter table public.cash_entries add column if not exists register_session_id uuid references public.cash_register_sessions(id) on delete set null;
alter table public.purchase_payments add column if not exists register_session_id uuid references public.cash_register_sessions(id) on delete set null;

create index if not exists payments_register_session_idx on public.payments(register_session_id);
create index if not exists returns_register_session_idx on public.returns(register_session_id);
create index if not exists cash_entries_register_session_idx on public.cash_entries(register_session_id);
create index if not exists purchase_payments_register_session_idx on public.purchase_payments(register_session_id);

drop index if exists public.cash_register_one_open_per_branch_uq;
create unique index if not exists cash_register_sessions_one_open_per_counter_idx
  on public.cash_register_sessions(branch_id, lower(register_name))
  where status = 'open';
create unique index if not exists cash_register_sessions_one_open_per_user_idx
  on public.cash_register_sessions(branch_id, opened_by)
  where status = 'open';

create or replace function private.current_user_register_session(p_organization_id uuid, p_branch_id uuid)
returns uuid language sql stable security definer
set search_path = public, private, auth, pg_temp
as $$
  select s.id
  from public.cash_register_sessions s
  where s.organization_id = p_organization_id
    and s.branch_id = p_branch_id
    and s.status = 'open'
    and s.opened_by = auth.uid()
  order by s.opened_at desc
  limit 1
$$;

create or replace function private.assign_register_session()
returns trigger language plpgsql security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  if new.register_session_id is null and auth.uid() is not null then
    new.register_session_id := private.current_user_register_session(new.organization_id, new.branch_id);
  end if;
  return new;
end;
$$;

drop trigger if exists assign_payment_register_session on public.payments;
create trigger assign_payment_register_session before insert on public.payments for each row execute function private.assign_register_session();
drop trigger if exists assign_return_register_session on public.returns;
create trigger assign_return_register_session before insert on public.returns for each row execute function private.assign_register_session();
drop trigger if exists assign_cash_entry_register_session on public.cash_entries;
create trigger assign_cash_entry_register_session before insert on public.cash_entries for each row execute function private.assign_register_session();
drop trigger if exists assign_purchase_payment_register_session on public.purchase_payments;
create trigger assign_purchase_payment_register_session before insert on public.purchase_payments for each row execute function private.assign_register_session();

create or replace function private.cash_register_summary(
  p_session_id uuid,
  p_end_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_end_at timestamptz;

  v_sales_usd numeric(14,2) := 0;
  v_sales_khr numeric(14,2) := 0;

  v_refunds_usd numeric(14,2) := 0;
  v_refunds_khr numeric(14,2) := 0;

  v_income_usd numeric(14,2) := 0;
  v_income_khr numeric(14,2) := 0;

  v_expenses_usd numeric(14,2) := 0;
  v_expenses_khr numeric(14,2) := 0;

  v_supplier_usd numeric(14,2) := 0;
  v_supplier_khr numeric(14,2) := 0;

  v_expected_usd numeric(14,2);
  v_expected_khr numeric(14,2);
begin
  select *
  into v_session
  from public.cash_register_sessions
  where id = p_session_id;

  if not found then
    raise exception 'Cash register session not found';
  end if;

  v_end_at := coalesce(
    v_session.closed_at,
    p_end_at,
    now()
  );

  select
    coalesce(sum(case when p.currency = 'USD' then p.amount else 0 end), 0),
    coalesce(sum(case when p.currency = 'KHR' then p.amount else 0 end), 0)
  into v_sales_usd, v_sales_khr
  from public.payments p
  where p.organization_id = v_session.organization_id
    and p.branch_id = v_session.branch_id
    and p.method = 'cash'
    and (
      p.register_session_id = v_session.id
      or (
        p.register_session_id is null
        and p.paid_at >= v_session.opened_at
        and p.paid_at <= v_end_at
        and exists (select 1 from public.sales s where s.id = p.sale_id and s.cashier_id = v_session.opened_by)
      )
    );

  select
    coalesce(sum(case when r.currency = 'USD' then r.refund_amount else 0 end), 0),
    coalesce(sum(case when r.currency = 'KHR' then r.refund_amount else 0 end), 0)
  into v_refunds_usd, v_refunds_khr
  from public.returns r
  where r.organization_id = v_session.organization_id
    and r.branch_id = v_session.branch_id
    and r.status = 'completed'
    and r.refund_method = 'cash'
    and (
      r.register_session_id = v_session.id
      or (
        r.register_session_id is null
        and r.processed_at >= v_session.opened_at
        and r.processed_at <= v_end_at
        and r.processed_by = v_session.opened_by
      )
    );

  select
    coalesce(sum(
      case
        when e.direction = 'income' and e.currency = 'USD'
          then e.amount
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when e.direction = 'income' and e.currency = 'KHR'
          then e.amount
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when e.direction = 'expense' and e.currency = 'USD'
          then e.amount
        else 0
      end
    ), 0),
    coalesce(sum(
      case
        when e.direction = 'expense' and e.currency = 'KHR'
          then e.amount
        else 0
      end
    ), 0)
  into
    v_income_usd,
    v_income_khr,
    v_expenses_usd,
    v_expenses_khr
  from public.cash_entries e
  where e.organization_id = v_session.organization_id
    and e.branch_id = v_session.branch_id
    and e.status = 'active'
    and e.method = 'cash'
    and (
      e.register_session_id = v_session.id
      or (
        e.register_session_id is null
        and e.entry_at >= v_session.opened_at
        and e.entry_at <= v_end_at
        and e.created_by = v_session.opened_by
      )
    );

  select
    coalesce(sum(case when p.currency = 'USD' then p.amount else 0 end), 0),
    coalesce(sum(case when p.currency = 'KHR' then p.amount else 0 end), 0)
  into v_supplier_usd, v_supplier_khr
  from public.purchase_payments p
  where p.organization_id = v_session.organization_id
    and p.branch_id = v_session.branch_id
    and p.method = 'cash'
    and (
      p.register_session_id = v_session.id
      or (
        p.register_session_id is null
        and p.paid_at >= v_session.opened_at
        and p.paid_at <= v_end_at
        and p.paid_by = v_session.opened_by
      )
    );

  v_expected_usd := round(
    v_session.opening_cash_usd
    + v_sales_usd
    - v_refunds_usd
    + v_income_usd
    - v_expenses_usd
    - v_supplier_usd,
    2
  );

  v_expected_khr := round(
    v_session.opening_cash_khr
    + v_sales_khr
    - v_refunds_khr
    + v_income_khr
    - v_expenses_khr
    - v_supplier_khr,
    2
  );

  return jsonb_build_object(
    'session',
    to_jsonb(v_session),
    'totals',
    jsonb_build_object(
      'USD',
      jsonb_build_object(
        'opening', v_session.opening_cash_usd,
        'cash_sales', v_sales_usd,
        'cash_refunds', v_refunds_usd,
        'cash_income', v_income_usd,
        'cash_expenses', v_expenses_usd,
        'supplier_payments', v_supplier_usd,
        'expected', v_expected_usd,
        'counted', v_session.counted_cash_usd,
        'variance', v_session.variance_usd
      ),
      'KHR',
      jsonb_build_object(
        'opening', v_session.opening_cash_khr,
        'cash_sales', v_sales_khr,
        'cash_refunds', v_refunds_khr,
        'cash_income', v_income_khr,
        'cash_expenses', v_expenses_khr,
        'supplier_payments', v_supplier_khr,
        'expected', v_expected_khr,
        'counted', v_session.counted_cash_khr,
        'variance', v_session.variance_khr
      )
    )
  );
end;
$$;

revoke all on function private.cash_register_summary(
  uuid,
  timestamptz
) from public;

grant execute on function private.cash_register_summary(
  uuid,
  timestamptz
) to authenticated, service_role;


create or replace function public.open_cash_register_v2(
  p_opening_cash_usd numeric default 0,
  p_opening_cash_khr numeric default 0,
  p_register_name text default 'Main Register',
  p_opening_note text default null
) returns jsonb language plpgsql security definer
set search_path = public, private, auth, pg_temp
as $$
declare v_user uuid := auth.uid(); v_profile record; v_id uuid; v_number text;
begin
  perform private.require_permission('cash_register.use');
  select organization_id, branch_id, is_active into v_profile from public.profiles where id=v_user;
  if not found or not v_profile.is_active or v_profile.branch_id is null then raise exception 'Active POS profile and branch are required'; end if;
  if coalesce(p_opening_cash_usd,0)<0 or coalesce(p_opening_cash_khr,0)<0 then raise exception 'Opening cash cannot be negative'; end if;
  if nullif(trim(p_register_name),'') is null then raise exception 'Register name is required'; end if;
  perform pg_advisory_xact_lock(hashtext('tiny-pos-register:'||v_profile.branch_id::text||':'||lower(trim(p_register_name))));
  if exists(select 1 from public.cash_register_sessions where branch_id=v_profile.branch_id and status='open' and opened_by=v_user) then raise exception 'You already have an open register session'; end if;
  if exists(select 1 from public.cash_register_sessions where branch_id=v_profile.branch_id and status='open' and lower(register_name)=lower(trim(p_register_name))) then raise exception 'This counter already has an open session'; end if;
  v_number := private.next_document_number(v_profile.organization_id,v_profile.branch_id,'REG');
  insert into public.cash_register_sessions(organization_id,branch_id,session_number,register_name,status,opening_cash_usd,opening_cash_khr,opening_note,opened_by,opened_at)
  values(v_profile.organization_id,v_profile.branch_id,v_number,trim(p_register_name),'open',round(coalesce(p_opening_cash_usd,0),2),round(coalesce(p_opening_cash_khr,0),2),nullif(trim(p_opening_note),''),v_user,now()) returning id into v_id;
  return private.cash_register_summary(v_id,now());
end;$$;

create or replace function public.get_open_cash_register_summary()
returns jsonb language plpgsql security definer
set search_path = public, private, auth, pg_temp
as $$
declare v_user uuid:=auth.uid(); v_profile record; v_id uuid;
begin
  select organization_id,branch_id,is_active into v_profile from public.profiles where id=v_user;
  if not found or not v_profile.is_active then raise exception 'Active POS profile required'; end if;
  select id into v_id from public.cash_register_sessions where organization_id=v_profile.organization_id and branch_id=v_profile.branch_id and status='open' and opened_by=v_user order by opened_at desc limit 1;
  if v_id is null then return jsonb_build_object('session',null,'totals',null); end if;
  return private.cash_register_summary(v_id,now());
end;$$;

create or replace function public.close_cash_register_v2(
  p_counted_cash_usd numeric,
  p_counted_cash_khr numeric,
  p_closing_note text default null,
  p_session_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = public, private, auth, pg_temp
as $$
declare v_user uuid:=auth.uid(); v_profile record; v_session public.cash_register_sessions%rowtype; v_summary jsonb; v_now timestamptz:=now(); v_eu numeric; v_ek numeric; v_cu numeric; v_ck numeric; v_override boolean:=false;
begin
  perform private.require_permission('cash_register.close');
  select organization_id,branch_id,role,is_active into v_profile from public.profiles where id=v_user;
  if not found or not v_profile.is_active then raise exception 'Active POS profile required'; end if;
  v_override := v_profile.role in ('owner','admin','manager');
  select * into v_session from public.cash_register_sessions where organization_id=v_profile.organization_id and branch_id=v_profile.branch_id and status='open' and (id=coalesce(p_session_id,id)) and (opened_by=v_user or v_override) order by opened_at desc limit 1 for update;
  if not found then raise exception 'No permitted open register session was found'; end if;
  v_summary:=private.cash_register_summary(v_session.id,v_now);
  v_eu:=coalesce((v_summary#>>'{totals,USD,expected}')::numeric,0); v_ek:=coalesce((v_summary#>>'{totals,KHR,expected}')::numeric,0);
  v_cu:=round(coalesce(p_counted_cash_usd,0),2); v_ck:=round(coalesce(p_counted_cash_khr,0),2);
  update public.cash_register_sessions set status='closed',expected_cash_usd=v_eu,expected_cash_khr=v_ek,counted_cash_usd=v_cu,counted_cash_khr=v_ck,variance_usd=v_cu-v_eu,variance_khr=v_ck-v_ek,closing_note=nullif(trim(p_closing_note),''),closed_by=v_user,closed_at=v_now,updated_at=v_now where id=v_session.id;
  return private.cash_register_summary(v_session.id,v_now);
end;$$;

create or replace function public.get_end_of_day_report(
  p_from date, p_to date, p_branch_id uuid default null, p_cashier_id uuid default null, p_register_name text default null
) returns jsonb language plpgsql security definer
set search_path = public, private, auth, pg_temp
as $$
declare v_user uuid:=auth.uid(); v_profile record; v_from date:=coalesce(p_from,current_date); v_to date:=coalesce(p_to,current_date); v_branch uuid; v_all boolean; v_tz text:='Asia/Phnom_Penh';
begin
  perform private.require_permission('reports.view');
  select organization_id,branch_id,role,is_active into v_profile from public.profiles where id=v_user;
  if not found or not v_profile.is_active then raise exception 'Active POS profile required'; end if;
  v_all:=v_profile.role in ('owner','admin') and p_branch_id is null; v_branch:=case when v_all then null when v_profile.role in ('owner','admin') then coalesce(p_branch_id,v_profile.branch_id) else v_profile.branch_id end;
  select coalesce(nullif(trim(timezone),''),'Asia/Phnom_Penh') into v_tz from public.app_settings where organization_id=v_profile.organization_id;
  return jsonb_build_object(
    'from',v_from,'to',v_to,
    'summary',(select jsonb_build_object('invoice_count',count(distinct s.id),'gross_sales',coalesce(sum(s.total_amount),0),'refunds',coalesce(sum(r.refund_amount),0),'net_sales',coalesce(sum(s.total_amount),0)-coalesce(sum(r.refund_amount),0)) from public.sales s left join public.returns r on r.original_sale_id=s.id and r.status='completed' where s.organization_id=v_profile.organization_id and (v_all or s.branch_id=v_branch) and (timezone(v_tz,coalesce(s.completed_at,s.created_at)))::date between v_from and v_to and (p_cashier_id is null or s.cashier_id=p_cashier_id)),
    'payments',(select coalesce(jsonb_agg(x order by x.method), '[]'::jsonb) from (select p.method::text method,p.currency::text currency,count(*) transaction_count,sum(p.amount) amount from public.payments p join public.sales s on s.id=p.sale_id where p.organization_id=v_profile.organization_id and (v_all or p.branch_id=v_branch) and (timezone(v_tz,p.paid_at))::date between v_from and v_to and (p_cashier_id is null or s.cashier_id=p_cashier_id) group by p.method,p.currency) x),
    'cashiers',(select coalesce(jsonb_agg(x order by x.net_sales desc),'[]'::jsonb) from (select s.cashier_id,p.full_name cashier_name,count(*) invoice_count,sum(s.total_amount) gross_sales,coalesce(sum((select sum(rr.refund_amount) from public.returns rr where rr.original_sale_id=s.id and rr.status='completed')),0) refunds,sum(s.total_amount)-coalesce(sum((select sum(rr.refund_amount) from public.returns rr where rr.original_sale_id=s.id and rr.status='completed')),0) net_sales from public.sales s left join public.profiles p on p.id=s.cashier_id where s.organization_id=v_profile.organization_id and (v_all or s.branch_id=v_branch) and (timezone(v_tz,coalesce(s.completed_at,s.created_at)))::date between v_from and v_to and (p_cashier_id is null or s.cashier_id=p_cashier_id) group by s.cashier_id,p.full_name) x),
    'registers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.opened_at desc),'[]'::jsonb) from (select crs.*,op.full_name opened_by_name,cp.full_name closed_by_name from public.cash_register_sessions crs left join public.profiles op on op.id=crs.opened_by left join public.profiles cp on cp.id=crs.closed_by where crs.organization_id=v_profile.organization_id and (v_all or crs.branch_id=v_branch) and (timezone(v_tz,crs.opened_at))::date between v_from and v_to and (p_cashier_id is null or crs.opened_by=p_cashier_id) and (nullif(trim(p_register_name),'') is null or lower(crs.register_name)=lower(trim(p_register_name)))) x)
  );
end;$$;

revoke all on function public.open_cash_register_v2(numeric,numeric,text,text) from public,anon;
grant execute on function public.open_cash_register_v2(numeric,numeric,text,text) to authenticated,service_role;
revoke all on function public.close_cash_register_v2(numeric,numeric,text,uuid) from public,anon;
grant execute on function public.close_cash_register_v2(numeric,numeric,text,uuid) to authenticated,service_role;
revoke all on function public.get_open_cash_register_summary() from public,anon;
grant execute on function public.get_open_cash_register_summary() to authenticated,service_role;
revoke all on function public.get_end_of_day_report(date,date,uuid,uuid,text) from public,anon;
grant execute on function public.get_end_of_day_report(date,date,uuid,uuid,text) to authenticated,service_role;

commit;
