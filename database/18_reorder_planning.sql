-- ============================================================================
-- Tiny POS - Step 20: Low-stock reorder planning
-- Run once in the NEW Supabase project after Step 19.
--
-- Reorder quantities are calculated in the product's base unit and then
-- converted into the preferred purchasing unit, such as Box or Carton.
--
-- This migration does not delete products, inventory, suppliers, purchases,
-- sales, or other business data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. REORDER RULES
-- ----------------------------------------------------------------------------

create table if not exists public.reorder_rules (
  id uuid primary key default gen_random_uuid(),

  organization_id uuid not null
    references public.organizations(id) on delete cascade,

  branch_id uuid not null
    references public.branches(id) on delete cascade,

  product_id uuid not null
    references public.products(id) on delete cascade,

  preferred_supplier_id uuid
    references public.suppliers(id) on delete set null,

  purchase_unit_id uuid
    references public.product_units(id) on delete set null,

  -- All stock thresholds are stored in the product's base unit.
  reorder_point numeric(14,3) not null default 0
    check (reorder_point >= 0),

  target_stock numeric(14,3) not null default 0
    check (target_stock >= 0),

  -- Minimum quantity in the selected purchasing unit.
  minimum_order_quantity numeric(14,3) not null default 1
    check (minimum_order_quantity > 0),

  lead_time_days integer not null default 0
    check (lead_time_days between 0 and 3650),

  supplier_sku text,

  is_active boolean not null default true,

  created_by uuid
    references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (branch_id, product_id),

  check (target_stock >= reorder_point),
  check (
    supplier_sku is null
    or length(trim(supplier_sku)) > 0
  )
);

create index if not exists reorder_rules_org_branch_idx
  on public.reorder_rules (
    organization_id,
    branch_id,
    is_active,
    product_id
  );

create index if not exists reorder_rules_supplier_idx
  on public.reorder_rules (
    organization_id,
    preferred_supplier_id
  );

drop trigger if exists set_reorder_rules_updated_at
  on public.reorder_rules;

create trigger set_reorder_rules_updated_at
before update on public.reorder_rules
for each row execute function public.set_updated_at();

alter table public.reorder_rules enable row level security;

drop policy if exists reorder_rules_select_management
  on public.reorder_rules;

drop policy if exists reorder_rules_manage_management
  on public.reorder_rules;

create policy reorder_rules_select_management
on public.reorder_rules
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and branch_id = (select private.current_branch_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

create policy reorder_rules_manage_management
on public.reorder_rules
for all to authenticated
using (
  organization_id = (select private.current_organization_id())
  and branch_id = (select private.current_branch_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
)
with check (
  organization_id = (select private.current_organization_id())
  and branch_id = (select private.current_branch_id())
  and (select private.has_any_role(
    array[
      'owner',
      'admin',
      'manager'
    ]::public.app_role[]
  ))
);

revoke all on public.reorder_rules from anon;
grant select, insert, update, delete
  on public.reorder_rules to authenticated;
grant all on public.reorder_rules to service_role;

-- ----------------------------------------------------------------------------
-- 2. SAVE A PRODUCT REORDER RULE
-- ----------------------------------------------------------------------------

create or replace function public.save_reorder_rule(
  p_product_id uuid,
  p_reorder_point numeric,
  p_target_stock numeric,
  p_preferred_supplier_id uuid default null,
  p_purchase_unit_id uuid default null,
  p_minimum_order_quantity numeric default 1,
  p_lead_time_days integer default 0,
  p_supplier_sku text default null,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_product public.products%rowtype;
  v_supplier public.suppliers%rowtype;
  v_unit public.product_units%rowtype;
  v_rule public.reorder_rules%rowtype;
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
    raise exception 'Your role cannot manage reorder rules';
  end if;

  select *
  into v_product
  from public.products
  where id = p_product_id
    and organization_id = v_profile.organization_id
    and is_active = true;

  if not found then
    raise exception 'Product not found or inactive';
  end if;

  if v_product.track_stock is not true then
    raise exception 'This product does not track stock';
  end if;

  if p_reorder_point is null or p_reorder_point < 0 then
    raise exception 'Reorder point cannot be negative';
  end if;

  if p_target_stock is null
     or p_target_stock < p_reorder_point then
    raise exception 'Target stock must equal or exceed the reorder point';
  end if;

  if p_minimum_order_quantity is null
     or p_minimum_order_quantity <= 0 then
    raise exception 'Minimum order quantity must be greater than zero';
  end if;

  if p_lead_time_days is null
     or p_lead_time_days < 0
     or p_lead_time_days > 3650 then
    raise exception 'Lead time must be between 0 and 3650 days';
  end if;

  if p_preferred_supplier_id is not null then
    select *
    into v_supplier
    from public.suppliers
    where id = p_preferred_supplier_id
      and organization_id = v_profile.organization_id
      and is_active = true;

    if not found then
      raise exception 'Preferred supplier not found or inactive';
    end if;
  end if;

  if p_purchase_unit_id is null then
    select *
    into v_unit
    from public.product_units
    where organization_id = v_profile.organization_id
      and product_id = v_product.id
      and is_base = true
      and is_active = true
    limit 1;
  else
    select *
    into v_unit
    from public.product_units
    where id = p_purchase_unit_id
      and organization_id = v_profile.organization_id
      and product_id = v_product.id
      and is_active = true;
  end if;

  if not found then
    raise exception 'Selected purchase unit is unavailable';
  end if;

  insert into public.reorder_rules (
    organization_id,
    branch_id,
    product_id,
    preferred_supplier_id,
    purchase_unit_id,
    reorder_point,
    target_stock,
    minimum_order_quantity,
    lead_time_days,
    supplier_sku,
    is_active,
    created_by
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_product.id,
    p_preferred_supplier_id,
    v_unit.id,
    round(p_reorder_point, 3),
    round(p_target_stock, 3),
    round(p_minimum_order_quantity, 3),
    p_lead_time_days,
    nullif(trim(p_supplier_sku), ''),
    coalesce(p_is_active, true),
    v_user_id
  )
  on conflict (branch_id, product_id)
  do update
  set
    preferred_supplier_id = excluded.preferred_supplier_id,
    purchase_unit_id = excluded.purchase_unit_id,
    reorder_point = excluded.reorder_point,
    target_stock = excluded.target_stock,
    minimum_order_quantity = excluded.minimum_order_quantity,
    lead_time_days = excluded.lead_time_days,
    supplier_sku = excluded.supplier_sku,
    is_active = excluded.is_active,
    updated_at = now()
  returning * into v_rule;

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
    'save_reorder_rule',
    'reorder_rule',
    v_rule.id,
    jsonb_build_object(
      'product_id', v_product.id,
      'product_name', v_product.name,
      'reorder_point', v_rule.reorder_point,
      'target_stock', v_rule.target_stock,
      'preferred_supplier_id', v_rule.preferred_supplier_id,
      'purchase_unit_id', v_rule.purchase_unit_id,
      'minimum_order_quantity', v_rule.minimum_order_quantity,
      'lead_time_days', v_rule.lead_time_days,
      'is_active', v_rule.is_active
    )
  );

  return to_jsonb(v_rule);
end;
$$;

revoke all on function public.save_reorder_rule(
  uuid,
  numeric,
  numeric,
  uuid,
  uuid,
  numeric,
  integer,
  text,
  boolean
) from public, anon;

grant execute on function public.save_reorder_rule(
  uuid,
  numeric,
  numeric,
  uuid,
  uuid,
  numeric,
  integer,
  text,
  boolean
) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. REORDER SUGGESTIONS FOR THE CURRENT BRANCH
-- ----------------------------------------------------------------------------

create or replace function public.get_reorder_suggestions()
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_result jsonb;
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
    raise exception 'Your role cannot view reorder planning';
  end if;

  with pending_orders as (
    select
      pi.product_id,

      coalesce(sum(
        case
          when po.status = 'ordered'
            then coalesce(
              pi.base_quantity,
              pi.quantity * coalesce(pi.unit_factor, 1)
            )
          else 0
        end
      ), 0)::numeric(14,3)
        as ordered_base_quantity,

      coalesce(sum(
        case
          when po.status = 'draft'
            then coalesce(
              pi.base_quantity,
              pi.quantity * coalesce(pi.unit_factor, 1)
            )
          else 0
        end
      ), 0)::numeric(14,3)
        as draft_base_quantity

    from public.purchase_items pi
    join public.purchases po
      on po.id = pi.purchase_id

    where po.organization_id = v_profile.organization_id
      and po.branch_id = v_profile.branch_id
      and po.status in ('draft','ordered')

    group by pi.product_id
  ),

  latest_purchase as (
    select distinct on (pi.product_id)
      pi.product_id,
      po.supplier_id,
      coalesce(
        pi.base_unit_cost,
        pi.unit_cost / greatest(
          coalesce(pi.unit_factor, 1),
          0.001
        )
      )::numeric(14,4)
        as base_unit_cost

    from public.purchase_items pi
    join public.purchases po
      on po.id = pi.purchase_id

    where po.organization_id = v_profile.organization_id
      and po.branch_id = v_profile.branch_id
      and po.status = 'received'

    order by
      pi.product_id,
      po.received_at desc nulls last,
      po.created_at desc
  ),

  raw as (
    select
      p.id as product_id,
      p.name as product_name,
      p.name_km,
      p.sku,
      p.barcode,
      p.unit_name as base_unit_name,
      p.currency,
      p.default_cost,
      p.low_stock_threshold,
      p.category_id,

      c.name as category_name,

      rr.id as rule_id,
      coalesce(rr.is_active, false) as rule_active,

      rr.preferred_supplier_id
        as configured_supplier_id,

      rr.purchase_unit_id
        as configured_purchase_unit_id,

      rr.reorder_point
        as configured_reorder_point,

      rr.target_stock
        as configured_target_stock,

      rr.minimum_order_quantity
        as configured_minimum_order_quantity,

      rr.lead_time_days
        as configured_lead_time_days,

      rr.supplier_sku,

      coalesce(ib.quantity, 0)::numeric(14,3)
        as current_stock,

      coalesce(po.ordered_base_quantity, 0)::numeric(14,3)
        as ordered_base_quantity,

      coalesce(po.draft_base_quantity, 0)::numeric(14,3)
        as draft_base_quantity,

      coalesce(
        case
          when rr.is_active then rr.reorder_point
          else null
        end,
        p.low_stock_threshold,
        settings.low_stock_threshold,
        0
      )::numeric(14,3)
        as effective_reorder_point,

      coalesce(
        case
          when rr.is_active then rr.target_stock
          else null
        end,
        greatest(
          coalesce(
            p.low_stock_threshold,
            settings.low_stock_threshold,
            0
          ) * 2,
          coalesce(
            p.low_stock_threshold,
            settings.low_stock_threshold,
            0
          ) + 1
        )
      )::numeric(14,3)
        as effective_target_stock,

      coalesce(
        case
          when rr.is_active
            then rr.minimum_order_quantity
          else null
        end,
        1
      )::numeric(14,3)
        as effective_minimum_order_quantity,

      coalesce(
        case
          when rr.is_active
            then rr.lead_time_days
          else null
        end,
        0
      )::integer
        as effective_lead_time_days,

      chosen_unit.id as purchase_unit_id,
      chosen_unit.name as purchase_unit_name,
      chosen_unit.short_name
        as purchase_unit_short_name,

      coalesce(
        chosen_unit.conversion_factor,
        1
      )::numeric(14,3)
        as purchase_unit_factor,

      coalesce(
        case
          when rr.is_active
            then rr.preferred_supplier_id
          else null
        end,
        lp.supplier_id
      ) as preferred_supplier_id,

      coalesce(
        lp.base_unit_cost,
        p.default_cost,
        0
      )::numeric(14,4)
        as estimated_base_unit_cost,

      (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', unit_row.id,
              'name', unit_row.name,
              'short_name', unit_row.short_name,
              'conversion_factor',
                unit_row.conversion_factor,
              'barcode', unit_row.barcode,
              'is_base', unit_row.is_base,
              'is_active', unit_row.is_active,
              'sort_order', unit_row.sort_order
            )
            order by
              unit_row.is_base desc,
              unit_row.sort_order,
              unit_row.name
          ),
          '[]'::jsonb
        )
        from public.product_units unit_row
        where unit_row.organization_id =
          v_profile.organization_id
          and unit_row.product_id = p.id
          and unit_row.is_active = true
      ) as product_units

    from public.products p

    left join public.categories c
      on c.id = p.category_id

    left join public.inventory_balances ib
      on ib.product_id = p.id
      and ib.branch_id = v_profile.branch_id

    left join public.app_settings settings
      on settings.organization_id =
        v_profile.organization_id

    left join public.reorder_rules rr
      on rr.organization_id =
        v_profile.organization_id
      and rr.branch_id = v_profile.branch_id
      and rr.product_id = p.id

    left join pending_orders po
      on po.product_id = p.id

    left join latest_purchase lp
      on lp.product_id = p.id

    left join lateral (
      select unit_row.*
      from public.product_units unit_row
      where unit_row.organization_id =
        v_profile.organization_id
        and unit_row.product_id = p.id
        and unit_row.is_active = true
      order by
        case
          when rr.is_active
            and unit_row.id = rr.purchase_unit_id
            then 0
          when unit_row.is_base then 1
          else 2
        end,
        unit_row.sort_order,
        unit_row.name
      limit 1
    ) chosen_unit on true

    where p.organization_id =
      v_profile.organization_id
      and p.is_active = true
      and p.track_stock = true
  ),

  with_supplier as (
    select
      raw.*,
      supplier.name as preferred_supplier_name,
      supplier.supplier_code,
      supplier.is_active
        as preferred_supplier_active,

      round(
        raw.estimated_base_unit_cost
          * raw.purchase_unit_factor,
        4
      ) as estimated_purchase_unit_cost,

      round(
        raw.current_stock
          + raw.ordered_base_quantity,
        3
      ) as projected_stock

    from raw

    left join public.suppliers supplier
      on supplier.id = raw.preferred_supplier_id
      and supplier.organization_id =
        v_profile.organization_id
      and supplier.is_active = true
  ),

  calculated as (
    select
      with_supplier.*,

      greatest(
        round(
          with_supplier.effective_target_stock
            - with_supplier.projected_stock,
          3
        ),
        0
      )::numeric(14,3)
        as suggested_base_quantity

    from with_supplier
  ),

  final_rows as (
    select
      calculated.*,

      case
        when calculated.suggested_base_quantity <= 0
          then 0::numeric

        else greatest(
          calculated.effective_minimum_order_quantity,

          ceil(
            calculated.suggested_base_quantity
              / greatest(
                calculated.purchase_unit_factor,
                0.001
              )
          )::numeric
        )
      end::numeric(14,3)
        as suggested_purchase_quantity,

      case
        when calculated.current_stock <= 0
          and calculated.ordered_base_quantity <= 0
          and calculated.draft_base_quantity <= 0
          and calculated.projected_stock
            <= calculated.effective_reorder_point
          then 'out_of_stock'

        when calculated.draft_base_quantity > 0
          and calculated.projected_stock
            <= calculated.effective_reorder_point
          then 'draft_order'

        when calculated.ordered_base_quantity > 0
          and calculated.current_stock
            <= calculated.effective_reorder_point
          and calculated.projected_stock
            > calculated.effective_reorder_point
          then 'incoming'

        when calculated.projected_stock
          <= calculated.effective_reorder_point
          then 'reorder'

        when calculated.rule_id is null
          or calculated.rule_active is false
          then 'unconfigured'

        else 'ok'
      end as reorder_status

    from calculated
  )

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'product_id', row_data.product_id,
        'product_name', row_data.product_name,
        'name_km', row_data.name_km,
        'sku', row_data.sku,
        'barcode', row_data.barcode,
        'base_unit_name', row_data.base_unit_name,
        'currency', row_data.currency,
        'category_id', row_data.category_id,
        'category_name', row_data.category_name,

        'rule_id', row_data.rule_id,
        'rule_active', row_data.rule_active,
        'configured_supplier_id',
          row_data.configured_supplier_id,
        'configured_purchase_unit_id',
          row_data.configured_purchase_unit_id,
        'configured_reorder_point',
          row_data.configured_reorder_point,
        'configured_target_stock',
          row_data.configured_target_stock,
        'configured_minimum_order_quantity',
          row_data.configured_minimum_order_quantity,
        'configured_lead_time_days',
          row_data.configured_lead_time_days,
        'supplier_sku', row_data.supplier_sku,

        'current_stock', row_data.current_stock,
        'ordered_base_quantity',
          row_data.ordered_base_quantity,
        'draft_base_quantity',
          row_data.draft_base_quantity,
        'projected_stock', row_data.projected_stock,

        'reorder_point',
          row_data.effective_reorder_point,
        'target_stock',
          row_data.effective_target_stock,

        'preferred_supplier_id',
          row_data.preferred_supplier_id,
        'preferred_supplier_name',
          row_data.preferred_supplier_name,
        'supplier_code', row_data.supplier_code,
        'preferred_supplier_active',
          row_data.preferred_supplier_active,

        'purchase_unit_id',
          row_data.purchase_unit_id,
        'purchase_unit_name',
          row_data.purchase_unit_name,
        'purchase_unit_short_name',
          row_data.purchase_unit_short_name,
        'purchase_unit_factor',
          row_data.purchase_unit_factor,
        'minimum_order_quantity',
          row_data.effective_minimum_order_quantity,
        'lead_time_days',
          row_data.effective_lead_time_days,

        'estimated_base_unit_cost',
          row_data.estimated_base_unit_cost,
        'estimated_purchase_unit_cost',
          row_data.estimated_purchase_unit_cost,

        'suggested_base_quantity',
          row_data.suggested_base_quantity,
        'suggested_purchase_quantity',
          row_data.suggested_purchase_quantity,

        'estimated_order_total',
          round(
            row_data.suggested_purchase_quantity
              * row_data.estimated_purchase_unit_cost,
            2
          ),

        'reorder_status',
          row_data.reorder_status,

        'can_create_order',
          (
            row_data.preferred_supplier_id is not null
            and row_data.purchase_unit_id is not null
            and row_data.suggested_purchase_quantity > 0
            and row_data.draft_base_quantity <= 0
          ),

        'product_units', row_data.product_units
      )
      order by
        case row_data.reorder_status
          when 'out_of_stock' then 1
          when 'reorder' then 2
          when 'draft_order' then 3
          when 'incoming' then 4
          when 'unconfigured' then 5
          else 6
        end,
        row_data.product_name
    ),
    '[]'::jsonb
  )
  into v_result
  from final_rows row_data;

  return v_result;
end;
$$;

revoke all on function public.get_reorder_suggestions()
  from public, anon;

grant execute on function public.get_reorder_suggestions()
  to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 20
-- ============================================================================
