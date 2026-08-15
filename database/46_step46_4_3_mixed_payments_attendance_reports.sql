-- ============================================================================
-- Tiny POS - Step 46.4.3: Dual-currency/mixed tender and attendance reports
-- Run ONCE after database/45_step46_4_2_credit_receiving_recovery.sql.
-- Additive migration. Do not rerun older migrations.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Preserve the invoice currency while recording the actual tender currency.
--    payments.currency / payments.amount remain the sale-currency settlement.
-- ----------------------------------------------------------------------------

alter table public.payments
  add column if not exists tender_currency public.currency_code,
  add column if not exists tender_amount numeric(14,2),
  add column if not exists tender_change_amount numeric(14,2) not null default 0,
  add column if not exists exchange_rate numeric(14,4);

comment on column public.payments.tender_currency is
  'Actual currency received from the customer. payments.currency remains the invoice/settlement currency.';
comment on column public.payments.tender_amount is
  'Actual amount tendered in tender_currency before change.';
comment on column public.payments.tender_change_amount is
  'Change returned in tender_currency.';
comment on column public.payments.exchange_rate is
  'USD to KHR rate used when tender_currency differs from the invoice currency.';

create index if not exists payments_tender_currency_paid_idx
  on public.payments(organization_id, branch_id, tender_currency, paid_at desc);

-- Complete a normal sale with one or more non-credit tenders. The existing
-- complete_sale_v9 function remains the inventory, pricing, quotation, order,
-- coupon and approval source of truth. This wrapper only replaces its temporary
-- payment row with the verified tender rows inside the same transaction.
create or replace function public.complete_sale_v10_tenders(
  p_items jsonb,
  p_payments jsonb,
  p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',
  p_manual_discount_value numeric default 0,
  p_coupon_code text default null,
  p_currency public.currency_code default 'USD',
  p_notes text default null,
  p_idempotency_key text default null,
  p_source_quote_id uuid default null,
  p_approval_request_id uuid default null,
  p_source_sales_order_delivery_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_rate numeric(14,4);
  v_result jsonb;
  v_sale public.sales%rowtype;
  v_sale_id uuid;
  v_total numeric(14,4);
  v_remaining numeric(14,4);
  v_total_received_sale numeric(14,4) := 0;
  v_total_change_sale numeric(14,4) := 0;
  v_row record;
  v_method text;
  v_tender_currency public.currency_code;
  v_tender_amount numeric(14,2);
  v_converted numeric(14,4);
  v_allocation numeric(14,4);
  v_change_sale numeric(14,4);
  v_change_tender numeric(14,2);
  v_payment_rows jsonb := '[]'::jsonb;
  v_count integer;
  v_cash_count integer;
  v_register_session_id uuid;
  v_reference text;
  v_precision integer;
  v_tolerance numeric(14,4);
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id and is_active = true;

  if not found or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if jsonb_typeof(p_payments) <> 'array'
     or jsonb_array_length(p_payments) < 1 then
    raise exception 'At least one payment is required';
  end if;

  select count(*), count(*) filter (
    where lower(trim(coalesce(item.value->>'method',''))) = 'cash'
  )
  into v_count, v_cash_count
  from jsonb_array_elements(p_payments) item;

  if v_count > 6 then
    raise exception 'A receipt can contain at most six payment parts';
  end if;
  if v_cash_count > 1 then
    raise exception 'Use only one cash part per receipt';
  end if;
  if v_cash_count > 0 then
    v_register_session_id := private.current_user_register_session(
      v_profile.organization_id,
      v_profile.branch_id
    );
    if v_register_session_id is null then
      raise exception 'Open your own cash register before accepting cash';
    end if;
  end if;

  for v_row in
    select item.value as value
    from jsonb_array_elements(p_payments) with ordinality item(value, position)
  loop
    v_method := lower(trim(coalesce(v_row.value->>'method','')));
    if v_method not in ('cash','bank','khqr','card','other') then
      raise exception 'Unsupported payment method: %', coalesce(v_method,'');
    end if;

    begin
      v_tender_currency := upper(trim(coalesce(v_row.value->>'currency','USD')))::public.currency_code;
    exception when others then
      raise exception 'Payment currency must be USD or KHR';
    end;

    v_tender_amount := nullif(v_row.value->>'amount_received','')::numeric;
    if v_tender_amount is null or v_tender_amount <= 0 then
      raise exception 'Every payment part requires an amount greater than zero';
    end if;
  end loop;

  select coalesce(nullif(usd_to_khr_rate,0),4100)
  into v_rate
  from public.app_settings
  where organization_id = v_profile.organization_id;
  v_rate := coalesce(v_rate,4100);
  if v_rate <= 0 then raise exception 'USD to KHR exchange rate must be greater than zero'; end if;

  -- Use a temporary non-cash settlement so all established checkout rules run.
  v_result := public.complete_sale_v9(
    p_items,
    'other',
    999999999999.99::numeric,
    p_customer_id,
    p_manual_discount_type,
    p_manual_discount_value,
    p_coupon_code,
    p_currency,
    p_notes,
    'TENDER-TEMPORARY',
    p_idempotency_key,
    p_source_quote_id,
    p_approval_request_id,
    p_source_sales_order_delivery_id
  );

  v_sale_id := (v_result->>'sale_id')::uuid;
  select * into v_sale
  from public.sales
  where id = v_sale_id and organization_id = v_profile.organization_id
  for update;
  if not found then raise exception 'Completed sale could not be loaded'; end if;

  if coalesce((v_result->>'duplicate_request')::boolean,false) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',p.id,
      'method',p.method,
      'settlement_currency',p.currency,
      'settlement_amount',p.amount,
      'tender_currency',coalesce(p.tender_currency,p.currency),
      'tender_amount',coalesce(p.tender_amount,p.tendered_amount,p.amount),
      'change_amount',coalesce(p.tender_change_amount,p.change_amount,0),
      'exchange_rate',coalesce(p.exchange_rate,v_rate),
      'reference_number',p.reference_number
    ) order by p.paid_at,p.id),'[]'::jsonb)
    into v_payment_rows
    from public.payments p where p.sale_id = v_sale.id;

    return v_result || jsonb_build_object(
      'payments',v_payment_rows,
      'payment_method',case when jsonb_array_length(v_payment_rows)>1 then 'split' else coalesce(v_payment_rows->0->>'method','other') end,
      'exchange_rate',v_rate
    );
  end if;

  v_total := round(v_sale.total_amount, case when p_currency='KHR' then 0 else 2 end);
  v_remaining := v_total;
  v_precision := case when p_currency='KHR' then 0 else 2 end;
  v_tolerance := case when p_currency='KHR' then 1 else 0.01 end;

  -- Remove the temporary payment before inserting the real tender allocation.
  delete from public.payments where sale_id = v_sale.id;

  -- Process non-cash first. Cash is processed last so any permitted over-tender
  -- becomes cash change rather than hiding an excessive bank transfer.
  for v_row in
    select item.value as value, item.position
    from jsonb_array_elements(p_payments) with ordinality item(value, position)
    order by case when lower(trim(item.value->>'method'))='cash' then 1 else 0 end,
             item.position
  loop
    v_method := lower(trim(v_row.value->>'method'));
    v_tender_currency := upper(trim(coalesce(v_row.value->>'currency','USD')))::public.currency_code;
    v_tender_amount := round((v_row.value->>'amount_received')::numeric,
      case when v_tender_currency='KHR' then 0 else 2 end);
    v_reference := nullif(left(trim(coalesce(v_row.value->>'reference_number','')),200),'');

    v_converted := case
      when v_tender_currency = p_currency then v_tender_amount
      when v_tender_currency = 'USD' and p_currency = 'KHR' then v_tender_amount * v_rate
      when v_tender_currency = 'KHR' and p_currency = 'USD' then v_tender_amount / v_rate
      else 0
    end;
    v_converted := round(v_converted,v_precision);

    if v_method <> 'cash' and v_converted > v_remaining + v_tolerance then
      raise exception 'Non-cash payment exceeds the remaining balance';
    end if;

    v_allocation := least(v_converted,v_remaining);
    v_change_sale := case when v_method='cash' then greatest(v_converted-v_remaining,0) else 0 end;

    if v_allocation <= 0 then
      raise exception 'Payment parts exceed the invoice total';
    end if;

    v_change_tender := round(case
      when v_change_sale <= 0 then 0
      when v_tender_currency = p_currency then v_change_sale
      when v_tender_currency = 'USD' and p_currency = 'KHR' then v_change_sale / v_rate
      when v_tender_currency = 'KHR' and p_currency = 'USD' then v_change_sale * v_rate
      else 0
    end, case when v_tender_currency='KHR' then 0 else 2 end);

    insert into public.payments(
      organization_id,branch_id,sale_id,method,currency,amount,
      tendered_amount,change_amount,reference_number,received_by,
      tender_currency,tender_amount,tender_change_amount,exchange_rate,
      register_session_id
    ) values(
      v_sale.organization_id,v_sale.branch_id,v_sale.id,v_method::public.payment_method,
      p_currency,round(v_allocation,v_precision),round(v_converted,v_precision),
      round(v_change_sale,v_precision),v_reference,v_user_id,
      v_tender_currency,v_tender_amount,v_change_tender,v_rate,
      case when v_method='cash' then v_register_session_id else null end
    );

    v_payment_rows := v_payment_rows || jsonb_build_array(jsonb_build_object(
      'method',v_method,
      'settlement_currency',p_currency,
      'settlement_amount',round(v_allocation,v_precision),
      'tender_currency',v_tender_currency,
      'tender_amount',v_tender_amount,
      'change_amount',v_change_tender,
      'change_sale_amount',round(v_change_sale,v_precision),
      'exchange_rate',v_rate,
      'reference_number',v_reference
    ));

    v_total_received_sale := v_total_received_sale + v_converted;
    v_total_change_sale := v_total_change_sale + v_change_sale;
    v_remaining := greatest(round(v_remaining-v_allocation,v_precision),0);
  end loop;

  if v_remaining > v_tolerance then
    raise exception 'Payment is short by % %', v_remaining, p_currency;
  end if;

  update public.sales set
    paid_amount = v_total,
    payment_status = 'paid',
    change_amount = round(v_total_change_sale,v_precision),
    updated_at = now()
  where id = v_sale.id;

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_sale.organization_id,v_sale.branch_id,v_user_id,
    'complete_sale_tenders','sale',v_sale.id,
    jsonb_build_object(
      'invoice_number',v_sale.invoice_number,
      'invoice_currency',p_currency,
      'invoice_total',v_total,
      'exchange_rate',v_rate,
      'payments',v_payment_rows
    )
  );

  return v_result || jsonb_build_object(
    'payment_method',case when jsonb_array_length(v_payment_rows)>1 then 'split' else v_payment_rows->0->>'method' end,
    'payments',v_payment_rows,
    'amount_received',round(v_total_received_sale,v_precision),
    'change_amount',round(v_total_change_sale,v_precision),
    'exchange_rate',v_rate
  );
end;
$$;

revoke all on function public.complete_sale_v10_tenders(
  jsonb,jsonb,uuid,public.discount_type,numeric,text,public.currency_code,
  text,text,uuid,uuid,uuid
) from public,anon;
grant execute on function public.complete_sale_v10_tenders(
  jsonb,jsonb,uuid,public.discount_type,numeric,text,public.currency_code,
  text,text,uuid,uuid,uuid
) to authenticated,service_role;

-- Cash-register totals use the physical tender currency for new payments while
-- retaining the original behaviour for all legacy payment rows.
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
  select * into v_session from public.cash_register_sessions where id=p_session_id;
  if not found then raise exception 'Cash register session not found'; end if;
  v_end_at:=coalesce(v_session.closed_at,p_end_at,now());

  select
    coalesce(sum(case when coalesce(p.tender_currency,p.currency)='USD' then
      case when p.tender_currency is null or p.tender_amount is null
        then p.amount
        else greatest(p.tender_amount-coalesce(p.tender_change_amount,0),0)
      end else 0 end),0),
    coalesce(sum(case when coalesce(p.tender_currency,p.currency)='KHR' then
      case when p.tender_currency is null or p.tender_amount is null
        then p.amount
        else greatest(p.tender_amount-coalesce(p.tender_change_amount,0),0)
      end else 0 end),0)
  into v_sales_usd,v_sales_khr
  from public.payments p
  where p.organization_id=v_session.organization_id
    and p.branch_id=v_session.branch_id
    and p.method='cash'
    and (
      p.register_session_id=v_session.id
      or (p.register_session_id is null and p.paid_at>=v_session.opened_at and p.paid_at<=v_end_at
          and exists(select 1 from public.sales s where s.id=p.sale_id and s.cashier_id=v_session.opened_by))
    );

  select
    coalesce(sum(case when r.currency='USD' then r.refund_amount else 0 end),0),
    coalesce(sum(case when r.currency='KHR' then r.refund_amount else 0 end),0)
  into v_refunds_usd,v_refunds_khr
  from public.returns r
  where r.organization_id=v_session.organization_id and r.branch_id=v_session.branch_id
    and r.status='completed' and r.refund_method='cash'
    and (r.register_session_id=v_session.id or
      (r.register_session_id is null and r.processed_at>=v_session.opened_at and r.processed_at<=v_end_at
       and r.processed_by=v_session.opened_by));

  select
    coalesce(sum(case when e.direction='income' and e.currency='USD' then e.amount else 0 end),0),
    coalesce(sum(case when e.direction='income' and e.currency='KHR' then e.amount else 0 end),0),
    coalesce(sum(case when e.direction='expense' and e.currency='USD' then e.amount else 0 end),0),
    coalesce(sum(case when e.direction='expense' and e.currency='KHR' then e.amount else 0 end),0)
  into v_income_usd,v_income_khr,v_expenses_usd,v_expenses_khr
  from public.cash_entries e
  where e.organization_id=v_session.organization_id and e.branch_id=v_session.branch_id
    and e.status='active' and e.method='cash'
    and (e.register_session_id=v_session.id or
      (e.register_session_id is null and e.entry_at>=v_session.opened_at and e.entry_at<=v_end_at
       and e.created_by=v_session.opened_by));

  select
    coalesce(sum(case when p.currency='USD' then p.amount else 0 end),0),
    coalesce(sum(case when p.currency='KHR' then p.amount else 0 end),0)
  into v_supplier_usd,v_supplier_khr
  from public.purchase_payments p
  where p.organization_id=v_session.organization_id and p.branch_id=v_session.branch_id
    and p.method='cash'
    and (p.register_session_id=v_session.id or
      (p.register_session_id is null and p.paid_at>=v_session.opened_at and p.paid_at<=v_end_at
       and p.paid_by=v_session.opened_by));

  v_expected_usd:=round(v_session.opening_cash_usd+v_sales_usd-v_refunds_usd+v_income_usd-v_expenses_usd-v_supplier_usd,2);
  v_expected_khr:=round(v_session.opening_cash_khr+v_sales_khr-v_refunds_khr+v_income_khr-v_expenses_khr-v_supplier_khr,2);

  return jsonb_build_object('session',to_jsonb(v_session),'totals',jsonb_build_object(
    'USD',jsonb_build_object('opening',v_session.opening_cash_usd,'cash_sales',v_sales_usd,'cash_refunds',v_refunds_usd,'cash_income',v_income_usd,'cash_expenses',v_expenses_usd,'supplier_payments',v_supplier_usd,'expected',v_expected_usd,'counted',v_session.counted_cash_usd,'variance',v_session.variance_usd),
    'KHR',jsonb_build_object('opening',v_session.opening_cash_khr,'cash_sales',v_sales_khr,'cash_refunds',v_refunds_khr,'cash_income',v_income_khr,'cash_expenses',v_expenses_khr,'supplier_payments',v_supplier_khr,'expected',v_expected_khr,'counted',v_session.counted_cash_khr,'variance',v_session.variance_khr)
  ));
end;
$$;

revoke all on function private.cash_register_summary(uuid,timestamptz) from public;
grant execute on function private.cash_register_summary(uuid,timestamptz) to authenticated,service_role;

-- ----------------------------------------------------------------------------
-- 2. Attendance calendar, manual bulk setting, day off and printable summaries.
-- ----------------------------------------------------------------------------

alter table public.app_settings
  add column if not exists attendance_work_start time not null default '07:00',
  add column if not exists attendance_work_end time not null default '17:00',
  add column if not exists attendance_late_grace_minutes integer not null default 10,
  add column if not exists attendance_standard_minutes integer not null default 480;

create table if not exists public.staff_attendance_day_overrides(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete cascade,
  business_date date not null,
  day_type text not null check(day_type in('day_off','leave','absence')),
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,user_id,business_date)
);

create index if not exists staff_attendance_overrides_date_idx
  on public.staff_attendance_day_overrides(organization_id,business_date,branch_id,user_id);

drop trigger if exists set_staff_attendance_day_overrides_updated_at
  on public.staff_attendance_day_overrides;
create trigger set_staff_attendance_day_overrides_updated_at
before update on public.staff_attendance_day_overrides
for each row execute function public.set_updated_at();

alter table public.staff_attendance_day_overrides enable row level security;
drop policy if exists staff_attendance_day_overrides_read on public.staff_attendance_day_overrides;
create policy staff_attendance_day_overrides_read
on public.staff_attendance_day_overrides for select to authenticated
using(
  organization_id=(select private.current_organization_id())
  and (
    user_id=auth.uid()
    or (private.has_permission('attendance.manage',auth.uid()) and private.staff_branch_allowed(branch_id))
  )
);
revoke all on public.staff_attendance_day_overrides from anon;
grant select on public.staff_attendance_day_overrides to authenticated;
grant all on public.staff_attendance_day_overrides to service_role;

create or replace function public.save_manual_attendance_days(
  p_user_id uuid,
  p_branch_id uuid,
  p_month date,
  p_days integer[],
  p_day_type text default 'work',
  p_check_in_time time default '07:00',
  p_check_out_time time default '17:00',
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_org uuid:=private.current_organization_id();
  v_actor uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_timezone text;
  v_month date:=date_trunc('month',p_month)::date;
  v_day integer;
  v_date date;
  v_check_in timestamptz;
  v_check_out timestamptz;
  v_session_id uuid;
  v_saved integer:=0;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('attendance.manage');
  if p_user_id is null then raise exception 'Choose a staff member'; end if;
  if p_branch_id is null then raise exception 'Choose a branch'; end if;
  if p_month is null then raise exception 'Choose a month'; end if;
  if p_days is null or cardinality(p_days)<1 then raise exception 'Choose at least one day'; end if;
  if cardinality(p_days)>31 then raise exception 'Too many selected days'; end if;
  if p_day_type not in('work','day_off','leave','absence') then raise exception 'Invalid attendance type'; end if;
  if p_day_type='work' and (p_check_in_time is null or p_check_out_time is null or p_check_out_time<=p_check_in_time) then
    raise exception 'Check-out time must be after check-in time';
  end if;

  select * into v_profile from public.profiles
  where id=p_user_id and organization_id=v_org and is_active=true;
  if not found then raise exception 'Active staff member not found'; end if;
  if not exists(select 1 from public.branches b where b.id=p_branch_id and b.organization_id=v_org and b.is_active=true) then
    raise exception 'Active branch not found';
  end if;
  if not private.staff_branch_allowed(p_branch_id) then raise exception 'You cannot manage this branch'; end if;
  if not private.has_permission('branches.all',v_actor)
     and v_profile.branch_id is distinct from p_branch_id then
    raise exception 'This staff member is not assigned to your branch';
  end if;

  select coalesce(nullif(trim(timezone),''),'Asia/Phnom_Penh') into v_timezone
  from public.app_settings where organization_id=v_org;
  v_timezone:=coalesce(v_timezone,'Asia/Phnom_Penh');

  foreach v_day in array p_days loop
    if v_day<1 or v_day>31 then raise exception 'Invalid day %',v_day; end if;
    v_date:=v_month+(v_day-1);
    if date_trunc('month',v_date)::date<>v_month then raise exception 'Day % is outside the selected month',v_day; end if;

    if p_day_type='work' then
      v_check_in:=make_timestamptz(extract(year from v_date)::integer,extract(month from v_date)::integer,extract(day from v_date)::integer,
        extract(hour from p_check_in_time)::integer,extract(minute from p_check_in_time)::integer,0,v_timezone);
      v_check_out:=make_timestamptz(extract(year from v_date)::integer,extract(month from v_date)::integer,extract(day from v_date)::integer,
        extract(hour from p_check_out_time)::integer,extract(minute from p_check_out_time)::integer,0,v_timezone);

      select id into v_session_id from public.attendance_sessions
      where organization_id=v_org and user_id=p_user_id and business_date=v_date
      order by check_in_at limit 1 for update;

      if v_session_id is null then
        insert into public.attendance_sessions(
          organization_id,branch_id,user_id,business_date,status,check_in_at,check_out_at,
          check_in_source,check_out_source,check_in_note,check_out_note,total_minutes,
          corrected_at,corrected_by,correction_note
        ) values(
          v_org,p_branch_id,p_user_id,v_date,'closed',v_check_in,v_check_out,
          'admin','admin',nullif(left(trim(coalesce(p_note,'')),500),''),null,
          greatest(0,floor(extract(epoch from(v_check_out-v_check_in))/60)::integer),
          now(),v_actor,'Manual attendance set'
        );
      else
        update public.attendance_sessions set
          branch_id=p_branch_id,status='closed',check_in_at=v_check_in,check_out_at=v_check_out,
          check_in_source='admin',check_out_source='admin',
          check_in_note=nullif(left(trim(coalesce(p_note,'')),500),''),
          total_minutes=greatest(0,floor(extract(epoch from(v_check_out-v_check_in))/60)::integer),
          corrected_at=now(),corrected_by=v_actor,correction_note='Manual attendance set',updated_at=now()
        where id=v_session_id;
      end if;

      delete from public.staff_attendance_day_overrides
      where organization_id=v_org and user_id=p_user_id and business_date=v_date;
    else
      insert into public.staff_attendance_day_overrides(
        organization_id,branch_id,user_id,business_date,day_type,note,created_by
      ) values(
        v_org,p_branch_id,p_user_id,v_date,p_day_type,
        nullif(left(trim(coalesce(p_note,'')),1000),''),v_actor
      )
      on conflict(organization_id,user_id,business_date) do update set
        branch_id=excluded.branch_id,day_type=excluded.day_type,note=excluded.note,
        created_by=v_actor,updated_at=now();
    end if;
    v_saved:=v_saved+1;
    v_session_id:=null;
  end loop;

  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,p_branch_id,v_actor,'set_manual_attendance','profile',p_user_id,
    jsonb_build_object('month',v_month,'days',p_days,'day_type',p_day_type,'check_in_time',p_check_in_time,'check_out_time',p_check_out_time,'note',p_note));

  return jsonb_build_object('ok',true,'saved_days',v_saved,'user_id',p_user_id,'month',v_month,'day_type',p_day_type);
end;
$$;

revoke all on function public.save_manual_attendance_days(uuid,uuid,date,integer[],text,time,time,text) from public,anon;
grant execute on function public.save_manual_attendance_days(uuid,uuid,date,integer[],text,time,time,text) to authenticated,service_role;

create or replace function public.get_attendance_report(
  p_date_from date,
  p_date_to date,
  p_branch_id uuid default null,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_org uuid:=private.current_organization_id();
  v_actor uuid:=auth.uid();
  v_can_manage boolean;
  v_timezone text;
  v_work_start time;
  v_work_end time;
  v_grace integer;
  v_standard integer;
  v_today date;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_date_from is null or p_date_to is null or p_date_to<p_date_from then raise exception 'Invalid attendance date range'; end if;
  if p_date_to-p_date_from>366 then raise exception 'Attendance report is limited to 367 days'; end if;

  v_can_manage:=private.has_permission('attendance.manage',v_actor);
  if not v_can_manage then
    perform private.require_permission('staff_operations.self');
    p_user_id:=v_actor;
    p_branch_id:=null;
  elsif p_branch_id is not null and not private.staff_branch_allowed(p_branch_id) then
    raise exception 'You cannot view this branch';
  end if;

  select coalesce(nullif(trim(timezone),''),'Asia/Phnom_Penh'),attendance_work_start,
    attendance_work_end,attendance_late_grace_minutes,attendance_standard_minutes
  into v_timezone,v_work_start,v_work_end,v_grace,v_standard
  from public.app_settings where organization_id=v_org;
  v_timezone:=coalesce(v_timezone,'Asia/Phnom_Penh');
  v_work_start:=coalesce(v_work_start,'07:00');
  v_work_end:=coalesce(v_work_end,'17:00');
  v_grace:=greatest(coalesce(v_grace,10),0);
  v_standard:=greatest(coalesce(v_standard,480),1);
  v_today:=(timezone(v_timezone,now()))::date;

  with target_staff as (
    select p.id as user_id,p.full_name,p.role,p.branch_id,b.name as branch_name,b.code as branch_code
    from public.profiles p
    left join public.branches b on b.id=p.branch_id
    where p.organization_id=v_org and p.is_active=true
      and (p_user_id is null or p.id=p_user_id)
      and (p_branch_id is null or p.branch_id=p_branch_id)
      and (not v_can_manage or private.staff_branch_allowed(p.branch_id))
  ), dates as (
    select generate_series(p_date_from,p_date_to,interval '1 day')::date as business_date
  ), sessions as (
    select a.user_id,a.business_date,
      (array_agg(a.id order by a.check_in_at))[1] as session_id,min(a.check_in_at) as check_in_at,max(a.check_out_at) as check_out_at,
      sum(case when a.status='open' then greatest(0,floor(extract(epoch from(now()-a.check_in_at))/60)::integer) else a.total_minutes end)::integer as total_minutes,
      bool_or(a.status='open') as is_open,
      string_agg(distinct nullif(trim(concat_ws(' · ',a.check_in_note,a.check_out_note,a.correction_note)),''),' | ') as note,
      string_agg(distinct a.check_in_source,', ') as check_in_source,
      string_agg(distinct coalesce(a.check_out_source,'—'),', ') as check_out_source,
      (array_agg(a.branch_id order by a.check_in_at))[1] as worked_branch_id
    from public.attendance_sessions a
    where a.organization_id=v_org and a.business_date between p_date_from and p_date_to
      and (p_user_id is null or a.user_id=p_user_id)
      and (p_branch_id is null or a.branch_id=p_branch_id)
    group by a.user_id,a.business_date
  ), detailed_base as (
    select ts.user_id,ts.full_name,ts.role,
      coalesce(s.worked_branch_id,o.branch_id,ts.branch_id) as branch_id,
      coalesce(wb.name,ob.name,ts.branch_name) as branch_name,
      coalesce(wb.code,ob.code,ts.branch_code) as branch_code,
      d.business_date,extract(isodow from d.business_date)::integer as weekday_number,
      trim(to_char(d.business_date,'Day')) as weekday_name,
      s.session_id,s.check_in_at,s.check_out_at,coalesce(s.total_minutes,0)::integer as total_minutes,
      coalesce(s.is_open,false) as is_open,s.check_in_source,s.check_out_source,
      o.day_type as override_type,coalesce(nullif(s.note,''),o.note) as note,
      case when s.check_in_at is null then 0 else greatest(0,
        floor(extract(epoch from(((timezone(v_timezone,s.check_in_at))::time-v_work_start)))/60)::integer-v_grace
      ) end as late_minutes,
      greatest(coalesce(s.total_minutes,0)-v_standard,0)::integer as overtime_minutes
    from target_staff ts cross join dates d
    left join sessions s on s.user_id=ts.user_id and s.business_date=d.business_date
    left join public.staff_attendance_day_overrides o
      on o.organization_id=v_org and o.user_id=ts.user_id and o.business_date=d.business_date
    left join public.branches wb on wb.id=s.worked_branch_id
    left join public.branches ob on ob.id=o.branch_id
  ), detailed as (
    select db.*,
      case
        when db.override_type='day_off' and db.session_id is not null then 'worked_day_off'
        when db.override_type='day_off' then 'day_off'
        when db.override_type='leave' then 'leave'
        when db.override_type='absence' then 'absent'
        when db.is_open then 'open'
        when db.session_id is not null and db.late_minutes>0 and db.overtime_minutes>0 then 'late_overtime'
        when db.session_id is not null and db.late_minutes>0 then 'late'
        when db.session_id is not null and db.overtime_minutes>0 then 'overtime'
        when db.session_id is not null then 'on_time'
        when db.business_date<=v_today then 'absent'
        else 'scheduled'
      end as attendance_status
    from detailed_base db
  ), staff_summary as (
    select user_id,full_name,role,branch_id,branch_name,
      count(*)::integer as calendar_days,
      count(*) filter(where session_id is not null)::integer as present_days,
      count(*) filter(where attendance_status='on_time')::integer as on_time_days,
      count(*) filter(where attendance_status in('late','late_overtime'))::integer as late_days,
      count(*) filter(where attendance_status in('overtime','late_overtime','worked_day_off'))::integer as overtime_days,
      count(*) filter(where attendance_status='absent')::integer as absent_days,
      count(*) filter(where attendance_status in('day_off','worked_day_off'))::integer as day_off_days,
      count(*) filter(where attendance_status='leave')::integer as leave_days,
      sum(total_minutes)::integer as work_minutes,
      sum(overtime_minutes)::integer as overtime_minutes,
      sum(late_minutes)::integer as late_minutes
    from detailed group by user_id,full_name,role,branch_id,branch_name
  )
  select jsonb_build_object(
    'settings',jsonb_build_object('timezone',v_timezone,'work_start',v_work_start,'work_end',v_work_end,'late_grace_minutes',v_grace,'standard_minutes',v_standard),
    'date_from',p_date_from,'date_to',p_date_to,
    'rows',coalesce((select jsonb_agg(to_jsonb(d) order by d.full_name,d.business_date) from detailed d),'[]'::jsonb),
    'summary',coalesce((select jsonb_agg(to_jsonb(s) order by s.full_name) from staff_summary s),'[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_attendance_report(date,date,uuid,uuid) from public,anon;
grant execute on function public.get_attendance_report(date,date,uuid,uuid) to authenticated,service_role;

commit;
