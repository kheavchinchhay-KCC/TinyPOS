-- ============================================================================
-- Tiny POS - Step 22: Stock Count and Cycle Counting
-- Run once in the NEW Supabase project after Step 21.
--
-- Safe workflow:
--   1. Start a count and snapshot system stock.
--   2. Count products manually or scan a product/package barcode.
--   3. Review discrepancies.
--   4. Complete the count to create one controlled inventory adjustment.
--
-- Inventory completion is blocked when system stock changed after the count
-- started. This prevents sales, purchases, transfers, or refunds from being
-- overwritten by a stale physical count.
--
-- This migration does not delete existing business data.
-- ============================================================================

begin;

do $$
begin
  if not exists (
    select 1
    from pg_type
    where typname = 'stock_count_status'
  ) then
    create type public.stock_count_status
      as enum ('counting', 'completed', 'cancelled');
  end if;

  if not exists (
    select 1
    from pg_type
    where typname = 'stock_count_scope'
  ) then
    create type public.stock_count_scope
      as enum ('all', 'category', 'selected');
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 1. STOCK COUNT SESSIONS
-- ----------------------------------------------------------------------------

create table if not exists public.stock_count_sessions (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid not null
    references public.branches(id) on delete restrict,

  count_number text not null,
  name text not null
    check (length(trim(name)) between 1 and 120),

  status public.stock_count_status
    not null default 'counting',

  scope public.stock_count_scope
    not null default 'all',

  category_id uuid
    references public.categories(id) on delete set null,

  blind_count boolean not null default false,
  notes text,

  expected_items integer not null default 0
    check (expected_items >= 0),

  counted_items integer not null default 0
    check (counted_items >= 0),

  discrepancy_items integer not null default 0
    check (discrepancy_items >= 0),

  shortage_items integer not null default 0
    check (shortage_items >= 0),

  overage_items integer not null default 0
    check (overage_items >= 0),

  value_variance_usd numeric(14,2)
    not null default 0,

  value_variance_khr numeric(14,2)
    not null default 0,

  adjustment_id uuid
    references public.inventory_adjustments(id)
    on delete set null,

  started_by uuid not null
    references auth.users(id) on delete restrict,

  started_at timestamptz not null default now(),

  completed_by uuid
    references auth.users(id) on delete set null,

  completed_at timestamptz,

  cancelled_by uuid
    references auth.users(id) on delete set null,

  cancelled_at timestamptz,

  cancellation_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, count_number),

  check (
    (status = 'counting'
      and completed_at is null
      and cancelled_at is null)
    or
    (status = 'completed'
      and completed_at is not null
      and cancelled_at is null)
    or
    (status = 'cancelled'
      and cancelled_at is not null
      and completed_at is null)
  )
);

create unique index if not exists
  stock_count_one_active_per_branch_uq
on public.stock_count_sessions (branch_id)
where status = 'counting';

create index if not exists stock_count_sessions_branch_date_idx
  on public.stock_count_sessions (
    organization_id,
    branch_id,
    started_at desc
  );

drop trigger if exists set_stock_count_sessions_updated_at
  on public.stock_count_sessions;

create trigger set_stock_count_sessions_updated_at
before update on public.stock_count_sessions
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 2. STOCK COUNT ITEMS
-- All quantities use the product's base inventory unit.
-- ----------------------------------------------------------------------------

create table if not exists public.stock_count_items (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  session_id uuid not null
    references public.stock_count_sessions(id)
    on delete cascade,

  product_id uuid not null
    references public.products(id) on delete restrict,

  expected_quantity numeric(14,3) not null default 0,

  counted_quantity numeric(14,3)
    check (
      counted_quantity is null
      or counted_quantity >= 0
    ),

  unit_cost_snapshot numeric(14,4)
    not null default 0
    check (unit_cost_snapshot >= 0),

  note text,

  counted_by uuid
    references auth.users(id) on delete set null,

  counted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (session_id, product_id)
);

create index if not exists stock_count_items_session_product_idx
  on public.stock_count_items (
    session_id,
    product_id
  );

drop trigger if exists set_stock_count_items_updated_at
  on public.stock_count_items;

create trigger set_stock_count_items_updated_at
before update on public.stock_count_items
for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------

alter table public.stock_count_sessions
  enable row level security;

alter table public.stock_count_items
  enable row level security;

drop policy if exists stock_count_sessions_select_management
  on public.stock_count_sessions;

create policy stock_count_sessions_select_management
on public.stock_count_sessions
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and branch_id =
    (select private.current_branch_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

drop policy if exists stock_count_items_select_management
  on public.stock_count_items;

create policy stock_count_items_select_management
on public.stock_count_items
for select to authenticated
using (
  organization_id =
    (select private.current_organization_id())
  and exists (
    select 1
    from public.stock_count_sessions session_row
    where session_row.id = session_id
      and session_row.organization_id =
        (select private.current_organization_id())
      and session_row.branch_id =
        (select private.current_branch_id())
  )
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

revoke all on public.stock_count_sessions from anon;
revoke all on public.stock_count_items from anon;

grant select on public.stock_count_sessions
  to authenticated;

grant select on public.stock_count_items
  to authenticated;

grant all on public.stock_count_sessions
  to service_role;

grant all on public.stock_count_items
  to service_role;

-- ----------------------------------------------------------------------------
-- 4. INTERNAL HELPERS
-- ----------------------------------------------------------------------------

create or replace function private.refresh_stock_count_progress(
  p_session_id uuid
)
returns public.stock_count_sessions
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_session public.stock_count_sessions%rowtype;
begin
  update public.stock_count_sessions session_row
  set
    counted_items = progress.counted_items,
    discrepancy_items = progress.discrepancy_items,
    shortage_items = progress.shortage_items,
    overage_items = progress.overage_items,
    value_variance_usd = progress.value_variance_usd,
    value_variance_khr = progress.value_variance_khr,
    updated_at = now()
  from (
    select
      count(*) filter (
        where item.counted_quantity is not null
      )::integer as counted_items,

      count(*) filter (
        where item.counted_quantity is not null
          and item.counted_quantity
            <> item.expected_quantity
      )::integer as discrepancy_items,

      count(*) filter (
        where item.counted_quantity is not null
          and item.counted_quantity
            < item.expected_quantity
      )::integer as shortage_items,

      count(*) filter (
        where item.counted_quantity is not null
          and item.counted_quantity
            > item.expected_quantity
      )::integer as overage_items,

      round(coalesce(sum(
        case
          when product.currency = 'USD'
            and item.counted_quantity is not null
          then
            (
              item.counted_quantity
              - item.expected_quantity
            )
            * item.unit_cost_snapshot
          else 0
        end
      ), 0), 2) as value_variance_usd,

      round(coalesce(sum(
        case
          when product.currency = 'KHR'
            and item.counted_quantity is not null
          then
            (
              item.counted_quantity
              - item.expected_quantity
            )
            * item.unit_cost_snapshot
          else 0
        end
      ), 0), 2) as value_variance_khr

    from public.stock_count_items item
    join public.products product
      on product.id = item.product_id

    where item.session_id = p_session_id
  ) progress

  where session_row.id = p_session_id
  returning session_row.*
  into v_session;

  if not found then
    raise exception 'Stock count session not found';
  end if;

  return v_session;
end;
$$;

revoke all on function private.refresh_stock_count_progress(uuid)
  from public;

grant execute on function private.refresh_stock_count_progress(uuid)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. START A STOCK COUNT
-- ----------------------------------------------------------------------------

create or replace function public.start_stock_count(
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
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session_id uuid;
  v_count_number text;
  v_item_count integer := 0;
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
    'manager'
  ) then
    raise exception 'Your role cannot start stock counts';
  end if;

  if p_name is null
     or length(trim(p_name)) = 0 then
    raise exception 'Stock count name is required';
  end if;

  if p_scope = 'category'
     and p_category_id is null then
    raise exception 'Choose a category';
  end if;

  if p_scope = 'selected'
     and coalesce(cardinality(p_product_ids), 0) = 0 then
    raise exception 'Choose at least one product';
  end if;

  perform pg_advisory_xact_lock(
    hashtext(
      'tiny-pos-stock-count:'
      || v_profile.branch_id::text
    )
  );

  if exists (
    select 1
    from public.stock_count_sessions
    where branch_id = v_profile.branch_id
      and status = 'counting'
  ) then
    raise exception
      'This branch already has an active stock count';
  end if;

  if p_scope = 'category'
     and not exists (
       select 1
       from public.categories category_row
       where category_row.id = p_category_id
         and category_row.organization_id =
           v_profile.organization_id
         and category_row.is_active = true
     ) then
    raise exception 'Category not found or inactive';
  end if;

  -- Ensure a stock balance row exists before taking the snapshot.
  insert into public.inventory_balances (
    organization_id,
    branch_id,
    product_id,
    quantity,
    average_cost
  )
  select
    v_profile.organization_id,
    v_profile.branch_id,
    product.id,
    0,
    product.default_cost
  from public.products product
  where product.organization_id =
      v_profile.organization_id
    and product.is_active = true
    and product.track_stock = true
    and (
      p_scope = 'all'
      or (
        p_scope = 'category'
        and product.category_id = p_category_id
      )
      or (
        p_scope = 'selected'
        and product.id = any(
          coalesce(
            p_product_ids,
            '{}'::uuid[]
          )
        )
      )
    )
  on conflict (branch_id, product_id)
  do nothing;

  v_count_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'CNT'
  );

  insert into public.stock_count_sessions (
    organization_id,
    branch_id,
    count_number,
    name,
    status,
    scope,
    category_id,
    blind_count,
    notes,
    started_by,
    started_at
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_count_number,
    trim(p_name),
    'counting',
    p_scope,
    case
      when p_scope = 'category'
        then p_category_id
      else null
    end,
    coalesce(p_blind_count, false),
    nullif(trim(p_notes), ''),
    v_user_id,
    now()
  )
  returning id into v_session_id;

  insert into public.stock_count_items (
    organization_id,
    session_id,
    product_id,
    expected_quantity,
    counted_quantity,
    unit_cost_snapshot
  )
  select
    v_profile.organization_id,
    v_session_id,
    product.id,
    balance.quantity,
    null,
    coalesce(
      nullif(balance.average_cost, 0),
      product.default_cost,
      0
    )
  from public.products product
  join public.inventory_balances balance
    on balance.product_id = product.id
    and balance.branch_id = v_profile.branch_id
  where product.organization_id =
      v_profile.organization_id
    and product.is_active = true
    and product.track_stock = true
    and (
      p_scope = 'all'
      or (
        p_scope = 'category'
        and product.category_id = p_category_id
      )
      or (
        p_scope = 'selected'
        and product.id = any(
          coalesce(
            p_product_ids,
            '{}'::uuid[]
          )
        )
      )
    )
  order by product.name;

  get diagnostics v_item_count = row_count;

  if v_item_count = 0 then
    raise exception
      'No active stock-tracked products match this count scope';
  end if;

  update public.stock_count_sessions
  set
    expected_items = v_item_count,
    updated_at = now()
  where id = v_session_id;

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
    'start_stock_count',
    'stock_count_session',
    v_session_id,
    jsonb_build_object(
      'count_number', v_count_number,
      'name', trim(p_name),
      'scope', p_scope,
      'item_count', v_item_count,
      'blind_count',
        coalesce(p_blind_count, false)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session_id,
    'count_number', v_count_number,
    'name', trim(p_name),
    'scope', p_scope,
    'expected_items', v_item_count,
    'blind_count',
      coalesce(p_blind_count, false)
  );
end;
$$;

revoke all on function public.start_stock_count(
  text,
  public.stock_count_scope,
  uuid,
  uuid[],
  boolean,
  text
) from public, anon;

grant execute on function public.start_stock_count(
  text,
  public.stock_count_scope,
  uuid,
  uuid[],
  boolean,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. SAVE OR CLEAR ONE MANUAL COUNT
-- ----------------------------------------------------------------------------

create or replace function public.save_stock_count_item(
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
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session public.stock_count_sessions%rowtype;
  v_item public.stock_count_items%rowtype;
  v_progress public.stock_count_sessions%rowtype;
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
    'manager'
  ) then
    raise exception 'Your role cannot enter stock counts';
  end if;

  select *
  into v_session
  from public.stock_count_sessions
  where id = p_session_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Stock count session not found';
  end if;

  if v_session.status <> 'counting' then
    raise exception 'This stock count is no longer active';
  end if;

  if p_counted_quantity is not null
     and p_counted_quantity < 0 then
    raise exception 'Counted quantity cannot be negative';
  end if;

  update public.stock_count_items
  set
    counted_quantity =
      case
        when p_counted_quantity is null
          then null
        else round(p_counted_quantity, 3)
      end,

    note = nullif(trim(p_note), ''),

    counted_by =
      case
        when p_counted_quantity is null
          then null
        else v_user_id
      end,

    counted_at =
      case
        when p_counted_quantity is null
          then null
        else now()
      end,

    updated_at = now()

  where session_id = v_session.id
    and product_id = p_product_id

  returning *
  into v_item;

  if not found then
    raise exception
      'Product is not included in this stock count';
  end if;

  v_progress :=
    private.refresh_stock_count_progress(
      v_session.id
    );

  return jsonb_build_object(
    'ok', true,
    'item', to_jsonb(v_item),
    'progress', to_jsonb(v_progress)
  );
end;
$$;

revoke all on function public.save_stock_count_item(
  uuid,
  uuid,
  numeric,
  text
) from public, anon;

grant execute on function public.save_stock_count_item(
  uuid,
  uuid,
  numeric,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. SCAN A PRODUCT OR PACKAGE
-- Each scan adds the selected unit's base conversion factor.
-- ----------------------------------------------------------------------------

create or replace function public.scan_stock_count_item(
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
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session public.stock_count_sessions%rowtype;
  v_item public.stock_count_items%rowtype;
  v_unit public.product_units%rowtype;
  v_increment numeric(14,3);
  v_progress public.stock_count_sessions%rowtype;
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
    'manager'
  ) then
    raise exception 'Your role cannot enter stock counts';
  end if;

  if p_unit_quantity is null
     or p_unit_quantity <= 0 then
    raise exception 'Scan quantity must be greater than zero';
  end if;

  select *
  into v_session
  from public.stock_count_sessions
  where id = p_session_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Stock count session not found';
  end if;

  if v_session.status <> 'counting' then
    raise exception 'This stock count is no longer active';
  end if;

  if not exists (
    select 1
    from public.stock_count_items item
    where item.session_id = v_session.id
      and item.product_id = p_product_id
  ) then
    raise exception
      'Product is not included in this stock count';
  end if;

  if p_product_unit_id is null then
    select *
    into v_unit
    from public.product_units
    where organization_id =
        v_profile.organization_id
      and product_id = p_product_id
      and is_base = true
      and is_active = true
    limit 1;
  else
    select *
    into v_unit
    from public.product_units
    where id = p_product_unit_id
      and organization_id =
        v_profile.organization_id
      and product_id = p_product_id
      and is_active = true;
  end if;

  if not found then
    raise exception
      'The scanned product unit is unavailable';
  end if;

  v_increment := round(
    p_unit_quantity
      * v_unit.conversion_factor,
    3
  );

  update public.stock_count_items
  set
    counted_quantity =
      coalesce(counted_quantity, 0)
      + v_increment,

    counted_by = v_user_id,
    counted_at = now(),
    updated_at = now()

  where session_id = v_session.id
    and product_id = p_product_id

  returning *
  into v_item;

  v_progress :=
    private.refresh_stock_count_progress(
      v_session.id
    );

  return jsonb_build_object(
    'ok', true,
    'item', to_jsonb(v_item),
    'unit', jsonb_build_object(
      'id', v_unit.id,
      'name', v_unit.name,
      'conversion_factor',
        v_unit.conversion_factor
    ),
    'base_increment', v_increment,
    'progress', to_jsonb(v_progress)
  );
end;
$$;

revoke all on function public.scan_stock_count_item(
  uuid,
  uuid,
  uuid,
  numeric
) from public, anon;

grant execute on function public.scan_stock_count_item(
  uuid,
  uuid,
  uuid,
  numeric
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 8. COMPLETE AND APPLY THE STOCK COUNT
-- ----------------------------------------------------------------------------

create or replace function public.complete_stock_count(
  p_session_id uuid,
  p_completion_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_session public.stock_count_sessions%rowtype;
  v_progress public.stock_count_sessions%rowtype;
  v_conflict record;
  v_item record;

  v_adjustment_id uuid;
  v_adjustment_number text;

  v_quantity_change numeric(14,3);
  v_completed_at timestamptz := now();
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
    'manager'
  ) then
    raise exception 'Your role cannot complete stock counts';
  end if;

  select *
  into v_session
  from public.stock_count_sessions
  where id = p_session_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Stock count session not found';
  end if;

  if v_session.status <> 'counting' then
    raise exception 'This stock count is no longer active';
  end if;

  v_progress :=
    private.refresh_stock_count_progress(
      v_session.id
    );

  if v_progress.counted_items
     <> v_progress.expected_items then
    raise exception
      'Count every product before completion. % of % products are counted',
      v_progress.counted_items,
      v_progress.expected_items;
  end if;

  -- Lock every affected inventory balance in a stable order.
  perform balance.id
  from public.inventory_balances balance
  join public.stock_count_items item
    on item.product_id = balance.product_id
  where item.session_id = v_session.id
    and balance.branch_id = v_profile.branch_id
  order by balance.product_id
  for update of balance;

  -- Reject stale counts when stock changed after the snapshot.
  select
    product.name as product_name,
    item.expected_quantity,
    balance.quantity as current_quantity
  into v_conflict
  from public.stock_count_items item
  join public.products product
    on product.id = item.product_id
  join public.inventory_balances balance
    on balance.product_id = item.product_id
    and balance.branch_id = v_profile.branch_id
  where item.session_id = v_session.id
    and balance.quantity
      <> item.expected_quantity
  order by product.name
  limit 1;

  if found then
    raise exception
      'Stock changed for "%" after this count started. Snapshot: %, current system stock: %. Cancel and restart the count after sales and stock movements are paused',
      v_conflict.product_name,
      v_conflict.expected_quantity,
      v_conflict.current_quantity;
  end if;

  if v_progress.discrepancy_items > 0 then
    v_adjustment_number :=
      private.next_document_number(
        v_profile.organization_id,
        v_profile.branch_id,
        'ADJ'
      );

    insert into public.inventory_adjustments (
      organization_id,
      branch_id,
      adjustment_number,
      reason,
      notes,
      created_by
    )
    values (
      v_profile.organization_id,
      v_profile.branch_id,
      v_adjustment_number,
      'count_correction',
      concat(
        'Stock count ',
        v_session.count_number,
        ' · ',
        v_session.name,
        case
          when nullif(
            trim(p_completion_note),
            ''
          ) is not null
          then ' · ' || trim(p_completion_note)
          else ''
        end
      ),
      v_user_id
    )
    returning id into v_adjustment_id;

    for v_item in
      select
        item.*,
        product.name as product_name,
        product.currency,
        balance.quantity as current_quantity,
        balance.average_cost
      from public.stock_count_items item
      join public.products product
        on product.id = item.product_id
      join public.inventory_balances balance
        on balance.product_id = item.product_id
        and balance.branch_id = v_profile.branch_id
      where item.session_id = v_session.id
        and item.counted_quantity
          <> item.expected_quantity
      order by item.product_id
    loop
      v_quantity_change := round(
        v_item.counted_quantity
          - v_item.current_quantity,
        3
      );

      insert into public.inventory_adjustment_items (
        organization_id,
        adjustment_id,
        product_id,
        quantity_before,
        quantity_change,
        quantity_after,
        unit_cost
      )
      values (
        v_profile.organization_id,
        v_adjustment_id,
        v_item.product_id,
        v_item.current_quantity,
        v_quantity_change,
        v_item.counted_quantity,
        v_item.unit_cost_snapshot
      );

      update public.inventory_balances
      set
        quantity = v_item.counted_quantity,
        updated_at = v_completed_at
      where branch_id = v_profile.branch_id
        and product_id = v_item.product_id;

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
        created_by
      )
      values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_item.product_id,
        'adjustment',
        v_quantity_change,
        v_item.current_quantity,
        v_item.counted_quantity,
        v_item.unit_cost_snapshot,
        'stock_count_sessions',
        v_session.id,
        concat(
          v_session.count_number,
          ' · Physical stock count correction'
        ),
        v_user_id
      );
    end loop;
  end if;

  update public.stock_count_sessions
  set
    status = 'completed',
    adjustment_id = v_adjustment_id,
    notes = case
      when nullif(
        trim(p_completion_note),
        ''
      ) is null
        then notes
      when notes is null
        then trim(p_completion_note)
      else notes
        || E'\n'
        || trim(p_completion_note)
    end,
    completed_by = v_user_id,
    completed_at = v_completed_at,
    updated_at = v_completed_at
  where id = v_session.id
  returning *
  into v_session;

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
    'complete_stock_count',
    'stock_count_session',
    v_session.id,
    jsonb_build_object(
      'count_number', v_session.count_number,
      'item_count', v_session.expected_items,
      'discrepancy_items',
        v_session.discrepancy_items,
      'shortage_items',
        v_session.shortage_items,
      'overage_items',
        v_session.overage_items,
      'value_variance_usd',
        v_session.value_variance_usd,
      'value_variance_khr',
        v_session.value_variance_khr,
      'adjustment_id', v_adjustment_id,
      'adjustment_number',
        v_adjustment_number
    )
  );

  return to_jsonb(v_session)
    || jsonb_build_object(
      'ok', true,
      'adjustment_number',
        v_adjustment_number
    );
end;
$$;

revoke all on function public.complete_stock_count(
  uuid,
  text
) from public, anon;

grant execute on function public.complete_stock_count(
  uuid,
  text
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9. CANCEL AN ACTIVE COUNT WITHOUT CHANGING INVENTORY
-- ----------------------------------------------------------------------------

create or replace function public.cancel_stock_count(
  p_session_id uuid,
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
  v_session public.stock_count_sessions%rowtype;
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
    'manager'
  ) then
    raise exception 'Your role cannot cancel stock counts';
  end if;

  if p_reason is null
     or length(trim(p_reason)) < 3 then
    raise exception 'A cancellation reason is required';
  end if;

  select *
  into v_session
  from public.stock_count_sessions
  where id = p_session_id
    and organization_id = v_profile.organization_id
    and branch_id = v_profile.branch_id
  for update;

  if not found then
    raise exception 'Stock count session not found';
  end if;

  if v_session.status <> 'counting' then
    raise exception 'Only an active stock count can be cancelled';
  end if;

  update public.stock_count_sessions
  set
    status = 'cancelled',
    cancellation_reason = trim(p_reason),
    cancelled_by = v_user_id,
    cancelled_at = now(),
    updated_at = now()
  where id = v_session.id
  returning *
  into v_session;

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
    'cancel_stock_count',
    'stock_count_session',
    v_session.id,
    jsonb_build_object(
      'count_number',
        v_session.count_number,
      'reason',
        v_session.cancellation_reason,
      'counted_items',
        v_session.counted_items,
      'expected_items',
        v_session.expected_items
    )
  );

  return to_jsonb(v_session)
    || jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.cancel_stock_count(
  uuid,
  text
) from public, anon;

grant execute on function public.cancel_stock_count(
  uuid,
  text
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 22
-- ============================================================================
