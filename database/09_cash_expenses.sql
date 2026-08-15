-- ============================================================================
-- Tiny POS - Step 11: Cash, expenses, and net profit
-- Run once in the NEW Supabase project after Step 10.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'cash_entry_direction') then
    create type public.cash_entry_direction as enum ('income', 'expense');
  end if;

  if not exists (select 1 from pg_type where typname = 'cash_entry_status') then
    create type public.cash_entry_status as enum ('active', 'voided');
  end if;
end
$$;

create table if not exists public.cash_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 100),
  direction public.cash_entry_direction not null,
  affects_profit boolean not null default true,
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cash_categories_org_direction_name_uq
  on public.cash_categories (organization_id, direction, lower(name));

create table if not exists public.cash_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  entry_number text not null,
  direction public.cash_entry_direction not null,
  category_id uuid not null references public.cash_categories(id) on delete restrict,
  method public.payment_method not null default 'cash',
  currency public.currency_code not null default 'USD',
  amount numeric(14,2) not null check (amount > 0),
  entry_at timestamptz not null default now(),
  reference_number text,
  remark text,
  status public.cash_entry_status not null default 'active',
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  voided_by uuid references auth.users(id) on delete set null,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, entry_number)
);

create index if not exists cash_entries_branch_date_idx
  on public.cash_entries (organization_id, branch_id, entry_at desc);

create index if not exists cash_entries_category_date_idx
  on public.cash_entries (category_id, entry_at desc);

create index if not exists cash_entries_active_report_idx
  on public.cash_entries (organization_id, branch_id, direction, entry_at desc)
  where status = 'active';

drop trigger if exists set_cash_categories_updated_at on public.cash_categories;
create trigger set_cash_categories_updated_at
before update on public.cash_categories
for each row execute function public.set_updated_at();

drop trigger if exists set_cash_entries_updated_at on public.cash_entries;
create trigger set_cash_entries_updated_at
before update on public.cash_entries
for each row execute function public.set_updated_at();

-- Default categories for every existing organization.
with defaults(name, direction, affects_profit, is_system) as (
  values
    ('Opening Balance', 'income'::public.cash_entry_direction, false, true),
    ('Owner Contribution', 'income'::public.cash_entry_direction, false, true),
    ('Other Income', 'income'::public.cash_entry_direction, true, true),
    ('Rent', 'expense'::public.cash_entry_direction, true, true),
    ('Utilities', 'expense'::public.cash_entry_direction, true, true),
    ('Salary & Wages', 'expense'::public.cash_entry_direction, true, true),
    ('Transport', 'expense'::public.cash_entry_direction, true, true),
    ('Office & Shop Supplies', 'expense'::public.cash_entry_direction, true, true),
    ('Marketing', 'expense'::public.cash_entry_direction, true, true),
    ('Repairs & Maintenance', 'expense'::public.cash_entry_direction, true, true),
    ('Bank Fees', 'expense'::public.cash_entry_direction, true, true),
    ('Bank Deposit / Transfer', 'expense'::public.cash_entry_direction, false, true),
    ('Owner Withdrawal', 'expense'::public.cash_entry_direction, false, true),
    ('Other Expense', 'expense'::public.cash_entry_direction, true, true)
)
insert into public.cash_categories (
  organization_id,
  name,
  direction,
  affects_profit,
  is_system,
  is_active,
  created_by
)
select
  o.id,
  d.name,
  d.direction,
  d.affects_profit,
  d.is_system,
  true,
  o.created_by
from public.organizations o
cross join defaults d
where not exists (
  select 1
  from public.cash_categories c
  where c.organization_id = o.id
    and c.direction = d.direction
    and lower(c.name) = lower(d.name)
);

alter table public.cash_categories enable row level security;
alter table public.cash_entries enable row level security;

do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('cash_categories', 'cash_entries')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end
$$;

create policy cash_categories_select_management
on public.cash_categories
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager','viewer']::public.app_role[]))
);

create policy cash_categories_manage_management
on public.cash_categories
for all to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager']::public.app_role[]))
)
with check (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager']::public.app_role[]))
);

create policy cash_entries_select_management
on public.cash_entries
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(array['owner','admin','manager','viewer']::public.app_role[]))
);

revoke all on public.cash_categories, public.cash_entries from anon;
grant select, insert, update, delete on public.cash_categories to authenticated;
grant select on public.cash_entries to authenticated;
grant all on public.cash_categories, public.cash_entries to service_role;

-- ----------------------------------------------------------------------------
-- Create or update an income/expense category.
-- ----------------------------------------------------------------------------
create or replace function public.save_cash_category(
  p_category_id uuid,
  p_name text,
  p_direction public.cash_entry_direction,
  p_affects_profit boolean default true,
  p_is_active boolean default true
)
returns public.cash_categories
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_result public.cash_categories;
begin
  select p.organization_id, p.role, p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot manage cash categories';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Category name is required';
  end if;

  if p_category_id is null then
    insert into public.cash_categories (
      organization_id, name, direction, affects_profit,
      is_system, is_active, created_by
    )
    values (
      v_profile.organization_id, trim(p_name), p_direction,
      coalesce(p_affects_profit, true), false,
      coalesce(p_is_active, true), v_user_id
    )
    returning * into v_result;
  else
    update public.cash_categories c
    set
      name = trim(p_name),
      direction = p_direction,
      affects_profit = coalesce(p_affects_profit, true),
      is_active = coalesce(p_is_active, true),
      updated_at = now()
    where c.id = p_category_id
      and c.organization_id = v_profile.organization_id
    returning * into v_result;

    if not found then
      raise exception 'Cash category not found';
    end if;
  end if;

  insert into public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id, new_data
  )
  values (
    v_profile.organization_id,
    v_user_id,
    case when p_category_id is null then 'create_cash_category' else 'update_cash_category' end,
    'cash_category',
    v_result.id,
    to_jsonb(v_result)
  );

  return v_result;
end;
$$;

revoke all on function public.save_cash_category(
  uuid, text, public.cash_entry_direction, boolean, boolean
) from public, anon;
grant execute on function public.save_cash_category(
  uuid, text, public.cash_entry_direction, boolean, boolean
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Securely create or edit a cash/expense entry.
-- ----------------------------------------------------------------------------
create or replace function public.save_cash_entry(
  p_entry_id uuid,
  p_direction public.cash_entry_direction,
  p_category_id uuid,
  p_method public.payment_method,
  p_currency public.currency_code,
  p_amount numeric,
  p_entry_at timestamptz,
  p_reference_number text default null,
  p_remark text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_category record;
  v_existing public.cash_entries;
  v_result public.cash_entries;
  v_entry_number text;
begin
  select p.organization_id, p.branch_id, p.role, p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot manage cash and expenses';
  end if;

  if v_profile.branch_id is null then
    raise exception 'No branch is assigned to your account';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;

  select c.id, c.direction, c.is_active, c.name, c.affects_profit
  into v_category
  from public.cash_categories c
  where c.id = p_category_id
    and c.organization_id = v_profile.organization_id;

  if not found or v_category.is_active is not true then
    raise exception 'Choose an active category';
  end if;

  if v_category.direction <> p_direction then
    raise exception 'The selected category does not match the entry type';
  end if;

  if p_entry_id is null then
    v_entry_number := private.next_document_number(
      v_profile.organization_id,
      v_profile.branch_id,
      case when p_direction = 'income' then 'CIN' else 'EXP' end
    );

    insert into public.cash_entries (
      organization_id, branch_id, entry_number, direction,
      category_id, method, currency, amount, entry_at,
      reference_number, remark, status, created_by, updated_by
    )
    values (
      v_profile.organization_id, v_profile.branch_id, v_entry_number,
      p_direction, p_category_id, p_method, p_currency,
      round(p_amount, case when p_currency = 'KHR' then 0 else 2 end),
      coalesce(p_entry_at, now()),
      nullif(trim(p_reference_number), ''),
      nullif(trim(p_remark), ''),
      'active', v_user_id, v_user_id
    )
    returning * into v_result;
  else
    select * into v_existing
    from public.cash_entries e
    where e.id = p_entry_id
      and e.organization_id = v_profile.organization_id
      and e.branch_id = v_profile.branch_id
    for update;

    if not found then
      raise exception 'Cash or expense entry not found in your branch';
    end if;

    if v_existing.status <> 'active' then
      raise exception 'A voided entry cannot be edited';
    end if;

    update public.cash_entries e
    set
      direction = p_direction,
      category_id = p_category_id,
      method = p_method,
      currency = p_currency,
      amount = round(p_amount, case when p_currency = 'KHR' then 0 else 2 end),
      entry_at = coalesce(p_entry_at, e.entry_at),
      reference_number = nullif(trim(p_reference_number), ''),
      remark = nullif(trim(p_remark), ''),
      updated_by = v_user_id,
      updated_at = now()
    where e.id = p_entry_id
    returning * into v_result;
  end if;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action,
    entity_type, entity_id, old_data, new_data
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    case when p_entry_id is null then 'create_cash_entry' else 'update_cash_entry' end,
    'cash_entry',
    v_result.id,
    case when p_entry_id is null then null else to_jsonb(v_existing) end,
    to_jsonb(v_result)
  );

  return jsonb_build_object(
    'ok', true,
    'id', v_result.id,
    'entry_number', v_result.entry_number,
    'direction', v_result.direction,
    'amount', v_result.amount,
    'currency', v_result.currency
  );
end;
$$;

revoke all on function public.save_cash_entry(
  uuid, public.cash_entry_direction, uuid, public.payment_method,
  public.currency_code, numeric, timestamptz, text, text
) from public, anon;
grant execute on function public.save_cash_entry(
  uuid, public.cash_entry_direction, uuid, public.payment_method,
  public.currency_code, numeric, timestamptz, text, text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- "Delete" financial entries safely by voiding them and preserving audit data.
-- ----------------------------------------------------------------------------
create or replace function public.void_cash_entry(
  p_entry_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_existing public.cash_entries;
begin
  select p.organization_id, p.branch_id, p.role, p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Your role cannot void cash entries';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Enter a reason for deleting this entry';
  end if;

  select * into v_existing
  from public.cash_entries e
  where e.id = p_entry_id
    and e.organization_id = v_profile.organization_id
    and e.branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Cash or expense entry not found in your branch';
  end if;

  if v_existing.status = 'voided' then
    return jsonb_build_object('ok', true, 'entry_number', v_existing.entry_number);
  end if;

  update public.cash_entries
  set
    status = 'voided',
    voided_by = v_user_id,
    voided_at = now(),
    void_reason = trim(p_reason),
    updated_by = v_user_id,
    updated_at = now()
  where id = p_entry_id;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action,
    entity_type, entity_id, old_data, new_data
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'void_cash_entry',
    'cash_entry',
    p_entry_id,
    to_jsonb(v_existing),
    jsonb_build_object('status', 'voided', 'reason', trim(p_reason))
  );

  return jsonb_build_object(
    'ok', true,
    'entry_number', v_existing.entry_number
  );
end;
$$;

revoke all on function public.void_cash_entry(uuid, text) from public, anon;
grant execute on function public.void_cash_entry(uuid, text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Cash/expense workspace and Profit & Loss data.
-- ----------------------------------------------------------------------------
create or replace function public.get_cash_expense_workspace(
  p_from date,
  p_to date,
  p_branch_id uuid default null,
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
  v_branch_id uuid;
  v_branch_name text;
  v_all_branches boolean := false;
  v_base_currency public.currency_code;
  v_usd_to_khr_rate numeric(14,4);
  v_timezone text;
  v_summary jsonb;
  v_categories jsonb;
  v_entries jsonb;
  v_expense_categories jsonb;
  v_methods jsonb;
  v_trend jsonb;
begin
  select p.organization_id, p.branch_id, p.role, p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS account is inactive or missing';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager', 'viewer') then
    raise exception 'Your role cannot access cash and expense reports';
  end if;

  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Choose a valid start and end date';
  end if;

  if (p_to - p_from) > 1095 then
    raise exception 'Choose a period of three years or less';
  end if;

  select
    s.base_currency,
    s.usd_to_khr_rate,
    coalesce(nullif(trim(s.timezone), ''), 'Asia/Phnom_Penh')
  into v_base_currency, v_usd_to_khr_rate, v_timezone
  from public.app_settings s
  where s.organization_id = v_profile.organization_id;

  v_base_currency := coalesce(v_base_currency, 'USD');
  if v_usd_to_khr_rate is null or v_usd_to_khr_rate <= 0 then
    v_usd_to_khr_rate := 4100;
  end if;

  if v_profile.role in ('owner', 'admin') and p_all_branches then
    v_all_branches := true;
    v_branch_id := null;
    v_branch_name := 'All branches';
  else
    v_branch_id := coalesce(p_branch_id, v_profile.branch_id);

    if v_profile.role not in ('owner', 'admin')
       and v_branch_id is distinct from v_profile.branch_id then
      raise exception 'You may view only your assigned branch';
    end if;

    select b.name into v_branch_name
    from public.branches b
    where b.id = v_branch_id
      and b.organization_id = v_profile.organization_id
      and b.is_active = true;

    if v_branch_name is null then
      raise exception 'Active branch not found';
    end if;
  end if;

  with period_entries as (
    select
      e.*,
      c.affects_profit,
      private.convert_to_base_currency(
        e.amount, e.currency, v_base_currency, v_usd_to_khr_rate
      ) as amount_base
    from public.cash_entries e
    join public.cash_categories c on c.id = e.category_id
    where e.organization_id = v_profile.organization_id
      and (v_all_branches or e.branch_id = v_branch_id)
      and e.status = 'active'
      and (timezone(v_timezone, e.entry_at))::date between p_from and p_to
  ),
  period_cash_sales as (
    select coalesce(sum(private.convert_to_base_currency(
      p.amount, p.currency, v_base_currency, v_usd_to_khr_rate
    )), 0) as amount
    from public.payments p
    join public.sales s on s.id = p.sale_id
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.method = 'cash'
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, p.paid_at))::date between p_from and p_to
  ),
  period_cash_refunds as (
    select coalesce(sum(private.convert_to_base_currency(
      r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
    )), 0) as amount
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and r.refund_method = 'cash'
      and (timezone(v_timezone, r.processed_at))::date between p_from and p_to
  ),
  all_cash_sales as (
    select coalesce(sum(private.convert_to_base_currency(
      p.amount, p.currency, v_base_currency, v_usd_to_khr_rate
    )), 0) as amount
    from public.payments p
    join public.sales s on s.id = p.sale_id
    where p.organization_id = v_profile.organization_id
      and (v_all_branches or p.branch_id = v_branch_id)
      and p.method = 'cash'
      and s.status in ('completed', 'partially_refunded', 'refunded')
      and (timezone(v_timezone, p.paid_at))::date <= p_to
  ),
  all_cash_refunds as (
    select coalesce(sum(private.convert_to_base_currency(
      r.refund_amount, r.currency, v_base_currency, v_usd_to_khr_rate
    )), 0) as amount
    from public.returns r
    where r.organization_id = v_profile.organization_id
      and (v_all_branches or r.branch_id = v_branch_id)
      and r.status = 'completed'
      and r.refund_method = 'cash'
      and (timezone(v_timezone, r.processed_at))::date <= p_to
  ),
  all_cash_entries as (
    select
      coalesce(sum(case when e.direction = 'income' then
        private.convert_to_base_currency(e.amount, e.currency, v_base_currency, v_usd_to_khr_rate)
        else 0 end), 0) as income,
      coalesce(sum(case when e.direction = 'expense' then
        private.convert_to_base_currency(e.amount, e.currency, v_base_currency, v_usd_to_khr_rate)
        else 0 end), 0) as expense
    from public.cash_entries e
    where e.organization_id = v_profile.organization_id
      and (v_all_branches or e.branch_id = v_branch_id)
      and e.status = 'active'
      and e.method = 'cash'
      and (timezone(v_timezone, e.entry_at))::date <= p_to
  )
  select jsonb_build_object(
    'manual_income', coalesce(sum(amount_base) filter (where direction = 'income'), 0),
    'manual_expenses', coalesce(sum(amount_base) filter (where direction = 'expense'), 0),
    'other_income', coalesce(sum(amount_base) filter (
      where direction = 'income' and affects_profit
    ), 0),
    'operating_expenses', coalesce(sum(amount_base) filter (
      where direction = 'expense' and affects_profit
    ), 0),
    'non_profit_cash_in', coalesce(sum(amount_base) filter (
      where direction = 'income' and not affects_profit
    ), 0),
    'non_profit_cash_out', coalesce(sum(amount_base) filter (
      where direction = 'expense' and not affects_profit
    ), 0),
    'cash_entry_income', coalesce(sum(amount_base) filter (
      where direction = 'income' and method = 'cash'
    ), 0),
    'cash_entry_expense', coalesce(sum(amount_base) filter (
      where direction = 'expense' and method = 'cash'
    ), 0),
    'cash_sales', (select amount from period_cash_sales),
    'cash_refunds', (select amount from period_cash_refunds),
    'period_cash_flow',
      (select amount from period_cash_sales)
      + coalesce(sum(amount_base) filter (where direction = 'income' and method = 'cash'), 0)
      - (select amount from period_cash_refunds)
      - coalesce(sum(amount_base) filter (where direction = 'expense' and method = 'cash'), 0),
    'current_cash_balance',
      (select amount from all_cash_sales)
      + (select income from all_cash_entries)
      - (select amount from all_cash_refunds)
      - (select expense from all_cash_entries),
    'entry_count', count(*),
    'income_count', count(*) filter (where direction = 'income'),
    'expense_count', count(*) filter (where direction = 'expense')
  ) into v_summary
  from period_entries;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'name', c.name,
    'direction', c.direction,
    'affects_profit', c.affects_profit,
    'is_system', c.is_system,
    'is_active', c.is_active
  ) order by c.direction, c.name), '[]'::jsonb)
  into v_categories
  from public.cash_categories c
  where c.organization_id = v_profile.organization_id;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.entry_at desc), '[]'::jsonb)
  into v_entries
  from (
    select
      e.id,
      e.entry_number,
      e.direction::text,
      e.method::text,
      e.currency::text,
      e.amount,
      private.convert_to_base_currency(
        e.amount, e.currency, v_base_currency, v_usd_to_khr_rate
      ) as base_amount,
      e.entry_at,
      e.reference_number,
      e.remark,
      e.status::text,
      e.category_id,
      c.name as category_name,
      c.affects_profit,
      b.id as branch_id,
      b.name as branch_name,
      coalesce(p.full_name, p.email, 'POS Staff') as created_by_name,
      e.created_at,
      e.updated_at
    from public.cash_entries e
    join public.cash_categories c on c.id = e.category_id
    join public.branches b on b.id = e.branch_id
    left join public.profiles p on p.id = e.created_by
    where e.organization_id = v_profile.organization_id
      and (v_all_branches or e.branch_id = v_branch_id)
      and e.status = 'active'
      and (timezone(v_timezone, e.entry_at))::date between p_from and p_to
    order by e.entry_at desc
    limit 1000
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.total desc), '[]'::jsonb)
  into v_expense_categories
  from (
    select
      c.id as category_id,
      c.name as category_name,
      c.affects_profit,
      count(*) as entry_count,
      sum(private.convert_to_base_currency(
        e.amount, e.currency, v_base_currency, v_usd_to_khr_rate
      )) as total
    from public.cash_entries e
    join public.cash_categories c on c.id = e.category_id
    where e.organization_id = v_profile.organization_id
      and (v_all_branches or e.branch_id = v_branch_id)
      and e.status = 'active'
      and e.direction = 'expense'
      and (timezone(v_timezone, e.entry_at))::date between p_from and p_to
    group by c.id, c.name, c.affects_profit
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.method), '[]'::jsonb)
  into v_methods
  from (
    select
      e.method::text as method,
      sum(case when e.direction = 'income' then private.convert_to_base_currency(
        e.amount, e.currency, v_base_currency, v_usd_to_khr_rate
      ) else 0 end) as income,
      sum(case when e.direction = 'expense' then private.convert_to_base_currency(
        e.amount, e.currency, v_base_currency, v_usd_to_khr_rate
      ) else 0 end) as expense
    from public.cash_entries e
    where e.organization_id = v_profile.organization_id
      and (v_all_branches or e.branch_id = v_branch_id)
      and e.status = 'active'
      and (timezone(v_timezone, e.entry_at))::date between p_from and p_to
    group by e.method
  ) q;

  with periods as (
    select generate_series(p_from, p_to, interval '1 day')::date as period
  ),
  daily as (
    select
      (timezone(v_timezone, e.entry_at))::date as period,
      sum(case when e.direction = 'income' then private.convert_to_base_currency(
        e.amount, e.currency, v_base_currency, v_usd_to_khr_rate
      ) else 0 end) as income,
      sum(case when e.direction = 'expense' then private.convert_to_base_currency(
        e.amount, e.currency, v_base_currency, v_usd_to_khr_rate
      ) else 0 end) as expense
    from public.cash_entries e
    where e.organization_id = v_profile.organization_id
      and (v_all_branches or e.branch_id = v_branch_id)
      and e.status = 'active'
      and (timezone(v_timezone, e.entry_at))::date between p_from and p_to
    group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'period', to_char(p.period, 'YYYY-MM-DD'),
    'income', coalesce(d.income, 0),
    'expense', coalesce(d.expense, 0),
    'net', coalesce(d.income, 0) - coalesce(d.expense, 0)
  ) order by p.period), '[]'::jsonb)
  into v_trend
  from periods p
  left join daily d on d.period = p.period;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'base_currency', v_base_currency,
    'scope', jsonb_build_object(
      'all_branches', v_all_branches,
      'branch_id', v_branch_id,
      'branch_name', v_branch_name
    ),
    'summary', v_summary,
    'categories', v_categories,
    'entries', v_entries,
    'expense_categories', v_expense_categories,
    'methods', v_methods,
    'trend', v_trend
  );
end;
$$;

revoke all on function public.get_cash_expense_workspace(
  date, date, uuid, boolean
) from public, anon;
grant execute on function public.get_cash_expense_workspace(
  date, date, uuid, boolean
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 11
-- ============================================================================
