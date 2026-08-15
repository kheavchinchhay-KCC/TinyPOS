-- ============================================================================
-- Tiny POS - Step 46.10: Flexible branch-transfer requests, package-unit count,
-- all-time open metrics, and endpoint approval.
-- Run ONCE after migration 54.
--
-- Additive only:
--   * Does not delete or reset existing transfers.
--   * Existing requested/count quantities stay stored in base units.
--   * Adds display-unit snapshots so requests/counts can use pcs/can/box/etc.
--   * New workflow does not move stock until final approval.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Transfer request/count unit snapshots
-- ----------------------------------------------------------------------------
alter table public.stock_transfers
  add column if not exists requested_by_branch_id uuid
    references public.branches(id) on delete set null;

alter table public.stock_transfer_items
  add column if not exists requested_product_unit_id uuid
    references public.product_units(id) on delete set null,
  add column if not exists requested_unit_name text,
  add column if not exists requested_unit_factor numeric(14,3) not null default 1,
  add column if not exists requested_unit_quantity numeric(14,3),
  add column if not exists counted_product_unit_id uuid
    references public.product_units(id) on delete set null,
  add column if not exists counted_unit_name text,
  add column if not exists counted_unit_factor numeric(14,3),
  add column if not exists counted_unit_quantity numeric(14,3);

update public.stock_transfers
set requested_by_branch_id = source_branch_id
where requested_by_branch_id is null;

update public.stock_transfer_items sti
set
  requested_product_unit_id = coalesce(
    sti.requested_product_unit_id,
    (
      select pu.id
      from public.product_units pu
      where pu.product_id = sti.product_id
        and (pu.is_active = true or pu.is_base = true)
      order by pu.is_base desc, pu.sort_order, pu.created_at
      limit 1
    )
  ),
  requested_unit_name = coalesce(
    nullif(sti.requested_unit_name, ''),
    (
      select coalesce(nullif(pu.short_name, ''), pu.name)
      from public.product_units pu
      where pu.product_id = sti.product_id
        and (pu.is_active = true or pu.is_base = true)
      order by pu.is_base desc, pu.sort_order, pu.created_at
      limit 1
    ),
    p.unit_name,
    'pcs'
  ),
  requested_unit_factor = case
    when sti.requested_unit_factor is null or sti.requested_unit_factor <= 0 then 1
    else sti.requested_unit_factor
  end,
  requested_unit_quantity = coalesce(sti.requested_unit_quantity, sti.quantity)
from public.products p
where p.id = sti.product_id;

update public.stock_transfer_items sti
set
  counted_product_unit_id = coalesce(
    sti.counted_product_unit_id,
    (
      select pu.id
      from public.product_units pu
      where pu.product_id = sti.product_id
        and (pu.is_active = true or pu.is_base = true)
      order by pu.is_base desc, pu.sort_order, pu.created_at
      limit 1
    )
  ),
  counted_unit_name = coalesce(
    nullif(sti.counted_unit_name, ''),
    (
      select coalesce(nullif(pu.short_name, ''), pu.name)
      from public.product_units pu
      where pu.product_id = sti.product_id
        and (pu.is_active = true or pu.is_base = true)
      order by pu.is_base desc, pu.sort_order, pu.created_at
      limit 1
    ),
    p.unit_name,
    'pcs'
  ),
  counted_unit_factor = coalesce(nullif(sti.counted_unit_factor, 0), 1),
  counted_unit_quantity = coalesce(sti.counted_unit_quantity, sti.counted_quantity)
from public.products p
where p.id = sti.product_id
  and sti.counted_quantity is not null;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'stock_transfer_items_requested_unit_factor_check'
      and conrelid = 'public.stock_transfer_items'::regclass
  ) then
    alter table public.stock_transfer_items
      add constraint stock_transfer_items_requested_unit_factor_check
      check (requested_unit_factor > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'stock_transfer_items_requested_unit_quantity_check'
      and conrelid = 'public.stock_transfer_items'::regclass
  ) then
    alter table public.stock_transfer_items
      add constraint stock_transfer_items_requested_unit_quantity_check
      check (requested_unit_quantity is null or requested_unit_quantity > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'stock_transfer_items_counted_unit_factor_check'
      and conrelid = 'public.stock_transfer_items'::regclass
  ) then
    alter table public.stock_transfer_items
      add constraint stock_transfer_items_counted_unit_factor_check
      check (counted_unit_factor is null or counted_unit_factor > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'stock_transfer_items_counted_unit_quantity_check'
      and conrelid = 'public.stock_transfer_items'::regclass
  ) then
    alter table public.stock_transfer_items
      add constraint stock_transfer_items_counted_unit_quantity_check
      check (counted_unit_quantity is null or counted_unit_quantity >= 0);
  end if;
end
$constraints$;

-- ----------------------------------------------------------------------------
-- 2. All-time open metrics for the CURRENT branch.
--    These intentionally ignore the list's date/search filters.
-- ----------------------------------------------------------------------------
create or replace function public.get_stock_transfer_metrics_v5()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_outgoing bigint := 0;
  v_waiting_count bigint := 0;
  v_waiting_approval bigint := 0;
  v_requested numeric(18,3) := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id
    and is_active = true;

  if not found or v_profile.branch_id is null then
    raise exception 'Active profile and branch required';
  end if;

  select
    count(*) filter (
      where st.status = 'pending'
        and st.source_branch_id = v_profile.branch_id
    ),
    count(*) filter (
      where st.status = 'pending'
        and st.destination_branch_id = v_profile.branch_id
        and coalesce(st.count_status, 'pending') in ('pending', 'counting')
    ),
    count(*) filter (
      where st.status = 'pending'
        and coalesce(st.count_status, 'pending') = 'awaiting_approval'
        and (st.source_branch_id = v_profile.branch_id or st.destination_branch_id = v_profile.branch_id)
    )
  into v_outgoing, v_waiting_count, v_waiting_approval
  from public.stock_transfers st
  where st.organization_id = v_profile.organization_id;

  select coalesce(sum(sti.quantity), 0)
  into v_requested
  from public.stock_transfers st
  join public.stock_transfer_items sti
    on sti.transfer_id = st.id
  where st.organization_id = v_profile.organization_id
    and st.status = 'pending'
    and (st.source_branch_id = v_profile.branch_id or st.destination_branch_id = v_profile.branch_id);

  return jsonb_build_object(
    'outgoing_pending', v_outgoing,
    'waiting_to_count', v_waiting_count,
    'waiting_approval', v_waiting_approval,
    'requested_units', v_requested
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Create transfer request with explicit FROM + TO and requested package unit.
--    Stock is NOT deducted here. The source can fulfil less/more during Count;
--    the final approved base quantity is validated against live source stock.
-- ----------------------------------------------------------------------------
create or replace function public.create_stock_transfer_v5(
  p_source_branch_id uuid,
  p_destination_branch_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_source_branch public.branches%rowtype;
  v_destination_branch public.branches%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_unit_id uuid;
  v_unit_name text;
  v_unit_factor numeric(14,3);
  v_base_quantity numeric(14,3);
  v_transfer_id uuid;
  v_transfer_number text;
  v_total_items integer := 0;
  v_total_units numeric(18,3) := 0;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('transfers.create');

  select * into v_profile
  from public.profiles
  where id = v_user_id and is_active = true;
  if not found or v_profile.branch_id is null then raise exception 'Active profile and branch required'; end if;

  select * into v_source_branch
  from public.branches
  where id = p_source_branch_id
    and organization_id = v_profile.organization_id
    and is_active = true;
  if not found then raise exception 'From branch not found or inactive'; end if;

  select * into v_destination_branch
  from public.branches
  where id = p_destination_branch_id
    and organization_id = v_profile.organization_id
    and is_active = true;
  if not found then raise exception 'To branch not found or inactive'; end if;

  if v_source_branch.id = v_destination_branch.id then
    raise exception 'From and To branches must be different';
  end if;

  if v_profile.branch_id not in (v_source_branch.id, v_destination_branch.id)
     and not private.has_permission('branches.all', v_user_id) then
    raise exception 'Your current branch must be either From or To';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product to the transfer';
  end if;

  v_transfer_number := private.next_document_number(
    v_profile.organization_id,
    v_source_branch.id,
    'TRF'
  );

  insert into public.stock_transfers(
    organization_id, transfer_number, source_branch_id, destination_branch_id,
    status, notes, created_by, workflow_version, count_status, requested_by_branch_id
  ) values (
    v_profile.organization_id, v_transfer_number, v_source_branch.id, v_destination_branch.id,
    'pending', nullif(trim(p_notes), ''), v_user_id, 3, 'pending', v_profile.branch_id
  ) returning id into v_transfer_id;

  for v_item in
    select x.product_id, x.product_unit_id, x.quantity
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, product_unit_id uuid, quantity numeric)
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Every transfer item requires a product and quantity greater than zero';
    end if;

    if exists (
      select 1 from public.stock_transfer_items
      where transfer_id = v_transfer_id and product_id = v_item.product_id
    ) then
      raise exception 'The same product cannot be added twice to one transfer';
    end if;

    select * into v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id
      and is_active = true
      and track_stock = true;
    if not found then raise exception 'A transfer product is missing, inactive, or does not track stock'; end if;

    v_unit_id := null;
    v_unit_name := null;
    v_unit_factor := null;

    if v_item.product_unit_id is not null then
      select pu.id, coalesce(nullif(pu.short_name, ''), pu.name), pu.conversion_factor
      into v_unit_id, v_unit_name, v_unit_factor
      from public.product_units pu
      where pu.id = v_item.product_unit_id
        and pu.product_id = v_product.id
        and pu.organization_id = v_profile.organization_id
        and (pu.is_active = true or pu.is_base = true);
      if not found then raise exception 'Selected unit is not valid for product %', v_product.name; end if;
    else
      select pu.id, coalesce(nullif(pu.short_name, ''), pu.name), pu.conversion_factor
      into v_unit_id, v_unit_name, v_unit_factor
      from public.product_units pu
      where pu.product_id = v_product.id
        and pu.organization_id = v_profile.organization_id
        and (pu.is_active = true or pu.is_base = true)
      order by pu.is_base desc, pu.sort_order, pu.created_at
      limit 1;
      if not found then
        v_unit_id := null;
        v_unit_name := coalesce(nullif(v_product.unit_name, ''), 'pcs');
        v_unit_factor := 1;
      end if;
    end if;

    v_base_quantity := round(v_item.quantity * coalesce(v_unit_factor, 1), 3);
    if v_base_quantity <= 0 then raise exception 'Requested base quantity must be greater than zero'; end if;

    insert into public.inventory_balances(
      organization_id, branch_id, product_id, quantity, average_cost
    ) values (
      v_profile.organization_id, v_source_branch.id, v_product.id, 0, coalesce(v_product.default_cost, 0)
    ) on conflict (branch_id, product_id) do nothing;

    select * into v_balance
    from public.inventory_balances
    where branch_id = v_source_branch.id
      and product_id = v_product.id;

    insert into public.stock_transfer_items(
      organization_id, transfer_id, product_id, quantity, unit_cost, counted_quantity,
      requested_product_unit_id, requested_unit_name, requested_unit_factor, requested_unit_quantity
    ) values (
      v_profile.organization_id, v_transfer_id, v_product.id, v_base_quantity,
      coalesce(nullif(v_balance.average_cost, 0), v_product.default_cost, 0), null,
      v_unit_id, v_unit_name, coalesce(v_unit_factor, 1), v_item.quantity
    );

    v_total_items := v_total_items + 1;
    v_total_units := v_total_units + v_base_quantity;
  end loop;

  if v_total_items = 0 then raise exception 'Add at least one product to the transfer'; end if;

  insert into public.audit_logs(
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id, v_profile.branch_id, v_user_id,
    'create_stock_transfer_request', 'stock_transfer', v_transfer_id,
    jsonb_build_object(
      'transfer_number', v_transfer_number,
      'source_branch_id', v_source_branch.id,
      'destination_branch_id', v_destination_branch.id,
      'item_count', v_total_items,
      'requested_base_units', v_total_units,
      'workflow_version', 3
    )
  );

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer_id,
    'transfer_number', v_transfer_number,
    'status', 'pending',
    'count_status', 'pending',
    'item_count', v_total_items,
    'total_units', v_total_units
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Edit an uncounted request. Either endpoint may edit when permitted.
-- ----------------------------------------------------------------------------
create or replace function public.update_stock_transfer_v5(
  p_transfer_id uuid,
  p_source_branch_id uuid,
  p_destination_branch_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_source_branch public.branches%rowtype;
  v_destination_branch public.branches%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_unit_id uuid;
  v_unit_name text;
  v_unit_factor numeric(14,3);
  v_base_quantity numeric(14,3);
  v_total integer := 0;
begin
  perform private.require_permission('transfers.edit');

  select * into v_profile
  from public.profiles
  where id = v_user_id and is_active = true;

  select * into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = v_profile.organization_id
  for update;
  if not found then raise exception 'Transfer not found'; end if;

  if v_transfer.workflow_version < 2
     or v_transfer.status <> 'pending'
     or coalesce(v_transfer.count_status, 'pending') <> 'pending' then
    raise exception 'Only an uncounted pending workflow transfer can be edited';
  end if;

  if v_profile.branch_id not in (v_transfer.source_branch_id, v_transfer.destination_branch_id)
     and not private.has_permission('branches.all', v_user_id) then
    raise exception 'Switch to a branch participating in this transfer before editing';
  end if;

  select * into v_source_branch
  from public.branches
  where id = p_source_branch_id
    and organization_id = v_profile.organization_id
    and is_active = true;
  if not found then raise exception 'Choose a valid From branch'; end if;

  select * into v_destination_branch
  from public.branches
  where id = p_destination_branch_id
    and organization_id = v_profile.organization_id
    and is_active = true;
  if not found then raise exception 'Choose a valid To branch'; end if;

  if v_source_branch.id = v_destination_branch.id then raise exception 'From and To branches must be different'; end if;

  if v_profile.branch_id not in (v_source_branch.id, v_destination_branch.id)
     and not private.has_permission('branches.all', v_user_id) then
    raise exception 'Your current branch must be either From or To';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product';
  end if;

  delete from public.stock_transfer_items where transfer_id = v_transfer.id;

  for v_item in
    select x.product_id, x.product_unit_id, x.quantity
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, product_unit_id uuid, quantity numeric)
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity <= 0 then
      raise exception 'Transfer quantities must be greater than zero';
    end if;

    if exists (
      select 1 from public.stock_transfer_items
      where transfer_id = v_transfer.id and product_id = v_item.product_id
    ) then
      raise exception 'The same product cannot be added twice to one transfer';
    end if;

    select * into v_product
    from public.products
    where id = v_item.product_id
      and organization_id = v_profile.organization_id
      and is_active = true
      and track_stock = true;
    if not found then raise exception 'Transfer product missing or inactive'; end if;

    v_unit_id := null;
    v_unit_name := null;
    v_unit_factor := null;

    if v_item.product_unit_id is not null then
      select pu.id, coalesce(nullif(pu.short_name, ''), pu.name), pu.conversion_factor
      into v_unit_id, v_unit_name, v_unit_factor
      from public.product_units pu
      where pu.id = v_item.product_unit_id
        and pu.product_id = v_product.id
        and pu.organization_id = v_profile.organization_id
        and (pu.is_active = true or pu.is_base = true);
      if not found then raise exception 'Selected unit is not valid for product %', v_product.name; end if;
    else
      select pu.id, coalesce(nullif(pu.short_name, ''), pu.name), pu.conversion_factor
      into v_unit_id, v_unit_name, v_unit_factor
      from public.product_units pu
      where pu.product_id = v_product.id
        and pu.organization_id = v_profile.organization_id
        and (pu.is_active = true or pu.is_base = true)
      order by pu.is_base desc, pu.sort_order, pu.created_at
      limit 1;
      if not found then
        v_unit_name := coalesce(nullif(v_product.unit_name, ''), 'pcs');
        v_unit_factor := 1;
      end if;
    end if;

    v_base_quantity := round(v_item.quantity * coalesce(v_unit_factor, 1), 3);

    insert into public.inventory_balances(
      organization_id, branch_id, product_id, quantity, average_cost
    ) values (
      v_profile.organization_id, v_source_branch.id, v_product.id, 0, coalesce(v_product.default_cost, 0)
    ) on conflict (branch_id, product_id) do nothing;

    select * into v_balance
    from public.inventory_balances
    where branch_id = v_source_branch.id and product_id = v_product.id;

    insert into public.stock_transfer_items(
      organization_id, transfer_id, product_id, quantity, unit_cost,
      requested_product_unit_id, requested_unit_name, requested_unit_factor, requested_unit_quantity
    ) values (
      v_profile.organization_id, v_transfer.id, v_product.id, v_base_quantity,
      coalesce(nullif(v_balance.average_cost, 0), v_product.default_cost, 0),
      v_unit_id, v_unit_name, coalesce(v_unit_factor, 1), v_item.quantity
    );

    v_total := v_total + 1;
  end loop;

  update public.stock_transfers
  set
    source_branch_id = v_source_branch.id,
    destination_branch_id = v_destination_branch.id,
    notes = nullif(trim(p_notes), ''),
    workflow_version = greatest(workflow_version, 3::smallint),
    requested_by_branch_id = coalesce(requested_by_branch_id, v_profile.branch_id),
    updated_at = now()
  where id = v_transfer.id;

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'status', 'pending',
    'item_count', v_total
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. Save/submit actual transfer counts in ANY configured package unit.
--    Counted quantity is converted to base units for inventory movement.
-- ----------------------------------------------------------------------------
create or replace function public.save_stock_transfer_count_v5(
  p_transfer_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_submit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_unit_id uuid;
  v_unit_name text;
  v_unit_factor numeric(14,3);
  v_base_quantity numeric(14,3);
  v_saved integer := 0;
begin
  if not private.has_permission('transfers.count', v_user_id)
     and not private.has_permission('transfers.receive', v_user_id) then
    raise exception 'Permission required: transfers.count';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id and is_active = true;

  select * into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = v_profile.organization_id
  for update;
  if not found then raise exception 'Transfer not found'; end if;

  if v_transfer.workflow_version < 2
     or v_transfer.status <> 'pending'
     or coalesce(v_transfer.count_status, 'pending') not in ('pending', 'counting') then
    raise exception 'This transfer is not open for counting';
  end if;

  if v_profile.branch_id not in (v_transfer.source_branch_id, v_transfer.destination_branch_id)
     and not private.has_permission('branches.all', v_user_id) then
    raise exception 'Switch to a branch participating in this transfer before counting';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Count items are required';
  end if;

  for v_item in
    select x.product_id, x.product_unit_id, x.counted_unit_quantity, x.note
    from jsonb_to_recordset(p_items)
      as x(product_id uuid, product_unit_id uuid, counted_unit_quantity numeric, note text)
  loop
    if v_item.product_id is null then raise exception 'Every count row requires a product'; end if;
    if v_item.counted_unit_quantity is not null and v_item.counted_unit_quantity < 0 then
      raise exception 'Counted quantity cannot be negative';
    end if;

    select p.* into v_product
    from public.stock_transfer_items sti
    join public.products p on p.id = sti.product_id
    where sti.transfer_id = v_transfer.id
      and sti.product_id = v_item.product_id;
    if not found then raise exception 'A counted product is not part of this transfer'; end if;

    if v_item.counted_unit_quantity is null then
      update public.stock_transfer_items
      set
        counted_quantity = null,
        counted_product_unit_id = null,
        counted_unit_name = null,
        counted_unit_factor = null,
        counted_unit_quantity = null,
        count_note = nullif(trim(coalesce(v_item.note, '')), '')
      where transfer_id = v_transfer.id and product_id = v_item.product_id;
    else
      v_unit_id := null;
      v_unit_name := null;
      v_unit_factor := null;

      if v_item.product_unit_id is not null then
        select pu.id, coalesce(nullif(pu.short_name, ''), pu.name), pu.conversion_factor
        into v_unit_id, v_unit_name, v_unit_factor
        from public.product_units pu
        where pu.id = v_item.product_unit_id
          and pu.product_id = v_product.id
          and pu.organization_id = v_profile.organization_id
          and (pu.is_active = true or pu.is_base = true);
        if not found then raise exception 'Selected count unit is not valid for product %', v_product.name; end if;
      else
        select pu.id, coalesce(nullif(pu.short_name, ''), pu.name), pu.conversion_factor
        into v_unit_id, v_unit_name, v_unit_factor
        from public.product_units pu
        where pu.product_id = v_product.id
          and pu.organization_id = v_profile.organization_id
          and (pu.is_active = true or pu.is_base = true)
        order by pu.is_base desc, pu.sort_order, pu.created_at
        limit 1;
        if not found then
          v_unit_name := coalesce(nullif(v_product.unit_name, ''), 'pcs');
          v_unit_factor := 1;
        end if;
      end if;

      v_base_quantity := round(v_item.counted_unit_quantity * coalesce(v_unit_factor, 1), 3);

      update public.stock_transfer_items
      set
        counted_quantity = v_base_quantity,
        counted_product_unit_id = v_unit_id,
        counted_unit_name = v_unit_name,
        counted_unit_factor = coalesce(v_unit_factor, 1),
        counted_unit_quantity = v_item.counted_unit_quantity,
        count_note = nullif(trim(coalesce(v_item.note, '')), '')
      where transfer_id = v_transfer.id and product_id = v_item.product_id;
    end if;

    v_saved := v_saved + 1;
  end loop;

  if p_submit and exists (
    select 1
    from public.stock_transfer_items
    where transfer_id = v_transfer.id
      and counted_quantity is null
  ) then
    raise exception 'Count every product before submitting for approval';
  end if;

  update public.stock_transfers
  set
    count_status = case when p_submit then 'awaiting_approval' else 'counting' end,
    count_notes = nullif(trim(p_notes), ''),
    counted_by = v_user_id,
    counted_at = now(),
    submitted_by = case when p_submit then v_user_id else submitted_by end,
    submitted_at = case when p_submit then now() else submitted_at end,
    updated_at = now()
  where id = v_transfer.id;

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'count_status', case when p_submit then 'awaiting_approval' else 'counting' end,
    'saved_items', v_saved
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Final approval. Either participating branch may approve when the user has
--    approval permission. Only NOW are base quantities deducted/added.
-- ----------------------------------------------------------------------------
create or replace function public.approve_stock_transfer_v5(
  p_transfer_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_item record;
  v_source public.inventory_balances%rowtype;
  v_destination public.inventory_balances%rowtype;
  v_quantity numeric(14,3);
  v_new_average numeric(14,4);
  v_batch public.inventory_batches%rowtype;
  v_remaining numeric(14,3);
  v_take numeric(14,3);
  v_transfer_batch_id uuid;
  v_destination_batch_id uuid;
  v_today date;
begin
  if not private.has_permission('transfers.approve', v_user_id)
     and not private.has_permission('approvals.review', v_user_id) then
    raise exception 'Permission required: transfers.approve';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id and is_active = true;

  select * into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = v_profile.organization_id
  for update;
  if not found then raise exception 'Transfer not found'; end if;

  if v_transfer.workflow_version < 2
     or v_transfer.status <> 'pending'
     or v_transfer.count_status <> 'awaiting_approval' then
    raise exception 'This transfer is not waiting for approval';
  end if;

  if v_profile.branch_id not in (v_transfer.source_branch_id, v_transfer.destination_branch_id)
     and not private.has_permission('branches.all', v_user_id) then
    raise exception 'Switch to a branch participating in this transfer before approval';
  end if;

  v_today := coalesce(private.batch_business_date(v_profile.organization_id), current_date);

  for v_item in
    select sti.*, p.name, p.default_cost, p.batch_tracking, p.expiry_tracking, p.picking_policy, p.unit_name
    from public.stock_transfer_items sti
    join public.products p on p.id = sti.product_id
    where sti.transfer_id = v_transfer.id
    order by sti.product_id
  loop
    if v_item.counted_quantity is null then raise exception 'Every product must be counted before approval'; end if;
    v_quantity := v_item.counted_quantity;
    if v_quantity <= 0 then continue; end if;

    insert into public.inventory_balances(
      organization_id, branch_id, product_id, quantity, average_cost
    ) values (
      v_profile.organization_id, v_transfer.source_branch_id, v_item.product_id, 0,
      coalesce(v_item.unit_cost, v_item.default_cost, 0)
    ) on conflict (branch_id, product_id) do nothing;

    select * into v_source
    from public.inventory_balances
    where branch_id = v_transfer.source_branch_id
      and product_id = v_item.product_id
    for update;

    if v_source.quantity < v_quantity then
      raise exception 'Not enough source stock for %. Available %, counted %',
        v_item.name, v_source.quantity, v_quantity;
    end if;

    insert into public.inventory_balances(
      organization_id, branch_id, product_id, quantity, average_cost
    ) values (
      v_profile.organization_id, v_transfer.destination_branch_id, v_item.product_id, 0,
      coalesce(v_item.unit_cost, v_item.default_cost, 0)
    ) on conflict (branch_id, product_id) do nothing;

    select * into v_destination
    from public.inventory_balances
    where branch_id = v_transfer.destination_branch_id
      and product_id = v_item.product_id
    for update;

    v_new_average := case
      when v_destination.quantity + v_quantity <= 0 then coalesce(v_item.unit_cost, 0)
      else round(
        ((v_destination.quantity * v_destination.average_cost)
          + (v_quantity * coalesce(v_item.unit_cost, 0)))
        / (v_destination.quantity + v_quantity),
        4
      )
    end;

    update public.inventory_balances
    set quantity = quantity - v_quantity, updated_at = now()
    where id = v_source.id;

    update public.inventory_balances
    set quantity = quantity + v_quantity,
        average_cost = v_new_average,
        updated_at = now()
    where id = v_destination.id;

    insert into public.stock_movements(
      organization_id, branch_id, product_id, movement_type, quantity_change,
      quantity_before, quantity_after, unit_cost, reference_table, reference_id,
      notes, created_by
    ) values
      (
        v_profile.organization_id, v_transfer.source_branch_id, v_item.product_id,
        'transfer_out', -v_quantity, v_source.quantity, v_source.quantity - v_quantity,
        coalesce(v_item.unit_cost, 0), 'stock_transfers', v_transfer.id,
        concat(v_transfer.transfer_number, ' approved transfer out'), v_user_id
      ),
      (
        v_profile.organization_id, v_transfer.destination_branch_id, v_item.product_id,
        'transfer_in', v_quantity, v_destination.quantity, v_destination.quantity + v_quantity,
        coalesce(v_item.unit_cost, 0), 'stock_transfers', v_transfer.id,
        concat(v_transfer.transfer_number, ' approved transfer in'), v_user_id
      );

    if coalesce(v_item.batch_tracking, false) then
      v_remaining := v_quantity;
      for v_batch in
        select *
        from public.inventory_batches b
        where b.branch_id = v_transfer.source_branch_id
          and b.product_id = v_item.product_id
          and b.status = 'active'
          and b.quantity > 0
          and (b.expiry_date is null or b.expiry_date >= v_today)
        order by
          case when v_item.picking_policy = 'fefo' then coalesce(b.expiry_date, '9999-12-31'::date) end,
          b.received_date,
          b.created_at
        for update
      loop
        exit when v_remaining <= 0.0005;
        v_take := least(v_remaining, v_batch.quantity);

        update public.inventory_batches
        set
          quantity = quantity - v_take,
          status = case
            when quantity - v_take <= 0.0005 then 'depleted'::public.inventory_batch_status
            else status
          end,
          updated_at = now()
        where id = v_batch.id;

        insert into public.stock_transfer_item_batches(
          organization_id, transfer_item_id, source_batch_id, batch_number,
          expiry_date, received_date, base_quantity, base_unit_cost, notes
        ) values (
          v_profile.organization_id, v_item.id, v_batch.id, v_batch.batch_number,
          v_batch.expiry_date, v_batch.received_date, v_take, v_batch.unit_cost, v_batch.notes
        ) returning id into v_transfer_batch_id;

        insert into public.inventory_batches(
          organization_id, branch_id, product_id, batch_number, expiry_date,
          received_date, source_type, source_transfer_item_id, initial_quantity,
          quantity, unit_cost, status, notes, created_by
        ) values (
          v_profile.organization_id, v_transfer.destination_branch_id, v_item.product_id,
          v_batch.batch_number, v_batch.expiry_date, v_batch.received_date,
          'transfer', v_item.id, v_take, v_take, v_batch.unit_cost,
          case
            when v_batch.expiry_date is not null and v_batch.expiry_date < v_today
              then 'quarantined'::public.inventory_batch_status
            else 'active'::public.inventory_batch_status
          end,
          v_batch.notes, v_user_id
        ) returning id into v_destination_batch_id;

        update public.stock_transfer_item_batches
        set destination_batch_id = v_destination_batch_id
        where id = v_transfer_batch_id;

        v_remaining := round(v_remaining - v_take, 3);
      end loop;

      if v_remaining > 0.0005 then
        raise exception 'Insufficient active batch stock for %', v_item.name;
      end if;
    end if;
  end loop;

  update public.stock_transfers
  set
    status = 'received',
    count_status = 'approved',
    received_by = v_user_id,
    received_at = now(),
    approved_by = v_user_id,
    approved_at = now(),
    approval_note = nullif(trim(p_note), ''),
    receive_notes = coalesce(count_notes, receive_notes),
    updated_at = now()
  where id = v_transfer.id;

  insert into public.audit_logs(
    organization_id, branch_id, user_id, action, entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id, v_profile.branch_id, v_user_id,
    'approve_stock_transfer', 'stock_transfer', v_transfer.id,
    jsonb_build_object(
      'transfer_number', v_transfer.transfer_number,
      'source_branch_id', v_transfer.source_branch_id,
      'destination_branch_id', v_transfer.destination_branch_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'status', 'received',
    'count_status', 'approved'
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Either participating branch may cancel an open workflow request.
-- ----------------------------------------------------------------------------
create or replace function public.cancel_stock_transfer_v5(
  p_transfer_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
begin
  perform private.require_permission('transfers.cancel');

  select * into v_profile
  from public.profiles
  where id = v_user_id and is_active = true;

  select * into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = v_profile.organization_id
  for update;
  if not found then raise exception 'Transfer not found'; end if;

  if v_transfer.workflow_version < 2 then
    return public.cancel_stock_transfer_v3(p_transfer_id, p_reason);
  end if;

  if v_transfer.status <> 'pending' then raise exception 'Only pending transfers can be cancelled'; end if;

  if v_profile.branch_id not in (v_transfer.source_branch_id, v_transfer.destination_branch_id)
     and not private.has_permission('branches.all', v_user_id) then
    raise exception 'Switch to a branch participating in this transfer before cancelling';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'Cancellation reason is required';
  end if;

  update public.stock_transfers
  set
    status = 'cancelled',
    count_status = 'cancelled',
    cancelled_by = v_user_id,
    cancelled_at = now(),
    cancel_reason = trim(p_reason),
    updated_at = now()
  where id = v_transfer.id;

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'status', 'cancelled'
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. Execute permissions
-- ----------------------------------------------------------------------------
revoke all on function public.get_stock_transfer_metrics_v5() from public, anon;
revoke all on function public.create_stock_transfer_v5(uuid, uuid, jsonb, text) from public, anon;
revoke all on function public.update_stock_transfer_v5(uuid, uuid, uuid, jsonb, text) from public, anon;
revoke all on function public.save_stock_transfer_count_v5(uuid, jsonb, text, boolean) from public, anon;
revoke all on function public.approve_stock_transfer_v5(uuid, text) from public, anon;
revoke all on function public.cancel_stock_transfer_v5(uuid, text) from public, anon;

grant execute on function public.get_stock_transfer_metrics_v5() to authenticated, service_role;
grant execute on function public.create_stock_transfer_v5(uuid, uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.update_stock_transfer_v5(uuid, uuid, uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.save_stock_transfer_count_v5(uuid, jsonb, text, boolean) to authenticated, service_role;
grant execute on function public.approve_stock_transfer_v5(uuid, text) to authenticated, service_role;
grant execute on function public.cancel_stock_transfer_v5(uuid, text) to authenticated, service_role;

commit;
