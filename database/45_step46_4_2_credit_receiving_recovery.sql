-- ============================================================================
-- Tiny POS - Step 46.4.2: Customer Credit and Purchase Receiving Recovery
-- Run once after migration 44.
--
-- Fixes:
--   * customer sales failing with record NEW has no field created_by
--   * default no-credit, exact-limit credit, and unlimited-credit customer rules
--   * purchase receiving enum assignment failure for public.purchase_status
--
-- Additive only. No existing sales, customers, balances, purchases or stock are
-- deleted or reset.
-- ============================================================================

begin;

alter table public.customers
  add column if not exists allow_unlimited_credit boolean not null default false;

alter table public.customer_credit_accounts
  add column if not exists allow_unlimited_credit boolean not null default false;

grant insert (allow_unlimited_credit)
  on public.customers to authenticated;

grant update (allow_unlimited_credit)
  on public.customers to authenticated;

create or replace function private.sync_customer_base_credit_account()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_currency public.currency_code := 'USD';
  v_actor uuid := auth.uid();
begin
  select coalesce(settings.base_currency, 'USD')
  into v_currency
  from public.app_settings settings
  where settings.organization_id = new.organization_id;

  v_actor := coalesce(
    v_actor,
    nullif(to_jsonb(new) ->> 'created_by', '')::uuid
  );

  if coalesce(new.allow_unlimited_credit, false)
     or new.credit_limit > 0
     or exists (
       select 1
       from public.customer_credit_accounts account
       where account.customer_id = new.id
         and account.currency = v_currency
     ) then
    insert into public.customer_credit_accounts (
      organization_id,
      customer_id,
      currency,
      credit_limit,
      allow_unlimited_credit,
      balance_due,
      payment_terms_days,
      is_on_hold,
      created_by
    )
    values (
      new.organization_id,
      new.id,
      v_currency,
      new.credit_limit,
      coalesce(new.allow_unlimited_credit, false),
      0,
      30,
      false,
      v_actor
    )
    on conflict (customer_id, currency)
    do update set
      credit_limit = excluded.credit_limit,
      allow_unlimited_credit = excluded.allow_unlimited_credit,
      updated_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists sync_customer_base_credit_account
  on public.customers;

create trigger sync_customer_base_credit_account
after insert or update of credit_limit, allow_unlimited_credit
on public.customers
for each row execute function private.sync_customer_base_credit_account();

-- Keep existing base-currency accounts aligned with the customer rule.
update public.customer_credit_accounts account
set
  credit_limit = customer.credit_limit,
  allow_unlimited_credit = customer.allow_unlimited_credit,
  updated_at = now()
from public.customers customer
join public.app_settings settings
  on settings.organization_id = customer.organization_id
where account.customer_id = customer.id
  and account.currency = coalesce(settings.base_currency, 'USD');

create or replace view public.customer_directory
with (security_invoker = true)
as
select
  c.id,
  c.organization_id,
  c.customer_code,
  c.customer_type,
  c.name,
  c.company_name,
  c.phone,
  c.email,
  c.address,
  c.date_of_birth,
  c.loyalty_points,
  c.credit_limit,
  c.notes,
  c.is_active,
  c.created_by,
  c.created_at,
  c.updated_at,
  settings.base_currency as summary_currency,
  coalesce(s.sale_count, 0)::bigint as sale_count,
  coalesce(s.gross_sales, 0)::numeric(14,2) as gross_sales,
  coalesce(s.gross_profit, 0)::numeric(14,4) as gross_profit,
  coalesce(r.refund_count, 0)::bigint as refund_count,
  coalesce(r.refund_amount, 0)::numeric(14,2) as refund_amount,
  coalesce(r.profit_reversal, 0)::numeric(14,4) as profit_reversal,
  round(
    coalesce(s.gross_sales, 0) - coalesce(r.refund_amount, 0),
    2
  )::numeric(14,2) as net_spent,
  round(
    coalesce(s.gross_profit, 0) - coalesce(r.profit_reversal, 0),
    4
  )::numeric(14,4) as net_profit,
  case
    when coalesce(s.sale_count, 0) > 0 then
      round(
        (
          coalesce(s.gross_sales, 0) - coalesce(r.refund_amount, 0)
        ) / s.sale_count,
        2
      )
    else 0
  end::numeric(14,2) as average_sale,
  s.last_purchase_at,
  c.allow_unlimited_credit
from public.customers c
join public.app_settings settings
  on settings.organization_id = c.organization_id
left join lateral (
  select
    count(*) as sale_count,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.total_amount
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.total_amount / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.total_amount * settings.usd_to_khr_rate
        else x.total_amount
      end
    ), 0) as gross_sales,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.gross_profit
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.gross_profit / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.gross_profit * settings.usd_to_khr_rate
        else x.gross_profit
      end
    ), 0) as gross_profit,
    max(coalesce(x.completed_at, x.created_at)) as last_purchase_at
  from public.sales x
  where x.customer_id = c.id
    and x.organization_id = c.organization_id
    and x.status in ('completed', 'partially_refunded', 'refunded')
) s on true
left join lateral (
  select
    count(*) as refund_count,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.refund_amount
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.refund_amount / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.refund_amount * settings.usd_to_khr_rate
        else x.refund_amount
      end
    ), 0) as refund_amount,
    coalesce(sum(
      case
        when x.currency = settings.base_currency then x.profit_reversal
        when settings.base_currency = 'USD' and x.currency = 'KHR'
          then x.profit_reversal / settings.usd_to_khr_rate
        when settings.base_currency = 'KHR' and x.currency = 'USD'
          then x.profit_reversal * settings.usd_to_khr_rate
        else x.profit_reversal
      end
    ), 0) as profit_reversal
  from public.returns x
  where x.customer_id = c.id
    and x.organization_id = c.organization_id
    and x.status = 'completed'
) r on true;

revoke all on public.customer_directory from anon;
grant select on public.customer_directory to authenticated, service_role;

create or replace function public.save_customer_credit_account_v3(
  p_customer_id uuid,
  p_currency public.currency_code,
  p_credit_limit numeric,
  p_allow_unlimited_credit boolean default false,
  p_payment_terms_days integer default 30,
  p_is_on_hold boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_result jsonb;
  v_account public.customer_credit_accounts%rowtype;
  v_base_currency public.currency_code := 'USD';
begin
  perform private.require_permission('credit_accounts.manage');

  v_result := public.save_customer_credit_account(
    p_customer_id,
    p_currency,
    p_credit_limit,
    p_payment_terms_days,
    p_is_on_hold,
    p_notes
  );

  update public.customer_credit_accounts
  set
    allow_unlimited_credit = coalesce(p_allow_unlimited_credit, false),
    updated_at = now()
  where customer_id = p_customer_id
    and currency = p_currency
    and organization_id = private.current_organization_id()
  returning * into v_account;

  if not found then
    raise exception 'Credit account could not be updated';
  end if;

  select coalesce(settings.base_currency, 'USD')
  into v_base_currency
  from public.app_settings settings
  where settings.organization_id = v_account.organization_id;

  if p_currency = v_base_currency then
    update public.customers
    set
      credit_limit = v_account.credit_limit,
      allow_unlimited_credit = v_account.allow_unlimited_credit,
      updated_at = now()
    where id = p_customer_id
      and organization_id = v_account.organization_id;

    select * into v_account
    from public.customer_credit_accounts
    where customer_id = p_customer_id
      and currency = p_currency
      and organization_id = private.current_organization_id();
  end if;

  return to_jsonb(v_account) || jsonb_build_object(
    'credit_rule', case
      when v_account.allow_unlimited_credit then 'unlimited'
      when v_account.credit_limit > 0 then 'exact_limit'
      else 'disabled'
    end
  );
end;
$$;

revoke all on function public.save_customer_credit_account_v3(
  uuid,public.currency_code,numeric,boolean,integer,boolean,text
) from public, anon;

grant execute on function public.save_customer_credit_account_v3(
  uuid,public.currency_code,numeric,boolean,integer,boolean,text
) to authenticated, service_role;

create or replace function public.get_customer_credit_workspace()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_accounts jsonb := '[]'::jsonb;
  v_customers jsonb := '[]'::jsonb;
  v_metrics jsonb := '{}'::jsonb;
  v_today date;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile required';
  end if;

  if v_profile.role not in ('owner','admin','manager','cashier') then
    raise exception 'Your role cannot view credit accounts';
  end if;

  select (
    timezone(
      coalesce(nullif(trim(settings.timezone), ''), 'Asia/Phnom_Penh'),
      now()
    )
  )::date
  into v_today
  from public.app_settings settings
  where settings.organization_id = v_profile.organization_id;

  v_today := coalesce(v_today, current_date);

  with invoice_summary as (
    select
      sale.credit_account_id as account_id,
      count(*) filter (
        where sale.credit_amount > sale.paid_amount
      )::integer as open_invoice_count,

      coalesce(sum(
        greatest(sale.credit_amount - sale.paid_amount, 0)
      ) filter (
        where sale.credit_amount > sale.paid_amount
          and sale.credit_due_date < v_today
      ), 0)::numeric(14,2) as overdue_amount,

      count(*) filter (
        where sale.credit_amount > sale.paid_amount
          and sale.credit_due_date < v_today
      )::integer as overdue_invoice_count,

      min(sale.credit_due_date) filter (
        where sale.credit_amount > sale.paid_amount
      ) as oldest_due_date

    from public.sales sale
    where sale.organization_id = v_profile.organization_id
      and sale.credit_account_id is not null
      and sale.status <> 'voided'
    group by sale.credit_account_id
  ),

  last_payment as (
    select distinct on (payment.account_id)
      payment.account_id,
      payment.payment_number,
      payment.amount,
      payment.method,
      payment.paid_at
    from public.customer_credit_payments payment
    where payment.organization_id = v_profile.organization_id
    order by payment.account_id, payment.paid_at desc
  )

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', account.id,
      'organization_id', account.organization_id,
      'customer_id', account.customer_id,
      'currency', account.currency,
      'credit_limit', account.credit_limit,
      'allow_unlimited_credit', coalesce(account.allow_unlimited_credit, false),
      'balance_due', account.balance_due,
      'available_credit', case
        when coalesce(account.allow_unlimited_credit, false) then null
        else greatest(account.credit_limit - account.balance_due, 0)
      end,
      'payment_terms_days', account.payment_terms_days,
      'is_on_hold', account.is_on_hold,
      'notes', account.notes,
      'last_activity_at', account.last_activity_at,
      'created_at', account.created_at,
      'updated_at', account.updated_at,
      'customer', jsonb_build_object(
        'id', customer.id,
        'customer_code', customer.customer_code,
        'customer_type', customer.customer_type,
        'name', customer.name,
        'company_name', customer.company_name,
        'phone', customer.phone,
        'email', customer.email,
        'is_active', customer.is_active,
        'allow_unlimited_credit', coalesce(customer.allow_unlimited_credit, false)
      ),
      'open_invoice_count', coalesce(summary.open_invoice_count, 0),
      'overdue_amount', coalesce(summary.overdue_amount, 0),
      'overdue_invoice_count', coalesce(summary.overdue_invoice_count, 0),
      'oldest_due_date', summary.oldest_due_date,
      'last_payment', case
        when latest.account_id is null then null
        else jsonb_build_object(
          'payment_number', latest.payment_number,
          'amount', latest.amount,
          'method', latest.method,
          'paid_at', latest.paid_at
        )
      end,
      'account_status', case
        when account.is_on_hold then 'hold'
        when coalesce(summary.overdue_amount, 0) > 0 then 'overdue'
        when not coalesce(account.allow_unlimited_credit, false)
             and account.balance_due >= account.credit_limit
             and account.credit_limit > 0 then 'limit_reached'
        when account.balance_due > 0 then 'open'
        else 'clear'
      end
    )
    order by
      case
        when account.is_on_hold then 1
        when coalesce(summary.overdue_amount, 0) > 0 then 2
        when account.balance_due > 0 then 3
        else 4
      end,
      customer.name,
      account.currency
  ), '[]'::jsonb)
  into v_accounts
  from public.customer_credit_accounts account
  join public.customers customer
    on customer.id = account.customer_id
  left join invoice_summary summary
    on summary.account_id = account.id
  left join last_payment latest
    on latest.account_id = account.id
  where account.organization_id = v_profile.organization_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', customer.id,
      'customer_code', customer.customer_code,
      'customer_type', customer.customer_type,
      'name', customer.name,
      'company_name', customer.company_name,
      'phone', customer.phone,
      'email', customer.email,
      'credit_limit', customer.credit_limit,
      'allow_unlimited_credit', coalesce(customer.allow_unlimited_credit, false),
      'account_currencies', coalesce((
        select jsonb_agg(account.currency order by account.currency)
        from public.customer_credit_accounts account
        where account.customer_id = customer.id
      ), '[]'::jsonb)
    )
    order by customer.name
  ), '[]'::jsonb)
  into v_customers
  from public.customers customer
  where customer.organization_id = v_profile.organization_id
    and customer.is_active = true;

  select jsonb_build_object(
    'account_count', count(*),
    'customers_with_balance', count(*) filter (where balance_due > 0),
    'accounts_on_hold', count(*) filter (where is_on_hold),
    'receivable_usd', coalesce(sum(balance_due) filter (where currency = 'USD'), 0),
    'receivable_khr', coalesce(sum(balance_due) filter (where currency = 'KHR'), 0),
    'overdue_accounts', count(*) filter (where overdue_amount > 0),
    'overdue_usd', coalesce(sum(overdue_amount) filter (where currency = 'USD'), 0),
    'overdue_khr', coalesce(sum(overdue_amount) filter (where currency = 'KHR'), 0)
  )
  into v_metrics
  from (
    select
      account.currency,
      account.balance_due,
      account.is_on_hold,
      coalesce(sum(
        greatest(sale.credit_amount - sale.paid_amount, 0)
      ) filter (
        where sale.credit_amount > sale.paid_amount
          and sale.credit_due_date < v_today
      ), 0) as overdue_amount
    from public.customer_credit_accounts account
    left join public.sales sale
      on sale.credit_account_id = account.id
      and sale.organization_id = v_profile.organization_id
      and sale.status <> 'voided'
    where account.organization_id = v_profile.organization_id
    group by account.id
  ) metrics;

  return jsonb_build_object(
    'accounts', v_accounts,
    'customers', v_customers,
    'metrics', v_metrics,
    'can_manage', v_profile.role in ('owner','admin','manager'),
    'can_receive_payment', v_profile.role in ('owner','admin','manager','cashier')
  );
end;
$$;

revoke all on function public.get_customer_credit_workspace() from public, anon;
grant execute on function public.get_customer_credit_workspace() to authenticated, service_role;

create or replace function public.get_customer_credit_statement(
  p_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_account public.customer_credit_accounts%rowtype;
  v_customer public.customers%rowtype;
  v_account_json jsonb;
  v_invoices jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
  v_entries jsonb := '[]'::jsonb;
  v_today date;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile required';
  end if;

  if v_profile.role not in ('owner','admin','manager','cashier') then
    raise exception 'Your role cannot view credit statements';
  end if;

  select (
    timezone(
      coalesce(nullif(trim(settings.timezone), ''), 'Asia/Phnom_Penh'),
      now()
    )
  )::date
  into v_today
  from public.app_settings settings
  where settings.organization_id = v_profile.organization_id;

  v_today := coalesce(v_today, current_date);

  select *
  into v_account
  from public.customer_credit_accounts
  where id = p_account_id
    and organization_id = v_profile.organization_id;

  if not found then
    raise exception 'Credit account not found';
  end if;

  select *
  into v_customer
  from public.customers
  where id = v_account.customer_id;

  v_account_json := to_jsonb(v_account) || jsonb_build_object(
    'available_credit', case
      when coalesce(v_account.allow_unlimited_credit, false) then null
      else greatest(v_account.credit_limit - v_account.balance_due, 0)
    end,
    'customer', jsonb_build_object(
      'id', v_customer.id,
      'customer_code', v_customer.customer_code,
      'customer_type', v_customer.customer_type,
      'name', v_customer.name,
      'company_name', v_customer.company_name,
      'phone', v_customer.phone,
      'email', v_customer.email,
      'address', v_customer.address
    )
  );

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', sale.id,
      'invoice_number', sale.invoice_number,
      'branch_id', sale.branch_id,
      'branch_name', branch.name,
      'completed_at', sale.completed_at,
      'credit_due_date', sale.credit_due_date,
      'status', sale.status,
      'payment_status', sale.payment_status,
      'currency', sale.currency,
      'credit_amount', sale.credit_amount,
      'paid_amount', sale.paid_amount,
      'outstanding_amount', greatest(
        sale.credit_amount - sale.paid_amount,
        0
      ),
      'is_overdue',
        sale.credit_amount > sale.paid_amount
        and sale.credit_due_date < v_today
    )
    order by
      sale.credit_due_date nulls last,
      sale.completed_at,
      sale.invoice_number
  ), '[]'::jsonb)
  into v_invoices
  from public.sales sale
  join public.branches branch
    on branch.id = sale.branch_id
  where sale.organization_id = v_profile.organization_id
    and sale.credit_account_id = v_account.id
  ;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', payment.id,
      'payment_number', payment.payment_number,
      'branch_id', payment.branch_id,
      'branch_name', branch.name,
      'method', payment.method,
      'currency', payment.currency,
      'amount', payment.amount,
      'reference_number', payment.reference_number,
      'notes', payment.notes,
      'paid_at', payment.paid_at,
      'received_by', profile.full_name,
      'allocations', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'sale_id', allocation.sale_id,
            'invoice_number', sale.invoice_number,
            'amount', allocation.amount
          )
          order by sale.credit_due_date, sale.invoice_number
        )
        from public.customer_credit_payment_allocations allocation
        join public.sales sale
          on sale.id = allocation.sale_id
        where allocation.credit_payment_id = payment.id
      ), '[]'::jsonb)
    )
    order by payment.paid_at desc
  ), '[]'::jsonb)
  into v_payments
  from public.customer_credit_payments payment
  join public.branches branch
    on branch.id = payment.branch_id
  left join public.profiles profile
    on profile.id = payment.received_by
  where payment.organization_id = v_profile.organization_id
    and payment.account_id = v_account.id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', entry.id,
      'branch_id', entry.branch_id,
      'entry_type', entry.entry_type,
      'amount_change', entry.amount_change,
      'balance_before', entry.balance_before,
      'balance_after', entry.balance_after,
      'sale_id', entry.sale_id,
      'invoice_number', sale.invoice_number,
      'credit_payment_id', entry.credit_payment_id,
      'payment_number', payment.payment_number,
      'return_id', entry.return_id,
      'return_number', return_row.return_number,
      'description', entry.description,
      'created_by', profile.full_name,
      'created_at', entry.created_at
    )
    order by entry.created_at desc
  ), '[]'::jsonb)
  into v_entries
  from public.customer_credit_entries entry
  left join public.sales sale
    on sale.id = entry.sale_id
  left join public.customer_credit_payments payment
    on payment.id = entry.credit_payment_id
  left join public.returns return_row
    on return_row.id = entry.return_id
  left join public.profiles profile
    on profile.id = entry.created_by
  where entry.organization_id = v_profile.organization_id
    and entry.account_id = v_account.id;

  return jsonb_build_object(
    'account', v_account_json,
    'invoices', v_invoices,
    'payments', v_payments,
    'entries', v_entries
  );
end;
$$;

revoke all on function public.get_customer_credit_statement(uuid) from public, anon;
grant execute on function public.get_customer_credit_statement(uuid) to authenticated, service_role;

create or replace function public.complete_sale_v4_price(
  p_items jsonb,
  p_payment_method text,
  p_amount_received numeric,
  p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',
  p_manual_discount_value numeric default 0,
  p_coupon_code text default null,
  p_currency public.currency_code default 'USD',
  p_notes text default null,
  p_payment_reference text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_account public.customer_credit_accounts%rowtype;
  v_sale public.sales%rowtype;
  v_result jsonb;
  v_sale_id uuid;
  v_total numeric(14,2);
  v_balance_before numeric(14,2);
  v_balance_after numeric(14,2);
  v_due_date date;
  v_today date;
  v_method text := lower(trim(coalesce(p_payment_method, '')));
begin
  if v_method <> 'credit' then
    if v_method not in ('cash','bank','khqr','card','other') then
      raise exception 'Unsupported payment method';
    end if;

    return public.complete_sale_v3_price(
      p_items,
      v_method::public.payment_method,
      p_amount_received,
      p_customer_id,
      p_manual_discount_type,
      p_manual_discount_value,
      p_coupon_code,
      p_currency,
      p_notes,
      p_payment_reference,
      p_idempotency_key
    );
  end if;

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin','manager','cashier') then
    raise exception 'Your role cannot complete sales';
  end if;

  select (
    timezone(
      coalesce(nullif(trim(settings.timezone), ''), 'Asia/Phnom_Penh'),
      now()
    )
  )::date
  into v_today
  from public.app_settings settings
  where settings.organization_id = v_profile.organization_id;

  v_today := coalesce(v_today, current_date);

  if p_customer_id is null then
    raise exception 'Choose a customer before using Credit Account';
  end if;

  select account.*
  into v_account
  from public.customer_credit_accounts account
  join public.customers customer
    on customer.id = account.customer_id
  where account.organization_id = v_profile.organization_id
    and account.customer_id = p_customer_id
    and account.currency = p_currency
    and customer.is_active = true
  for update of account;

  if not found then
    raise exception 'This customer has no % credit account', p_currency;
  end if;

  if v_account.is_on_hold then
    raise exception 'This customer credit account is on hold';
  end if;

  if not coalesce(v_account.allow_unlimited_credit, false)
     and v_account.credit_limit <= 0 then
    raise exception 'This customer has no available credit limit';
  end if;

  -- Use a non-cash temporary payment. It is removed before commit.
  v_result := public.complete_sale_v3_price(
    p_items,
    'other'::public.payment_method,
    999999999999.99::numeric,
    p_customer_id,
    p_manual_discount_type,
    p_manual_discount_value,
    p_coupon_code,
    p_currency,
    p_notes,
    'CREDIT-TEMPORARY',
    p_idempotency_key
  );

  v_sale_id := (v_result ->> 'sale_id')::uuid;

  select *
  into v_sale
  from public.sales
  where id = v_sale_id
    and organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Completed sale could not be loaded';
  end if;

  if coalesce((v_result ->> 'duplicate_request')::boolean, false) then
    if v_sale.credit_account_id is null then
      raise exception 'This request was already completed with another payment method';
    end if;

    return v_result || jsonb_build_object(
      'payment_method', 'credit',
      'amount_received', 0,
      'change_amount', 0,
      'credit_account_id', v_sale.credit_account_id,
      'credit_due_date', v_sale.credit_due_date,
      'credit_amount', v_sale.credit_amount,
      'credit_balance_after', v_account.balance_due,
      'credit_unlimited', coalesce(v_account.allow_unlimited_credit, false),
      'credit_available_after', case
        when coalesce(v_account.allow_unlimited_credit, false) then null
        else greatest(v_account.credit_limit - v_account.balance_due, 0)
      end
    );
  end if;

  v_total := round(v_sale.total_amount, 2);

  if v_total <= 0 then
    raise exception 'Credit sale total must be greater than zero';
  end if;

  v_balance_before := v_account.balance_due;
  v_balance_after := round(v_balance_before + v_total, 2);

  if not coalesce(v_account.allow_unlimited_credit, false)
     and v_balance_after > v_account.credit_limit then
    raise exception
      'Credit limit exceeded. Available credit: %, invoice total: %',
      greatest(v_account.credit_limit - v_balance_before, 0),
      v_total;
  end if;

  v_due_date := v_today + v_account.payment_terms_days;

  delete from public.payments
  where sale_id = v_sale.id;

  update public.sales
  set
    payment_status = 'unpaid',
    paid_amount = 0,
    change_amount = 0,
    credit_account_id = v_account.id,
    credit_due_date = v_due_date,
    credit_amount = v_total,
    updated_at = now()
  where id = v_sale.id
  returning * into v_sale;

  update public.customer_credit_accounts
  set
    balance_due = v_balance_after,
    last_activity_at = now(),
    updated_at = now()
  where id = v_account.id;

  insert into public.customer_credit_entries (
    organization_id,
    branch_id,
    account_id,
    entry_type,
    amount_change,
    balance_before,
    balance_after,
    sale_id,
    description,
    created_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_account.id,
    'sale',
    v_total,
    v_balance_before,
    v_balance_after,
    v_sale.id,
    'Credit invoice ' || v_sale.invoice_number,
    v_user_id
  );

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'complete_credit_sale',
    'sale',
    v_sale.id,
    jsonb_build_object(
      'invoice_number', v_sale.invoice_number,
      'customer_id', p_customer_id,
      'credit_account_id', v_account.id,
      'credit_amount', v_total,
      'credit_due_date', v_due_date,
      'balance_before', v_balance_before,
      'balance_after', v_balance_after,
      'credit_unlimited', coalesce(v_account.allow_unlimited_credit, false)
    )
  );

  return v_result || jsonb_build_object(
    'payment_method', 'credit',
    'amount_received', 0,
    'change_amount', 0,
    'credit_account_id', v_account.id,
    'credit_due_date', v_due_date,
    'credit_amount', v_total,
    'credit_balance_after', v_balance_after,
    'credit_unlimited', coalesce(v_account.allow_unlimited_credit, false),
    'credit_available_after', case
      when coalesce(v_account.allow_unlimited_credit, false) then null
      else greatest(v_account.credit_limit - v_balance_after, 0)
    end
  );
end;
$$;

revoke all on function public.complete_sale_v4_price(
  jsonb,text,numeric,uuid,public.discount_type,numeric,text,
  public.currency_code,text,text,text
) from public, anon;
grant execute on function public.complete_sale_v4_price(
  jsonb,text,numeric,uuid,public.discount_type,numeric,text,
  public.currency_code,text,text,text
) to authenticated, service_role;

create or replace function private.crm_award_sale_loyalty()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  cfg public.loyalty_program_settings%rowtype;
  basis numeric;
  points numeric;
  v_actor uuid;
begin
  if new.customer_id is null
     or new.status not in ('completed','partially_refunded','refunded') then
    return new;
  end if;

  if exists (
    select 1
    from public.customer_loyalty_movements
    where reference_table = 'sale'
      and reference_id = new.id
  ) then
    return new;
  end if;

  select * into cfg
  from public.loyalty_program_settings
  where organization_id = new.organization_id;

  if not found or not cfg.enabled then
    return new;
  end if;

  if coalesce(new.completed_at, new.created_at) < cfg.started_at then
    return new;
  end if;

  basis := case
    when cfg.award_on_discounted_total then new.total_amount
    else new.subtotal
  end;

  if not cfg.award_on_tax then
    basis := greatest(0, basis - coalesce(new.tax_amount, 0));
  end if;

  points := case
    when new.currency = 'KHR'
      then floor(basis / 1000 * cfg.khr_points_per_1000)
    else floor(basis * cfg.usd_points_per_unit)
  end;

  v_actor := coalesce(
    new.cashier_id,
    auth.uid(),
    (
      select profile.id
      from public.profiles profile
      where profile.organization_id = new.organization_id
        and profile.role = 'owner'
        and profile.is_active
      order by profile.created_at
      limit 1
    )
  );

  if points > 0 and v_actor is not null then
    perform private.apply_loyalty_delta(
      new.organization_id,
      new.customer_id,
      points,
      'Automatic points from ' || new.invoice_number,
      'sale',
      new.id,
      v_actor
    );
  end if;

  return new;
end;
$$;

drop trigger if exists crm_award_sale_loyalty on public.sales;
create trigger crm_award_sale_loyalty
after insert or update of status on public.sales
for each row execute function private.crm_award_sale_loyalty();

create or replace function public.receive_purchase_order_v3(
  p_purchase_id uuid,
  p_items jsonb,
  p_amount_paid numeric default 0,
  p_payment_method public.payment_method default 'cash',
  p_payment_reference text default null,
  p_supplier_invoice_number text default null,
  p_received_at timestamptz default now(),
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_purchase public.purchases%rowtype;
  v_item record;
  v_purchase_item public.purchase_items%rowtype;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;

  v_receipt_id uuid;
  v_receipt_number text;
  v_received_at timestamptz;

  v_remaining_purchase_units numeric(14,3);
  v_base_receipt_quantity numeric(14,3);
  v_new_received_quantity numeric(14,3);
  v_new_base_received_quantity numeric(14,3);

  v_new_stock_quantity numeric(14,3);
  v_new_average numeric(14,4);
  v_line_total numeric(14,2);

  v_supplier_credit numeric(14,2) := 0;
  v_balance_due numeric(14,2);
  v_new_paid numeric(14,2);

  v_receipt_item_count integer := 0;
  v_receipt_purchase_units numeric(14,3) := 0;
  v_receipt_base_units numeric(14,3) := 0;
  v_receipt_value numeric(14,2) := 0;

  v_order_purchase_units numeric(14,3) := 0;
  v_order_received_units numeric(14,3) := 0;
  v_order_base_units numeric(14,3) := 0;
  v_order_base_received numeric(14,3) := 0;

  v_fully_received boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    organization_id,
    branch_id,
    role,
    is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found
     or v_profile.is_active is not true
     or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Your role cannot receive purchase orders';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Enter a received quantity for at least one product';
  end if;

  if p_amount_paid is null or p_amount_paid < 0 then
    raise exception 'Payment amount cannot be negative';
  end if;

  v_received_at := coalesce(p_received_at, now());

  if v_received_at > now() + interval '5 minutes' then
    raise exception 'Received time cannot be in the future';
  end if;

  select *
  into v_purchase
  from public.purchases
  where id = p_purchase_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Purchase order not found';
  end if;

  if v_purchase.status not in ('draft','ordered') then
    raise exception 'Only an open purchase order can receive stock';
  end if;

  if v_received_at < v_purchase.created_at then
    raise exception 'Received time cannot be before the purchase order was created';
  end if;

  if not exists (
    select 1
    from public.purchase_items item
    where item.purchase_id = v_purchase.id
  ) then
    raise exception 'This purchase order has no items';
  end if;

  if to_regprocedure('private.purchase_supplier_credit_total(uuid)')
     is not null then
    v_supplier_credit := round(
      private.purchase_supplier_credit_total(
        v_purchase.id
      ),
      2
    );
  end if;

  v_balance_due := greatest(
    round(
      v_purchase.total_amount
      - coalesce(v_purchase.amount_paid, 0)
      - v_supplier_credit,
      2
    ),
    0
  );

  if round(p_amount_paid, 2) > v_balance_due then
    raise exception
      'Payment exceeds the outstanding purchase balance of %',
      v_balance_due;
  end if;

  v_new_paid := round(
    coalesce(v_purchase.amount_paid, 0)
    + p_amount_paid,
    2
  );

  -- Validate and lock every selected purchase item.
  for v_item in
    select
      input.purchase_item_id,
      sum(input.quantity)::numeric(14,3)
        as quantity
    from jsonb_to_recordset(p_items)
      as input(
        purchase_item_id uuid,
        quantity numeric
      )
    group by input.purchase_item_id
    order by input.purchase_item_id
  loop
    if v_item.purchase_item_id is null
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'Every receipt item needs a quantity greater than zero';
    end if;

    select *
    into v_purchase_item
    from public.purchase_items
    where id = v_item.purchase_item_id
      and purchase_id = v_purchase.id
    for update;

    if not found then
      raise exception 'A selected receipt item does not belong to this purchase order';
    end if;

    v_remaining_purchase_units := round(
      v_purchase_item.quantity
      - v_purchase_item.received_quantity,
      3
    );

    if v_remaining_purchase_units <= 0 then
      raise exception
        'The selected purchase item has already been fully received';
    end if;

    if v_item.quantity > v_remaining_purchase_units then
      raise exception
        'Only % % remains for this purchase item',
        v_remaining_purchase_units,
        v_purchase_item.purchase_unit_name;
    end if;

    select *
    into v_product
    from public.products
    where id = v_purchase_item.product_id
      and organization_id = v_profile.organization_id;

    if not found or v_product.is_active is not true then
      raise exception 'A purchase-order product is missing or inactive';
    end if;

    insert into public.inventory_balances (
      organization_id,
      branch_id,
      product_id,
      quantity,
      average_cost
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_product.id,
      0,
      v_product.default_cost
    )
    on conflict (branch_id, product_id)
    do nothing;
  end loop;

  -- Lock selected balances in a stable order.
  perform balance.id
  from public.inventory_balances balance
  join public.purchase_items item
    on item.product_id = balance.product_id
  join (
    select distinct input.purchase_item_id
    from jsonb_to_recordset(p_items)
      as input(
        purchase_item_id uuid,
        quantity numeric
      )
  ) selected
    on selected.purchase_item_id = item.id
  where item.purchase_id = v_purchase.id
    and balance.branch_id = v_profile.branch_id
  order by balance.product_id
  for update of balance;

  v_receipt_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'GRN'
  );

  insert into public.purchase_receipts (
    organization_id,
    branch_id,
    purchase_id,
    receipt_number,
    supplier_invoice_number,
    received_at,
    notes,
    created_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_purchase.id,
    v_receipt_number,
    nullif(trim(p_supplier_invoice_number), ''),
    v_received_at,
    nullif(trim(p_notes), ''),
    v_user_id
  )
  returning id into v_receipt_id;

  for v_item in
    select
      input.purchase_item_id,
      sum(input.quantity)::numeric(14,3)
        as quantity
    from jsonb_to_recordset(p_items)
      as input(
        purchase_item_id uuid,
        quantity numeric
      )
    group by input.purchase_item_id
    order by input.purchase_item_id
  loop
    select *
    into strict v_purchase_item
    from public.purchase_items
    where id = v_item.purchase_item_id
      and purchase_id = v_purchase.id
    for update;

    select *
    into strict v_product
    from public.products
    where id = v_purchase_item.product_id
      and organization_id = v_profile.organization_id;

    v_base_receipt_quantity := round(
      v_item.quantity
      * v_purchase_item.unit_factor,
      3
    );

    v_new_received_quantity := round(
      v_purchase_item.received_quantity
      + v_item.quantity,
      3
    );

    v_new_base_received_quantity := round(
      v_purchase_item.base_received_quantity
      + v_base_receipt_quantity,
      3
    );

    if v_new_received_quantity > v_purchase_item.quantity
       or v_new_base_received_quantity > v_purchase_item.base_quantity then
      raise exception 'Received quantity exceeds the ordered quantity';
    end if;

    v_line_total := round(
      v_item.quantity
      * v_purchase_item.unit_cost,
      2
    );

    insert into public.purchase_receipt_items (
      organization_id,
      receipt_id,
      purchase_item_id,
      product_id,
      purchase_unit_name,
      unit_factor,
      quantity,
      base_quantity,
      unit_cost,
      base_unit_cost,
      line_total
    )
    values (
      v_profile.organization_id,
      v_receipt_id,
      v_purchase_item.id,
      v_purchase_item.product_id,
      v_purchase_item.purchase_unit_name,
      v_purchase_item.unit_factor,
      v_item.quantity,
      v_base_receipt_quantity,
      v_purchase_item.unit_cost,
      v_purchase_item.base_unit_cost,
      v_line_total
    );

    update public.purchase_items
    set
      received_quantity = v_new_received_quantity,
      base_received_quantity =
        v_new_base_received_quantity
    where id = v_purchase_item.id;

    if v_product.track_stock then
      select *
      into strict v_balance
      from public.inventory_balances
      where branch_id = v_profile.branch_id
        and product_id = v_product.id
      for update;

      v_new_stock_quantity := round(
        v_balance.quantity
        + v_base_receipt_quantity,
        3
      );

      if v_balance.quantity > 0
         and v_new_stock_quantity > 0 then
        v_new_average := round(
          (
            v_balance.quantity
            * coalesce(v_balance.average_cost, 0)
            + v_base_receipt_quantity
            * v_purchase_item.base_unit_cost
          )
          / v_new_stock_quantity,
          4
        );
      else
        v_new_average :=
          v_purchase_item.base_unit_cost;
      end if;

      update public.inventory_balances
      set
        quantity = v_new_stock_quantity,
        average_cost = v_new_average,
        updated_at = now()
      where id = v_balance.id;

      update public.products
      set
        default_cost = v_new_average,
        updated_at = now()
      where id = v_product.id;

      insert into public.stock_movements (
        organization_id,
        branch_id,
        product_id,
        movement_type,
        quantity_change,
        quantity_before,
        quantity_after,
        unit_cost,
        reference_table,
        reference_id,
        notes,
        created_by,
        created_at
      )
      values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_product.id,
        'purchase',
        v_base_receipt_quantity,
        v_balance.quantity,
        v_new_stock_quantity,
        v_purchase_item.base_unit_cost,
        'purchase_receipts',
        v_receipt_id,
        format(
          '%s · %s · %s %s = %s %s',
          v_receipt_number,
          v_purchase.purchase_number,
          v_item.quantity,
          v_purchase_item.purchase_unit_name,
          v_base_receipt_quantity,
          v_product.unit_name
        ),
        v_user_id,
        v_received_at
      );
    else
      update public.products
      set
        default_cost =
          v_purchase_item.base_unit_cost,
        updated_at = now()
      where id = v_product.id;
    end if;

    v_receipt_item_count :=
      v_receipt_item_count + 1;

    v_receipt_purchase_units :=
      v_receipt_purchase_units
      + v_item.quantity;

    v_receipt_base_units :=
      v_receipt_base_units
      + v_base_receipt_quantity;

    v_receipt_value :=
      v_receipt_value
      + v_line_total;
  end loop;

  if p_amount_paid > 0 then
    insert into public.purchase_payments (
      organization_id,
      branch_id,
      purchase_id,
      method,
      currency,
      amount,
      reference_number,
      notes,
      paid_by,
      paid_at
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_purchase.id,
      p_payment_method,
      v_purchase.currency,
      round(p_amount_paid, 2),
      nullif(trim(p_payment_reference), ''),
      concat_ws(
        ' · ',
        v_receipt_number,
        nullif(trim(p_notes), '')
      ),
      v_user_id,
      v_received_at
    );
  end if;

  select
    coalesce(sum(item.quantity), 0),
    coalesce(sum(item.received_quantity), 0),
    coalesce(sum(item.base_quantity), 0),
    coalesce(sum(item.base_received_quantity), 0),
    bool_and(
      item.received_quantity >= item.quantity
    )
  into
    v_order_purchase_units,
    v_order_received_units,
    v_order_base_units,
    v_order_base_received,
    v_fully_received
  from public.purchase_items item
  where item.purchase_id = v_purchase.id;

  v_fully_received :=
    coalesce(v_fully_received, false);

  update public.purchases
  set
    status = case
      when v_fully_received
        then 'received'::public.purchase_status
      else 'ordered'::public.purchase_status
    end,

    amount_paid = v_new_paid,

    supplier_invoice_number = coalesce(
      nullif(trim(p_supplier_invoice_number), ''),
      supplier_invoice_number
    ),

    notes = case
      when nullif(trim(p_notes), '') is null
        then notes
      when notes is null
        then trim(p_notes)
      else notes || E'\n' || trim(p_notes)
    end,

    ordered_at = coalesce(
      ordered_at,
      v_received_at
    ),

    ordered_by = coalesce(
      ordered_by,
      v_user_id
    ),

    first_received_at = case
      when first_received_at is null
        then v_received_at
      else least(
        first_received_at,
        v_received_at
      )
    end,

    last_received_at = greatest(
      coalesce(last_received_at, v_received_at),
      v_received_at
    ),

    received_at = case
      when v_fully_received
        then greatest(
          coalesce(last_received_at, v_received_at),
          v_received_at
        )
      else null
    end,

    received_by = case
      when v_fully_received
        then v_user_id
      else null
    end,

    updated_at = now()
  where id = v_purchase.id;

  insert into public.audit_logs (
    organization_id,
    branch_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'receive_purchase_order_partial',
    'purchase_receipt',
    v_receipt_id,
    jsonb_build_object(
      'receipt_number', v_receipt_number,
      'purchase_id', v_purchase.id,
      'purchase_number',
        v_purchase.purchase_number,
      'receipt_item_count',
        v_receipt_item_count,
      'receipt_purchase_units',
        v_receipt_purchase_units,
      'receipt_base_units',
        v_receipt_base_units,
      'receipt_value',
        round(v_receipt_value, 2),
      'order_purchase_units',
        v_order_purchase_units,
      'order_received_units',
        v_order_received_units,
      'order_base_units',
        v_order_base_units,
      'order_base_received',
        v_order_base_received,
      'fully_received',
        v_fully_received,
      'amount_paid',
        v_new_paid,
      'balance_due',
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_supplier_credit,
          0
        )
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number',
      v_purchase.purchase_number,
    'receipt_id', v_receipt_id,
    'receipt_number', v_receipt_number,
    'received_at', v_received_at,
    'status', case
      when v_fully_received
        then 'received'
      else 'ordered'
    end,
    'receiving_status', case
      when v_fully_received
        then 'received'
      else 'partially_received'
    end,
    'receipt_item_count',
      v_receipt_item_count,
    'receipt_purchase_units',
      v_receipt_purchase_units,
    'receipt_base_units',
      v_receipt_base_units,
    'receipt_value',
      round(v_receipt_value, 2),
    'order_purchase_units',
      v_order_purchase_units,
    'order_received_units',
      v_order_received_units,
    'order_remaining_units',
      greatest(
        v_order_purchase_units
        - v_order_received_units,
        0
      ),
    'order_base_units',
      v_order_base_units,
    'order_base_received',
      v_order_base_received,
    'order_base_remaining',
      greatest(
        v_order_base_units
        - v_order_base_received,
        0
      ),
    'fully_received', v_fully_received,
    'amount_paid', v_new_paid,
    'supplier_return_credit',
      v_supplier_credit,
    'balance_due',
      round(
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_supplier_credit,
          0
        ),
        2
      ),
    'currency', v_purchase.currency
  );
end;
$$;

revoke all on function public.receive_purchase_order_v3(
  uuid,jsonb,numeric,public.payment_method,text,text,timestamptz,text
) from public, anon;
grant execute on function public.receive_purchase_order_v3(
  uuid,jsonb,numeric,public.payment_method,text,text,timestamptz,text
) to service_role;

notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- END STEP 46.4.2
-- ============================================================================
