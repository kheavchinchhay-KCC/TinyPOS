-- ============================================================================
-- Tiny POS - Step 32: Granular permissions and approval workflows
-- Run once in the NEW Supabase project after Step 31.
--
-- Adds:
--   * Per-user Allow / Deny permission overrides
--   * Per-user discount and refund approval limits
--   * One-time approval requests
--   * Server-enforced checkout and refund approvals
--   * Permission wrappers for major inventory, purchasing, cash and pricing RPCs
--
-- Existing business records are not deleted.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PERMISSION CATALOG
-- ----------------------------------------------------------------------------

create table if not exists public.permission_definitions (
  permission_key text primary key,
  module_key text not null,
  label text not null,
  description text not null,
  risk_level text not null default 'normal'
    check (risk_level in ('normal','sensitive','critical')),
  default_roles public.app_role[] not null default '{}'::public.app_role[],
  approval_action boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_permission_definitions_updated_at
  on public.permission_definitions;

create trigger set_permission_definitions_updated_at
before update on public.permission_definitions
for each row execute function public.set_updated_at();

insert into public.permission_definitions (
  permission_key,
  module_key,
  label,
  description,
  risk_level,
  default_roles,
  approval_action,
  sort_order
)
values
  ('dashboard.view','General','View Dashboard',
   'Open the business dashboard and action center.',
   'normal', array['owner','admin','manager','cashier','viewer']::public.app_role[], false, 10),

  ('sales.create','Sales','Create Sales',
   'Open New Sale, add products, park bills and complete checkout.',
   'sensitive', array['owner','admin','manager','cashier']::public.app_role[], false, 20),

  ('sales.discount.apply','Sales','Apply Manual Discounts',
   'Apply a manual percentage or fixed discount within the user limit.',
   'sensitive', array['owner','admin','manager','cashier']::public.app_role[], false, 21),

  ('sales.discount.unlimited','Sales','Unlimited Manual Discount',
   'Bypass the user discount approval limit.',
   'critical', array['owner','admin']::public.app_role[], false, 22),

  ('sales.discount.exceed_limit','Approvals','Discount Above Limit',
   'One-time approval action used when a sale discount exceeds the cashier limit.',
   'critical', '{}'::public.app_role[], true, 23),

  ('quotations.manage','Sales','Manage Quotations',
   'Create, edit, print, approve and convert quotations.',
   'sensitive', array['owner','admin','manager','cashier']::public.app_role[], false, 30),

  ('invoices.view','Sales','View Invoice Center',
   'Search, view, export and reprint invoices.',
   'normal', array['owner','admin','manager','cashier','viewer']::public.app_role[], false, 40),

  ('returns.process','Sales','Process Returns and Refunds',
   'Create product returns and issue refunds.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 50),

  ('returns.refund.unlimited','Sales','Unlimited Refund Amount',
   'Bypass the user refund approval limit.',
   'critical', array['owner','admin']::public.app_role[], false, 51),

  ('returns.refund.exceed_limit','Approvals','Refund Above Limit',
   'One-time approval action used when a refund exceeds the user limit.',
   'critical', '{}'::public.app_role[], true, 52),

  ('customers.manage','Customers','Manage Customers',
   'Create and update customer records.',
   'normal', array['owner','admin','manager']::public.app_role[], false, 60),

  ('credit_accounts.manage','Customers','Manage Credit Accounts',
   'Configure customer credit limits and account holds.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 61),

  ('credit_accounts.collect','Customers','Collect Credit Payments',
   'Receive and allocate payments to customer credit invoices.',
   'sensitive', array['owner','admin','manager','cashier']::public.app_role[], false, 62),

  ('credit_accounts.sell','Customers','Sell on Customer Credit',
   'Complete checkout using an approved customer credit account.',
   'critical', array['owner','admin','manager','cashier']::public.app_role[], false, 63),

  ('coupons.manage','Pricing','Manage Coupons',
   'Create, edit, activate and deactivate coupons.',
   'sensitive', array['owner','admin','manager']::public.app_role[], false, 70),

  ('price_lists.manage','Pricing','Manage Price Lists',
   'Create customer price lists and assign special pricing.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 71),

  ('products.manage','Catalog','Manage Products',
   'Create and update products, barcodes, images and selling units.',
   'sensitive', array['owner','admin','manager']::public.app_role[], false, 80),

  ('labels.print','Catalog','Print Barcode Labels',
   'Generate and print barcode and price labels.',
   'normal', array['owner','admin','manager']::public.app_role[], false, 81),

  ('inventory.view','Inventory','View Inventory',
   'Open inventory balances and stock movement history.',
   'normal', array['owner','admin','manager']::public.app_role[], false, 90),

  ('inventory.adjust','Inventory','Adjust Inventory',
   'Increase, decrease or set inventory quantities manually.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 91),

  ('stock_counts.manage','Inventory','Manage Stock Counts',
   'Start, enter, cancel and complete physical stock counts.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 92),

  ('transfers.create','Inventory','Create Stock Transfers',
   'Send stock from the assigned branch to another branch.',
   'sensitive', array['owner','admin','manager']::public.app_role[], false, 93),

  ('transfers.receive','Inventory','Receive Stock Transfers',
   'Receive pending stock transfers into the assigned branch.',
   'sensitive', array['owner','admin','manager']::public.app_role[], false, 94),

  ('transfers.cancel','Inventory','Cancel Stock Transfers',
   'Cancel a pending stock transfer and restore source stock.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 95),

  ('purchases.manage','Purchasing','Manage Purchase Orders',
   'Create and edit draft or ordered purchase orders.',
   'sensitive', array['owner','admin','manager']::public.app_role[], false, 100),

  ('purchases.receive','Purchasing','Receive Purchases',
   'Receive full or partial supplier deliveries and update inventory.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 101),

  ('purchases.cancel','Purchasing','Cancel Purchase Orders',
   'Cancel an eligible purchase order.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 102),

  ('purchases.supplier_return','Purchasing','Return Stock to Supplier',
   'Deduct received stock and create a supplier return.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 103),

  ('supplier_payables.view','Purchasing','View Supplier Payables',
   'View supplier balances, aging and statements.',
   'normal', array['owner','admin','manager']::public.app_role[], false, 104),

  ('supplier_payables.pay','Purchasing','Pay Suppliers',
   'Record and allocate supplier payments.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 105),

  ('reorder.manage','Purchasing','Manage Reorder Planner',
   'Configure reorder rules and create draft purchase orders.',
   'sensitive', array['owner','admin','manager']::public.app_role[], false, 106),

  ('cash_expenses.manage','Cash','Manage Cash and Expenses',
   'Create income and expense entries.',
   'sensitive', array['owner','admin','manager']::public.app_role[], false, 110),

  ('cash_expenses.void','Cash','Void Cash Entries',
   'Void an existing income or expense entry.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 111),

  ('cash_register.use','Cash','Use Cash Register',
   'Open the branch cash register and accept cash activity.',
   'sensitive', array['owner','admin','manager','cashier']::public.app_role[], false, 112),

  ('cash_register.close','Cash','Close Cash Register',
   'Count cash and close the current register session.',
   'critical', array['owner','admin','manager','cashier']::public.app_role[], false, 113),

  ('reports.view','Reporting','View Reports',
   'Open sales, profit, inventory and customer reports.',
   'normal', array['owner','admin','manager','viewer']::public.app_role[], false, 120),

  ('profit.view','Reporting','View Cost and Profit',
   'View product costs, gross profit and net profit.',
   'sensitive', array['owner','admin','manager','viewer']::public.app_role[], false, 121),

  ('branches.all','Administration','View All Branches',
   'Use organization-wide branch filters and combined reporting.',
   'sensitive', array['owner','admin']::public.app_role[], false, 130),

  ('branches.switch','Administration','Switch Assigned Branch',
   'Switch the active branch from the application sidebar.',
   'critical', array['owner','admin']::public.app_role[], false, 131),

  ('staff.manage','Administration','Manage Staff and Branches',
   'Create staff accounts, roles, passwords and branches.',
   'critical', array['owner','admin']::public.app_role[], false, 132),

  ('access.manage','Administration','Manage Individual Permissions',
   'Edit per-user permission overrides and approval limits.',
   'critical', array['owner','admin']::public.app_role[], false, 133),

  ('approvals.review','Approvals','Review Approval Requests',
   'Approve or reject one-time discount and refund requests.',
   'critical', array['owner','admin','manager']::public.app_role[], false, 134),

  ('audit_backup.manage','Administration','Audit and Backup',
   'View audit logs, create backups and restore business data.',
   'critical', array['owner','admin']::public.app_role[], false, 135),

  ('import.manage','Administration','Import Data',
   'Import products, stock, customers, suppliers and package units.',
   'critical', array['owner','admin']::public.app_role[], false, 136),

  ('telegram.use','Integration','Use Telegram',
   'Connect Telegram and manage personal notification preferences.',
   'normal', array['owner','admin','manager','cashier','viewer']::public.app_role[], false, 140),

  ('telegram.admin','Integration','Configure Telegram Bot',
   'Configure the webhook, bot menu and linked-user overview.',
   'critical', array['owner','admin']::public.app_role[], false, 141),

  ('settings.view','Settings','View Settings',
   'Open personal theme, language and shop settings.',
   'normal', array['owner','admin','manager','cashier','viewer']::public.app_role[], false, 150),

  ('settings.manage','Settings','Edit Shop Settings',
   'Change shop branding, receipt settings and organization defaults.',
   'critical', array['owner','admin']::public.app_role[], false, 151)
on conflict (permission_key)
do update set
  module_key = excluded.module_key,
  label = excluded.label,
  description = excluded.description,
  risk_level = excluded.risk_level,
  default_roles = excluded.default_roles,
  approval_action = excluded.approval_action,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

-- ----------------------------------------------------------------------------
-- 2. USER OVERRIDES AND LIMITS
-- ----------------------------------------------------------------------------

create table if not exists public.user_permission_overrides (
  user_id uuid not null
    references public.profiles(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  permission_key text not null
    references public.permission_definitions(permission_key)
    on delete cascade,
  allowed boolean not null,
  updated_by uuid
    references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);

create index if not exists user_permission_overrides_org_idx
  on public.user_permission_overrides (
    organization_id,
    user_id
  );

create table if not exists public.user_approval_limits (
  user_id uuid primary key
    references public.profiles(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  max_discount_percent numeric(7,3)
    check (
      max_discount_percent is null
      or max_discount_percent between 0 and 100
    ),

  max_discount_amount_usd numeric(14,2)
    check (
      max_discount_amount_usd is null
      or max_discount_amount_usd >= 0
    ),

  max_discount_amount_khr numeric(14,2)
    check (
      max_discount_amount_khr is null
      or max_discount_amount_khr >= 0
    ),

  max_refund_amount_usd numeric(14,2)
    check (
      max_refund_amount_usd is null
      or max_refund_amount_usd >= 0
    ),

  max_refund_amount_khr numeric(14,2)
    check (
      max_refund_amount_khr is null
      or max_refund_amount_khr >= 0
    ),

  updated_by uuid
    references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function private.default_approval_limits(
  p_role public.app_role
)
returns jsonb
language sql
stable
as $$
  select case p_role
    when 'owner' then jsonb_build_object(
      'max_discount_percent', null,
      'max_discount_amount_usd', null,
      'max_discount_amount_khr', null,
      'max_refund_amount_usd', null,
      'max_refund_amount_khr', null
    )
    when 'admin' then jsonb_build_object(
      'max_discount_percent', null,
      'max_discount_amount_usd', null,
      'max_discount_amount_khr', null,
      'max_refund_amount_usd', null,
      'max_refund_amount_khr', null
    )
    when 'manager' then jsonb_build_object(
      'max_discount_percent', 15,
      'max_discount_amount_usd', 50,
      'max_discount_amount_khr', 200000,
      'max_refund_amount_usd', 100,
      'max_refund_amount_khr', 400000
    )
    when 'cashier' then jsonb_build_object(
      'max_discount_percent', 5,
      'max_discount_amount_usd', 10,
      'max_discount_amount_khr', 40000,
      'max_refund_amount_usd', 0,
      'max_refund_amount_khr', 0
    )
    else jsonb_build_object(
      'max_discount_percent', 0,
      'max_discount_amount_usd', 0,
      'max_discount_amount_khr', 0,
      'max_refund_amount_usd', 0,
      'max_refund_amount_khr', 0
    )
  end;
$$;

create or replace function private.ensure_user_approval_limits(
  p_user_id uuid
)
returns public.user_approval_limits
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_defaults jsonb;
  v_result public.user_approval_limits%rowtype;
begin
  select *
  into v_profile
  from public.profiles
  where id = p_user_id;

  if not found then
    raise exception 'POS profile not found';
  end if;

  v_defaults :=
    private.default_approval_limits(
      v_profile.role
    );

  insert into public.user_approval_limits (
    user_id,
    organization_id,
    max_discount_percent,
    max_discount_amount_usd,
    max_discount_amount_khr,
    max_refund_amount_usd,
    max_refund_amount_khr
  )
  values (
    v_profile.id,
    v_profile.organization_id,
    (v_defaults ->> 'max_discount_percent')::numeric,
    (v_defaults ->> 'max_discount_amount_usd')::numeric,
    (v_defaults ->> 'max_discount_amount_khr')::numeric,
    (v_defaults ->> 'max_refund_amount_usd')::numeric,
    (v_defaults ->> 'max_refund_amount_khr')::numeric
  )
  on conflict (user_id)
  do nothing;

  select *
  into v_result
  from public.user_approval_limits
  where user_id = p_user_id;

  return v_result;
end;
$$;

revoke all on function private.ensure_user_approval_limits(uuid)
  from public;

grant execute on function private.ensure_user_approval_limits(uuid)
  to authenticated, service_role;

do $$
declare
  v_profile record;
begin
  for v_profile in
    select id from public.profiles
  loop
    perform private.ensure_user_approval_limits(
      v_profile.id
    );
  end loop;
end
$$;

create or replace function private.initialize_profile_access()
returns trigger
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.ensure_user_approval_limits(new.id);
  return new;
end;
$$;

drop trigger if exists initialize_profile_access_after_insert
  on public.profiles;

create trigger initialize_profile_access_after_insert
after insert on public.profiles
for each row execute function private.initialize_profile_access();

-- ----------------------------------------------------------------------------
-- 3. EFFECTIVE PERMISSION HELPERS
-- ----------------------------------------------------------------------------

create or replace function private.has_permission(
  p_permission_key text,
  p_user_id uuid default auth.uid()
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_profile record;
  v_override boolean;
  v_defaults public.app_role[];
begin
  if p_user_id is null then
    return false;
  end if;

  select
    profile_row.organization_id,
    profile_row.role,
    profile_row.is_active
  into v_profile
  from public.profiles profile_row
  where profile_row.id = p_user_id;

  if not found
     or v_profile.is_active is not true then
    return false;
  end if;

  if v_profile.role = 'owner' then
    return true;
  end if;

  select override_row.allowed
  into v_override
  from public.user_permission_overrides override_row
  where override_row.user_id = p_user_id
    and override_row.permission_key =
      p_permission_key;

  if found then
    return v_override;
  end if;

  select definition.default_roles
  into v_defaults
  from public.permission_definitions definition
  where definition.permission_key =
      p_permission_key
    and definition.is_active = true;

  if not found then
    return false;
  end if;

  return v_profile.role = any(v_defaults);
end;
$$;

revoke all on function private.has_permission(text, uuid)
  from public;

grant execute on function private.has_permission(text, uuid)
  to authenticated, service_role;

create or replace function private.require_permission(
  p_permission_key text
)
returns void
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  if not private.has_permission(
    p_permission_key,
    auth.uid()
  ) then
    raise exception
      'Permission required: %',
      p_permission_key;
  end if;
end;
$$;

revoke all on function private.require_permission(text)
  from public;

grant execute on function private.require_permission(text)
  to authenticated, service_role;

create or replace function private.current_approval_limits()
returns public.user_approval_limits
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_result public.user_approval_limits%rowtype;
begin
  v_result :=
    private.ensure_user_approval_limits(
      auth.uid()
    );
  return v_result;
end;
$$;

revoke all on function private.current_approval_limits()
  from public;

grant execute on function private.current_approval_limits()
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. APPROVAL REQUESTS
-- ----------------------------------------------------------------------------

create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid not null
    references public.branches(id) on delete restrict,

  requested_by uuid not null
    references public.profiles(id) on delete cascade,

  permission_key text not null
    references public.permission_definitions(permission_key)
    on delete restrict,

  action_type text not null,
  action_hash text not null,
  action_summary text not null,

  amount numeric(14,2),
  currency public.currency_code,
  payload jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (
      status in (
        'pending',
        'approved',
        'rejected',
        'expired',
        'consumed',
        'cancelled'
      )
    ),

  requested_at timestamptz not null default now(),
  expires_at timestamptz not null
    default (now() + interval '30 minutes'),

  reviewed_by uuid
    references public.profiles(id) on delete set null,

  reviewed_at timestamptz,
  review_note text,

  consumed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (expires_at > requested_at),
  check (
    (status not in ('approved','rejected')
      or reviewed_at is not null)
    and
    (status <> 'consumed'
      or consumed_at is not null)
  )
);

create index if not exists approval_requests_pending_idx
  on public.approval_requests (
    organization_id,
    branch_id,
    status,
    requested_at desc
  );

create index if not exists approval_requests_requester_idx
  on public.approval_requests (
    requested_by,
    requested_at desc
  );

drop trigger if exists set_approval_requests_updated_at
  on public.approval_requests;

create trigger set_approval_requests_updated_at
before update on public.approval_requests
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. RLS
-- ----------------------------------------------------------------------------

alter table public.permission_definitions
  enable row level security;

alter table public.user_permission_overrides
  enable row level security;

alter table public.user_approval_limits
  enable row level security;

alter table public.approval_requests
  enable row level security;

drop policy if exists permission_definitions_select_authenticated
  on public.permission_definitions;

create policy permission_definitions_select_authenticated
on public.permission_definitions
for select to authenticated
using (is_active = true);

drop policy if exists permission_overrides_select_allowed
  on public.user_permission_overrides;

create policy permission_overrides_select_allowed
on public.user_permission_overrides
for select to authenticated
using (
  user_id = auth.uid()
  or (
    organization_id =
      (select private.current_organization_id())
    and private.has_permission(
      'access.manage',
      auth.uid()
    )
  )
);

drop policy if exists approval_limits_select_allowed
  on public.user_approval_limits;

create policy approval_limits_select_allowed
on public.user_approval_limits
for select to authenticated
using (
  user_id = auth.uid()
  or (
    organization_id =
      (select private.current_organization_id())
    and private.has_permission(
      'access.manage',
      auth.uid()
    )
  )
);

drop policy if exists approval_requests_select_allowed
  on public.approval_requests;

create policy approval_requests_select_allowed
on public.approval_requests
for select to authenticated
using (
  requested_by = auth.uid()
  or (
    organization_id =
      (select private.current_organization_id())
    and private.has_permission(
      'approvals.review',
      auth.uid()
    )
    and (
      private.has_permission(
        'branches.all',
        auth.uid()
      )
      or branch_id =
        (select private.current_branch_id())
    )
  )
);

revoke all on public.permission_definitions from anon;
revoke all on public.user_permission_overrides from anon;
revoke all on public.user_approval_limits from anon;
revoke all on public.approval_requests from anon;

grant select on public.permission_definitions
  to authenticated;
grant select on public.user_permission_overrides
  to authenticated;
grant select on public.user_approval_limits
  to authenticated;
grant select on public.approval_requests
  to authenticated;

grant all on public.permission_definitions
  to service_role;
grant all on public.user_permission_overrides
  to service_role;
grant all on public.user_approval_limits
  to service_role;
grant all on public.approval_requests
  to service_role;

-- ----------------------------------------------------------------------------
-- 6. MY EFFECTIVE ACCESS
-- ----------------------------------------------------------------------------

create or replace function public.get_my_access()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_limits public.user_approval_limits%rowtype;
  v_permissions jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active POS profile required';
  end if;

  v_limits :=
    private.ensure_user_approval_limits(
      v_user_id
    );

  select coalesce(
    jsonb_object_agg(
      definition.permission_key,
      private.has_permission(
        definition.permission_key,
        v_user_id
      )
      order by definition.sort_order
    ),
    '{}'::jsonb
  )
  into v_permissions
  from public.permission_definitions definition
  where definition.is_active = true
    and definition.approval_action = false;

  return jsonb_build_object(
    'user_id', v_user_id,
    'role', v_profile.role,
    'permissions', v_permissions,
    'limits', to_jsonb(v_limits)
      - 'user_id'
      - 'organization_id'
      - 'updated_by'
  );
end;
$$;

revoke all on function public.get_my_access()
  from public, anon;

grant execute on function public.get_my_access()
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. ACCESS AND APPROVAL WORKSPACE
-- ----------------------------------------------------------------------------

create or replace function public.get_access_control_workspace()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_can_manage boolean;
  v_can_review boolean;
  v_staff jsonb := '[]'::jsonb;
  v_requests jsonb := '[]'::jsonb;
  v_definitions jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if not found then
    raise exception 'Active POS profile required';
  end if;

  v_can_manage :=
    private.has_permission(
      'access.manage',
      v_user_id
    );

  v_can_review :=
    private.has_permission(
      'approvals.review',
      v_user_id
    );

  if not v_can_manage
     and not v_can_review then
    raise exception
      'Access management or approval-review permission is required';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'permission_key',
          definition.permission_key,
        'module_key',
          definition.module_key,
        'label',
          definition.label,
        'description',
          definition.description,
        'risk_level',
          definition.risk_level,
        'default_roles',
          definition.default_roles,
        'approval_action',
          definition.approval_action,
        'sort_order',
          definition.sort_order
      )
      order by
        definition.module_key,
        definition.sort_order,
        definition.label
    ),
    '[]'::jsonb
  )
  into v_definitions
  from public.permission_definitions definition
  where definition.is_active = true
    and definition.approval_action = false;

  if v_can_manage then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', profile_row.id,
          'full_name', profile_row.full_name,
          'email', profile_row.email,
          'phone', profile_row.phone,
          'role', profile_row.role,
          'branch_id', profile_row.branch_id,
          'branch_name', branch_row.name,
          'branch_code', branch_row.code,
          'is_active', profile_row.is_active,
          'overrides', coalesce((
            select jsonb_object_agg(
              override_row.permission_key,
              override_row.allowed
            )
            from public.user_permission_overrides override_row
            where override_row.user_id =
              profile_row.id
          ), '{}'::jsonb),
          'limits', to_jsonb(
            private.ensure_user_approval_limits(
              profile_row.id
            )
          )
            - 'user_id'
            - 'organization_id'
            - 'updated_by'
        )
        order by
          profile_row.full_name,
          profile_row.email
      ),
      '[]'::jsonb
    )
    into v_staff
    from public.profiles profile_row
    left join public.branches branch_row
      on branch_row.id = profile_row.branch_id
    where profile_row.organization_id =
      v_profile.organization_id;
  end if;

  if v_can_review then
    update public.approval_requests
    set
      status = 'expired',
      updated_at = now()
    where organization_id =
        v_profile.organization_id
      and status in ('pending','approved')
      and expires_at <= now();

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', request_row.id,
          'branch_id', request_row.branch_id,
          'branch_name', branch_row.name,
          'requested_by',
            request_row.requested_by,
          'requested_by_name',
            requester.full_name,
          'requested_by_role',
            requester.role,
          'permission_key',
            request_row.permission_key,
          'action_type',
            request_row.action_type,
          'action_summary',
            request_row.action_summary,
          'amount', request_row.amount,
          'currency', request_row.currency,
          'payload', request_row.payload,
          'status', request_row.status,
          'requested_at',
            request_row.requested_at,
          'expires_at',
            request_row.expires_at,
          'reviewed_by',
            request_row.reviewed_by,
          'reviewed_by_name',
            reviewer.full_name,
          'reviewed_at',
            request_row.reviewed_at,
          'review_note',
            request_row.review_note,
          'consumed_at',
            request_row.consumed_at
        )
        order by
          case request_row.status
            when 'pending' then 0
            when 'approved' then 1
            else 2
          end,
          request_row.requested_at desc
      ),
      '[]'::jsonb
    )
    into v_requests
    from public.approval_requests request_row
    join public.profiles requester
      on requester.id =
        request_row.requested_by
    left join public.profiles reviewer
      on reviewer.id =
        request_row.reviewed_by
    left join public.branches branch_row
      on branch_row.id =
        request_row.branch_id
    where request_row.organization_id =
        v_profile.organization_id
      and (
        private.has_permission(
          'branches.all',
          v_user_id
        )
        or request_row.branch_id =
          v_profile.branch_id
      )
      and request_row.requested_at
        >= now() - interval '30 days';
  end if;

  return jsonb_build_object(
    'can_manage', v_can_manage,
    'can_review', v_can_review,
    'definitions', v_definitions,
    'staff', v_staff,
    'requests', v_requests
  );
end;
$$;

revoke all on function public.get_access_control_workspace()
  from public, anon;

grant execute on function public.get_access_control_workspace()
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. SAVE INDIVIDUAL ACCESS
-- ----------------------------------------------------------------------------

create or replace function public.save_user_access(
  p_user_id uuid,
  p_overrides jsonb,
  p_limits jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_caller_id uuid := auth.uid();
  v_caller public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_override record;
  v_limit_row public.user_approval_limits%rowtype;
begin
  if v_caller_id is null then
    raise exception 'Authentication required';
  end if;

  perform private.require_permission(
    'access.manage'
  );

  select *
  into v_caller
  from public.profiles
  where id = v_caller_id
    and is_active = true;

  select *
  into v_target
  from public.profiles
  where id = p_user_id
    and organization_id =
      v_caller.organization_id;

  if not found then
    raise exception 'Staff account not found';
  end if;

  if v_target.role = 'owner'
     and v_caller.role <> 'owner' then
    raise exception
      'Only the owner can manage owner access';
  end if;

  if v_caller.role = 'admin'
     and v_target.role in ('owner','admin')
     and v_target.id <> v_caller.id then
    raise exception
      'Administrators cannot edit owner or other administrator access';
  end if;

  if jsonb_typeof(
    coalesce(p_overrides, '[]'::jsonb)
  ) <> 'array' then
    raise exception 'Permission overrides must be an array';
  end if;

  for v_override in
    select
      value ->> 'permission_key'
        as permission_key,
      value -> 'allowed'
        as allowed_json
    from jsonb_array_elements(
      coalesce(p_overrides, '[]'::jsonb)
    )
  loop
    if not exists (
      select 1
      from public.permission_definitions definition
      where definition.permission_key =
          v_override.permission_key
        and definition.is_active = true
        and definition.approval_action = false
    ) then
      raise exception
        'Unknown permission: %',
        v_override.permission_key;
    end if;

    if v_override.allowed_json is null
       or v_override.allowed_json =
          'null'::jsonb then
      delete from public.user_permission_overrides
      where user_id = v_target.id
        and permission_key =
          v_override.permission_key;
    else
      insert into public.user_permission_overrides (
        user_id,
        organization_id,
        permission_key,
        allowed,
        updated_by,
        updated_at
      )
      values (
        v_target.id,
        v_target.organization_id,
        v_override.permission_key,
        (v_override.allowed_json)::boolean,
        v_caller_id,
        now()
      )
      on conflict (user_id, permission_key)
      do update set
        allowed = excluded.allowed,
        updated_by = excluded.updated_by,
        updated_at = now();
    end if;
  end loop;

  v_limit_row :=
    private.ensure_user_approval_limits(
      v_target.id
    );

  update public.user_approval_limits
  set
    max_discount_percent =
      case
        when p_limits ? 'max_discount_percent'
          then nullif(
            p_limits ->> 'max_discount_percent',
            ''
          )::numeric
        else max_discount_percent
      end,

    max_discount_amount_usd =
      case
        when p_limits ? 'max_discount_amount_usd'
          then nullif(
            p_limits ->> 'max_discount_amount_usd',
            ''
          )::numeric
        else max_discount_amount_usd
      end,

    max_discount_amount_khr =
      case
        when p_limits ? 'max_discount_amount_khr'
          then nullif(
            p_limits ->> 'max_discount_amount_khr',
            ''
          )::numeric
        else max_discount_amount_khr
      end,

    max_refund_amount_usd =
      case
        when p_limits ? 'max_refund_amount_usd'
          then nullif(
            p_limits ->> 'max_refund_amount_usd',
            ''
          )::numeric
        else max_refund_amount_usd
      end,

    max_refund_amount_khr =
      case
        when p_limits ? 'max_refund_amount_khr'
          then nullif(
            p_limits ->> 'max_refund_amount_khr',
            ''
          )::numeric
        else max_refund_amount_khr
      end,

    updated_by = v_caller_id,
    updated_at = now()

  where user_id = v_target.id
  returning *
  into v_limit_row;

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
    v_caller.organization_id,
    v_target.branch_id,
    v_caller_id,
    'save_user_access',
    'profile',
    v_target.id,
    jsonb_build_object(
      'target_name', v_target.full_name,
      'target_role', v_target.role,
      'limits', to_jsonb(v_limit_row)
        - 'user_id'
        - 'organization_id'
        - 'updated_by'
    )
  );

  return jsonb_build_object(
    'ok', true,
    'user_id', v_target.id,
    'limits', to_jsonb(v_limit_row)
      - 'user_id'
      - 'organization_id'
      - 'updated_by',
    'overrides', coalesce((
      select jsonb_object_agg(
        override_row.permission_key,
        override_row.allowed
      )
      from public.user_permission_overrides override_row
      where override_row.user_id =
        v_target.id
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.save_user_access(
  uuid,
  jsonb,
  jsonb
) from public, anon;

grant execute on function public.save_user_access(
  uuid,
  jsonb,
  jsonb
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9. REQUEST, REVIEW AND CONSUME APPROVAL
-- ----------------------------------------------------------------------------

create or replace function public.create_approval_request(
  p_permission_key text,
  p_action_type text,
  p_action_payload jsonb,
  p_action_summary text,
  p_amount numeric default null,
  p_currency public.currency_code default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_request public.approval_requests%rowtype;
  v_hash text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if not found
     or v_profile.branch_id is null then
    raise exception
      'Active POS profile and branch are required';
  end if;

  if not exists (
    select 1
    from public.permission_definitions definition
    where definition.permission_key =
        p_permission_key
      and definition.approval_action = true
      and definition.is_active = true
  ) then
    raise exception
      'This action does not support approval requests';
  end if;

  if p_action_payload is null
     or jsonb_typeof(p_action_payload) <> 'object' then
    raise exception
      'Approval action payload is required';
  end if;

  if p_action_summary is null
     or length(trim(p_action_summary)) < 3 then
    raise exception
      'Approval summary is required';
  end if;

  if p_amount is not null
     and p_amount < 0 then
    raise exception
      'Approval amount cannot be negative';
  end if;

  v_hash := md5(p_action_payload::text);

  update public.approval_requests
  set
    status = 'expired',
    updated_at = now()
  where requested_by = v_user_id
    and status in ('pending','approved')
    and expires_at <= now();

  select *
  into v_request
  from public.approval_requests request_row
  where request_row.requested_by =
      v_user_id
    and request_row.permission_key =
      p_permission_key
    and request_row.action_hash =
      v_hash
    and request_row.status in (
      'pending',
      'approved'
    )
    and request_row.expires_at > now()
  order by request_row.requested_at desc
  limit 1;

  if found then
    return to_jsonb(v_request)
      || jsonb_build_object(
        'ok', true,
        'existing', true
      );
  end if;

  insert into public.approval_requests (
    organization_id,
    branch_id,
    requested_by,
    permission_key,
    action_type,
    action_hash,
    action_summary,
    amount,
    currency,
    payload,
    status,
    requested_at,
    expires_at
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    p_permission_key,
    trim(p_action_type),
    v_hash,
    trim(p_action_summary),
    case
      when p_amount is null
        then null
      else round(p_amount, 2)
    end,
    p_currency,
    p_action_payload,
    'pending',
    now(),
    now() + interval '30 minutes'
  )
  returning *
  into v_request;

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
    'request_action_approval',
    'approval_request',
    v_request.id,
    jsonb_build_object(
      'permission_key',
        p_permission_key,
      'action_type',
        p_action_type,
      'summary',
        p_action_summary,
      'amount',
        p_amount,
      'currency',
        p_currency
    )
  );

  return to_jsonb(v_request)
    || jsonb_build_object(
      'ok', true,
      'existing', false
    );
end;
$$;

revoke all on function public.create_approval_request(
  text,
  text,
  jsonb,
  text,
  numeric,
  public.currency_code
) from public, anon;

grant execute on function public.create_approval_request(
  text,
  text,
  jsonb,
  text,
  numeric,
  public.currency_code
) to authenticated, service_role;

create or replace function public.get_approval_request_status(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_request public.approval_requests%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  select *
  into v_request
  from public.approval_requests
  where id = p_request_id
    and organization_id =
      v_profile.organization_id;

  if not found then
    raise exception 'Approval request not found';
  end if;

  if v_request.requested_by <> v_user_id
     and not private.has_permission(
       'approvals.review',
       v_user_id
     ) then
    raise exception
      'You cannot view this approval request';
  end if;

  if v_request.status in (
    'pending',
    'approved'
  )
  and v_request.expires_at <= now() then
    update public.approval_requests
    set
      status = 'expired',
      updated_at = now()
    where id = v_request.id
    returning *
    into v_request;
  end if;

  return to_jsonb(v_request);
end;
$$;

revoke all on function public.get_approval_request_status(uuid)
  from public, anon;

grant execute on function public.get_approval_request_status(uuid)
  to authenticated, service_role;

create or replace function public.review_approval_request(
  p_request_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_reviewer public.profiles%rowtype;
  v_request public.approval_requests%rowtype;
  v_status text;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  perform private.require_permission(
    'approvals.review'
  );

  select *
  into v_reviewer
  from public.profiles
  where id = v_user_id
    and is_active = true;

  select *
  into v_request
  from public.approval_requests
  where id = p_request_id
    and organization_id =
      v_reviewer.organization_id
  for update;

  if not found then
    raise exception 'Approval request not found';
  end if;

  if not private.has_permission(
    'branches.all',
    v_user_id
  )
  and v_request.branch_id <>
      v_reviewer.branch_id then
    raise exception
      'This request belongs to another branch';
  end if;

  if v_request.requested_by = v_user_id then
    raise exception
      'You cannot approve your own request';
  end if;

  if v_request.status <> 'pending' then
    raise exception
      'This request is already %',
      v_request.status;
  end if;

  if v_request.expires_at <= now() then
    update public.approval_requests
    set
      status = 'expired',
      updated_at = now()
    where id = v_request.id;

    raise exception
      'This approval request has expired';
  end if;

  v_status := case lower(trim(p_decision))
    when 'approve' then 'approved'
    when 'approved' then 'approved'
    when 'reject' then 'rejected'
    when 'rejected' then 'rejected'
    else null
  end;

  if v_status is null then
    raise exception
      'Decision must be Approve or Reject';
  end if;

  update public.approval_requests
  set
    status = v_status,
    reviewed_by = v_user_id,
    reviewed_at = now(),
    review_note =
      nullif(trim(p_note), ''),
    updated_at = now()
  where id = v_request.id
  returning *
  into v_request;

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
    v_reviewer.organization_id,
    v_request.branch_id,
    v_user_id,
    case
      when v_status = 'approved'
        then 'approve_action_request'
      else 'reject_action_request'
    end,
    'approval_request',
    v_request.id,
    jsonb_build_object(
      'requested_by',
        v_request.requested_by,
      'permission_key',
        v_request.permission_key,
      'action_summary',
        v_request.action_summary,
      'amount',
        v_request.amount,
      'currency',
        v_request.currency,
      'note',
        v_request.review_note
    )
  );

  return to_jsonb(v_request)
    || jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.review_approval_request(
  uuid,
  text,
  text
) from public, anon;

grant execute on function public.review_approval_request(
  uuid,
  text,
  text
) to authenticated, service_role;

create or replace function private.consume_approved_request(
  p_request_id uuid,
  p_permission_key text,
  p_action_payload jsonb
)
returns public.approval_requests
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_request public.approval_requests%rowtype;
  v_hash text := md5(p_action_payload::text);
begin
  if p_request_id is null then
    raise exception
      'Manager approval is required for this action';
  end if;

  select *
  into v_request
  from public.approval_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Approval request not found';
  end if;

  if v_request.requested_by <> auth.uid() then
    raise exception
      'This approval belongs to another user';
  end if;

  if v_request.permission_key <>
      p_permission_key then
    raise exception
      'Approval does not match this action';
  end if;

  if v_request.action_hash <> v_hash then
    raise exception
      'The bill or refund changed after approval. Request a new approval';
  end if;

  if v_request.status <> 'approved' then
    raise exception
      'Approval status is %',
      v_request.status;
  end if;

  if v_request.expires_at <= now() then
    update public.approval_requests
    set
      status = 'expired',
      updated_at = now()
    where id = v_request.id;

    raise exception
      'This approval has expired';
  end if;

  update public.approval_requests
  set
    status = 'consumed',
    consumed_at = now(),
    updated_at = now()
  where id = v_request.id
  returning *
  into v_request;

  return v_request;
end;
$$;

revoke all on function private.consume_approved_request(
  uuid,
  text,
  jsonb
) from public;

grant execute on function private.consume_approved_request(
  uuid,
  text,
  jsonb
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 10. REFUND ESTIMATE USED FOR SERVER APPROVAL LIMIT
-- ----------------------------------------------------------------------------

create or replace function private.estimate_return_total(
  p_sale_id uuid,
  p_items jsonb
)
returns numeric
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_sale public.sales%rowtype;
  v_item record;
  v_sale_item public.sale_items%rowtype;
  v_sale_line_total numeric(14,2) := 0;
  v_previous_tax_refunded numeric(14,2) := 0;
  v_remaining_tax numeric(14,2) := 0;
  v_requested numeric(14,3);
  v_previous_returned numeric(14,3);
  v_available numeric(14,3);
  v_net_refund numeric(14,2);
  v_tax_refund numeric(14,2);
  v_total numeric(14,2) := 0;
begin
  select *
  into v_sale
  from public.sales
  where id = p_sale_id;

  if not found then
    raise exception 'Sale not found';
  end if;

  select coalesce(sum(line_total), 0)
  into v_sale_line_total
  from public.sale_items
  where sale_id = v_sale.id;

  select coalesce(sum(item.tax_refund), 0)
  into v_previous_tax_refunded
  from public.return_items item
  join public.returns return_row
    on return_row.id = item.return_id
  where return_row.original_sale_id =
      v_sale.id
    and return_row.status = 'completed';

  v_remaining_tax := greatest(
    v_sale.tax_amount
      - v_previous_tax_refunded,
    0
  );

  for v_item in
    select
      row_item.sale_item_id,
      sum(row_item.quantity)::numeric(14,3)
        as quantity
    from jsonb_to_recordset(p_items)
      as row_item(
        sale_item_id uuid,
        quantity numeric,
        restock boolean
      )
    group by row_item.sale_item_id
    order by row_item.sale_item_id
  loop
    v_requested := v_item.quantity;

    select *
    into v_sale_item
    from public.sale_items
    where id = v_item.sale_item_id
      and sale_id = v_sale.id;

    if not found then
      raise exception
        'Refund item does not belong to this sale';
    end if;

    select coalesce(sum(item.quantity), 0)
    into v_previous_returned
    from public.return_items item
    join public.returns return_row
      on return_row.id = item.return_id
    where item.sale_item_id =
        v_sale_item.id
      and return_row.status = 'completed';

    v_available :=
      v_sale_item.quantity
      - v_previous_returned;

    if v_requested <= 0
       or v_requested > v_available then
      raise exception
        'Invalid refund quantity for %',
        v_sale_item.product_name;
    end if;

    v_net_refund := round(
      v_sale_item.line_total
        * v_requested
        / v_sale_item.quantity,
      2
    );

    if v_sale_line_total > 0
       and v_remaining_tax > 0 then
      v_tax_refund := least(
        v_remaining_tax,
        round(
          v_sale.tax_amount
            * (
              v_sale_item.line_total
              / v_sale_line_total
            )
            * (
              v_requested
              / v_sale_item.quantity
            ),
          2
        )
      );
    else
      v_tax_refund := 0;
    end if;

    v_remaining_tax := greatest(
      v_remaining_tax - v_tax_refund,
      0
    );

    v_total := v_total
      + v_net_refund
      + v_tax_refund;
  end loop;

  return round(v_total, 2);
end;
$$;

revoke all on function private.estimate_return_total(
  uuid,
  jsonb
) from public;

grant execute on function private.estimate_return_total(
  uuid,
  jsonb
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 11. SERVER-ENFORCED SALE CHECKOUT WITH ONE-TIME APPROVAL
-- ----------------------------------------------------------------------------

create or replace function public.complete_sale_v7(
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
  p_idempotency_key text default null,
  p_source_quote_id uuid default null,
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_limits public.user_approval_limits%rowtype;
  v_subtotal numeric(14,2);
  v_discount_amount numeric(14,2) := 0;
  v_needs_approval boolean := false;
  v_amount_limit numeric(14,2);
  v_payload jsonb;
  v_existing_sale public.sales%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  perform private.require_permission(
    'sales.create'
  );

  select *
  into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if p_payment_method = 'credit' then
    perform private.require_permission(
      'credit_accounts.sell'
    );
  end if;

  -- Permit idempotent retry after an approval was consumed.
  if nullif(trim(p_idempotency_key), '') is not null then
    select *
    into v_existing_sale
    from public.sales
    where organization_id =
        v_profile.organization_id
      and idempotency_key =
        nullif(trim(p_idempotency_key), '')
    limit 1;

    if found then
      return public.complete_sale_v6(
        p_items,
        p_payment_method,
        p_amount_received,
        p_customer_id,
        p_manual_discount_type,
        p_manual_discount_value,
        p_coupon_code,
        p_currency,
        p_notes,
        p_payment_reference,
        p_idempotency_key,
        p_source_quote_id
      );
    end if;
  end if;

  if p_coupon_code is null
     and p_manual_discount_type <> 'none'
     and coalesce(p_manual_discount_value, 0) > 0 then

    perform private.require_permission(
      'sales.discount.apply'
    );

    v_subtotal :=
      private.secure_sale_subtotal_v2(
        v_profile.organization_id,
        v_profile.branch_id,
        p_customer_id,
        p_items,
        p_currency
      );

    if p_manual_discount_type = 'percent' then
      if p_manual_discount_value > 100 then
        raise exception
          'Percentage discount cannot exceed 100';
      end if;

      v_discount_amount := round(
        v_subtotal
        * p_manual_discount_value
        / 100,
        2
      );
    elsif p_manual_discount_type = 'fixed' then
      v_discount_amount := least(
        v_subtotal,
        round(
          p_manual_discount_value,
          2
        )
      );
    end if;

    if not private.has_permission(
      'sales.discount.unlimited',
      v_user_id
    ) then
      v_limits :=
        private.current_approval_limits();

      v_amount_limit := case p_currency
        when 'KHR'
          then v_limits.max_discount_amount_khr
        else v_limits.max_discount_amount_usd
      end;

      if p_manual_discount_type = 'percent'
         and v_limits.max_discount_percent is not null
         and p_manual_discount_value >
           v_limits.max_discount_percent then
        v_needs_approval := true;
      end if;

      if v_amount_limit is not null
         and v_discount_amount >
           v_amount_limit then
        v_needs_approval := true;
      end if;
    end if;

    if v_needs_approval then
      v_payload := jsonb_build_object(
        'items', p_items,
        'payment_method',
          lower(trim(p_payment_method)),
        'amount_received',
          coalesce(p_amount_received, 0),
        'customer_id', p_customer_id,
        'manual_discount_type',
          p_manual_discount_type,
        'manual_discount_value',
          coalesce(p_manual_discount_value, 0),
        'coupon_code',
          nullif(
            upper(trim(p_coupon_code)),
            ''
          ),
        'currency', p_currency,
        'source_quote_id',
          p_source_quote_id
      );

      perform private.consume_approved_request(
        p_approval_request_id,
        'sales.discount.exceed_limit',
        v_payload
      );
    end if;
  end if;

  return public.complete_sale_v6(
    p_items,
    p_payment_method,
    p_amount_received,
    p_customer_id,
    p_manual_discount_type,
    p_manual_discount_value,
    p_coupon_code,
    p_currency,
    p_notes,
    p_payment_reference,
    p_idempotency_key,
    p_source_quote_id
  );
end;
$$;

revoke all on function public.complete_sale_v6(
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
  text,
  uuid
) from authenticated;

revoke all on function public.complete_sale_v7(
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
  text,
  uuid,
  uuid
) from public, anon;

grant execute on function public.complete_sale_v7(
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
  text,
  uuid,
  uuid
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 12. SERVER-ENFORCED REFUND WITH ONE-TIME APPROVAL
-- ----------------------------------------------------------------------------

create or replace function public.process_sale_return_v3(
  p_sale_id uuid,
  p_items jsonb,
  p_refund_method text,
  p_reason text,
  p_refund_reference text default null,
  p_approval_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_limits public.user_approval_limits%rowtype;
  v_sale public.sales%rowtype;
  v_refund_amount numeric(14,2);
  v_limit numeric(14,2);
  v_payload jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  perform private.require_permission(
    'returns.process'
  );

  select *
  into v_sale
  from public.sales
  where id = p_sale_id
    and organization_id =
      (select private.current_organization_id())
    and branch_id =
      (select private.current_branch_id());

  if not found then
    raise exception 'Sale not found';
  end if;

  v_refund_amount :=
    private.estimate_return_total(
      p_sale_id,
      p_items
    );

  if not private.has_permission(
    'returns.refund.unlimited',
    v_user_id
  ) then
    v_limits :=
      private.current_approval_limits();

    v_limit := case v_sale.currency
      when 'KHR'
        then v_limits.max_refund_amount_khr
      else v_limits.max_refund_amount_usd
    end;

    if v_limit is not null
       and v_refund_amount > v_limit then

      v_payload := jsonb_build_object(
        'sale_id', p_sale_id,
        'items', p_items,
        'refund_method',
          lower(trim(p_refund_method)),
        'reason', trim(p_reason),
        'refund_reference',
          nullif(
            trim(p_refund_reference),
            ''
          )
      );

      perform private.consume_approved_request(
        p_approval_request_id,
        'returns.refund.exceed_limit',
        v_payload
      );
    end if;
  end if;

  return public.process_sale_return_v2(
    p_sale_id,
    p_items,
    p_refund_method,
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
) from authenticated;

revoke all on function public.process_sale_return_v3(
  uuid,
  jsonb,
  text,
  text,
  text,
  uuid
) from public, anon;

grant execute on function public.process_sale_return_v3(
  uuid,
  jsonb,
  text,
  text,
  text,
  uuid
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 13. PERMISSION WRAPPERS FOR OTHER HIGH-RISK OPERATIONS
-- ----------------------------------------------------------------------------

create or replace function public.create_pos_product_v2(
  p_name text,
  p_category_id uuid default null,
  p_name_km text default null,
  p_sku text default null,
  p_barcode text default null,
  p_description text default null,
  p_unit_name text default 'pcs',
  p_selling_price numeric default 0,
  p_default_cost numeric default 0,
  p_currency public.currency_code default 'USD',
  p_track_stock boolean default true,
  p_allow_negative_stock boolean default false,
  p_low_stock_threshold numeric default 5,
  p_opening_quantity numeric default 0,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('products.manage');
  return public.create_pos_product(
    p_name,p_category_id,p_name_km,p_sku,p_barcode,
    p_description,p_unit_name,p_selling_price,p_default_cost,
    p_currency,p_track_stock,p_allow_negative_stock,
    p_low_stock_threshold,p_opening_quantity,p_is_active
  );
end;
$$;

create or replace function public.update_pos_product_v2(
  p_product_id uuid,
  p_name text,
  p_category_id uuid default null,
  p_name_km text default null,
  p_sku text default null,
  p_barcode text default null,
  p_description text default null,
  p_unit_name text default 'pcs',
  p_selling_price numeric default 0,
  p_default_cost numeric default 0,
  p_currency public.currency_code default 'USD',
  p_track_stock boolean default true,
  p_allow_negative_stock boolean default false,
  p_low_stock_threshold numeric default 5,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('products.manage');
  return public.update_pos_product(
    p_product_id,p_name,p_category_id,p_name_km,p_sku,
    p_barcode,p_description,p_unit_name,p_selling_price,
    p_default_cost,p_currency,p_track_stock,
    p_allow_negative_stock,p_low_stock_threshold,p_is_active
  );
end;
$$;

create or replace function public.adjust_inventory_v2(
  p_product_id uuid,
  p_mode text,
  p_quantity numeric,
  p_reason public.adjustment_reason,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('inventory.adjust');
  return public.adjust_inventory(
    p_product_id,p_mode,p_quantity,p_reason,p_notes
  );
end;
$$;

create or replace function public.create_stock_transfer_v2(
  p_destination_branch_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('transfers.create');
  return public.create_stock_transfer(
    p_destination_branch_id,p_items,p_notes
  );
end;
$$;

create or replace function public.receive_stock_transfer_v2(
  p_transfer_id uuid,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('transfers.receive');
  return public.receive_stock_transfer(
    p_transfer_id,p_notes
  );
end;
$$;

create or replace function public.cancel_stock_transfer_v2(
  p_transfer_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('transfers.cancel');
  return public.cancel_stock_transfer(
    p_transfer_id,p_reason
  );
end;
$$;

create or replace function public.save_purchase_order_v3(
  p_purchase_id uuid,
  p_supplier_id uuid,
  p_items jsonb,
  p_currency public.currency_code default 'USD',
  p_discount_amount numeric default 0,
  p_tax_amount numeric default 0,
  p_expected_date date default null,
  p_supplier_invoice_number text default null,
  p_payment_terms text default null,
  p_delivery_address text default null,
  p_notes text default null,
  p_status public.purchase_status default 'draft'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('purchases.manage');
  return public.save_purchase_order_v2(
    p_purchase_id,p_supplier_id,p_items,p_currency,
    p_discount_amount,p_tax_amount,p_expected_date,
    p_supplier_invoice_number,p_payment_terms,
    p_delivery_address,p_notes,p_status
  );
end;
$$;

create or replace function public.receive_purchase_order_v4(
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
begin
  perform private.require_permission('purchases.receive');
  return public.receive_purchase_order_v3(
    p_purchase_id,p_items,p_amount_paid,p_payment_method,
    p_payment_reference,p_supplier_invoice_number,
    p_received_at,p_notes
  );
end;
$$;

create or replace function public.cancel_purchase_order_v2(
  p_purchase_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('purchases.cancel');
  return public.cancel_purchase_order(
    p_purchase_id,p_reason
  );
end;
$$;

create or replace function public.process_supplier_return_v4(
  p_purchase_id uuid,
  p_items jsonb,
  p_reason text,
  p_supplier_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission(
    'purchases.supplier_return'
  );
  return public.process_supplier_return_v3(
    p_purchase_id,p_items,p_reason,p_supplier_reference
  );
end;
$$;

create or replace function public.start_stock_count_v2(
  p_name text,
  p_scope public.stock_count_scope default 'all',
  p_category_id uuid default null,
  p_product_ids uuid[] default null,
  p_blind_count boolean default false,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('stock_counts.manage');
  return public.start_stock_count(
    p_name,p_scope,p_category_id,p_product_ids,
    p_blind_count,p_notes
  );
end;
$$;

create or replace function public.save_stock_count_item_v2(
  p_session_id uuid,
  p_product_id uuid,
  p_counted_quantity numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('stock_counts.manage');
  return public.save_stock_count_item(
    p_session_id,p_product_id,p_counted_quantity,p_note
  );
end;
$$;

create or replace function public.scan_stock_count_item_v2(
  p_session_id uuid,
  p_product_id uuid,
  p_product_unit_id uuid default null,
  p_unit_quantity numeric default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('stock_counts.manage');
  return public.scan_stock_count_item(
    p_session_id,p_product_id,p_product_unit_id,p_unit_quantity
  );
end;
$$;

create or replace function public.complete_stock_count_v2(
  p_session_id uuid,
  p_completion_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('stock_counts.manage');
  return public.complete_stock_count(
    p_session_id,p_completion_note
  );
end;
$$;

create or replace function public.cancel_stock_count_v2(
  p_session_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('stock_counts.manage');
  return public.cancel_stock_count(
    p_session_id,p_reason
  );
end;
$$;

create or replace function public.record_supplier_payment_batch_v2(
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
begin
  perform private.require_permission('supplier_payables.pay');
  return public.record_supplier_payment_batch(
    p_supplier_id,p_currency,p_amount,p_method,
    p_reference_number,p_notes
  );
end;
$$;

create or replace function public.save_cash_entry_v2(
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
begin
  perform private.require_permission('cash_expenses.manage');
  return public.save_cash_entry(
    p_entry_id,p_direction,p_category_id,p_method,
    p_currency,p_amount,p_entry_at,p_reference_number,p_remark
  );
end;
$$;

create or replace function public.void_cash_entry_v2(
  p_entry_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('cash_expenses.void');
  return public.void_cash_entry(
    p_entry_id,p_reason
  );
end;
$$;

create or replace function public.open_cash_register_v2(
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
begin
  perform private.require_permission('cash_register.use');
  return public.open_cash_register(
    p_opening_cash_usd,p_opening_cash_khr,
    p_register_name,p_opening_note
  );
end;
$$;

create or replace function public.close_cash_register_v2(
  p_counted_cash_usd numeric,
  p_counted_cash_khr numeric,
  p_closing_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('cash_register.close');
  return public.close_cash_register(
    p_counted_cash_usd,p_counted_cash_khr,p_closing_note
  );
end;
$$;

create or replace function public.save_customer_credit_account_v2(
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
begin
  perform private.require_permission('credit_accounts.manage');
  return public.save_customer_credit_account(
    p_customer_id,p_currency,p_credit_limit,
    p_payment_terms_days,p_is_on_hold,p_notes
  );
end;
$$;

create or replace function public.record_customer_credit_payment_v2(
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
begin
  perform private.require_permission('credit_accounts.collect');
  return public.record_customer_credit_payment(
    p_account_id,p_amount,p_method,p_reference_number,p_notes
  );
end;
$$;

create or replace function public.save_price_list_v2(
  p_price_list_id uuid,
  p_code text,
  p_name text,
  p_currency public.currency_code,
  p_customer_type text default 'all',
  p_branch_id uuid default null,
  p_priority integer default 0,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_is_active boolean default true,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('price_lists.manage');
  return public.save_price_list(
    p_price_list_id,p_code,p_name,p_currency,p_customer_type,
    p_branch_id,p_priority,p_starts_at,p_ends_at,p_is_active,p_notes
  );
end;
$$;

create or replace function public.save_price_list_items_v2(
  p_price_list_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('price_lists.manage');
  return public.save_price_list_items(
    p_price_list_id,p_items
  );
end;
$$;

create or replace function public.assign_customer_price_list_v2(
  p_customer_id uuid,
  p_price_list_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('price_lists.manage');
  return public.assign_customer_price_list(
    p_customer_id,p_price_list_id
  );
end;
$$;

create or replace function public.save_sales_quote_v3(
  p_quote_id uuid,
  p_items jsonb,
  p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',
  p_manual_discount_value numeric default 0,
  p_coupon_code text default null,
  p_currency public.currency_code default 'USD',
  p_valid_until date default null,
  p_notes text default null,
  p_terms text default null,
  p_status public.sales_quote_status default 'draft'
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('quotations.manage');

  if p_coupon_code is null
     and p_manual_discount_type <> 'none'
     and coalesce(p_manual_discount_value,0) > 0 then
    perform private.require_permission('sales.discount.apply');
  end if;

  return public.save_sales_quote_v2(
    p_quote_id,p_items,p_customer_id,p_manual_discount_type,
    p_manual_discount_value,p_coupon_code,p_currency,
    p_valid_until,p_notes,p_terms,p_status
  );
end;
$$;

create or replace function public.update_sales_quote_status_v2(
  p_quote_id uuid,
  p_status public.sales_quote_status,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
begin
  perform private.require_permission('quotations.manage');
  return public.update_sales_quote_status(
    p_quote_id,p_status,p_reason
  );
end;
$$;

-- Revoke direct access to protected originals.
revoke execute on function public.create_pos_product(
  text,uuid,text,text,text,text,text,numeric,numeric,
  public.currency_code,boolean,boolean,numeric,numeric,boolean
) from authenticated;

revoke execute on function public.update_pos_product(
  uuid,text,uuid,text,text,text,text,text,numeric,numeric,
  public.currency_code,boolean,boolean,numeric,boolean
) from authenticated;

revoke execute on function public.adjust_inventory(
  uuid,text,numeric,public.adjustment_reason,text
) from authenticated;

revoke execute on function public.create_stock_transfer(
  uuid,jsonb,text
) from authenticated;

revoke execute on function public.receive_stock_transfer(
  uuid,text
) from authenticated;

revoke execute on function public.cancel_stock_transfer(
  uuid,text
) from authenticated;

revoke execute on function public.save_purchase_order_v2(
  uuid,uuid,jsonb,public.currency_code,numeric,numeric,
  date,text,text,text,text,public.purchase_status
) from authenticated;

revoke execute on function public.receive_purchase_order_v3(
  uuid,jsonb,numeric,public.payment_method,text,text,timestamptz,text
) from authenticated;

revoke execute on function public.cancel_purchase_order(
  uuid,text
) from authenticated;

revoke execute on function public.process_supplier_return_v3(
  uuid,jsonb,text,text
) from authenticated;

revoke execute on function public.start_stock_count(
  text,public.stock_count_scope,uuid,uuid[],boolean,text
) from authenticated;

revoke execute on function public.save_stock_count_item(
  uuid,uuid,numeric,text
) from authenticated;

revoke execute on function public.scan_stock_count_item(
  uuid,uuid,uuid,numeric
) from authenticated;

revoke execute on function public.complete_stock_count(
  uuid,text
) from authenticated;

revoke execute on function public.cancel_stock_count(
  uuid,text
) from authenticated;

revoke execute on function public.record_supplier_payment_batch(
  uuid,public.currency_code,numeric,public.payment_method,text,text
) from authenticated;

revoke execute on function public.save_cash_entry(
  uuid,public.cash_entry_direction,uuid,public.payment_method,
  public.currency_code,numeric,timestamptz,text,text
) from authenticated;

revoke execute on function public.void_cash_entry(
  uuid,text
) from authenticated;

revoke execute on function public.open_cash_register(
  numeric,numeric,text,text
) from authenticated;

revoke execute on function public.close_cash_register(
  numeric,numeric,text
) from authenticated;

revoke execute on function public.save_customer_credit_account(
  uuid,public.currency_code,numeric,integer,boolean,text
) from authenticated;

revoke execute on function public.record_customer_credit_payment(
  uuid,numeric,public.payment_method,text,text
) from authenticated;

revoke execute on function public.save_price_list(
  uuid,text,text,public.currency_code,text,uuid,integer,
  timestamptz,timestamptz,boolean,text
) from authenticated;

revoke execute on function public.save_price_list_items(
  uuid,jsonb
) from authenticated;

revoke execute on function public.assign_customer_price_list(
  uuid,uuid
) from authenticated;

revoke execute on function public.save_sales_quote_v2(
  uuid,jsonb,uuid,public.discount_type,numeric,text,
  public.currency_code,date,text,text,public.sales_quote_status
) from authenticated;

revoke execute on function public.update_sales_quote_status(
  uuid,public.sales_quote_status,text
) from authenticated;

-- Grant wrappers.
grant execute on function public.create_pos_product_v2(
  text,uuid,text,text,text,text,text,numeric,numeric,
  public.currency_code,boolean,boolean,numeric,numeric,boolean
) to authenticated, service_role;

grant execute on function public.update_pos_product_v2(
  uuid,text,uuid,text,text,text,text,text,numeric,numeric,
  public.currency_code,boolean,boolean,numeric,boolean
) to authenticated, service_role;

grant execute on function public.adjust_inventory_v2(
  uuid,text,numeric,public.adjustment_reason,text
) to authenticated, service_role;

grant execute on function public.create_stock_transfer_v2(
  uuid,jsonb,text
) to authenticated, service_role;

grant execute on function public.receive_stock_transfer_v2(
  uuid,text
) to authenticated, service_role;

grant execute on function public.cancel_stock_transfer_v2(
  uuid,text
) to authenticated, service_role;

grant execute on function public.save_purchase_order_v3(
  uuid,uuid,jsonb,public.currency_code,numeric,numeric,
  date,text,text,text,text,public.purchase_status
) to authenticated, service_role;

grant execute on function public.receive_purchase_order_v4(
  uuid,jsonb,numeric,public.payment_method,text,text,timestamptz,text
) to authenticated, service_role;

grant execute on function public.cancel_purchase_order_v2(
  uuid,text
) to authenticated, service_role;

grant execute on function public.process_supplier_return_v4(
  uuid,jsonb,text,text
) to authenticated, service_role;

grant execute on function public.start_stock_count_v2(
  text,public.stock_count_scope,uuid,uuid[],boolean,text
) to authenticated, service_role;

grant execute on function public.save_stock_count_item_v2(
  uuid,uuid,numeric,text
) to authenticated, service_role;

grant execute on function public.scan_stock_count_item_v2(
  uuid,uuid,uuid,numeric
) to authenticated, service_role;

grant execute on function public.complete_stock_count_v2(
  uuid,text
) to authenticated, service_role;

grant execute on function public.cancel_stock_count_v2(
  uuid,text
) to authenticated, service_role;

grant execute on function public.record_supplier_payment_batch_v2(
  uuid,public.currency_code,numeric,public.payment_method,text,text
) to authenticated, service_role;

grant execute on function public.save_cash_entry_v2(
  uuid,public.cash_entry_direction,uuid,public.payment_method,
  public.currency_code,numeric,timestamptz,text,text
) to authenticated, service_role;

grant execute on function public.void_cash_entry_v2(
  uuid,text
) to authenticated, service_role;

grant execute on function public.open_cash_register_v2(
  numeric,numeric,text,text
) to authenticated, service_role;

grant execute on function public.close_cash_register_v2(
  numeric,numeric,text
) to authenticated, service_role;

grant execute on function public.save_customer_credit_account_v2(
  uuid,public.currency_code,numeric,integer,boolean,text
) to authenticated, service_role;

grant execute on function public.record_customer_credit_payment_v2(
  uuid,numeric,public.payment_method,text,text
) to authenticated, service_role;

grant execute on function public.save_price_list_v2(
  uuid,text,text,public.currency_code,text,uuid,integer,
  timestamptz,timestamptz,boolean,text
) to authenticated, service_role;

grant execute on function public.save_price_list_items_v2(
  uuid,jsonb
) to authenticated, service_role;

grant execute on function public.assign_customer_price_list_v2(
  uuid,uuid
) to authenticated, service_role;

grant execute on function public.save_sales_quote_v3(
  uuid,jsonb,uuid,public.discount_type,numeric,text,
  public.currency_code,date,text,text,public.sales_quote_status
) to authenticated, service_role;

grant execute on function public.update_sales_quote_status_v2(
  uuid,public.sales_quote_status,text
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 32
-- ============================================================================
