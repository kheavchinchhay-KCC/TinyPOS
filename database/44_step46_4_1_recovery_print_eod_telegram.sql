-- ============================================================================
-- Tiny POS - Step 46.4.1 Recovery: Telegram linking + richer End-of-Day
-- Run ONCE after database/43_step46_4_invoice_eod_multi_counter.sql.
-- Additive migration. Do not rerun older migrations.
-- ============================================================================

begin;

-- Supabase normally installs pgcrypto in the extensions schema. The older
-- function used an unqualified function name while excluding that schema from
-- its search_path, which caused gen_random_bytes(integer) not found.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_my_telegram_link_code()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_code text;
  v_expires_at timestamptz := now() + interval '10 minutes';
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active POS profile required';
  end if;

  perform private.ensure_telegram_preferences(v_user_id);

  delete from public.telegram_link_codes
  where user_id = v_user_id
     or expires_at <= now()
     or used_at is not null;

  v_code := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 8));

  insert into public.telegram_link_codes (
    organization_id,
    user_id,
    code_hash,
    expires_at
  )
  values (
    v_profile.organization_id,
    v_user_id,
    encode(digest(v_code, 'sha256'), 'hex'),
    v_expires_at
  );

  return jsonb_build_object(
    'code', v_code,
    'expires_at', v_expires_at
  );
end;
$$;

revoke all on function public.create_my_telegram_link_code()
  from public, anon;
grant execute on function public.create_my_telegram_link_code()
  to authenticated;

-- Rich End-of-Day report. Values are kept in their original USD/KHR currency;
-- currencies are never added together.
create or replace function public.get_end_of_day_report(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
  p_cashier_id uuid default null,
  p_register_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_profile record;
  v_from date := coalesce(p_from, current_date);
  v_to date := coalesce(p_to, current_date);
  v_branch uuid;
  v_all boolean := false;
  v_tz text := 'Asia/Phnom_Penh';
  v_branch_name text;
  v_cashier_name text;
begin
  perform private.require_permission('reports.view');

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user;

  if not found or not v_profile.is_active then
    raise exception 'Active POS profile required';
  end if;

  if v_from > v_to then
    raise exception 'The start date cannot be after the end date';
  end if;

  if (v_to - v_from) > 1095 then
    raise exception 'Choose a report period of three years or less';
  end if;

  v_all := private.has_permission('branches.all') and p_branch_id is null;
  v_branch := case
    when v_all then null
    when private.has_permission('branches.all') then coalesce(p_branch_id, v_profile.branch_id)
    else v_profile.branch_id
  end;

  select coalesce(nullif(trim(timezone), ''), 'Asia/Phnom_Penh')
  into v_tz
  from public.app_settings
  where organization_id = v_profile.organization_id;

  v_tz := coalesce(v_tz, 'Asia/Phnom_Penh');

  if v_all then
    v_branch_name := 'All branches';
  else
    select name into v_branch_name
    from public.branches
    where id = v_branch
      and organization_id = v_profile.organization_id;

    if v_branch_name is null then
      raise exception 'Report branch not found';
    end if;
  end if;

  if p_cashier_id is not null then
    select coalesce(full_name, email, 'POS Staff')
    into v_cashier_name
    from public.profiles
    where id = p_cashier_id
      and organization_id = v_profile.organization_id;

    if v_cashier_name is null then
      raise exception 'Selected POS user not found';
    end if;
  else
    v_cashier_name := 'All users';
  end if;

  return (
    with scoped_registers as (
      select r.*
      from public.cash_register_sessions r
      where r.organization_id = v_profile.organization_id
        and (v_all or r.branch_id = v_branch)
        and (timezone(v_tz, r.opened_at))::date <= v_to
        and (timezone(v_tz, coalesce(r.closed_at, now())))::date >= v_from
        and (p_cashier_id is null or r.opened_by = p_cashier_id)
        and (
          nullif(trim(p_register_name), '') is null
          or lower(r.register_name) = lower(trim(p_register_name))
        )
    ),
    scoped_sales as (
      select s.*
      from public.sales s
      where s.organization_id = v_profile.organization_id
        and (v_all or s.branch_id = v_branch)
        and s.status in ('completed', 'partially_refunded', 'refunded')
        and (timezone(v_tz, coalesce(s.completed_at, s.created_at)))::date
          between v_from and v_to
        and (p_cashier_id is null or s.cashier_id = p_cashier_id)
        and (
          nullif(trim(p_register_name), '') is null
          or exists (
            select 1
            from public.payments px
            join scoped_registers rx on rx.id = px.register_session_id
            where px.sale_id = s.id
          )
        )
    ),
    scoped_returns as (
      select r.*, s.cashier_id as sale_cashier_id
      from public.returns r
      left join public.sales s on s.id = r.original_sale_id
      where r.organization_id = v_profile.organization_id
        and (v_all or r.branch_id = v_branch)
        and r.status = 'completed'
        and (timezone(v_tz, r.processed_at))::date between v_from and v_to
        and (p_cashier_id is null or s.cashier_id = p_cashier_id or r.processed_by = p_cashier_id)
        and (
          nullif(trim(p_register_name), '') is null
          or r.register_session_id in (select id from scoped_registers)
        )
    ),
    scoped_payments as (
      select p.*, s.cashier_id
      from public.payments p
      join public.sales s on s.id = p.sale_id
      where p.organization_id = v_profile.organization_id
        and (v_all or p.branch_id = v_branch)
        and (timezone(v_tz, p.paid_at))::date between v_from and v_to
        and (p_cashier_id is null or s.cashier_id = p_cashier_id)
        and (
          nullif(trim(p_register_name), '') is null
          or p.register_session_id in (select id from scoped_registers)
        )
    ),
    scoped_cash as (
      select e.*, c.name as category_name, c.affects_profit
      from public.cash_entries e
      join public.cash_categories c on c.id = e.category_id
      where e.organization_id = v_profile.organization_id
        and (v_all or e.branch_id = v_branch)
        and e.status = 'active'
        and (timezone(v_tz, e.entry_at))::date between v_from and v_to
        and (p_cashier_id is null or e.created_by = p_cashier_id)
        and (
          nullif(trim(p_register_name), '') is null
          or e.register_session_id in (select id from scoped_registers)
        )
    ),
    scoped_supplier_payments as (
      select pp.*
      from public.purchase_payments pp
      where pp.organization_id = v_profile.organization_id
        and (v_all or pp.branch_id = v_branch)
        and (timezone(v_tz, pp.paid_at))::date between v_from and v_to
        and (p_cashier_id is null or pp.paid_by = p_cashier_id)
        and (
          nullif(trim(p_register_name), '') is null
          or pp.register_session_id in (select id from scoped_registers)
        )
    ),
    currencies(currency) as (
      values ('USD'::public.currency_code), ('KHR'::public.currency_code)
    ),
    summary_rows as (
      select
        c.currency::text as currency,
        (select count(*) from scoped_sales s where s.currency = c.currency) as invoice_count,
        coalesce((select sum(s.total_amount) from scoped_sales s where s.currency = c.currency), 0) as gross_sales,
        coalesce((select sum(r.refund_amount) from scoped_returns r where r.currency = c.currency), 0) as refunds,
        coalesce((select sum(s.total_amount) from scoped_sales s where s.currency = c.currency), 0)
          - coalesce((select sum(r.refund_amount) from scoped_returns r where r.currency = c.currency), 0) as net_sales,
        coalesce((select sum(p.amount) from scoped_payments p where p.currency = c.currency and lower(p.method::text) = 'cash'), 0) as cash_sales,
        coalesce((select sum(p.amount) from scoped_payments p where p.currency = c.currency and lower(p.method::text) = 'credit'), 0) as credit_sales,
        coalesce((select sum(p.amount) from scoped_payments p where p.currency = c.currency and lower(p.method::text) not in ('cash', 'credit')), 0) as bank_sales,
        coalesce((select sum(r.refund_amount) from scoped_returns r where r.currency = c.currency and lower(coalesce(r.refund_method::text, 'other')) = 'cash'), 0) as cash_refunds,
        coalesce((select sum(e.amount) from scoped_cash e where e.currency = c.currency and e.direction = 'income' and lower(e.method::text) = 'cash'), 0) as cash_income,
        coalesce((select sum(e.amount) from scoped_cash e where e.currency = c.currency and e.direction = 'income' and lower(e.method::text) <> 'cash'), 0) as bank_income,
        coalesce((select sum(e.amount) from scoped_cash e where e.currency = c.currency and e.direction = 'expense' and lower(e.method::text) = 'cash'), 0) as cash_expenses,
        coalesce((select sum(e.amount) from scoped_cash e where e.currency = c.currency and e.direction = 'expense' and lower(e.method::text) <> 'cash'), 0) as bank_expenses,
        coalesce((select sum(pp.amount) from scoped_supplier_payments pp where pp.currency = c.currency and lower(pp.method::text) = 'cash'), 0) as supplier_cash_payments,
        coalesce((select sum(pp.amount) from scoped_supplier_payments pp where pp.currency = c.currency and lower(pp.method::text) <> 'cash'), 0) as supplier_bank_payments
      from currencies c
    ),
    cashier_keys as (
      select cashier_id, currency from scoped_sales
      union
      select sale_cashier_id, currency from scoped_returns
      union
      select cashier_id, currency from scoped_payments
    ),
    cashier_rows as (
      select
        k.cashier_id,
        coalesce(pr.full_name, pr.email, 'POS Staff') as cashier_name,
        k.currency::text as currency,
        (select count(*) from scoped_sales s where s.cashier_id is not distinct from k.cashier_id and s.currency = k.currency) as invoice_count,
        coalesce((select sum(s.total_amount) from scoped_sales s where s.cashier_id is not distinct from k.cashier_id and s.currency = k.currency), 0) as gross_sales,
        coalesce((select sum(r.refund_amount) from scoped_returns r where r.sale_cashier_id is not distinct from k.cashier_id and r.currency = k.currency), 0) as refunds,
        coalesce((select sum(p.amount) from scoped_payments p where p.cashier_id is not distinct from k.cashier_id and p.currency = k.currency and lower(p.method::text) = 'cash'), 0) as cash_sales,
        coalesce((select sum(p.amount) from scoped_payments p where p.cashier_id is not distinct from k.cashier_id and p.currency = k.currency and lower(p.method::text) <> 'cash'), 0) as non_cash_sales
      from cashier_keys k
      left join public.profiles pr on pr.id = k.cashier_id
    ),
    sales_detail as (
      select * from (
        select
          s.id,
          s.invoice_number,
          coalesce(s.completed_at, s.created_at) as completed_at,
          b.name as branch_name,
          coalesce(cu.name, 'Walk-in') as customer_name,
          coalesce(pr.full_name, pr.email, 'POS Staff') as cashier_name,
          s.currency::text as currency,
          s.total_amount as gross_total,
          coalesce((select sum(r.refund_amount) from scoped_returns r where r.original_sale_id = s.id and r.currency = s.currency), 0) as refund_total,
          s.total_amount - coalesce((select sum(r.refund_amount) from scoped_returns r where r.original_sale_id = s.id and r.currency = s.currency), 0) as net_total,
          coalesce((select string_agg(distinct upper(p.method::text), ', ' order by upper(p.method::text)) from scoped_payments p where p.sale_id = s.id), '—') as payment_methods,
          coalesce((select string_agg(distinct rr.register_name, ', ' order by rr.register_name) from scoped_payments p join public.cash_register_sessions rr on rr.id = p.register_session_id where p.sale_id = s.id), '—') as register_names,
          s.status::text as status
        from scoped_sales s
        join public.branches b on b.id = s.branch_id
        left join public.customers cu on cu.id = s.customer_id
        left join public.profiles pr on pr.id = s.cashier_id
        order by coalesce(s.completed_at, s.created_at) desc
        limit 1000
      ) d
    )
    select jsonb_build_object(
      'from', v_from,
      'to', v_to,
      'timezone', v_tz,
      'organization_name', (select name from public.organizations where id = v_profile.organization_id),
      'branch_name', v_branch_name,
      'cashier_name', v_cashier_name,
      'register_name', coalesce(nullif(trim(p_register_name), ''), 'All counters'),
      'summary_by_currency', coalesce((
        select jsonb_agg(
          to_jsonb(sr) || jsonb_build_object(
            'expected_cash_movement', sr.cash_sales + sr.cash_income - sr.cash_refunds - sr.cash_expenses - sr.supplier_cash_payments,
            'net_bank_movement', sr.bank_sales + sr.bank_income - sr.bank_expenses - sr.supplier_bank_payments
          )
          order by sr.currency
        ) from summary_rows sr
      ), '[]'::jsonb),
      'payments', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.currency, x.method)
        from (
          select method::text as method, currency::text as currency,
                 count(*) as transaction_count, sum(amount) as amount
          from scoped_payments
          group by method, currency
        ) x
      ), '[]'::jsonb),
      'cash_activity', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.currency, x.direction, x.category_name, x.method)
        from (
          select direction::text as direction, category_name, method::text as method,
                 currency::text as currency, count(*) as transaction_count,
                 sum(amount) as amount, bool_or(affects_profit) as affects_profit
          from scoped_cash
          group by direction, category_name, method, currency
        ) x
      ), '[]'::jsonb),
      'supplier_payments', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.currency, x.method)
        from (
          select method::text as method, currency::text as currency,
                 count(*) as transaction_count, sum(amount) as amount
          from scoped_supplier_payments
          group by method, currency
        ) x
      ), '[]'::jsonb),
      'cashiers', coalesce((
        select jsonb_agg(
          to_jsonb(x) || jsonb_build_object('net_sales', x.gross_sales - x.refunds)
          order by x.currency, (x.gross_sales - x.refunds) desc
        ) from cashier_rows x
      ), '[]'::jsonb),
      'registers', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'register_name', r.register_name,
            'session_number', r.session_number,
            'status', r.status,
            'opened_by_name', coalesce(op.full_name, op.email, 'POS Staff'),
            'closed_by_name', coalesce(cp.full_name, cp.email),
            'opened_at', r.opened_at,
            'closed_at', r.closed_at,
            'opening_cash_usd', r.opening_cash_usd,
            'expected_cash_usd', coalesce((private.cash_register_summary(r.id, now()) #>> '{totals,USD,expected}')::numeric, 0),
            'counted_cash_usd', r.counted_cash_usd,
            'variance_usd', case when r.status = 'closed' then r.variance_usd else null end,
            'opening_cash_khr', r.opening_cash_khr,
            'expected_cash_khr', coalesce((private.cash_register_summary(r.id, now()) #>> '{totals,KHR,expected}')::numeric, 0),
            'counted_cash_khr', r.counted_cash_khr,
            'variance_khr', case when r.status = 'closed' then r.variance_khr else null end
          ) order by r.opened_at desc
        )
        from scoped_registers r
        left join public.profiles op on op.id = r.opened_by
        left join public.profiles cp on cp.id = r.closed_by
      ), '[]'::jsonb),
      'sales', coalesce((select jsonb_agg(to_jsonb(d) order by d.completed_at desc) from sales_detail d), '[]'::jsonb),
      'register_names', coalesce((select jsonb_agg(x.register_name order by x.register_name) from (select distinct register_name from scoped_registers) x), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.get_end_of_day_report(date,date,uuid,uuid,text)
  from public, anon;
grant execute on function public.get_end_of_day_report(date,date,uuid,uuid,text)
  to authenticated, service_role;

commit;
