-- ============================================================================
-- Tiny POS - Step 44: Demand forecasting, stock planning and purchase suggestions
-- Run once in the NEW Supabase project after Step 43.
--
-- This migration adds a planning ledger. It does not rewrite sales, returns,
-- inventory balances, reservations, purchases or supplier payments.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. GRANULAR PERMISSIONS
-- ----------------------------------------------------------------------------

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
  (
    'demand_planning.view',
    'Inventory',
    'View Demand Planning',
    'View sales forecasts, stock-cover risks and recommended purchase quantities.',
    'normal',
    array['owner','admin','manager']::public.app_role[],
    false,
    116
  ),
  (
    'demand_planning.manage',
    'Inventory',
    'Manage Demand Planning',
    'Change forecast settings and generate new branch forecasts.',
    'sensitive',
    array['owner','admin','manager']::public.app_role[],
    false,
    117
  ),
  (
    'demand_planning.create_purchase_orders',
    'Purchasing',
    'Create Forecast Purchase Orders',
    'Convert selected forecast recommendations into draft supplier purchase orders.',
    'sensitive',
    array['owner','admin','manager']::public.app_role[],
    false,
    118
  )
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
-- 2. PLANNING SETTINGS AND FORECAST SNAPSHOTS
-- ----------------------------------------------------------------------------

create table if not exists public.demand_planning_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  history_days integer not null default 90 check (history_days between 30 and 730),
  forecast_horizon_days integer not null default 30 check (forecast_horizon_days between 7 and 180),
  safety_stock_days integer not null default 7 check (safety_stock_days between 0 and 90),
  recent_window_days integer not null default 30 check (recent_window_days between 7 and 90),
  recent_weight numeric(6,5) not null default 0.55 check (recent_weight between 0 and 1),
  seasonality_weight numeric(6,5) not null default 0.20 check (seasonality_weight between 0 and 1),
  minimum_history_days integer not null default 14 check (minimum_history_days between 1 and 365),
  slow_moving_days integer not null default 60 check (slow_moving_days between 7 and 730),
  overstock_cover_days integer not null default 90 check (overstock_cover_days between 14 and 730),
  auto_run_enabled boolean not null default true,
  auto_run_hour integer not null default 6 check (auto_run_hour between 0 and 23),
  last_auto_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, branch_id)
);

drop trigger if exists set_demand_planning_settings_updated_at
  on public.demand_planning_settings;
create trigger set_demand_planning_settings_updated_at
before update on public.demand_planning_settings
for each row execute function public.set_updated_at();

create table if not exists public.demand_forecast_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  as_of_date date not null,
  history_start_date date not null,
  forecast_end_date date not null,
  history_days integer not null,
  forecast_horizon_days integer not null,
  source text not null default 'manual' check (source in ('manual','scheduled')),
  status text not null default 'completed' check (status in ('running','completed','failed')),
  item_count integer not null default 0,
  out_of_stock_count integer not null default 0,
  critical_count integer not null default 0,
  urgent_count integer not null default 0,
  watch_count integer not null default 0,
  slow_moving_count integer not null default 0,
  overstock_count integer not null default 0,
  suggested_order_value_usd numeric(16,2) not null default 0,
  suggested_order_value_khr numeric(16,2) not null default 0,
  average_accuracy_percent numeric(7,2),
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists demand_forecast_runs_branch_date_idx
  on public.demand_forecast_runs (
    organization_id,
    branch_id,
    as_of_date desc,
    generated_at desc
  );

create table if not exists public.demand_forecast_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  run_id uuid not null references public.demand_forecast_runs(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  product_name text not null,
  product_name_km text,
  sku text,
  barcode text,
  category_id uuid references public.categories(id) on delete set null,
  category_name text,
  currency public.currency_code not null,
  base_unit_name text not null,
  history_base_quantity numeric(16,3) not null default 0,
  recent_base_quantity numeric(16,3) not null default 0,
  previous_base_quantity numeric(16,3) not null default 0,
  last_7_day_base_quantity numeric(16,3) not null default 0,
  sales_days integer not null default 0,
  last_sale_date date,
  history_daily_demand numeric(16,5) not null default 0,
  recent_daily_demand numeric(16,5) not null default 0,
  trend_factor numeric(10,5) not null default 1,
  seasonality_factor numeric(10,5) not null default 1,
  forecast_daily_demand numeric(16,5) not null default 0,
  forecast_horizon_demand numeric(16,3) not null default 0,
  safety_stock_quantity numeric(16,3) not null default 0,
  lead_time_demand numeric(16,3) not null default 0,
  current_stock numeric(16,3) not null default 0,
  reserved_stock numeric(16,3) not null default 0,
  incoming_stock numeric(16,3) not null default 0,
  draft_purchase_stock numeric(16,3) not null default 0,
  available_stock numeric(16,3) not null default 0,
  projected_stock numeric(16,3) not null default 0,
  days_of_cover numeric(16,2),
  expected_stockout_date date,
  recommended_order_date date,
  preferred_supplier_id uuid references public.suppliers(id) on delete set null,
  preferred_supplier_name text,
  supplier_code text,
  purchase_unit_id uuid references public.product_units(id) on delete set null,
  purchase_unit_name text,
  purchase_unit_factor numeric(16,3) not null default 1,
  lead_time_days integer not null default 0,
  minimum_order_quantity numeric(16,3) not null default 1,
  estimated_base_unit_cost numeric(16,4) not null default 0,
  estimated_purchase_unit_cost numeric(16,4) not null default 0,
  suggested_base_quantity numeric(16,3) not null default 0,
  suggested_purchase_quantity numeric(16,3) not null default 0,
  estimated_order_total numeric(16,2) not null default 0,
  risk_status text not null check (
    risk_status in (
      'out_of_stock','critical','urgent','watch','healthy',
      'insufficient_history','slow_moving','overstock'
    )
  ),
  can_create_order boolean not null default false,
  actual_horizon_demand numeric(16,3),
  absolute_error numeric(16,3),
  accuracy_percent numeric(7,2),
  created_at timestamptz not null default now(),
  unique (run_id, product_id)
);

create index if not exists demand_forecast_items_run_risk_idx
  on public.demand_forecast_items (run_id, risk_status, product_name);

create index if not exists demand_forecast_items_product_idx
  on public.demand_forecast_items (
    organization_id,
    branch_id,
    product_id,
    created_at desc
  );

-- Seed one default setting row for every active branch.
insert into public.demand_planning_settings (
  organization_id,
  branch_id,
  created_by,
  updated_by
)
select
  b.organization_id,
  b.id,
  (
    select p.id
    from public.profiles p
    where p.organization_id = b.organization_id
      and p.role = 'owner'
      and p.is_active = true
    order by p.created_at
    limit 1
  ),
  (
    select p.id
    from public.profiles p
    where p.organization_id = b.organization_id
      and p.role = 'owner'
      and p.is_active = true
    order by p.created_at
    limit 1
  )
from public.branches b
where b.is_active = true
on conflict (organization_id, branch_id) do nothing;

-- Telegram preference for branch demand-risk alerts.
alter table public.telegram_notification_preferences
  add column if not exists forecast_alerts boolean not null default true;

-- ----------------------------------------------------------------------------
-- 3. RLS
-- ----------------------------------------------------------------------------

alter table public.demand_planning_settings enable row level security;
alter table public.demand_forecast_runs enable row level security;
alter table public.demand_forecast_items enable row level security;

create or replace function private.demand_branch_allowed(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, auth, pg_temp
as $$
  select coalesce(
    private.has_permission('branches.all', auth.uid())
    or p_branch_id = private.current_branch_id(),
    false
  )
$$;

revoke all on function private.demand_branch_allowed(uuid) from public, anon;
grant execute on function private.demand_branch_allowed(uuid) to authenticated, service_role;

create policy demand_settings_select_allowed
on public.demand_planning_settings
for select to authenticated
using (
  organization_id = private.current_organization_id()
  and private.has_permission('demand_planning.view', auth.uid())
  and private.demand_branch_allowed(branch_id)
);

create policy demand_runs_select_allowed
on public.demand_forecast_runs
for select to authenticated
using (
  organization_id = private.current_organization_id()
  and private.has_permission('demand_planning.view', auth.uid())
  and private.demand_branch_allowed(branch_id)
);

create policy demand_items_select_allowed
on public.demand_forecast_items
for select to authenticated
using (
  organization_id = private.current_organization_id()
  and private.has_permission('demand_planning.view', auth.uid())
  and private.demand_branch_allowed(branch_id)
);

revoke all on public.demand_planning_settings from anon;
revoke all on public.demand_forecast_runs from anon;
revoke all on public.demand_forecast_items from anon;

grant select on public.demand_planning_settings to authenticated;
grant select on public.demand_forecast_runs to authenticated;
grant select on public.demand_forecast_items to authenticated;

grant all on public.demand_planning_settings to service_role;
grant all on public.demand_forecast_runs to service_role;
grant all on public.demand_forecast_items to service_role;

-- ----------------------------------------------------------------------------
-- 4. FORECAST ACCURACY REFRESH
-- ----------------------------------------------------------------------------

create or replace function private.refresh_demand_forecast_accuracy(
  p_organization_id uuid,
  p_branch_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_timezone text := 'Asia/Phnom_Penh';
  v_today date;
begin
  select coalesce(timezone, 'Asia/Phnom_Penh')
  into v_timezone
  from public.app_settings
  where organization_id = p_organization_id;

  v_today := (now() at time zone v_timezone)::date;

  with completed_items as (
    select
      fi.id,
      fi.product_id,
      fr.as_of_date + 1 as actual_start,
      fr.forecast_end_date as actual_end,
      fi.forecast_horizon_demand
    from public.demand_forecast_items fi
    join public.demand_forecast_runs fr on fr.id = fi.run_id
    where fi.organization_id = p_organization_id
      and fi.branch_id = p_branch_id
      and fi.actual_horizon_demand is null
      and fr.status = 'completed'
      and fr.forecast_end_date < v_today
  ),
  sales_actual as (
    select
      ci.id,
      coalesce(sum(si.base_quantity), 0)::numeric as sold
    from completed_items ci
    left join public.sales s
      on s.organization_id = p_organization_id
      and s.branch_id = p_branch_id
      and s.status in ('completed','partially_refunded','refunded')
      and (s.completed_at at time zone v_timezone)::date between ci.actual_start and ci.actual_end
    left join public.sale_items si
      on si.sale_id = s.id
      and si.product_id = ci.product_id
    group by ci.id
  ),
  return_actual as (
    select
      ci.id,
      coalesce(sum(ri.base_quantity), 0)::numeric as returned
    from completed_items ci
    left join public.returns r
      on r.organization_id = p_organization_id
      and r.branch_id = p_branch_id
      and r.status = 'completed'
      and (r.processed_at at time zone v_timezone)::date between ci.actual_start and ci.actual_end
    left join public.return_items ri
      on ri.return_id = r.id
      and ri.product_id = ci.product_id
    group by ci.id
  ),
  actuals as (
    select
      ci.id,
      greatest(coalesce(sa.sold, 0) - coalesce(ra.returned, 0), 0)::numeric(16,3) as actual,
      ci.forecast_horizon_demand
    from completed_items ci
    left join sales_actual sa on sa.id = ci.id
    left join return_actual ra on ra.id = ci.id
  )
  update public.demand_forecast_items fi
  set
    actual_horizon_demand = a.actual,
    absolute_error = abs(a.actual - a.forecast_horizon_demand),
    accuracy_percent = case
      when a.actual = 0 and a.forecast_horizon_demand = 0 then 100
      when greatest(a.actual, a.forecast_horizon_demand) > 0 then
        greatest(
          0,
          round(
            100 - (
              abs(a.actual - a.forecast_horizon_demand)
              / greatest(a.actual, a.forecast_horizon_demand)
              * 100
            ),
            2
          )
        )
      else null
    end
  from actuals a
  where fi.id = a.id;

  update public.demand_forecast_runs fr
  set average_accuracy_percent = accuracy.value
  from (
    select
      fi.run_id,
      round(avg(fi.accuracy_percent), 2) as value
    from public.demand_forecast_items fi
    where fi.organization_id = p_organization_id
      and fi.branch_id = p_branch_id
      and fi.accuracy_percent is not null
    group by fi.run_id
  ) accuracy
  where fr.id = accuracy.run_id;
end;
$$;

revoke all on function private.refresh_demand_forecast_accuracy(uuid, uuid)
  from public, anon;
grant execute on function private.refresh_demand_forecast_accuracy(uuid, uuid)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. CORE FORECAST GENERATOR
-- ----------------------------------------------------------------------------

create or replace function private.generate_demand_forecast(
  p_organization_id uuid,
  p_branch_id uuid,
  p_generated_by uuid,
  p_source text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_settings public.demand_planning_settings%rowtype;
  v_run public.demand_forecast_runs%rowtype;
  v_as_of date;
  v_history_start date;
  v_recent_start date;
  v_previous_start date;
  v_previous_end date;
  v_seven_start date;
  v_recent_days integer;
  v_timezone text := 'Asia/Phnom_Penh';
begin
  select * into v_settings
  from public.demand_planning_settings
  where organization_id = p_organization_id
    and branch_id = p_branch_id
  for update;

  if not found then
    insert into public.demand_planning_settings (
      organization_id, branch_id, created_by, updated_by
    ) values (
      p_organization_id, p_branch_id, p_generated_by, p_generated_by
    )
    returning * into v_settings;
  end if;

  select coalesce(timezone, 'Asia/Phnom_Penh')
  into v_timezone
  from public.app_settings
  where organization_id = p_organization_id;

  v_as_of := (now() at time zone v_timezone)::date;
  v_history_start := v_as_of - (v_settings.history_days - 1);
  v_recent_days := least(v_settings.recent_window_days, v_settings.history_days);
  v_recent_start := v_as_of - (v_recent_days - 1);
  v_previous_end := v_recent_start - 1;
  v_previous_start := v_previous_end - (v_recent_days - 1);
  v_seven_start := v_as_of - 6;

  perform private.refresh_demand_forecast_accuracy(
    p_organization_id,
    p_branch_id
  );

  insert into public.demand_forecast_runs (
    organization_id,
    branch_id,
    as_of_date,
    history_start_date,
    forecast_end_date,
    history_days,
    forecast_horizon_days,
    source,
    status,
    generated_by
  ) values (
    p_organization_id,
    p_branch_id,
    v_as_of,
    v_history_start,
    v_as_of + v_settings.forecast_horizon_days,
    v_settings.history_days,
    v_settings.forecast_horizon_days,
    case when p_source = 'scheduled' then 'scheduled' else 'manual' end,
    'running',
    p_generated_by
  ) returning * into v_run;

  with sales_data as (
    select
      si.product_id,
      coalesce(sum(si.base_quantity) filter (
        where (s.completed_at at time zone v_timezone)::date
          between v_history_start and v_as_of
      ), 0)::numeric as history_sold,
      coalesce(sum(si.base_quantity) filter (
        where (s.completed_at at time zone v_timezone)::date
          between v_recent_start and v_as_of
      ), 0)::numeric as recent_sold,
      coalesce(sum(si.base_quantity) filter (
        where (s.completed_at at time zone v_timezone)::date
          between v_previous_start and v_previous_end
      ), 0)::numeric as previous_sold,
      coalesce(sum(si.base_quantity) filter (
        where (s.completed_at at time zone v_timezone)::date
          between v_seven_start and v_as_of
      ), 0)::numeric as seven_sold,
      count(distinct (s.completed_at at time zone v_timezone)::date) filter (
        where (s.completed_at at time zone v_timezone)::date
          between v_history_start and v_as_of
      )::integer as sales_days,
      max((s.completed_at at time zone v_timezone)::date) as last_sale_date
    from public.sales s
    join public.sale_items si on si.sale_id = s.id
    where s.organization_id = p_organization_id
      and s.branch_id = p_branch_id
      and s.status in ('completed','partially_refunded','refunded')
      and (s.completed_at at time zone v_timezone)::date >= least(v_history_start, v_previous_start)
      and (s.completed_at at time zone v_timezone)::date <= v_as_of
      and si.product_id is not null
    group by si.product_id
  ),
  return_data as (
    select
      ri.product_id,
      coalesce(sum(ri.base_quantity) filter (
        where (r.processed_at at time zone v_timezone)::date
          between v_history_start and v_as_of
      ), 0)::numeric as history_returned,
      coalesce(sum(ri.base_quantity) filter (
        where (r.processed_at at time zone v_timezone)::date
          between v_recent_start and v_as_of
      ), 0)::numeric as recent_returned,
      coalesce(sum(ri.base_quantity) filter (
        where (r.processed_at at time zone v_timezone)::date
          between v_previous_start and v_previous_end
      ), 0)::numeric as previous_returned,
      coalesce(sum(ri.base_quantity) filter (
        where (r.processed_at at time zone v_timezone)::date
          between v_seven_start and v_as_of
      ), 0)::numeric as seven_returned
    from public.returns r
    join public.return_items ri on ri.return_id = r.id
    where r.organization_id = p_organization_id
      and r.branch_id = p_branch_id
      and r.status = 'completed'
      and (r.processed_at at time zone v_timezone)::date >= least(v_history_start, v_previous_start)
      and (r.processed_at at time zone v_timezone)::date <= v_as_of
      and ri.product_id is not null
    group by ri.product_id
  ),
  incoming_data as (
    select
      pi.product_id,
      coalesce(sum(
        greatest(
          coalesce(pi.base_quantity, pi.quantity * coalesce(pi.unit_factor, 1))
          - coalesce(pi.base_received_quantity, 0),
          0
        )
      ) filter (where po.status in ('ordered','partially_received')), 0)::numeric as incoming,
      coalesce(sum(
        greatest(
          coalesce(pi.base_quantity, pi.quantity * coalesce(pi.unit_factor, 1))
          - coalesce(pi.base_received_quantity, 0),
          0
        )
      ) filter (where po.status = 'draft'), 0)::numeric as draft_incoming
    from public.purchase_items pi
    join public.purchases po on po.id = pi.purchase_id
    where po.organization_id = p_organization_id
      and po.branch_id = p_branch_id
      and po.status in ('draft','ordered','partially_received')
    group by pi.product_id
  ),
  reservation_data as (
    select
      product_id,
      coalesce(sum(
        greatest(
          reserved_base_quantity
          - delivered_base_quantity
          - released_base_quantity,
          0
        )
      ), 0)::numeric as reserved
    from public.stock_reservations
    where organization_id = p_organization_id
      and branch_id = p_branch_id
      and status = 'active'
    group by product_id
  ),
  latest_purchase as (
    select distinct on (pi.product_id)
      pi.product_id,
      po.supplier_id,
      coalesce(
        pi.base_unit_cost,
        pi.unit_cost / greatest(coalesce(pi.unit_factor, 1), 0.001)
      )::numeric(16,4) as base_unit_cost
    from public.purchase_items pi
    join public.purchases po on po.id = pi.purchase_id
    where po.organization_id = p_organization_id
      and po.branch_id = p_branch_id
      and po.status in ('received','partially_received')
    order by
      pi.product_id,
      po.last_received_at desc nulls last,
      po.received_at desc nulls last,
      po.created_at desc
  ),
  base as (
    select
      p.id as product_id,
      p.name as product_name,
      p.name_km as product_name_km,
      p.sku,
      p.barcode,
      p.category_id,
      c.name as category_name,
      p.currency,
      coalesce(nullif(p.unit_name, ''), 'Piece') as base_unit_name,
      coalesce(ib.quantity, 0)::numeric as current_stock,
      coalesce(rd.reserved, 0)::numeric as reserved_stock,
      coalesce(ind.incoming, 0)::numeric as incoming_stock,
      coalesce(ind.draft_incoming, 0)::numeric as draft_purchase_stock,
      greatest(coalesce(sd.history_sold, 0) - coalesce(ret.history_returned, 0), 0)::numeric as history_qty,
      greatest(coalesce(sd.recent_sold, 0) - coalesce(ret.recent_returned, 0), 0)::numeric as recent_qty,
      greatest(coalesce(sd.previous_sold, 0) - coalesce(ret.previous_returned, 0), 0)::numeric as previous_qty,
      greatest(coalesce(sd.seven_sold, 0) - coalesce(ret.seven_returned, 0), 0)::numeric as seven_qty,
      coalesce(sd.sales_days, 0)::integer as sales_days,
      sd.last_sale_date,
      coalesce(rr.lead_time_days, 0)::integer as lead_time_days,
      coalesce(rr.minimum_order_quantity, 1)::numeric as minimum_order_quantity,
      coalesce(rr.preferred_supplier_id, lp.supplier_id) as preferred_supplier_id,
      coalesce(rr.purchase_unit_id, unit_pick.id) as purchase_unit_id,
      coalesce(unit_pick.name, p.unit_name, 'Piece') as purchase_unit_name,
      coalesce(unit_pick.conversion_factor, 1)::numeric as purchase_unit_factor,
      coalesce(lp.base_unit_cost, ib.average_cost, p.default_cost, 0)::numeric as estimated_base_unit_cost,
      coalesce(rr.target_stock, 0)::numeric as configured_target_stock,
      coalesce(draft_po.has_draft, false) as has_draft_purchase
    from public.products p
    left join public.categories c on c.id = p.category_id
    left join public.inventory_balances ib
      on ib.branch_id = p_branch_id and ib.product_id = p.id
    left join sales_data sd on sd.product_id = p.id
    left join return_data ret on ret.product_id = p.id
    left join incoming_data ind on ind.product_id = p.id
    left join reservation_data rd on rd.product_id = p.id
    left join public.reorder_rules rr
      on rr.organization_id = p_organization_id
      and rr.branch_id = p_branch_id
      and rr.product_id = p.id
      and rr.is_active = true
    left join latest_purchase lp on lp.product_id = p.id
    left join lateral (
      select pu.*
      from public.product_units pu
      where pu.organization_id = p_organization_id
        and pu.product_id = p.id
        and pu.is_active = true
      order by
        case when rr.purchase_unit_id is not null and pu.id = rr.purchase_unit_id then 0 else 1 end,
        pu.is_base desc,
        pu.sort_order,
        pu.name
      limit 1
    ) unit_pick on true
    left join lateral (
      select true as has_draft
      from public.purchase_items dpi
      join public.purchases dpo on dpo.id = dpi.purchase_id
      where dpo.organization_id = p_organization_id
        and dpo.branch_id = p_branch_id
        and dpo.status = 'draft'
        and dpi.product_id = p.id
      limit 1
    ) draft_po on true
    where p.organization_id = p_organization_id
      and p.is_active = true
      and p.track_stock = true
  ),
  metrics as (
    select
      b.*,
      (b.history_qty / greatest(v_settings.history_days, 1))::numeric as history_daily,
      (b.recent_qty / greatest(v_recent_days, 1))::numeric as recent_daily,
      (b.previous_qty / greatest(v_recent_days, 1))::numeric as previous_daily,
      (b.seven_qty / 7.0)::numeric as seven_daily,
      greatest(b.current_stock - b.reserved_stock, 0)::numeric as available_stock,
      (b.current_stock - b.reserved_stock + b.incoming_stock)::numeric as projected_stock
    from base b
  ),
  factors as (
    select
      m.*,
      case
        when m.previous_daily > 0 then least(greatest(m.recent_daily / m.previous_daily, 0.50), 1.75)
        when m.recent_daily > 0 then 1.15
        else 1
      end::numeric as trend_factor,
      case
        when m.history_daily > 0 then least(greatest(m.seven_daily / m.history_daily, 0.75), 1.25)
        else 1
      end::numeric as seasonality_factor,
      (
        m.history_daily * (1 - v_settings.recent_weight)
        + m.recent_daily * v_settings.recent_weight
      )::numeric as weighted_daily
    from metrics m
  ),
  forecast as (
    select
      f.*,
      greatest(
        f.weighted_daily
        * (
          (1 - v_settings.seasonality_weight)
          + v_settings.seasonality_weight * f.seasonality_factor
        ),
        0
      )::numeric as forecast_daily
    from factors f
  ),
  calculated as (
    select
      x.*,
      round(x.forecast_daily * v_settings.forecast_horizon_days, 3) as horizon_demand,
      round(x.forecast_daily * v_settings.safety_stock_days, 3) as safety_stock,
      round(x.forecast_daily * x.lead_time_days, 3) as lead_demand,
      case
        when x.forecast_daily > 0 then round(x.projected_stock / x.forecast_daily, 2)
        else null
      end as days_cover,
      case
        when x.forecast_daily > 0 then
          v_as_of + greatest(floor(greatest(x.projected_stock, 0) / x.forecast_daily)::integer, 0)
        else null
      end as stockout_date,
      greatest(
        round(
          greatest(
            x.forecast_daily * (
              v_settings.forecast_horizon_days
              + v_settings.safety_stock_days
              + x.lead_time_days
            ),
            x.configured_target_stock
          ) - x.projected_stock,
          3
        ),
        0
      )::numeric as suggested_base
    from forecast x
  ),
  final_rows as (
    select
      q.*,
      case
        when q.suggested_base <= 0 then 0::numeric
        else greatest(
          q.minimum_order_quantity,
          ceil(q.suggested_base / greatest(q.purchase_unit_factor, 0.001))::numeric
        )
      end::numeric(16,3) as suggested_purchase,
      case
        when q.stockout_date is null then null
        else greatest(
          v_as_of,
          q.stockout_date - q.lead_time_days - v_settings.safety_stock_days
        )
      end as order_date,
      case
        when q.available_stock <= 0 and q.forecast_daily > 0 then 'out_of_stock'
        when q.sales_days < v_settings.minimum_history_days
          and q.last_sale_date is null then 'insufficient_history'
        when q.last_sale_date is not null
          and q.last_sale_date <= v_as_of - v_settings.slow_moving_days
          and q.current_stock > 0 then 'slow_moving'
        when q.days_cover is not null
          and q.days_cover > v_settings.overstock_cover_days then 'overstock'
        when q.days_cover is not null
          and q.days_cover <= q.lead_time_days then 'critical'
        when q.days_cover is not null
          and q.days_cover <= q.lead_time_days + v_settings.safety_stock_days then 'urgent'
        when q.days_cover is not null
          and q.days_cover <= v_settings.forecast_horizon_days then 'watch'
        when q.sales_days < v_settings.minimum_history_days then 'insufficient_history'
        else 'healthy'
      end as risk_status
    from calculated q
  )
  insert into public.demand_forecast_items (
    organization_id, branch_id, run_id, product_id,
    product_name, product_name_km, sku, barcode,
    category_id, category_name, currency, base_unit_name,
    history_base_quantity, recent_base_quantity, previous_base_quantity,
    last_7_day_base_quantity, sales_days, last_sale_date,
    history_daily_demand, recent_daily_demand, trend_factor,
    seasonality_factor, forecast_daily_demand, forecast_horizon_demand,
    safety_stock_quantity, lead_time_demand,
    current_stock, reserved_stock, incoming_stock, draft_purchase_stock,
    available_stock, projected_stock, days_of_cover,
    expected_stockout_date, recommended_order_date,
    preferred_supplier_id, preferred_supplier_name, supplier_code,
    purchase_unit_id, purchase_unit_name, purchase_unit_factor,
    lead_time_days, minimum_order_quantity,
    estimated_base_unit_cost, estimated_purchase_unit_cost,
    suggested_base_quantity, suggested_purchase_quantity,
    estimated_order_total, risk_status, can_create_order
  )
  select
    p_organization_id,
    p_branch_id,
    v_run.id,
    f.product_id,
    f.product_name,
    f.product_name_km,
    f.sku,
    f.barcode,
    f.category_id,
    f.category_name,
    f.currency,
    f.base_unit_name,
    round(f.history_qty, 3),
    round(f.recent_qty, 3),
    round(f.previous_qty, 3),
    round(f.seven_qty, 3),
    f.sales_days,
    f.last_sale_date,
    round(f.history_daily, 5),
    round(f.recent_daily, 5),
    round(f.trend_factor, 5),
    round(f.seasonality_factor, 5),
    round(f.forecast_daily, 5),
    f.horizon_demand,
    f.safety_stock,
    f.lead_demand,
    round(f.current_stock, 3),
    round(f.reserved_stock, 3),
    round(f.incoming_stock, 3),
    round(f.draft_purchase_stock, 3),
    round(f.available_stock, 3),
    round(f.projected_stock, 3),
    f.days_cover,
    f.stockout_date,
    f.order_date,
    supplier.id,
    supplier.name,
    supplier.supplier_code,
    f.purchase_unit_id,
    f.purchase_unit_name,
    round(f.purchase_unit_factor, 3),
    f.lead_time_days,
    round(f.minimum_order_quantity, 3),
    round(f.estimated_base_unit_cost, 4),
    round(f.estimated_base_unit_cost * f.purchase_unit_factor, 4),
    round(f.suggested_base, 3),
    f.suggested_purchase,
    round(
      f.suggested_purchase
      * f.estimated_base_unit_cost
      * f.purchase_unit_factor,
      2
    ),
    f.risk_status,
    (
      f.suggested_purchase > 0
      and supplier.id is not null
      and f.purchase_unit_id is not null
      and f.has_draft_purchase is false
    )
  from final_rows f
  left join public.suppliers supplier
    on supplier.id = f.preferred_supplier_id
    and supplier.organization_id = p_organization_id
    and supplier.is_active = true;

  update public.demand_forecast_runs
  set
    status = 'completed',
    completed_at = now(),
    item_count = summary.item_count,
    out_of_stock_count = summary.out_of_stock_count,
    critical_count = summary.critical_count,
    urgent_count = summary.urgent_count,
    watch_count = summary.watch_count,
    slow_moving_count = summary.slow_moving_count,
    overstock_count = summary.overstock_count,
    suggested_order_value_usd = summary.usd,
    suggested_order_value_khr = summary.khr
  from (
    select
      count(*)::integer as item_count,
      count(*) filter (where risk_status = 'out_of_stock')::integer as out_of_stock_count,
      count(*) filter (where risk_status = 'critical')::integer as critical_count,
      count(*) filter (where risk_status = 'urgent')::integer as urgent_count,
      count(*) filter (where risk_status = 'watch')::integer as watch_count,
      count(*) filter (where risk_status = 'slow_moving')::integer as slow_moving_count,
      count(*) filter (where risk_status = 'overstock')::integer as overstock_count,
      coalesce(sum(estimated_order_total) filter (where currency = 'USD'), 0)::numeric(16,2) as usd,
      coalesce(sum(estimated_order_total) filter (where currency = 'KHR'), 0)::numeric(16,2) as khr
    from public.demand_forecast_items
    where run_id = v_run.id
  ) summary
  where id = v_run.id;

  if p_source = 'scheduled' then
    update public.demand_planning_settings
    set last_auto_run_at = now(), updated_at = now()
    where id = v_settings.id;
  end if;

  if p_generated_by is not null then
    insert into public.audit_logs (
      organization_id, user_id, action, entity_type, entity_id, new_data
    ) values (
      p_organization_id,
      p_generated_by,
      'run_demand_forecast',
      'demand_forecast_run',
      v_run.id,
      jsonb_build_object(
        'branch_id', p_branch_id,
        'source', p_source,
        'as_of_date', v_as_of
      )
    );
  end if;

  return v_run.id;
exception
  when others then
    if v_run.id is not null then
      update public.demand_forecast_runs
      set status = 'failed', completed_at = now(), error_message = sqlerrm
      where id = v_run.id;
    end if;
    raise;
end;
$$;

revoke all on function private.generate_demand_forecast(uuid, uuid, uuid, text)
  from public, anon;
grant execute on function private.generate_demand_forecast(uuid, uuid, uuid, text)
  to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. SECURE USER RPCS
-- ----------------------------------------------------------------------------

create or replace function public.save_demand_planning_settings(
  p_branch_id uuid,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_org uuid := private.current_organization_id();
  v_branch uuid := coalesce(p_branch_id, private.current_branch_id());
  v_row public.demand_planning_settings%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('demand_planning.manage');
  if not private.demand_branch_allowed(v_branch) then
    raise exception 'You cannot manage demand settings for this branch';
  end if;

  insert into public.demand_planning_settings (
    organization_id,
    branch_id,
    history_days,
    forecast_horizon_days,
    safety_stock_days,
    recent_window_days,
    recent_weight,
    seasonality_weight,
    minimum_history_days,
    slow_moving_days,
    overstock_cover_days,
    auto_run_enabled,
    auto_run_hour,
    created_by,
    updated_by
  ) values (
    v_org,
    v_branch,
    greatest(30, least(730, coalesce((p_values->>'history_days')::integer, 90))),
    greatest(7, least(180, coalesce((p_values->>'forecast_horizon_days')::integer, 30))),
    greatest(0, least(90, coalesce((p_values->>'safety_stock_days')::integer, 7))),
    greatest(7, least(90, coalesce((p_values->>'recent_window_days')::integer, 30))),
    greatest(0, least(1, coalesce((p_values->>'recent_weight')::numeric, 0.55))),
    greatest(0, least(1, coalesce((p_values->>'seasonality_weight')::numeric, 0.20))),
    greatest(1, least(365, coalesce((p_values->>'minimum_history_days')::integer, 14))),
    greatest(7, least(730, coalesce((p_values->>'slow_moving_days')::integer, 60))),
    greatest(14, least(730, coalesce((p_values->>'overstock_cover_days')::integer, 90))),
    coalesce((p_values->>'auto_run_enabled')::boolean, true),
    greatest(0, least(23, coalesce((p_values->>'auto_run_hour')::integer, 6))),
    v_user,
    v_user
  )
  on conflict (organization_id, branch_id)
  do update set
    history_days = excluded.history_days,
    forecast_horizon_days = excluded.forecast_horizon_days,
    safety_stock_days = excluded.safety_stock_days,
    recent_window_days = excluded.recent_window_days,
    recent_weight = excluded.recent_weight,
    seasonality_weight = excluded.seasonality_weight,
    minimum_history_days = excluded.minimum_history_days,
    slow_moving_days = excluded.slow_moving_days,
    overstock_cover_days = excluded.overstock_cover_days,
    auto_run_enabled = excluded.auto_run_enabled,
    auto_run_hour = excluded.auto_run_hour,
    updated_by = v_user,
    updated_at = now()
  returning * into v_row;

  insert into public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_org,
    v_user,
    'save_demand_planning_settings',
    'demand_planning_settings',
    v_row.id,
    to_jsonb(v_row)
  );

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.save_demand_planning_settings(uuid, jsonb)
  from public, anon;
grant execute on function public.save_demand_planning_settings(uuid, jsonb)
  to authenticated;

create or replace function public.run_demand_forecast(
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_org uuid := private.current_organization_id();
  v_branch uuid := coalesce(p_branch_id, private.current_branch_id());
  v_run_id uuid;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('demand_planning.manage');
  if not private.demand_branch_allowed(v_branch) then
    raise exception 'You cannot run a forecast for this branch';
  end if;

  v_run_id := private.generate_demand_forecast(
    v_org,
    v_branch,
    v_user,
    'manual'
  );

  return (
    select to_jsonb(r)
    from public.demand_forecast_runs r
    where r.id = v_run_id
  );
end;
$$;

revoke all on function public.run_demand_forecast(uuid) from public, anon;
grant execute on function public.run_demand_forecast(uuid) to authenticated;

create or replace function public.get_demand_planning_workspace(
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_org uuid := private.current_organization_id();
  v_branch uuid := coalesce(p_branch_id, private.current_branch_id());
  v_run_id uuid;
  v_result jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('demand_planning.view');
  if not private.demand_branch_allowed(v_branch) then
    raise exception 'You cannot view demand planning for this branch';
  end if;

  select id into v_run_id
  from public.demand_forecast_runs
  where organization_id = v_org
    and branch_id = v_branch
    and status = 'completed'
  order by as_of_date desc, generated_at desc
  limit 1;

  select jsonb_build_object(
    'branch_id', v_branch,
    'settings', coalesce(
      (
        select to_jsonb(s)
        from public.demand_planning_settings s
        where s.organization_id = v_org and s.branch_id = v_branch
      ),
      '{}'::jsonb
    ),
    'run', coalesce(
      (
        select to_jsonb(r)
        from public.demand_forecast_runs r
        where r.id = v_run_id
      ),
      '{}'::jsonb
    ),
    'items', coalesce(
      (
        select jsonb_agg(to_jsonb(i) order by
          case i.risk_status
            when 'out_of_stock' then 1
            when 'critical' then 2
            when 'urgent' then 3
            when 'watch' then 4
            when 'insufficient_history' then 5
            when 'slow_moving' then 6
            when 'overstock' then 7
            else 8
          end,
          i.product_name
        )
        from public.demand_forecast_items i
        where i.run_id = v_run_id
      ),
      '[]'::jsonb
    ),
    'history', coalesce(
      (
        select jsonb_agg(to_jsonb(history_row) order by history_row.generated_at desc)
        from (
          select *
          from public.demand_forecast_runs r
          where r.organization_id = v_org
            and r.branch_id = v_branch
          order by r.generated_at desc
          limit 12
        ) history_row
      ),
      '[]'::jsonb
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_demand_planning_workspace(uuid)
  from public, anon;
grant execute on function public.get_demand_planning_workspace(uuid)
  to authenticated;

-- ----------------------------------------------------------------------------
-- 7. SERVICE-ROLE DAILY RUNNER
-- ----------------------------------------------------------------------------

create or replace function public.run_due_demand_forecasts()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_setting record;
  v_run_id uuid;
  v_count integer := 0;
  v_failed integer := 0;
begin
  for v_setting in
    select
      s.*,
      coalesce(a.timezone, 'Asia/Phnom_Penh') as timezone,
      (
        select p.id
        from public.profiles p
        where p.organization_id = s.organization_id
          and p.role in ('owner','admin')
          and p.is_active = true
        order by case p.role when 'owner' then 0 else 1 end, p.created_at
        limit 1
      ) as system_user_id
    from public.demand_planning_settings s
    join public.branches b on b.id = s.branch_id and b.is_active = true
    left join public.app_settings a on a.organization_id = s.organization_id
    where s.auto_run_enabled = true
      and extract(hour from now() at time zone coalesce(a.timezone, 'Asia/Phnom_Penh'))::integer = s.auto_run_hour
      and (
        s.last_auto_run_at is null
        or (s.last_auto_run_at at time zone coalesce(a.timezone, 'Asia/Phnom_Penh'))::date
          < (now() at time zone coalesce(a.timezone, 'Asia/Phnom_Penh'))::date
      )
  loop
    begin
      v_run_id := private.generate_demand_forecast(
        v_setting.organization_id,
        v_setting.branch_id,
        v_setting.system_user_id,
        'scheduled'
      );
      v_count := v_count + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'generated', v_count,
    'failed', v_failed,
    'checked_at', now()
  );
end;
$$;

revoke all on function public.run_due_demand_forecasts() from public, anon, authenticated;
grant execute on function public.run_due_demand_forecasts() to service_role;

-- ----------------------------------------------------------------------------
-- 8. TELEGRAM PREFERENCE SAVE COMPATIBILITY
-- ----------------------------------------------------------------------------

create or replace function public.save_my_telegram_preferences(p_preferences jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_result public.telegram_notification_preferences%rowtype;
  v_all boolean;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select * into v_profile from public.profiles where id = v_user_id and is_active = true;
  if not found then raise exception 'Active POS profile required'; end if;
  perform private.ensure_telegram_preferences(v_user_id);
  v_all := coalesce((p_preferences->>'all_branches')::boolean, false);
  if v_all and v_profile.role not in ('owner','admin') then
    raise exception 'Only owners and admins can receive all-branch alerts';
  end if;

  update public.telegram_notification_preferences set
    stock_alerts = coalesce((p_preferences->>'stock_alerts')::boolean, stock_alerts),
    forecast_alerts = coalesce((p_preferences->>'forecast_alerts')::boolean, forecast_alerts),
    sales_summary = coalesce((p_preferences->>'sales_summary')::boolean, sales_summary),
    credit_alerts = coalesce((p_preferences->>'credit_alerts')::boolean, credit_alerts),
    supplier_alerts = coalesce((p_preferences->>'supplier_alerts')::boolean, supplier_alerts),
    purchase_alerts = coalesce((p_preferences->>'purchase_alerts')::boolean, purchase_alerts),
    transfer_alerts = coalesce((p_preferences->>'transfer_alerts')::boolean, transfer_alerts),
    quotation_alerts = coalesce((p_preferences->>'quotation_alerts')::boolean, quotation_alerts),
    sales_order_alerts = coalesce((p_preferences->>'sales_order_alerts')::boolean, sales_order_alerts),
    online_order_alerts = coalesce((p_preferences->>'online_order_alerts')::boolean, online_order_alerts),
    cash_register_alerts = coalesce((p_preferences->>'cash_register_alerts')::boolean, cash_register_alerts),
    attendance_alerts = coalesce((p_preferences->>'attendance_alerts')::boolean, attendance_alerts),
    payroll_alerts = coalesce((p_preferences->>'payroll_alerts')::boolean, payroll_alerts),
    system_alerts = coalesce((p_preferences->>'system_alerts')::boolean, system_alerts),
    all_branches = v_all,
    daily_summary_hour = greatest(0, least(23, coalesce((p_preferences->>'daily_summary_hour')::integer, daily_summary_hour))),
    quiet_start_hour = case
      when p_preferences ? 'quiet_start_hour'
        and nullif(p_preferences->>'quiet_start_hour', '') is not null
      then greatest(0, least(23, (p_preferences->>'quiet_start_hour')::integer))
      else null
    end,
    quiet_end_hour = case
      when p_preferences ? 'quiet_end_hour'
        and nullif(p_preferences->>'quiet_end_hour', '') is not null
      then greatest(0, least(23, (p_preferences->>'quiet_end_hour')::integer))
      else null
    end,
    updated_by = v_user_id,
    updated_at = now()
  where user_id = v_user_id
  returning * into v_result;

  return to_jsonb(v_result);
end;
$$;

revoke all on function public.save_my_telegram_preferences(jsonb)
  from public, anon;
grant execute on function public.save_my_telegram_preferences(jsonb)
  to authenticated;

commit;

-- ============================================================================
-- END STEP 44
-- ============================================================================
