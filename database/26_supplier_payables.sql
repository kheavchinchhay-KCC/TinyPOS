-- ============================================================================
-- Tiny POS - Step 29: Supplier Payables, Aging and Statements
-- Run once in the NEW Supabase project after Step 28.
--
-- Adds supplier payment terms, purchase due dates, supplier-level payment
-- batches, aging reports, statements and purchase-return credits.
--
-- This migration does not delete existing business data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. SUPPLIER TERMS, PURCHASE DUE DATES AND PAYMENT BATCHES
-- ----------------------------------------------------------------------------

alter table public.suppliers
  add column if not exists default_payment_terms_days integer
    not null default 0
    check (default_payment_terms_days between 0 and 3650);

alter table public.purchases
  add column if not exists payment_due_date date;

create index if not exists purchases_supplier_due_idx
  on public.purchases (
    organization_id,
    supplier_id,
    payment_due_date,
    status
  );

create table if not exists public.supplier_payment_batches (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid not null
    references public.branches(id) on delete restrict,

  payment_number text not null,

  supplier_id uuid not null
    references public.suppliers(id) on delete restrict,

  currency public.currency_code not null,

  method public.payment_method not null,

  amount numeric(14,2) not null
    check (amount > 0),

  reference_number text,
  notes text,

  paid_by uuid not null
    references auth.users(id) on delete restrict,

  paid_at timestamptz not null default now(),

  created_at timestamptz not null default now(),

  unique (organization_id, payment_number)
);

create index if not exists supplier_payment_batches_supplier_paid_idx
  on public.supplier_payment_batches (
    organization_id,
    supplier_id,
    paid_at desc
  );

alter table public.purchase_payments
  add column if not exists payment_batch_id uuid
    references public.supplier_payment_batches(id)
    on delete set null;

create index if not exists purchase_payments_batch_idx
  on public.purchase_payments (payment_batch_id)
  where payment_batch_id is not null;

alter table public.supplier_payment_batches
  enable row level security;

drop policy if exists supplier_payment_batches_select_management
  on public.supplier_payment_batches;

create policy supplier_payment_batches_select_management
on public.supplier_payment_batches
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
  and (
    branch_id =
      (select private.current_branch_id())
    or (select private.has_any_role(
      array[
        'owner',
        'admin'
      ]::public.app_role[]
    ))
  )
);

revoke all on public.supplier_payment_batches from anon;
grant select on public.supplier_payment_batches to authenticated;
grant all on public.supplier_payment_batches to service_role;

-- ----------------------------------------------------------------------------
-- 2. PURCHASE RETURN CREDIT HELPER
-- ----------------------------------------------------------------------------

create or replace function private.purchase_supplier_credit_total(
  p_purchase_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(return_row.total_amount), 0)
  from public.purchase_returns return_row
  where return_row.purchase_id = p_purchase_id
    and return_row.status = 'completed';
$$;

revoke all on function private.purchase_supplier_credit_total(uuid)
  from public;

grant execute on function private.purchase_supplier_credit_total(uuid)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. DEFAULT DUE DATE WHEN A PURCHASE IS RECEIVED
-- ----------------------------------------------------------------------------

create or replace function public.set_purchase_payment_due_date()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_terms integer := 0;
begin
  if new.status = 'received'
     and new.payment_due_date is null then

    select coalesce(
      supplier.default_payment_terms_days,
      0
    )
    into v_terms
    from public.suppliers supplier
    where supplier.id = new.supplier_id;

    new.payment_due_date :=
      coalesce(
        new.received_at::date,
        current_date
      )
      + v_terms;
  end if;

  return new;
end;
$$;

drop trigger if exists set_purchase_payment_due_date_trigger
  on public.purchases;

create trigger set_purchase_payment_due_date_trigger
before insert or update of
  status,
  supplier_id,
  received_at,
  payment_due_date
on public.purchases
for each row
execute function public.set_purchase_payment_due_date();

update public.purchases purchase_row
set payment_due_date =
  coalesce(
    purchase_row.received_at::date,
    purchase_row.created_at::date
  )
  + coalesce(
      supplier.default_payment_terms_days,
      0
    )
from public.suppliers supplier
where purchase_row.supplier_id = supplier.id
  and purchase_row.status = 'received'
  and purchase_row.payment_due_date is null;

-- ----------------------------------------------------------------------------
-- 4. SAVE SUPPLIER PAYMENT TERMS
-- ----------------------------------------------------------------------------

create or replace function public.save_supplier_payable_terms(
  p_supplier_id uuid,
  p_default_payment_terms_days integer,
  p_apply_to_open_purchases boolean default false,
  p_apply_all_branches boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_supplier public.suppliers%rowtype;
  v_updated integer := 0;
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
    raise exception 'Your role cannot manage supplier terms';
  end if;

  if p_default_payment_terms_days is null
     or p_default_payment_terms_days < 0
     or p_default_payment_terms_days > 3650 then
    raise exception 'Payment terms must be between 0 and 3650 days';
  end if;

  if p_apply_all_branches
     and v_profile.role not in ('owner','admin') then
    raise exception 'Only an owner or admin can update all branches';
  end if;

  update public.suppliers
  set
    default_payment_terms_days =
      p_default_payment_terms_days,
    updated_at = now()
  where id = p_supplier_id
    and organization_id = v_profile.organization_id
  returning *
  into v_supplier;

  if not found then
    raise exception 'Supplier not found';
  end if;

  if p_apply_to_open_purchases then
    update public.purchases purchase_row
    set
      payment_due_date =
        coalesce(
          purchase_row.received_at::date,
          purchase_row.created_at::date
        )
        + p_default_payment_terms_days,
      updated_at = now()
    where purchase_row.organization_id =
        v_profile.organization_id
      and purchase_row.supplier_id =
        v_supplier.id
      and purchase_row.status = 'received'
      and greatest(
        purchase_row.total_amount
        - purchase_row.amount_paid
        - private.purchase_supplier_credit_total(
            purchase_row.id
          ),
        0
      ) > 0
      and (
        (
          p_apply_all_branches
          and v_profile.role in ('owner','admin')
        )
        or purchase_row.branch_id =
          v_profile.branch_id
      );

    get diagnostics v_updated = row_count;
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
    'save_supplier_payable_terms',
    'supplier',
    v_supplier.id,
    jsonb_build_object(
      'supplier_code',
        v_supplier.supplier_code,
      'supplier_name',
        v_supplier.name,
      'default_payment_terms_days',
        v_supplier.default_payment_terms_days,
      'updated_open_purchases',
        v_updated,
      'all_branches',
        coalesce(p_apply_all_branches, false)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'supplier_id', v_supplier.id,
    'default_payment_terms_days',
      v_supplier.default_payment_terms_days,
    'updated_open_purchases',
      v_updated
  );
end;
$$;

revoke all on function public.save_supplier_payable_terms(
  uuid,
  integer,
  boolean,
  boolean
) from public, anon;

grant execute on function public.save_supplier_payable_terms(
  uuid,
  integer,
  boolean,
  boolean
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. REPLACE DIRECT PURCHASE PAYMENT WITH RETURN-CREDIT AWARE VALIDATION
-- ----------------------------------------------------------------------------

create or replace function public.record_purchase_payment(
  p_purchase_id uuid,
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
  v_purchase public.purchases%rowtype;
  v_return_credit numeric(14,2);
  v_balance_due numeric(14,2);
  v_new_paid numeric(14,2);
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
    raise exception 'Your role cannot record supplier payments';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
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

  if v_purchase.status = 'cancelled' then
    raise exception 'A cancelled purchase order cannot receive payments';
  end if;

  v_return_credit := round(
    private.purchase_supplier_credit_total(
      v_purchase.id
    ),
    2
  );

  v_balance_due := greatest(
    round(
      v_purchase.total_amount
      - coalesce(v_purchase.amount_paid, 0)
      - v_return_credit,
      2
    ),
    0
  );

  if v_balance_due <= 0 then
    raise exception 'This purchase has no outstanding supplier balance';
  end if;

  if round(p_amount, 2) > v_balance_due then
    raise exception
      'Payment exceeds the outstanding balance of %',
      v_balance_due;
  end if;

  v_new_paid := round(
    coalesce(v_purchase.amount_paid, 0)
    + p_amount,
    2
  );

  insert into public.purchase_payments (
    organization_id,
    branch_id,
    purchase_id,
    payment_batch_id,
    method,
    currency,
    amount,
    reference_number,
    notes,
    paid_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_purchase.id,
    null,
    p_method,
    v_purchase.currency,
    round(p_amount, 2),
    nullif(trim(p_reference_number), ''),
    nullif(trim(p_notes), ''),
    v_user_id
  );

  update public.purchases
  set
    amount_paid = v_new_paid,
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
    'record_purchase_payment',
    'purchase',
    v_purchase.id,
    jsonb_build_object(
      'purchase_number',
        v_purchase.purchase_number,
      'payment_amount',
        round(p_amount, 2),
      'amount_paid',
        v_new_paid,
      'supplier_return_credit',
        v_return_credit,
      'balance_due',
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_return_credit,
          0
        ),
      'method',
        p_method
    )
  );

  return jsonb_build_object(
    'ok', true,
    'purchase_id', v_purchase.id,
    'purchase_number',
      v_purchase.purchase_number,
    'amount_paid', v_new_paid,
    'supplier_return_credit',
      v_return_credit,
    'balance_due',
      round(
        greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_return_credit,
          0
        ),
        2
      ),
    'payment_status',
      case
        when greatest(
          v_purchase.total_amount
          - v_new_paid
          - v_return_credit,
          0
        ) = 0 then 'paid'
        when v_new_paid > 0
          or v_return_credit > 0 then 'partial'
        else 'unpaid'
      end
  );
end;
$$;

revoke all on function public.record_purchase_payment(
  uuid,
  numeric,
  public.payment_method,
  text,
  text
) from public, anon;

grant execute on function public.record_purchase_payment(
  uuid,
  numeric,
  public.payment_method,
  text,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. RECORD ONE SUPPLIER PAYMENT AND ALLOCATE OLDEST DUE PURCHASES
-- ----------------------------------------------------------------------------

create or replace function public.record_supplier_payment_batch(
  p_supplier_id uuid,
  p_currency public.currency_code,
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
  v_supplier public.suppliers%rowtype;
  v_purchase record;

  v_payment_id uuid;
  v_payment_number text;

  v_total_outstanding numeric(14,2);
  v_remaining numeric(14,2);
  v_allocate numeric(14,2);
  v_new_paid numeric(14,2);

  v_allocations jsonb := '[]'::jsonb;
  v_allocation_count integer := 0;
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
    raise exception 'Your role cannot record supplier payments';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  select *
  into v_supplier
  from public.suppliers
  where id = p_supplier_id
    and organization_id = v_profile.organization_id
    and is_active = true;

  if not found then
    raise exception 'Supplier not found or inactive';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(
      'tiny-pos-supplier-payment:'
      || v_profile.branch_id::text
      || ':'
      || v_supplier.id::text
      || ':'
      || p_currency::text
    )
  );

  select round(coalesce(sum(open_row.balance_due), 0), 2)
  into v_total_outstanding
  from (
    select greatest(
      purchase_row.total_amount
      - purchase_row.amount_paid
      - private.purchase_supplier_credit_total(
          purchase_row.id
        ),
      0
    ) as balance_due
    from public.purchases purchase_row
    where purchase_row.organization_id =
        v_profile.organization_id
      and purchase_row.branch_id =
        v_profile.branch_id
      and purchase_row.supplier_id =
        v_supplier.id
      and purchase_row.status = 'received'
      and purchase_row.currency = p_currency
  ) open_row
  where open_row.balance_due > 0;

  if v_total_outstanding <= 0 then
    raise exception
      'This supplier has no outstanding % balance in the current branch',
      p_currency;
  end if;

  if round(p_amount, 2) > v_total_outstanding then
    raise exception
      'Payment exceeds the current-branch outstanding balance of % %',
      v_total_outstanding,
      p_currency;
  end if;

  v_payment_number :=
    private.next_document_number(
      v_profile.organization_id,
      v_profile.branch_id,
      'SPY'
    );

  insert into public.supplier_payment_batches (
    organization_id,
    branch_id,
    payment_number,
    supplier_id,
    currency,
    method,
    amount,
    reference_number,
    notes,
    paid_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_payment_number,
    v_supplier.id,
    p_currency,
    p_method,
    round(p_amount, 2),
    nullif(trim(p_reference_number), ''),
    nullif(trim(p_notes), ''),
    v_user_id
  )
  returning id into v_payment_id;

  v_remaining := round(p_amount, 2);

  for v_purchase in
    select
      purchase_row.id,
      purchase_row.purchase_number,
      purchase_row.total_amount,
      purchase_row.amount_paid,
      purchase_row.payment_due_date,
      purchase_row.received_at,
      round(
        private.purchase_supplier_credit_total(
          purchase_row.id
        ),
        2
      ) as return_credit,

      round(
        greatest(
          purchase_row.total_amount
          - purchase_row.amount_paid
          - private.purchase_supplier_credit_total(
              purchase_row.id
            ),
          0
        ),
        2
      ) as balance_due

    from public.purchases purchase_row

    where purchase_row.organization_id =
        v_profile.organization_id
      and purchase_row.branch_id =
        v_profile.branch_id
      and purchase_row.supplier_id =
        v_supplier.id
      and purchase_row.status = 'received'
      and purchase_row.currency = p_currency
      and greatest(
        purchase_row.total_amount
        - purchase_row.amount_paid
        - private.purchase_supplier_credit_total(
            purchase_row.id
          ),
        0
      ) > 0

    order by
      purchase_row.payment_due_date
        nulls last,
      purchase_row.received_at
        nulls last,
      purchase_row.created_at,
      purchase_row.id

    for update
  loop
    exit when v_remaining <= 0;

    v_allocate := least(
      v_remaining,
      v_purchase.balance_due
    );

    v_new_paid := round(
      v_purchase.amount_paid
      + v_allocate,
      2
    );

    insert into public.purchase_payments (
      organization_id,
      branch_id,
      purchase_id,
      payment_batch_id,
      method,
      currency,
      amount,
      reference_number,
      notes,
      paid_by
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_purchase.id,
      v_payment_id,
      p_method,
      p_currency,
      v_allocate,
      nullif(trim(p_reference_number), ''),
      concat(
        v_payment_number,
        case
          when nullif(trim(p_notes), '') is not null
            then ' · ' || trim(p_notes)
          else ''
        end
      ),
      v_user_id
    );

    update public.purchases
    set
      amount_paid = v_new_paid,
      updated_at = now()
    where id = v_purchase.id;

    v_allocations :=
      v_allocations
      || jsonb_build_array(
        jsonb_build_object(
          'purchase_id',
            v_purchase.id,
          'purchase_number',
            v_purchase.purchase_number,
          'allocated_amount',
            v_allocate,
          'return_credit',
            v_purchase.return_credit,
          'balance_after',
            greatest(
              v_purchase.total_amount
              - v_new_paid
              - v_purchase.return_credit,
              0
            )
        )
      );

    v_allocation_count :=
      v_allocation_count + 1;

    v_remaining := round(
      v_remaining - v_allocate,
      2
    );
  end loop;

  if v_remaining <> 0 then
    raise exception
      'Payment allocation failed with % remaining',
      v_remaining;
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
    'record_supplier_payment_batch',
    'supplier_payment_batch',
    v_payment_id,
    jsonb_build_object(
      'payment_number',
        v_payment_number,
      'supplier_id',
        v_supplier.id,
      'supplier_code',
        v_supplier.supplier_code,
      'supplier_name',
        v_supplier.name,
      'currency',
        p_currency,
      'amount',
        round(p_amount, 2),
      'method',
        p_method,
      'allocation_count',
        v_allocation_count,
      'allocations',
        v_allocations
    )
  );

  return jsonb_build_object(
    'ok', true,
    'payment_batch_id',
      v_payment_id,
    'payment_number',
      v_payment_number,
    'supplier_id',
      v_supplier.id,
    'supplier_name',
      v_supplier.name,
    'currency',
      p_currency,
    'amount',
      round(p_amount, 2),
    'method',
      p_method,
    'allocation_count',
      v_allocation_count,
    'allocations',
      v_allocations
  );
end;
$$;

revoke all on function public.record_supplier_payment_batch(
  uuid,
  public.currency_code,
  numeric,
  public.payment_method,
  text,
  text
) from public, anon;

grant execute on function public.record_supplier_payment_batch(
  uuid,
  public.currency_code,
  numeric,
  public.payment_method,
  text,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. SUPPLIER PAYABLES CENTER
-- ----------------------------------------------------------------------------

create or replace function public.get_supplier_payables_center(
  p_all_branches boolean default false,
  p_as_of date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_all_branches boolean := false;
  v_as_of date;
  v_timezone text := 'Asia/Phnom_Penh';

  v_summary jsonb := '{}'::jsonb;
  v_suppliers jsonb := '[]'::jsonb;
  v_invoices jsonb := '[]'::jsonb;
  v_recent_payments jsonb := '[]'::jsonb;
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
    raise exception 'Your role cannot view supplier payables';
  end if;

  v_all_branches :=
    coalesce(p_all_branches, false)
    and v_profile.role in ('owner','admin');

  select coalesce(
    nullif(trim(settings.timezone), ''),
    'Asia/Phnom_Penh'
  )
  into v_timezone
  from public.app_settings settings
  where settings.organization_id =
    v_profile.organization_id;

  v_as_of := coalesce(
    p_as_of,
    (timezone(v_timezone, now()))::date
  );

  with open_invoices as (
    select
      purchase_row.id,
      purchase_row.purchase_number,
      purchase_row.supplier_id,
      purchase_row.branch_id,
      branch.name as branch_name,
      branch.code as branch_code,
      purchase_row.currency,
      purchase_row.total_amount,
      purchase_row.amount_paid,

      round(
        private.purchase_supplier_credit_total(
          purchase_row.id
        ),
        2
      ) as return_credit,

      round(
        greatest(
          purchase_row.total_amount
          - purchase_row.amount_paid
          - private.purchase_supplier_credit_total(
              purchase_row.id
            ),
          0
        ),
        2
      ) as balance_due,

      coalesce(
        purchase_row.payment_due_date,
        purchase_row.received_at::date,
        purchase_row.created_at::date
      ) as due_date,

      purchase_row.received_at,
      purchase_row.supplier_invoice_number,
      purchase_row.payment_terms,
      purchase_row.notes

    from public.purchases purchase_row
    join public.branches branch
      on branch.id = purchase_row.branch_id

    where purchase_row.organization_id =
        v_profile.organization_id
      and purchase_row.status = 'received'
      and (
        v_all_branches
        or purchase_row.branch_id =
          v_profile.branch_id
      )
      and greatest(
        purchase_row.total_amount
        - purchase_row.amount_paid
        - private.purchase_supplier_credit_total(
            purchase_row.id
          ),
        0
      ) > 0
  ),

  supplier_totals as (
    select
      supplier.id as supplier_id,
      supplier.supplier_code,
      supplier.name,
      supplier.contact_name,
      supplier.phone,
      supplier.email,
      supplier.address,
      supplier.tax_id,
      supplier.default_payment_terms_days,

      count(invoice.id) as open_invoice_count,

      count(invoice.id) filter (
        where invoice.due_date < v_as_of
      ) as overdue_invoice_count,

      min(invoice.due_date) as oldest_due_date,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'USD'
      ), 0), 2) as usd_balance,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'KHR'
      ), 0), 2) as khr_balance,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'USD'
          and invoice.due_date < v_as_of
      ), 0), 2) as usd_overdue,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'KHR'
          and invoice.due_date < v_as_of
      ), 0), 2) as khr_overdue,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'USD'
          and invoice.due_date >= v_as_of
      ), 0), 2) as usd_current,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'KHR'
          and invoice.due_date >= v_as_of
      ), 0), 2) as khr_current,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'USD'
          and invoice.due_date < v_as_of
          and v_as_of - invoice.due_date
            between 1 and 30
      ), 0), 2) as usd_1_30,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'USD'
          and v_as_of - invoice.due_date
            between 31 and 60
      ), 0), 2) as usd_31_60,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'USD'
          and v_as_of - invoice.due_date
            between 61 and 90
      ), 0), 2) as usd_61_90,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'USD'
          and v_as_of - invoice.due_date > 90
      ), 0), 2) as usd_over_90,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'KHR'
          and invoice.due_date < v_as_of
          and v_as_of - invoice.due_date
            between 1 and 30
      ), 0), 2) as khr_1_30,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'KHR'
          and v_as_of - invoice.due_date
            between 31 and 60
      ), 0), 2) as khr_31_60,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'KHR'
          and v_as_of - invoice.due_date
            between 61 and 90
      ), 0), 2) as khr_61_90,

      round(coalesce(sum(invoice.balance_due) filter (
        where invoice.currency = 'KHR'
          and v_as_of - invoice.due_date > 90
      ), 0), 2) as khr_over_90

    from public.suppliers supplier
    join open_invoices invoice
      on invoice.supplier_id = supplier.id

    where supplier.organization_id =
      v_profile.organization_id

    group by
      supplier.id,
      supplier.supplier_code,
      supplier.name,
      supplier.contact_name,
      supplier.phone,
      supplier.email,
      supplier.address,
      supplier.tax_id,
      supplier.default_payment_terms_days
  )

  select coalesce(jsonb_agg(
    to_jsonb(supplier_row)
    order by
      supplier_row.usd_overdue
        + supplier_row.khr_overdue desc,
      supplier_row.usd_balance
        + supplier_row.khr_balance desc,
      supplier_row.name
  ), '[]'::jsonb)
  into v_suppliers
  from supplier_totals supplier_row;

  with open_invoices as (
    select
      purchase_row.id,
      purchase_row.purchase_number,
      purchase_row.supplier_id,
      supplier.supplier_code,
      supplier.name as supplier_name,
      purchase_row.branch_id,
      branch.name as branch_name,
      branch.code as branch_code,
      purchase_row.currency,
      purchase_row.total_amount,
      purchase_row.amount_paid,

      round(
        private.purchase_supplier_credit_total(
          purchase_row.id
        ),
        2
      ) as return_credit,

      round(
        greatest(
          purchase_row.total_amount
          - purchase_row.amount_paid
          - private.purchase_supplier_credit_total(
              purchase_row.id
            ),
          0
        ),
        2
      ) as balance_due,

      coalesce(
        purchase_row.payment_due_date,
        purchase_row.received_at::date,
        purchase_row.created_at::date
      ) as due_date,

      purchase_row.received_at,
      purchase_row.supplier_invoice_number,
      purchase_row.payment_terms,
      purchase_row.notes

    from public.purchases purchase_row
    join public.suppliers supplier
      on supplier.id = purchase_row.supplier_id
    join public.branches branch
      on branch.id = purchase_row.branch_id

    where purchase_row.organization_id =
        v_profile.organization_id
      and purchase_row.status = 'received'
      and (
        v_all_branches
        or purchase_row.branch_id =
          v_profile.branch_id
      )
      and greatest(
        purchase_row.total_amount
        - purchase_row.amount_paid
        - private.purchase_supplier_credit_total(
            purchase_row.id
          ),
        0
      ) > 0
  )

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', invoice.id,
      'purchase_number',
        invoice.purchase_number,
      'supplier_id',
        invoice.supplier_id,
      'supplier_code',
        invoice.supplier_code,
      'supplier_name',
        invoice.supplier_name,
      'branch_id',
        invoice.branch_id,
      'branch_name',
        invoice.branch_name,
      'branch_code',
        invoice.branch_code,
      'currency',
        invoice.currency,
      'total_amount',
        invoice.total_amount,
      'amount_paid',
        invoice.amount_paid,
      'return_credit',
        invoice.return_credit,
      'balance_due',
        invoice.balance_due,
      'due_date',
        invoice.due_date,
      'days_overdue',
        greatest(
          v_as_of - invoice.due_date,
          0
        ),
      'aging_bucket',
        case
          when invoice.due_date >= v_as_of
            then 'current'
          when v_as_of - invoice.due_date
            between 1 and 30
            then '1_30'
          when v_as_of - invoice.due_date
            between 31 and 60
            then '31_60'
          when v_as_of - invoice.due_date
            between 61 and 90
            then '61_90'
          else 'over_90'
        end,
      'received_at',
        invoice.received_at,
      'supplier_invoice_number',
        invoice.supplier_invoice_number,
      'payment_terms',
        invoice.payment_terms,
      'notes',
        invoice.notes,
      'can_pay_current_branch',
        invoice.branch_id =
          v_profile.branch_id
    )
    order by
      invoice.due_date,
      invoice.received_at,
      invoice.purchase_number
  ), '[]'::jsonb)
  into v_invoices
  from open_invoices invoice;

  with invoice_rows as (
    select *
    from jsonb_to_recordset(v_invoices)
      as invoice(
        currency public.currency_code,
        balance_due numeric,
        due_date date
      )
  )

  select jsonb_build_object(
    'as_of', v_as_of,

    'open_invoice_count',
      count(*),

    'overdue_invoice_count',
      count(*) filter (
        where due_date < v_as_of
      ),

    'usd', jsonb_build_object(
      'total',
        round(coalesce(sum(balance_due) filter (
          where currency = 'USD'
        ), 0), 2),
      'current',
        round(coalesce(sum(balance_due) filter (
          where currency = 'USD'
            and due_date >= v_as_of
        ), 0), 2),
      'overdue',
        round(coalesce(sum(balance_due) filter (
          where currency = 'USD'
            and due_date < v_as_of
        ), 0), 2),
      '1_30',
        round(coalesce(sum(balance_due) filter (
          where currency = 'USD'
            and v_as_of - due_date
              between 1 and 30
        ), 0), 2),
      '31_60',
        round(coalesce(sum(balance_due) filter (
          where currency = 'USD'
            and v_as_of - due_date
              between 31 and 60
        ), 0), 2),
      '61_90',
        round(coalesce(sum(balance_due) filter (
          where currency = 'USD'
            and v_as_of - due_date
              between 61 and 90
        ), 0), 2),
      'over_90',
        round(coalesce(sum(balance_due) filter (
          where currency = 'USD'
            and v_as_of - due_date > 90
        ), 0), 2)
    ),

    'khr', jsonb_build_object(
      'total',
        round(coalesce(sum(balance_due) filter (
          where currency = 'KHR'
        ), 0), 2),
      'current',
        round(coalesce(sum(balance_due) filter (
          where currency = 'KHR'
            and due_date >= v_as_of
        ), 0), 2),
      'overdue',
        round(coalesce(sum(balance_due) filter (
          where currency = 'KHR'
            and due_date < v_as_of
        ), 0), 2),
      '1_30',
        round(coalesce(sum(balance_due) filter (
          where currency = 'KHR'
            and v_as_of - due_date
              between 1 and 30
        ), 0), 2),
      '31_60',
        round(coalesce(sum(balance_due) filter (
          where currency = 'KHR'
            and v_as_of - due_date
              between 31 and 60
        ), 0), 2),
      '61_90',
        round(coalesce(sum(balance_due) filter (
          where currency = 'KHR'
            and v_as_of - due_date
              between 61 and 90
        ), 0), 2),
      'over_90',
        round(coalesce(sum(balance_due) filter (
          where currency = 'KHR'
            and v_as_of - due_date > 90
        ), 0), 2)
    )
  )
  into v_summary
  from invoice_rows;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', payment.id,
      'payment_batch_id',
        payment.payment_batch_id,
      'payment_number',
        batch.payment_number,
      'purchase_id',
        purchase_row.id,
      'purchase_number',
        purchase_row.purchase_number,
      'supplier_id',
        supplier.id,
      'supplier_code',
        supplier.supplier_code,
      'supplier_name',
        supplier.name,
      'branch_id',
        payment.branch_id,
      'branch_name',
        branch.name,
      'currency',
        payment.currency,
      'amount',
        payment.amount,
      'method',
        payment.method,
      'reference_number',
        coalesce(
          batch.reference_number,
          payment.reference_number
        ),
      'notes',
        coalesce(
          batch.notes,
          payment.notes
        ),
      'paid_at',
        payment.paid_at,
      'paid_by',
        profile_row.full_name
    )
    order by payment.paid_at desc
  ), '[]'::jsonb)
  into v_recent_payments
  from (
    select payment_row.*
    from public.purchase_payments payment_row
    where payment_row.organization_id =
        v_profile.organization_id
      and (
        v_all_branches
        or payment_row.branch_id =
          v_profile.branch_id
      )
    order by payment_row.paid_at desc
    limit 150
  ) payment
  join public.purchases purchase_row
    on purchase_row.id = payment.purchase_id
  join public.suppliers supplier
    on supplier.id = purchase_row.supplier_id
  join public.branches branch
    on branch.id = payment.branch_id
  left join public.supplier_payment_batches batch
    on batch.id = payment.payment_batch_id
  left join public.profiles profile_row
    on profile_row.id = payment.paid_by;

  return jsonb_build_object(
    'meta', jsonb_build_object(
      'generated_at', now(),
      'as_of', v_as_of,
      'scope',
        case
          when v_all_branches
            then 'all_branches'
          else 'branch'
        end,
      'current_branch_id',
        v_profile.branch_id,
      'can_all_branches',
        v_profile.role in ('owner','admin'),
      'role',
        v_profile.role
    ),
    'summary', v_summary,
    'suppliers', v_suppliers,
    'invoices', v_invoices,
    'recent_payments',
      v_recent_payments
  );
end;
$$;

revoke all on function public.get_supplier_payables_center(
  boolean,
  date
) from public, anon;

grant execute on function public.get_supplier_payables_center(
  boolean,
  date
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. PRINTABLE SUPPLIER STATEMENT
-- ----------------------------------------------------------------------------

create or replace function public.get_supplier_payable_statement(
  p_supplier_id uuid,
  p_from date,
  p_to date,
  p_all_branches boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_supplier public.suppliers%rowtype;
  v_all_branches boolean := false;
  v_from date;
  v_to date;

  v_opening_usd numeric(14,2) := 0;
  v_opening_khr numeric(14,2) := 0;
  v_closing_usd numeric(14,2) := 0;
  v_closing_khr numeric(14,2) := 0;

  v_transactions jsonb := '[]'::jsonb;
  v_open_invoices jsonb := '[]'::jsonb;
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
    raise exception 'Your role cannot view supplier statements';
  end if;

  v_all_branches :=
    coalesce(p_all_branches, false)
    and v_profile.role in ('owner','admin');

  v_from := coalesce(
    p_from,
    current_date - 89
  );

  v_to := coalesce(
    p_to,
    current_date
  );

  if v_to < v_from then
    raise exception 'Statement end date must be on or after the start date';
  end if;

  if v_to - v_from > 730 then
    raise exception 'Statement range cannot exceed 730 days';
  end if;

  select *
  into v_supplier
  from public.suppliers
  where id = p_supplier_id
    and organization_id = v_profile.organization_id;

  if not found then
    raise exception 'Supplier not found';
  end if;

  with opening_rows as (
    select
      purchase_row.currency,
      purchase_row.total_amount as debit,
      0::numeric as credit
    from public.purchases purchase_row
    where purchase_row.organization_id =
        v_profile.organization_id
      and purchase_row.supplier_id =
        v_supplier.id
      and purchase_row.status = 'received'
      and coalesce(
        purchase_row.received_at::date,
        purchase_row.created_at::date
      ) < v_from
      and (
        v_all_branches
        or purchase_row.branch_id =
          v_profile.branch_id
      )

    union all

    select
      return_row.currency,
      0::numeric,
      return_row.total_amount
    from public.purchase_returns return_row
    where return_row.organization_id =
        v_profile.organization_id
      and return_row.supplier_id =
        v_supplier.id
      and return_row.status = 'completed'
      and return_row.created_at::date < v_from
      and (
        v_all_branches
        or return_row.branch_id =
          v_profile.branch_id
      )

    union all

    select
      payment_row.currency,
      0::numeric,
      payment_row.amount
    from public.purchase_payments payment_row
    join public.purchases purchase_row
      on purchase_row.id =
        payment_row.purchase_id
    where payment_row.organization_id =
        v_profile.organization_id
      and purchase_row.supplier_id =
        v_supplier.id
      and payment_row.paid_at::date < v_from
      and (
        v_all_branches
        or payment_row.branch_id =
          v_profile.branch_id
      )
  )

  select
    round(coalesce(sum(
      debit - credit
    ) filter (
      where currency = 'USD'
    ), 0), 2),
    round(coalesce(sum(
      debit - credit
    ) filter (
      where currency = 'KHR'
    ), 0), 2)
  into
    v_opening_usd,
    v_opening_khr
  from opening_rows;

  with transaction_rows as (
    select
      coalesce(
        purchase_row.received_at,
        purchase_row.created_at
      ) as occurred_at,
      10 as sort_order,
      purchase_row.id as source_id,
      'purchase'::text as transaction_type,
      purchase_row.purchase_number
        as reference,
      branch.name as branch_name,
      purchase_row.currency,
      purchase_row.total_amount
        as debit,
      0::numeric as credit,
      coalesce(
        purchase_row.supplier_invoice_number,
        purchase_row.payment_terms,
        'Received purchase'
      ) as description

    from public.purchases purchase_row
    join public.branches branch
      on branch.id = purchase_row.branch_id

    where purchase_row.organization_id =
        v_profile.organization_id
      and purchase_row.supplier_id =
        v_supplier.id
      and purchase_row.status = 'received'
      and coalesce(
        purchase_row.received_at::date,
        purchase_row.created_at::date
      ) between v_from and v_to
      and (
        v_all_branches
        or purchase_row.branch_id =
          v_profile.branch_id
      )

    union all

    select
      return_row.created_at,
      20,
      return_row.id,
      'supplier_return',
      return_row.return_number,
      branch.name,
      return_row.currency,
      0::numeric,
      return_row.total_amount,
      concat(
        'Supplier return · ',
        return_row.reason
      )

    from public.purchase_returns return_row
    join public.branches branch
      on branch.id = return_row.branch_id

    where return_row.organization_id =
        v_profile.organization_id
      and return_row.supplier_id =
        v_supplier.id
      and return_row.status = 'completed'
      and return_row.created_at::date
        between v_from and v_to
      and (
        v_all_branches
        or return_row.branch_id =
          v_profile.branch_id
      )

    union all

    select
      batch.paid_at,
      30,
      batch.id,
      'payment',
      batch.payment_number,
      branch.name,
      batch.currency,
      0::numeric,
      batch.amount,
      concat(
        'Supplier payment · ',
        batch.method,
        case
          when batch.reference_number is not null
            then ' · ' || batch.reference_number
          else ''
        end
      )

    from public.supplier_payment_batches batch
    join public.branches branch
      on branch.id = batch.branch_id

    where batch.organization_id =
        v_profile.organization_id
      and batch.supplier_id =
        v_supplier.id
      and batch.paid_at::date
        between v_from and v_to
      and (
        v_all_branches
        or batch.branch_id =
          v_profile.branch_id
      )

    union all

    select
      payment_row.paid_at,
      31,
      payment_row.id,
      'payment',
      purchase_row.purchase_number,
      branch.name,
      payment_row.currency,
      0::numeric,
      payment_row.amount,
      concat(
        'Direct purchase payment · ',
        payment_row.method,
        case
          when payment_row.reference_number is not null
            then ' · ' || payment_row.reference_number
          else ''
        end
      )

    from public.purchase_payments payment_row
    join public.purchases purchase_row
      on purchase_row.id =
        payment_row.purchase_id
    join public.branches branch
      on branch.id = payment_row.branch_id

    where payment_row.organization_id =
        v_profile.organization_id
      and purchase_row.supplier_id =
        v_supplier.id
      and payment_row.payment_batch_id is null
      and payment_row.paid_at::date
        between v_from and v_to
      and (
        v_all_branches
        or payment_row.branch_id =
          v_profile.branch_id
      )
  ),

  with_running as (
    select
      transaction_row.*,

      case
        when transaction_row.currency = 'USD'
          then v_opening_usd
        else v_opening_khr
      end
      + sum(
          transaction_row.debit
          - transaction_row.credit
        ) over (
          partition by
            transaction_row.currency
          order by
            transaction_row.occurred_at,
            transaction_row.sort_order,
            transaction_row.source_id
          rows between unbounded preceding
            and current row
        ) as running_balance

    from transaction_rows transaction_row
  )

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'occurred_at',
        transaction_row.occurred_at,
      'transaction_type',
        transaction_row.transaction_type,
      'reference',
        transaction_row.reference,
      'branch_name',
        transaction_row.branch_name,
      'currency',
        transaction_row.currency,
      'debit',
        transaction_row.debit,
      'credit',
        transaction_row.credit,
      'running_balance',
        transaction_row.running_balance,
      'description',
        transaction_row.description
    )
    order by
      transaction_row.occurred_at,
      transaction_row.sort_order,
      transaction_row.source_id
  ), '[]'::jsonb)
  into v_transactions
  from with_running transaction_row;

  select
    round(
      v_opening_usd
      + coalesce(sum(
          tx.debit
          - tx.credit
        ) filter (
          where tx.currency = 'USD'
        ), 0),
      2
    ),
    round(
      v_opening_khr
      + coalesce(sum(
          tx.debit
          - tx.credit
        ) filter (
          where tx.currency = 'KHR'
        ), 0),
      2
    )
  into
    v_closing_usd,
    v_closing_khr
  from jsonb_to_recordset(v_transactions)
    as tx(
      currency public.currency_code,
      debit numeric,
      credit numeric
    );

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'purchase_number',
        purchase_row.purchase_number,
      'branch_name',
        branch.name,
      'currency',
        purchase_row.currency,
      'total_amount',
        purchase_row.total_amount,
      'amount_paid',
        purchase_row.amount_paid,
      'return_credit',
        round(
          private.purchase_supplier_credit_total(
            purchase_row.id
          ),
          2
        ),
      'balance_due',
        round(
          greatest(
            purchase_row.total_amount
            - purchase_row.amount_paid
            - private.purchase_supplier_credit_total(
                purchase_row.id
              ),
            0
          ),
          2
        ),
      'payment_due_date',
        coalesce(
          purchase_row.payment_due_date,
          purchase_row.received_at::date,
          purchase_row.created_at::date
        ),
      'received_at',
        purchase_row.received_at
    )
    order by
      coalesce(
        purchase_row.payment_due_date,
        purchase_row.received_at::date,
        purchase_row.created_at::date
      ),
      purchase_row.purchase_number
  ), '[]'::jsonb)
  into v_open_invoices
  from public.purchases purchase_row
  join public.branches branch
    on branch.id = purchase_row.branch_id
  where purchase_row.organization_id =
      v_profile.organization_id
    and purchase_row.supplier_id =
      v_supplier.id
    and purchase_row.status = 'received'
    and (
      v_all_branches
      or purchase_row.branch_id =
        v_profile.branch_id
    )
    and greatest(
      purchase_row.total_amount
      - purchase_row.amount_paid
      - private.purchase_supplier_credit_total(
          purchase_row.id
        ),
      0
    ) > 0;

  return jsonb_build_object(
    'meta', jsonb_build_object(
      'generated_at', now(),
      'from', v_from,
      'to', v_to,
      'scope',
        case
          when v_all_branches
            then 'all_branches'
          else 'branch'
        end
    ),

    'supplier', jsonb_build_object(
      'id', v_supplier.id,
      'supplier_code',
        v_supplier.supplier_code,
      'name', v_supplier.name,
      'contact_name',
        v_supplier.contact_name,
      'phone', v_supplier.phone,
      'email', v_supplier.email,
      'address', v_supplier.address,
      'tax_id', v_supplier.tax_id,
      'default_payment_terms_days',
        v_supplier.default_payment_terms_days
    ),

    'opening', jsonb_build_object(
      'USD', v_opening_usd,
      'KHR', v_opening_khr
    ),

    'closing', jsonb_build_object(
      'USD', v_closing_usd,
      'KHR', v_closing_khr
    ),

    'transactions', v_transactions,
    'open_invoices', v_open_invoices
  );
end;
$$;

revoke all on function public.get_supplier_payable_statement(
  uuid,
  date,
  date,
  boolean
) from public, anon;

grant execute on function public.get_supplier_payable_statement(
  uuid,
  date,
  date,
  boolean
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 29
-- ============================================================================
