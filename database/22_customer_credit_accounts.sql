-- ============================================================================
-- Tiny POS - Step 25: Customer Credit Accounts and Accounts Receivable
-- Run once in the NEW Supabase project after Step 24.
--
-- Features:
--   * Credit limits and payment terms by customer and currency
--   * Credit sales without creating a false cash/bank payment
--   * FIFO customer-payment allocation to the oldest outstanding invoices
--   * Credit-account refunds for unpaid credit invoices
--   * Statements, overdue balances, holds, audit records and backup support
--
-- This migration does not delete existing customers, sales, payments or stock.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. CREDIT ACCOUNTS
-- ----------------------------------------------------------------------------

create table if not exists public.customer_credit_accounts (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  customer_id uuid not null
    references public.customers(id) on delete cascade,

  currency public.currency_code not null default 'USD',

  credit_limit numeric(14,2) not null default 0
    check (credit_limit >= 0),

  balance_due numeric(14,2) not null default 0
    check (balance_due >= 0),

  payment_terms_days integer not null default 30
    check (payment_terms_days between 0 and 3650),

  is_on_hold boolean not null default false,
  notes text,
  last_activity_at timestamptz,

  created_by uuid
    references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (customer_id, currency)
);

create index if not exists customer_credit_accounts_org_balance_idx
  on public.customer_credit_accounts (
    organization_id,
    currency,
    balance_due desc
  );

create index if not exists customer_credit_accounts_customer_idx
  on public.customer_credit_accounts (
    customer_id,
    currency
  );

drop trigger if exists set_customer_credit_accounts_updated_at
  on public.customer_credit_accounts;

create trigger set_customer_credit_accounts_updated_at
before update on public.customer_credit_accounts
for each row execute function public.set_updated_at();

-- Create the base-currency credit account for customers that already have a
-- credit limit from the Customers module or CSV import.
insert into public.customer_credit_accounts (
  organization_id,
  customer_id,
  currency,
  credit_limit,
  balance_due,
  payment_terms_days,
  is_on_hold,
  created_by
)
select
  customer.organization_id,
  customer.id,
  coalesce(settings.base_currency, 'USD'),
  customer.credit_limit,
  0,
  30,
  false,
  customer.created_by
from public.customers customer
left join public.app_settings settings
  on settings.organization_id = customer.organization_id
where customer.credit_limit > 0
on conflict (customer_id, currency)
do update set
  credit_limit = greatest(
    public.customer_credit_accounts.credit_limit,
    excluded.credit_limit
  ),
  updated_at = now();

-- Keep the legacy Customers.credit_limit field synchronized to the account in
-- the organization's base currency. This preserves the existing customer form
-- and CSV import behavior.
create or replace function private.sync_customer_base_credit_account()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_currency public.currency_code := 'USD';
begin
  select coalesce(settings.base_currency, 'USD')
  into v_currency
  from public.app_settings settings
  where settings.organization_id = new.organization_id;

  if new.credit_limit > 0
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
      0,
      30,
      false,
      new.created_by
    )
    on conflict (customer_id, currency)
    do update set
      credit_limit = excluded.credit_limit,
      updated_at = now();
  end if;

  return new;
end;
$$;

drop trigger if exists sync_customer_base_credit_account
  on public.customers;

create trigger sync_customer_base_credit_account
after insert or update of credit_limit
on public.customers
for each row execute function private.sync_customer_base_credit_account();

-- ----------------------------------------------------------------------------
-- 2. CREDIT PAYMENTS AND LEDGER
-- ----------------------------------------------------------------------------

create table if not exists public.customer_credit_payments (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid not null
    references public.branches(id) on delete restrict,

  account_id uuid not null
    references public.customer_credit_accounts(id) on delete restrict,

  payment_number text not null,
  method public.payment_method not null,
  currency public.currency_code not null,

  amount numeric(14,2) not null
    check (amount > 0),

  reference_number text,
  notes text,

  received_by uuid not null
    references auth.users(id) on delete restrict,

  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  unique (organization_id, payment_number)
);

create index if not exists customer_credit_payments_account_date_idx
  on public.customer_credit_payments (
    account_id,
    paid_at desc
  );

create table if not exists public.customer_credit_payment_allocations (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  credit_payment_id uuid not null
    references public.customer_credit_payments(id) on delete cascade,

  sale_id uuid not null
    references public.sales(id) on delete restrict,

  amount numeric(14,2) not null
    check (amount > 0),

  created_at timestamptz not null default now(),

  unique (credit_payment_id, sale_id)
);

create index if not exists customer_credit_allocations_sale_idx
  on public.customer_credit_payment_allocations (
    sale_id,
    created_at desc
  );

create table if not exists public.customer_credit_entries (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid
    references public.branches(id) on delete set null,

  account_id uuid not null
    references public.customer_credit_accounts(id) on delete restrict,

  entry_type text not null
    check (entry_type in ('sale', 'payment', 'credit_note')),

  amount_change numeric(14,2) not null
    check (amount_change <> 0),

  balance_before numeric(14,2) not null
    check (balance_before >= 0),

  balance_after numeric(14,2) not null
    check (balance_after >= 0),

  sale_id uuid
    references public.sales(id) on delete set null,

  credit_payment_id uuid
    references public.customer_credit_payments(id) on delete set null,

  return_id uuid
    references public.returns(id) on delete set null,

  description text not null
    check (length(trim(description)) >= 3),

  created_by uuid not null
    references auth.users(id) on delete restrict,

  created_at timestamptz not null default now(),

  check (
    balance_after = round(balance_before + amount_change, 2)
  )
);

create index if not exists customer_credit_entries_account_date_idx
  on public.customer_credit_entries (
    account_id,
    created_at desc
  );

-- Sales identify credit invoices without adding a fake payment row.
alter table public.sales
  add column if not exists credit_account_id uuid
    references public.customer_credit_accounts(id) on delete set null,
  add column if not exists credit_due_date date,
  add column if not exists credit_amount numeric(14,2) not null default 0
    check (credit_amount >= 0);

create index if not exists sales_credit_account_due_idx
  on public.sales (
    credit_account_id,
    credit_due_date,
    completed_at
  )
  where credit_account_id is not null;

-- Actual customer collections are still allocated into the normal Payments
-- table so cash-register and payment reporting remain correct.
alter table public.payments
  add column if not exists credit_payment_id uuid
    references public.customer_credit_payments(id) on delete set null;

create index if not exists payments_credit_payment_idx
  on public.payments (credit_payment_id)
  where credit_payment_id is not null;

-- Credit refunds reduce receivables. They use the existing return workflow but
-- are marked separately instead of adding a new value to payment_method enum.
alter table public.returns
  add column if not exists credit_account_id uuid
    references public.customer_credit_accounts(id) on delete set null,
  add column if not exists credit_refund_amount numeric(14,2) not null default 0
    check (credit_refund_amount >= 0);

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table public.customer_credit_accounts enable row level security;
alter table public.customer_credit_payments enable row level security;
alter table public.customer_credit_payment_allocations enable row level security;
alter table public.customer_credit_entries enable row level security;

drop policy if exists customer_credit_accounts_select_staff
  on public.customer_credit_accounts;

create policy customer_credit_accounts_select_staff
on public.customer_credit_accounts
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager',
      'cashier'
    ]::public.app_role[]
  ))
);

drop policy if exists customer_credit_payments_select_staff
  on public.customer_credit_payments;

create policy customer_credit_payments_select_staff
on public.customer_credit_payments
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager',
      'cashier'
    ]::public.app_role[]
  ))
);

drop policy if exists customer_credit_allocations_select_staff
  on public.customer_credit_payment_allocations;

create policy customer_credit_allocations_select_staff
on public.customer_credit_payment_allocations
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager',
      'cashier'
    ]::public.app_role[]
  ))
);

drop policy if exists customer_credit_entries_select_staff
  on public.customer_credit_entries;

create policy customer_credit_entries_select_staff
on public.customer_credit_entries
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager',
      'cashier'
    ]::public.app_role[]
  ))
);

revoke all on public.customer_credit_accounts from anon;
revoke all on public.customer_credit_payments from anon;
revoke all on public.customer_credit_payment_allocations from anon;
revoke all on public.customer_credit_entries from anon;

revoke insert, update, delete
  on public.customer_credit_accounts from authenticated;
revoke insert, update, delete
  on public.customer_credit_payments from authenticated;
revoke insert, update, delete
  on public.customer_credit_payment_allocations from authenticated;
revoke insert, update, delete
  on public.customer_credit_entries from authenticated;

grant select on public.customer_credit_accounts to authenticated;
grant select on public.customer_credit_payments to authenticated;
grant select on public.customer_credit_payment_allocations to authenticated;
grant select on public.customer_credit_entries to authenticated;

grant all on public.customer_credit_accounts to service_role;
grant all on public.customer_credit_payments to service_role;
grant all on public.customer_credit_payment_allocations to service_role;
grant all on public.customer_credit_entries to service_role;

-- ----------------------------------------------------------------------------
-- 4. CREATE OR UPDATE A CREDIT ACCOUNT
-- ----------------------------------------------------------------------------

create or replace function public.save_customer_credit_account(
  p_customer_id uuid,
  p_currency public.currency_code,
  p_credit_limit numeric,
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
  v_user_id uuid := auth.uid();
  v_profile record;
  v_customer public.customers%rowtype;
  v_account public.customer_credit_accounts%rowtype;
  v_base_currency public.currency_code := 'USD';
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

  if v_profile.role not in ('owner','admin','manager') then
    raise exception 'Only management can configure credit accounts';
  end if;

  if p_credit_limit is null or p_credit_limit < 0 then
    raise exception 'Credit limit cannot be negative';
  end if;

  if p_payment_terms_days is null
     or p_payment_terms_days < 0
     or p_payment_terms_days > 3650 then
    raise exception 'Payment terms must be between 0 and 3650 days';
  end if;

  select *
  into v_customer
  from public.customers
  where id = p_customer_id
    and organization_id = v_profile.organization_id
    and is_active = true;

  if not found then
    raise exception 'Customer not found or inactive';
  end if;

  insert into public.customer_credit_accounts (
    organization_id,
    customer_id,
    currency,
    credit_limit,
    balance_due,
    payment_terms_days,
    is_on_hold,
    notes,
    created_by,
    last_activity_at
  )
  values (
    v_profile.organization_id,
    v_customer.id,
    p_currency,
    round(p_credit_limit, 2),
    0,
    p_payment_terms_days,
    coalesce(p_is_on_hold, false),
    nullif(trim(p_notes), ''),
    v_user_id,
    now()
  )
  on conflict (customer_id, currency)
  do update set
    credit_limit = excluded.credit_limit,
    payment_terms_days = excluded.payment_terms_days,
    is_on_hold = excluded.is_on_hold,
    notes = excluded.notes,
    last_activity_at = now(),
    updated_at = now()
  returning * into v_account;

  select coalesce(settings.base_currency, 'USD')
  into v_base_currency
  from public.app_settings settings
  where settings.organization_id = v_profile.organization_id;

  if p_currency = v_base_currency then
    update public.customers
    set
      credit_limit = v_account.credit_limit,
      updated_at = now()
    where id = v_customer.id;
  end if;

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
    'save_customer_credit_account',
    'customer_credit_account',
    v_account.id,
    jsonb_build_object(
      'customer_id', v_customer.id,
      'customer_name', v_customer.name,
      'currency', v_account.currency,
      'credit_limit', v_account.credit_limit,
      'balance_due', v_account.balance_due,
      'payment_terms_days', v_account.payment_terms_days,
      'is_on_hold', v_account.is_on_hold
    )
  );

  return to_jsonb(v_account);
end;
$$;

revoke all on function public.save_customer_credit_account(
  uuid,
  public.currency_code,
  numeric,
  integer,
  boolean,
  text
) from public, anon;

grant execute on function public.save_customer_credit_account(
  uuid,
  public.currency_code,
  numeric,
  integer,
  boolean,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. CREDIT-AWARE SECURE CHECKOUT
-- Existing complete_sale_v3 remains the source of truth for product pricing,
-- coupons, tax, stock, cost and profit. Credit checkout calls it inside the
-- same database transaction, removes the temporary payment, then posts the
-- receivable to the customer ledger.
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v4(
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

    return public.complete_sale_v3(
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

  if v_account.credit_limit <= 0 then
    raise exception 'This customer has no available credit limit';
  end if;

  -- Use a non-cash temporary payment. It is removed before commit.
  v_result := public.complete_sale_v3(
    p_items,
    'other'::public.payment_method,
    999999999999999::numeric,
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
      'credit_available_after', greatest(
        v_account.credit_limit - v_account.balance_due,
        0
      )
    );
  end if;

  v_total := round(v_sale.total_amount, 2);

  if v_total <= 0 then
    raise exception 'Credit sale total must be greater than zero';
  end if;

  v_balance_before := v_account.balance_due;
  v_balance_after := round(v_balance_before + v_total, 2);

  if v_balance_after > v_account.credit_limit then
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
      'balance_after', v_balance_after
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
    'credit_available_after', greatest(
      v_account.credit_limit - v_balance_after,
      0
    )
  );
end;
$$;

revoke all on function public.complete_sale_v4(
  jsonb,
  text,
  numeric,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  text,
  text,
  text
) from public, anon;

grant execute on function public.complete_sale_v4(
  jsonb,
  text,
  numeric,
  uuid,
  public.discount_type,
  numeric,
  text,
  public.currency_code,
  text,
  text,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. RECEIVE A CUSTOMER CREDIT PAYMENT
-- Payments are allocated oldest-due-invoice first. Normal Payments rows are
-- created for every allocation, preserving payment reports and cash registers.
-- ----------------------------------------------------------------------------

create or replace function public.record_customer_credit_payment(
  p_account_id uuid,
  p_amount numeric,
  p_method public.payment_method,
  p_reference_number text default null,
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
  v_account public.customer_credit_accounts%rowtype;
  v_customer public.customers%rowtype;
  v_sale public.sales%rowtype;
  v_payment_id uuid;
  v_payment_number text;
  v_amount numeric(14,2);
  v_remaining numeric(14,2);
  v_outstanding numeric(14,2);
  v_allocation numeric(14,2);
  v_balance_before numeric(14,2);
  v_balance_after numeric(14,2);
  v_new_sale_paid numeric(14,2);
  v_new_payment_status public.payment_status;
  v_allocated_invoice_count integer := 0;
begin
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
    raise exception 'Your role cannot receive customer payments';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  select *
  into v_account
  from public.customer_credit_accounts
  where id = p_account_id
    and organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Customer credit account not found';
  end if;

  select *
  into v_customer
  from public.customers
  where id = v_account.customer_id
    and organization_id = v_profile.organization_id;

  if not found then
    raise exception 'Customer not found';
  end if;

  v_amount := round(p_amount, 2);

  if v_amount > v_account.balance_due then
    raise exception
      'Payment cannot exceed the current balance of %',
      v_account.balance_due;
  end if;

  v_balance_before := v_account.balance_due;
  v_balance_after := round(v_balance_before - v_amount, 2);
  v_remaining := v_amount;

  v_payment_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'CRP'
  );

  insert into public.customer_credit_payments (
    organization_id,
    branch_id,
    account_id,
    payment_number,
    method,
    currency,
    amount,
    reference_number,
    notes,
    received_by,
    paid_at
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_account.id,
    v_payment_number,
    p_method,
    v_account.currency,
    v_amount,
    nullif(trim(p_reference_number), ''),
    nullif(trim(p_notes), ''),
    v_user_id,
    now()
  )
  returning id into v_payment_id;

  for v_sale in
    select sale_row.*
    from public.sales sale_row
    where sale_row.organization_id = v_profile.organization_id
      and sale_row.credit_account_id = v_account.id
      and sale_row.credit_amount > sale_row.paid_amount
      and sale_row.status <> 'voided'
    order by
      sale_row.credit_due_date nulls last,
      coalesce(sale_row.completed_at, sale_row.created_at),
      sale_row.invoice_number
    for update
  loop
    exit when v_remaining <= 0;

    v_outstanding := round(
      v_sale.credit_amount - v_sale.paid_amount,
      2
    );

    if v_outstanding <= 0 then
      continue;
    end if;

    v_allocation := least(v_remaining, v_outstanding);
    v_new_sale_paid := round(v_sale.paid_amount + v_allocation, 2);

    if v_new_sale_paid >= v_sale.credit_amount then
      v_new_payment_status := 'paid';
    elsif v_new_sale_paid > 0 then
      v_new_payment_status := 'partial';
    else
      v_new_payment_status := 'unpaid';
    end if;

    insert into public.customer_credit_payment_allocations (
      organization_id,
      credit_payment_id,
      sale_id,
      amount
    )
    values (
      v_profile.organization_id,
      v_payment_id,
      v_sale.id,
      v_allocation
    );

    insert into public.payments (
      organization_id,
      branch_id,
      sale_id,
      method,
      currency,
      amount,
      tendered_amount,
      change_amount,
      reference_number,
      received_by,
      paid_at,
      notes,
      credit_payment_id
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_sale.id,
      p_method,
      v_account.currency,
      v_allocation,
      v_allocation,
      0,
      nullif(trim(p_reference_number), ''),
      v_user_id,
      now(),
      'Credit collection ' || v_payment_number,
      v_payment_id
    );

    update public.sales
    set
      paid_amount = v_new_sale_paid,
      payment_status = v_new_payment_status,
      updated_at = now()
    where id = v_sale.id;

    v_remaining := round(v_remaining - v_allocation, 2);
    v_allocated_invoice_count := v_allocated_invoice_count + 1;
  end loop;

  if v_remaining <> 0 then
    raise exception
      'Credit balance and outstanding invoices are inconsistent. Remaining allocation: %',
      v_remaining;
  end if;

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
    credit_payment_id,
    description,
    created_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_account.id,
    'payment',
    -v_amount,
    v_balance_before,
    v_balance_after,
    v_payment_id,
    'Customer payment ' || v_payment_number,
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
    'record_customer_credit_payment',
    'customer_credit_payment',
    v_payment_id,
    jsonb_build_object(
      'payment_number', v_payment_number,
      'customer_id', v_customer.id,
      'customer_name', v_customer.name,
      'account_id', v_account.id,
      'currency', v_account.currency,
      'amount', v_amount,
      'method', p_method,
      'balance_before', v_balance_before,
      'balance_after', v_balance_after,
      'allocated_invoice_count', v_allocated_invoice_count
    )
  );

  return jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'payment_number', v_payment_number,
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'account_id', v_account.id,
    'currency', v_account.currency,
    'amount', v_amount,
    'method', p_method,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after,
    'allocated_invoice_count', v_allocated_invoice_count
  );
end;
$$;

revoke all on function public.record_customer_credit_payment(
  uuid,
  numeric,
  public.payment_method,
  text,
  text
) from public, anon;

grant execute on function public.record_customer_credit_payment(
  uuid,
  numeric,
  public.payment_method,
  text,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. CREDIT-AWARE CUSTOMER RETURN WRAPPER
-- ----------------------------------------------------------------------------

create or replace function public.process_sale_return_v2(
  p_sale_id uuid,
  p_items jsonb,
  p_refund_method text,
  p_reason text,
  p_refund_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_sale public.sales%rowtype;
  v_account public.customer_credit_accounts%rowtype;
  v_result jsonb;
  v_return_id uuid;
  v_refund_amount numeric(14,2);
  v_outstanding numeric(14,2);
  v_new_credit_amount numeric(14,2);
  v_balance_before numeric(14,2);
  v_balance_after numeric(14,2);
  v_new_payment_status public.payment_status;
  v_method text := lower(trim(coalesce(p_refund_method, '')));
begin
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

  select *
  into v_sale
  from public.sales
  where id = p_sale_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id;

  if not found then
    raise exception 'Sale not found';
  end if;

  if v_method = 'credit' then
    if v_sale.credit_account_id is null then
      raise exception 'Only a credit invoice can be refunded to Credit Account';
    end if;

    select *
    into v_account
    from public.customer_credit_accounts
    where id = v_sale.credit_account_id
      and organization_id = v_profile.organization_id
    for update;

    if not found then
      raise exception 'Customer credit account not found';
    end if;

    select *
    into strict v_sale
    from public.sales
    where id = p_sale_id
      and organization_id = v_profile.organization_id
      and branch_id = v_profile.branch_id
    for update;

    v_outstanding := greatest(
      round(v_sale.credit_amount - v_sale.paid_amount, 2),
      0
    );

    if v_outstanding <= 0 then
      raise exception 'This credit invoice is already paid. Use a cash, bank, KHQR, card or other refund';
    end if;

    v_result := public.process_sale_return(
      p_sale_id,
      p_items,
      'other'::public.payment_method,
      p_reason,
      p_refund_reference
    );

    v_return_id := (v_result ->> 'return_id')::uuid;
    v_refund_amount := round((v_result ->> 'refund_amount')::numeric, 2);

    if v_refund_amount > v_outstanding then
      raise exception
        'Credit-account refund cannot exceed the unpaid invoice balance of %',
        v_outstanding;
    end if;

    if v_refund_amount > v_account.balance_due then
      raise exception 'Credit-account balance is lower than this refund';
    end if;

    v_new_credit_amount := round(v_sale.credit_amount - v_refund_amount, 2);
    v_balance_before := v_account.balance_due;
    v_balance_after := round(v_balance_before - v_refund_amount, 2);

    if (v_result ->> 'sale_status') = 'refunded' then
      v_new_payment_status := 'refunded';
    elsif v_sale.paid_amount <= 0 then
      v_new_payment_status := 'unpaid';
    elsif v_sale.paid_amount < v_new_credit_amount then
      v_new_payment_status := 'partial';
    else
      v_new_payment_status := 'paid';
    end if;

    update public.sales
    set
      credit_amount = v_new_credit_amount,
      payment_status = v_new_payment_status,
      updated_at = now()
    where id = v_sale.id;

    update public.returns
    set
      credit_account_id = v_account.id,
      credit_refund_amount = v_refund_amount
    where id = v_return_id;

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
      return_id,
      description,
      created_by
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_account.id,
      'credit_note',
      -v_refund_amount,
      v_balance_before,
      v_balance_after,
      v_sale.id,
      v_return_id,
      'Credit note for invoice ' || v_sale.invoice_number,
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
      'refund_credit_invoice',
      'return',
      v_return_id,
      jsonb_build_object(
        'invoice_number', v_sale.invoice_number,
        'credit_account_id', v_account.id,
        'credit_refund_amount', v_refund_amount,
        'balance_before', v_balance_before,
        'balance_after', v_balance_after
      )
    );

    return v_result || jsonb_build_object(
      'refund_method', 'credit',
      'credit_account_id', v_account.id,
      'credit_refund_amount', v_refund_amount,
      'credit_balance_after', v_balance_after
    );
  end if;

  if v_method not in ('cash','bank','khqr','card','other') then
    raise exception 'Unsupported refund method';
  end if;

  select *
  into strict v_sale
  from public.sales
  where id = p_sale_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if v_sale.credit_account_id is not null
     and v_sale.credit_amount > v_sale.paid_amount then
    raise exception 'This invoice still has an unpaid credit balance. Use Credit Account as the refund method';
  end if;

  return public.process_sale_return(
    p_sale_id,
    p_items,
    v_method::public.payment_method,
    p_reason,
    p_refund_reference
  );
end;
$$;

revoke all on function public.process_sale_return_v2(
  uuid,
  jsonb,
  text,
  text,
  text
) from public, anon;

grant execute on function public.process_sale_return_v2(
  uuid,
  jsonb,
  text,
  text,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. CREDIT ACCOUNTS WORKSPACE
-- ----------------------------------------------------------------------------

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
      'balance_due', account.balance_due,
      'available_credit', greatest(
        account.credit_limit - account.balance_due,
        0
      ),
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
        'is_active', customer.is_active
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
        when account.balance_due >= account.credit_limit
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

revoke all on function public.get_customer_credit_workspace()
  from public, anon;

grant execute on function public.get_customer_credit_workspace()
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9. CUSTOMER CREDIT STATEMENT
-- ----------------------------------------------------------------------------

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
    'available_credit', greatest(
      v_account.credit_limit - v_account.balance_due,
      0
    ),
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

revoke all on function public.get_customer_credit_statement(uuid)
  from public, anon;

grant execute on function public.get_customer_credit_statement(uuid)
  to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 25
-- ============================================================================
