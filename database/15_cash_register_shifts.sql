-- ============================================================================
-- Tiny POS - Step 17: Cash register shifts and end-of-day closing
-- Run once in the NEW Supabase project after Step 16.
-- This migration does not delete or reset existing data.
--
-- IMPORTANT:
-- After this migration, new CASH sales, CASH refunds, CASH supplier payments,
-- and CASH income/expense entries require an open cash register at the branch.
-- Bank, KHQR, card, and other payment methods are unaffected.
-- ============================================================================

begin;

do $$
begin
  if not exists (
    select 1
    from pg_type
    where typname = 'cash_register_status'
  ) then
    create type public.cash_register_status
      as enum ('open', 'closed');
  end if;
end
$$;

create table if not exists public.cash_register_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  branch_id uuid not null
    references public.branches(id) on delete restrict,
  session_number text not null,
  register_name text not null default 'Main Register'
    check (length(trim(register_name)) between 1 and 80),
  status public.cash_register_status not null default 'open',

  opening_cash_usd numeric(14,2) not null default 0
    check (opening_cash_usd >= 0),
  opening_cash_khr numeric(14,2) not null default 0
    check (opening_cash_khr >= 0),

  expected_cash_usd numeric(14,2) not null default 0,
  expected_cash_khr numeric(14,2) not null default 0,

  counted_cash_usd numeric(14,2),
  counted_cash_khr numeric(14,2),

  variance_usd numeric(14,2),
  variance_khr numeric(14,2),

  opening_note text,
  closing_note text,

  opened_by uuid not null
    references auth.users(id) on delete restrict,
  opened_at timestamptz not null default now(),

  closed_by uuid
    references auth.users(id) on delete set null,
  closed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, session_number),

  check (
    (status = 'open' and closed_at is null)
    or
    (status = 'closed' and closed_at is not null)
  )
);

create unique index if not exists cash_register_one_open_per_branch_uq
  on public.cash_register_sessions (branch_id)
  where status = 'open';

create index if not exists cash_register_branch_opened_idx
  on public.cash_register_sessions (
    organization_id,
    branch_id,
    opened_at desc
  );

drop trigger if exists set_cash_register_sessions_updated_at
  on public.cash_register_sessions;

create trigger set_cash_register_sessions_updated_at
before update on public.cash_register_sessions
for each row execute function public.set_updated_at();

alter table public.cash_register_sessions enable row level security;

drop policy if exists cash_register_sessions_select_authorized
  on public.cash_register_sessions;

create policy cash_register_sessions_select_authorized
on public.cash_register_sessions
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and branch_id = (select private.current_branch_id())
  and (
    opened_by = (select auth.uid())
    or
    (select private.has_any_role(
      array[
        'owner',
        'admin',
        'manager',
        'viewer'
      ]::public.app_role[]
    ))
  )
);

revoke all on public.cash_register_sessions from anon;
grant select on public.cash_register_sessions to authenticated;
grant all on public.cash_register_sessions to service_role;

-- ----------------------------------------------------------------------------
-- Calculate drawer activity for one session.
-- ----------------------------------------------------------------------------

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
    and p.paid_at >= v_session.opened_at
    and p.paid_at <= v_end_at;

  select
    coalesce(sum(case when r.currency = 'USD' then r.refund_amount else 0 end), 0),
    coalesce(sum(case when r.currency = 'KHR' then r.refund_amount else 0 end), 0)
  into v_refunds_usd, v_refunds_khr
  from public.returns r
  where r.organization_id = v_session.organization_id
    and r.branch_id = v_session.branch_id
    and r.status = 'completed'
    and r.refund_method = 'cash'
    and r.processed_at >= v_session.opened_at
    and r.processed_at <= v_end_at;

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
    and e.entry_at >= v_session.opened_at
    and e.entry_at <= v_end_at;

  select
    coalesce(sum(case when p.currency = 'USD' then p.amount else 0 end), 0),
    coalesce(sum(case when p.currency = 'KHR' then p.amount else 0 end), 0)
  into v_supplier_usd, v_supplier_khr
  from public.purchase_payments p
  where p.organization_id = v_session.organization_id
    and p.branch_id = v_session.branch_id
    and p.method = 'cash'
    and p.paid_at >= v_session.opened_at
    and p.paid_at <= v_end_at;

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

-- ----------------------------------------------------------------------------
-- Open a register for the currently selected branch.
-- ----------------------------------------------------------------------------

create or replace function public.open_cash_register(
  p_opening_cash_usd numeric default 0,
  p_opening_cash_khr numeric default 0,
  p_register_name text default 'Main Register',
  p_opening_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session_id uuid;
  v_session_number text;
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

  if v_profile.role not in (
    'owner',
    'admin',
    'manager',
    'cashier'
  ) then
    raise exception 'Your role cannot open a cash register';
  end if;

  if coalesce(p_opening_cash_usd, 0) < 0
     or coalesce(p_opening_cash_khr, 0) < 0 then
    raise exception 'Opening cash cannot be negative';
  end if;

  if p_register_name is null
     or length(trim(p_register_name)) = 0 then
    raise exception 'Register name is required';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('tiny-pos-cash-register:' || v_profile.branch_id::text)
  );

  if exists (
    select 1
    from public.cash_register_sessions
    where branch_id = v_profile.branch_id
      and status = 'open'
  ) then
    raise exception 'This branch already has an open cash register';
  end if;

  v_session_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'REG'
  );

  insert into public.cash_register_sessions (
    organization_id,
    branch_id,
    session_number,
    register_name,
    status,
    opening_cash_usd,
    opening_cash_khr,
    opening_note,
    opened_by,
    opened_at
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_session_number,
    trim(p_register_name),
    'open',
    round(coalesce(p_opening_cash_usd, 0), 2),
    round(coalesce(p_opening_cash_khr, 0), 2),
    nullif(trim(p_opening_note), ''),
    v_user_id,
    now()
  )
  returning id into v_session_id;

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
    'open_cash_register',
    'cash_register_session',
    v_session_id,
    jsonb_build_object(
      'session_number', v_session_number,
      'register_name', trim(p_register_name),
      'opening_cash_usd', round(coalesce(p_opening_cash_usd, 0), 2),
      'opening_cash_khr', round(coalesce(p_opening_cash_khr, 0), 2)
    )
  );

  return private.cash_register_summary(
    v_session_id,
    now()
  );
end;
$$;

revoke all on function public.open_cash_register(
  numeric,
  numeric,
  text,
  text
) from public, anon;

grant execute on function public.open_cash_register(
  numeric,
  numeric,
  text,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Close the current branch register and store the final variance.
-- ----------------------------------------------------------------------------

create or replace function public.close_cash_register(
  p_counted_cash_usd numeric,
  p_counted_cash_khr numeric,
  p_closing_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session public.cash_register_sessions%rowtype;
  v_summary jsonb;
  v_now timestamptz := now();
  v_expected_usd numeric(14,2);
  v_expected_khr numeric(14,2);
  v_counted_usd numeric(14,2);
  v_counted_khr numeric(14,2);
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

  if coalesce(p_counted_cash_usd, 0) < 0
     or coalesce(p_counted_cash_khr, 0) < 0 then
    raise exception 'Counted cash cannot be negative';
  end if;

  select *
  into v_session
  from public.cash_register_sessions
  where organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
    and status = 'open'
  for update;

  if not found then
    raise exception 'There is no open cash register for this branch';
  end if;

  if v_profile.role = 'cashier'
     and v_session.opened_by <> v_user_id then
    raise exception 'A cashier may close only the register they opened';
  end if;

  if v_profile.role not in (
    'owner',
    'admin',
    'manager',
    'cashier'
  ) then
    raise exception 'Your role cannot close a cash register';
  end if;

  v_summary := private.cash_register_summary(
    v_session.id,
    v_now
  );

  v_expected_usd := coalesce(
    (v_summary #>> '{totals,USD,expected}')::numeric,
    0
  );
  v_expected_khr := coalesce(
    (v_summary #>> '{totals,KHR,expected}')::numeric,
    0
  );

  v_counted_usd := round(
    coalesce(p_counted_cash_usd, 0),
    2
  );
  v_counted_khr := round(
    coalesce(p_counted_cash_khr, 0),
    2
  );

  update public.cash_register_sessions
  set
    status = 'closed',
    expected_cash_usd = v_expected_usd,
    expected_cash_khr = v_expected_khr,
    counted_cash_usd = v_counted_usd,
    counted_cash_khr = v_counted_khr,
    variance_usd = round(v_counted_usd - v_expected_usd, 2),
    variance_khr = round(v_counted_khr - v_expected_khr, 2),
    closing_note = nullif(trim(p_closing_note), ''),
    closed_by = v_user_id,
    closed_at = v_now,
    updated_at = v_now
  where id = v_session.id;

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
    'close_cash_register',
    'cash_register_session',
    v_session.id,
    jsonb_build_object(
      'session_number', v_session.session_number,
      'expected_cash_usd', v_expected_usd,
      'expected_cash_khr', v_expected_khr,
      'counted_cash_usd', v_counted_usd,
      'counted_cash_khr', v_counted_khr,
      'variance_usd', round(v_counted_usd - v_expected_usd, 2),
      'variance_khr', round(v_counted_khr - v_expected_khr, 2)
    )
  );

  return private.cash_register_summary(
    v_session.id,
    v_now
  );
end;
$$;

revoke all on function public.close_cash_register(
  numeric,
  numeric,
  text
) from public, anon;

grant execute on function public.close_cash_register(
  numeric,
  numeric,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Read the open register for the user's selected branch.
-- ----------------------------------------------------------------------------

create or replace function public.get_open_cash_register_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session_id uuid;
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

  select id
  into v_session_id
  from public.cash_register_sessions
  where organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
    and status = 'open'
  limit 1;

  if v_session_id is null then
    return jsonb_build_object(
      'session', null,
      'totals', null
    );
  end if;

  return private.cash_register_summary(
    v_session_id,
    now()
  );
end;
$$;

revoke all on function public.get_open_cash_register_summary()
  from public, anon;

grant execute on function public.get_open_cash_register_summary()
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Read a historical session report.
-- ----------------------------------------------------------------------------

create or replace function public.get_cash_register_session_summary(
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session public.cash_register_sessions%rowtype;
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

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile required';
  end if;

  select *
  into v_session
  from public.cash_register_sessions
  where id = p_session_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id;

  if not found then
    raise exception 'Cash register session not found in this branch';
  end if;

  if v_profile.role = 'cashier'
     and v_session.opened_by <> v_user_id then
    raise exception 'You cannot view another cashier''s register session';
  end if;

  return private.cash_register_summary(
    v_session.id,
    coalesce(v_session.closed_at, now())
  );
end;
$$;

revoke all on function public.get_cash_register_session_summary(uuid)
  from public, anon;

grant execute on function public.get_cash_register_session_summary(uuid)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Require an open register for every new cash drawer transaction.
--
-- The service role is allowed through so owner-authorized backup restore and
-- administrative recovery can insert historical records.
-- ----------------------------------------------------------------------------

create or replace function private.enforce_open_cash_register()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_organization_id uuid;
  v_branch_id uuid;
  v_method public.payment_method;
  v_transaction_at timestamptz;
  v_opened_at timestamptz;
begin
  if auth.uid() is null then
    return new;
  end if;

  if tg_table_name = 'payments' then
    v_organization_id := new.organization_id;
    v_branch_id := new.branch_id;
    v_method := new.method;
    v_transaction_at := new.paid_at;

  elsif tg_table_name = 'returns' then
    v_organization_id := new.organization_id;
    v_branch_id := new.branch_id;
    v_method := new.refund_method;
    v_transaction_at := new.processed_at;

  elsif tg_table_name = 'purchase_payments' then
    v_organization_id := new.organization_id;
    v_branch_id := new.branch_id;
    v_method := new.method;
    v_transaction_at := new.paid_at;

  elsif tg_table_name = 'cash_entries' then
    if new.status <> 'active' then
      return new;
    end if;

    v_organization_id := new.organization_id;
    v_branch_id := new.branch_id;
    v_method := new.method;
    v_transaction_at := new.entry_at;

  else
    return new;
  end if;

  if v_method is distinct from 'cash'::public.payment_method then
    return new;
  end if;

  select opened_at
  into v_opened_at
  from public.cash_register_sessions
  where organization_id = v_organization_id
    and branch_id = v_branch_id
    and status = 'open'
  for share;

  if not found then
    raise exception
      'Open the cash register before recording a cash transaction';
  end if;

  if coalesce(v_transaction_at, now()) < v_opened_at then
    raise exception
      'Cash transaction time cannot be before the register opening time';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_open_cash_register()
  from public;

grant execute on function private.enforce_open_cash_register()
  to authenticated, service_role;

drop trigger if exists require_register_for_sale_cash
  on public.payments;

create trigger require_register_for_sale_cash
before insert on public.payments
for each row execute function private.enforce_open_cash_register();

drop trigger if exists require_register_for_cash_refund
  on public.returns;

create trigger require_register_for_cash_refund
before insert on public.returns
for each row execute function private.enforce_open_cash_register();

drop trigger if exists require_register_for_purchase_cash
  on public.purchase_payments;

create trigger require_register_for_purchase_cash
before insert on public.purchase_payments
for each row execute function private.enforce_open_cash_register();

drop trigger if exists require_register_for_cash_entry
  on public.cash_entries;

create trigger require_register_for_cash_entry
before insert or update of
  method,
  status,
  amount,
  entry_at
on public.cash_entries
for each row execute function private.enforce_open_cash_register();

commit;

-- ============================================================================
-- END STEP 17
-- ============================================================================
