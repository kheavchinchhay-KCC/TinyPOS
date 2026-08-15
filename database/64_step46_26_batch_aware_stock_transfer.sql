-- ============================================================================
-- Tiny POS - Step 46.26: Batch-aware branch transfer allocation and merge
-- Run ONCE after migration 63.
--
-- Goals:
--   * Transfer Count can explicitly select one or more source Batch/Lot rows.
--   * Selected lots are snapshots only; no stock moves before final approval.
--   * Approval deducts the exact selected source lots.
--   * Destination receives the SAME lot number + expiry date.
--   * If the destination already has the same lot number + same expiry date,
--     Tiny POS merges into that existing destination batch instead of creating
--     a duplicate batch row.
--   * Old submitted workflow transfers without a saved manual allocation keep
--     working by falling back to FIFO/FEFO allocation at approval.
-- ============================================================================

begin;

-- Allow authorized transfer counters/approvers to read the batch-allocation
-- rows for a transfer where their current branch is an endpoint.
drop policy if exists stock_transfer_item_batches_read on public.stock_transfer_item_batches;
create policy stock_transfer_item_batches_read on public.stock_transfer_item_batches
for select to authenticated using (
  organization_id = (select private.current_organization_id())
  and exists (
    select 1
    from public.stock_transfer_items sti
    join public.stock_transfers st on st.id = sti.transfer_id
    where sti.id = transfer_item_id
      and (
        st.source_branch_id = (select private.current_branch_id())
        or st.destination_branch_id = (select private.current_branch_id())
      )
  )
  and (
    private.has_permission('inventory.view', auth.uid())
    or private.has_permission('transfers.create', auth.uid())
    or private.has_permission('transfers.receive', auth.uid())
    or private.has_permission('transfers.count', auth.uid())
    or private.has_permission('transfers.approve', auth.uid())
    or private.has_permission('approvals.review', auth.uid())
  )
);

create index if not exists inventory_batches_branch_lot_expiry_idx
  on public.inventory_batches(organization_id, branch_id, product_id, lower(trim(batch_number)), expiry_date);

-- ----------------------------------------------------------------------------
-- Source-batch options for one open transfer.
-- Security-definer is intentional: the counter can be working from the
-- destination branch but still needs to see only the source lots belonging to
-- this transfer. This function does not expose unrelated source inventory.
-- ----------------------------------------------------------------------------
create or replace function public.get_stock_transfer_batch_options_v6(
  p_transfer_id uuid
)
returns table (
  transfer_item_id uuid,
  product_id uuid,
  source_batch_id uuid,
  batch_number text,
  expiry_date date,
  received_date date,
  available_quantity numeric(14,3),
  unit_cost numeric(14,4),
  batch_status text,
  picking_policy text,
  recommended_order bigint
)
language plpgsql
stable
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_today date;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not private.has_permission('transfers.count', v_user_id)
     and not private.has_permission('transfers.receive', v_user_id)
     and not private.has_permission('transfers.approve', v_user_id)
     and not private.has_permission('approvals.review', v_user_id) then
    raise exception 'Permission required: transfers.count';
  end if;

  select * into v_profile
  from public.profiles
  where id = v_user_id and is_active = true;

  if not found or v_profile.branch_id is null then
    raise exception 'Active profile and branch required';
  end if;

  select * into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = v_profile.organization_id;

  if not found then
    raise exception 'Transfer not found';
  end if;

  if v_profile.branch_id not in (v_transfer.source_branch_id, v_transfer.destination_branch_id)
     and not private.has_permission('branches.all', v_user_id) then
    raise exception 'Switch to a branch participating in this transfer';
  end if;

  v_today := coalesce(private.batch_business_date(v_profile.organization_id), current_date);

  return query
  select
    sti.id,
    sti.product_id,
    b.id,
    b.batch_number,
    b.expiry_date,
    b.received_date,
    b.quantity,
    b.unit_cost,
    b.status::text,
    coalesce(p.picking_policy, 'fifo')::text,
    row_number() over (
      partition by sti.id
      order by
        case
          when coalesce(p.picking_policy, 'fifo') = 'fefo'
            then coalesce(b.expiry_date, '9999-12-31'::date)
          else null
        end,
        b.received_date,
        b.created_at,
        b.id
    )
  from public.stock_transfer_items sti
  join public.products p on p.id = sti.product_id
  join public.inventory_batches b
    on b.product_id = sti.product_id
   and b.branch_id = v_transfer.source_branch_id
   and b.organization_id = v_profile.organization_id
  where sti.transfer_id = v_transfer.id
    and coalesce(p.batch_tracking, false) = true
    and b.status = 'active'
    and b.quantity > 0
    and (b.expiry_date is null or b.expiry_date >= v_today)
  order by sti.id, recommended_order;
end;
$$;

-- ----------------------------------------------------------------------------
-- Save count + optional exact Batch/Lot allocation.
-- Batch allocation quantities are always stored in BASE units because batch
-- balances are base-unit balances. The normal Count quantity can still use any
-- configured package unit (pcs/can/box/etc.).
-- ----------------------------------------------------------------------------
create or replace function public.save_stock_transfer_count_v6(
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
  v_alloc record;
  v_product public.products%rowtype;
  v_source_batch public.inventory_batches%rowtype;
  v_unit_id uuid;
  v_unit_name text;
  v_unit_factor numeric(14,3);
  v_base_quantity numeric(14,3);
  v_allocated numeric(14,3);
  v_today date;
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

  v_today := coalesce(private.batch_business_date(v_profile.organization_id), current_date);

  for v_item in
    select
      x.product_id,
      x.product_unit_id,
      x.counted_unit_quantity,
      x.note,
      x.batch_allocations
    from jsonb_to_recordset(p_items)
      as x(
        product_id uuid,
        product_unit_id uuid,
        counted_unit_quantity numeric,
        note text,
        batch_allocations jsonb
      )
  loop
    if v_item.product_id is null then
      raise exception 'Every count row requires a product';
    end if;

    if v_item.counted_unit_quantity is not null and v_item.counted_unit_quantity < 0 then
      raise exception 'Counted quantity cannot be negative';
    end if;

    select p.* into v_product
    from public.stock_transfer_items sti
    join public.products p on p.id = sti.product_id
    where sti.transfer_id = v_transfer.id
      and sti.product_id = v_item.product_id;

    if not found then
      raise exception 'A counted product is not part of this transfer';
    end if;

    -- A pending v2/v3 workflow has not moved any batch stock yet, so these rows
    -- are safe to replace as the user's saved allocation plan.
    delete from public.stock_transfer_item_batches stib
    using public.stock_transfer_items sti
    where stib.transfer_item_id = sti.id
      and sti.transfer_id = v_transfer.id
      and sti.product_id = v_item.product_id
      and stib.destination_batch_id is null;

    if v_item.counted_unit_quantity is null then
      update public.stock_transfer_items
      set
        counted_quantity = null,
        counted_product_unit_id = null,
        counted_unit_name = null,
        counted_unit_factor = null,
        counted_unit_quantity = null,
        count_note = nullif(trim(coalesce(v_item.note, '')), '')
      where transfer_id = v_transfer.id
        and product_id = v_item.product_id;

      v_saved := v_saved + 1;
      continue;
    end if;

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

      if not found then
        raise exception 'Selected count unit is not valid for product %', v_product.name;
      end if;
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
    where transfer_id = v_transfer.id
      and product_id = v_item.product_id;

    if coalesce(v_product.batch_tracking, false) then
      if v_item.batch_allocations is not null
         and jsonb_typeof(v_item.batch_allocations) <> 'array' then
        raise exception 'Batch allocation for % must be a list', v_product.name;
      end if;

      if coalesce(jsonb_array_length(coalesce(v_item.batch_allocations, '[]'::jsonb)), 0) > 0 then
        for v_alloc in
          select x.source_batch_id, x.base_quantity
          from jsonb_to_recordset(v_item.batch_allocations)
            as x(source_batch_id uuid, base_quantity numeric)
        loop
          if v_alloc.source_batch_id is null
             or v_alloc.base_quantity is null
             or v_alloc.base_quantity <= 0 then
            raise exception 'Choose a valid Batch/Lot and quantity for %', v_product.name;
          end if;

          if exists (
            select 1
            from public.stock_transfer_item_batches stib
            join public.stock_transfer_items sti on sti.id = stib.transfer_item_id
            where sti.transfer_id = v_transfer.id
              and sti.product_id = v_item.product_id
              and stib.source_batch_id = v_alloc.source_batch_id
              and stib.destination_batch_id is null
          ) then
            raise exception 'The same Batch/Lot cannot be selected twice for %', v_product.name;
          end if;

          select * into v_source_batch
          from public.inventory_batches b
          where b.id = v_alloc.source_batch_id
            and b.organization_id = v_profile.organization_id
            and b.branch_id = v_transfer.source_branch_id
            and b.product_id = v_product.id
            and b.status = 'active'
            and b.quantity > 0
            and (b.expiry_date is null or b.expiry_date >= v_today);

          if not found then
            raise exception 'Selected Batch/Lot is no longer available for %', v_product.name;
          end if;

          if v_source_batch.quantity + 0.0005 < v_alloc.base_quantity then
            raise exception 'Batch % has only % % available',
              v_source_batch.batch_number,
              v_source_batch.quantity,
              coalesce(v_product.unit_name, 'pcs');
          end if;

          insert into public.stock_transfer_item_batches(
            organization_id,
            transfer_item_id,
            source_batch_id,
            batch_number,
            expiry_date,
            received_date,
            base_quantity,
            base_unit_cost,
            notes
          )
          select
            v_profile.organization_id,
            sti.id,
            v_source_batch.id,
            v_source_batch.batch_number,
            v_source_batch.expiry_date,
            v_source_batch.received_date,
            round(v_alloc.base_quantity, 3),
            v_source_batch.unit_cost,
            v_source_batch.notes
          from public.stock_transfer_items sti
          where sti.transfer_id = v_transfer.id
            and sti.product_id = v_item.product_id;
        end loop;
      end if;

      select coalesce(sum(stib.base_quantity), 0)
      into v_allocated
      from public.stock_transfer_item_batches stib
      join public.stock_transfer_items sti on sti.id = stib.transfer_item_id
      where sti.transfer_id = v_transfer.id
        and sti.product_id = v_item.product_id
        and stib.destination_batch_id is null;

      if p_submit and abs(v_allocated - v_base_quantity) > 0.0005 then
        raise exception 'Batch/Lot allocation for % must equal the counted base quantity. Counted %, allocated %',
          v_product.name, v_base_quantity, v_allocated;
      end if;
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
    workflow_version = greatest(workflow_version, 4::smallint),
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
    'saved_items', v_saved,
    'batch_allocation', true
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Final approval using exact saved source Batch/Lot allocation.
-- If an old submitted workflow has no allocation rows, create an automatic
-- FIFO/FEFO plan first so it remains backward compatible.
-- ----------------------------------------------------------------------------
create or replace function public.approve_stock_transfer_v6(
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
  v_source_batch public.inventory_batches%rowtype;
  v_destination_batch public.inventory_batches%rowtype;
  v_alloc record;
  v_pick public.inventory_batches%rowtype;
  v_quantity numeric(14,3);
  v_remaining numeric(14,3);
  v_take numeric(14,3);
  v_allocated numeric(14,3);
  v_transfer_unit_cost numeric(14,4);
  v_new_average numeric(14,4);
  v_destination_batch_cost numeric(14,4);
  v_transfer_batch_id uuid;
  v_destination_batch_id uuid;
  v_today date;
  v_allocation_count integer;
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
    select
      sti.*,
      p.name,
      p.default_cost,
      p.batch_tracking,
      p.expiry_tracking,
      p.picking_policy,
      p.unit_name
    from public.stock_transfer_items sti
    join public.products p on p.id = sti.product_id
    where sti.transfer_id = v_transfer.id
    order by sti.product_id
  loop
    if v_item.counted_quantity is null then
      raise exception 'Every product must be counted before approval';
    end if;

    v_quantity := v_item.counted_quantity;
    if v_quantity <= 0 then
      -- A zero-count line should not carry a batch allocation.
      delete from public.stock_transfer_item_batches
      where transfer_item_id = v_item.id
        and destination_batch_id is null;
      continue;
    end if;

    v_transfer_unit_cost := coalesce(v_item.unit_cost, v_item.default_cost, 0);

    if coalesce(v_item.batch_tracking, false) then
      select count(*), coalesce(sum(stib.base_quantity), 0)
      into v_allocation_count, v_allocated
      from public.stock_transfer_item_batches stib
      where stib.transfer_item_id = v_item.id
        and stib.destination_batch_id is null;

      -- Backward compatibility for counts submitted before Step 46.26.
      if v_allocation_count = 0 then
        v_remaining := v_quantity;

        for v_pick in
          select *
          from public.inventory_batches b
          where b.branch_id = v_transfer.source_branch_id
            and b.product_id = v_item.product_id
            and b.organization_id = v_profile.organization_id
            and b.status = 'active'
            and b.quantity > 0
            and (b.expiry_date is null or b.expiry_date >= v_today)
          order by
            case
              when coalesce(v_item.picking_policy, 'fifo') = 'fefo'
                then coalesce(b.expiry_date, '9999-12-31'::date)
              else null
            end,
            b.received_date,
            b.created_at,
            b.id
          for update
        loop
          exit when v_remaining <= 0.0005;
          v_take := least(v_remaining, v_pick.quantity);

          insert into public.stock_transfer_item_batches(
            organization_id, transfer_item_id, source_batch_id, batch_number,
            expiry_date, received_date, base_quantity, base_unit_cost, notes
          ) values (
            v_profile.organization_id, v_item.id, v_pick.id, v_pick.batch_number,
            v_pick.expiry_date, v_pick.received_date, v_take, v_pick.unit_cost, v_pick.notes
          );

          v_remaining := round(v_remaining - v_take, 3);
        end loop;

        if v_remaining > 0.0005 then
          raise exception 'Insufficient active Batch/Lot stock for %', v_item.name;
        end if;

        select count(*), coalesce(sum(stib.base_quantity), 0)
        into v_allocation_count, v_allocated
        from public.stock_transfer_item_batches stib
        where stib.transfer_item_id = v_item.id
          and stib.destination_batch_id is null;
      end if;

      if abs(v_allocated - v_quantity) > 0.0005 then
        raise exception 'Batch/Lot allocation for % does not match counted quantity. Counted %, allocated %',
          v_item.name, v_quantity, v_allocated;
      end if;

      select round(
        coalesce(sum(stib.base_quantity * b.unit_cost), 0)
        / nullif(v_quantity, 0),
        4
      )
      into v_transfer_unit_cost
      from public.stock_transfer_item_batches stib
      join public.inventory_batches b on b.id = stib.source_batch_id
      where stib.transfer_item_id = v_item.id
        and stib.destination_batch_id is null;

      v_transfer_unit_cost := coalesce(v_transfer_unit_cost, v_item.unit_cost, v_item.default_cost, 0);
    end if;

    insert into public.inventory_balances(
      organization_id, branch_id, product_id, quantity, average_cost
    ) values (
      v_profile.organization_id,
      v_transfer.source_branch_id,
      v_item.product_id,
      0,
      v_transfer_unit_cost
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
      v_profile.organization_id,
      v_transfer.destination_branch_id,
      v_item.product_id,
      0,
      v_transfer_unit_cost
    ) on conflict (branch_id, product_id) do nothing;

    select * into v_destination
    from public.inventory_balances
    where branch_id = v_transfer.destination_branch_id
      and product_id = v_item.product_id
    for update;

    v_new_average := case
      when v_destination.quantity + v_quantity <= 0 then v_transfer_unit_cost
      else round(
        ((v_destination.quantity * v_destination.average_cost)
          + (v_quantity * v_transfer_unit_cost))
        / (v_destination.quantity + v_quantity),
        4
      )
    end;

    if coalesce(v_item.batch_tracking, false) then
      -- Lock and validate every exact source lot before changing balances.
      for v_alloc in
        select
          stib.id as transfer_batch_id,
          stib.base_quantity as allocated_quantity,
          stib.source_batch_id
        from public.stock_transfer_item_batches stib
        where stib.transfer_item_id = v_item.id
          and stib.destination_batch_id is null
        order by stib.created_at, stib.id
      loop
        select * into v_source_batch
        from public.inventory_batches b
        where b.id = v_alloc.source_batch_id
          and b.organization_id = v_profile.organization_id
          and b.branch_id = v_transfer.source_branch_id
          and b.product_id = v_item.product_id
        for update;

        if not found
           or v_source_batch.status <> 'active'
           or v_source_batch.quantity + 0.0005 < v_alloc.allocated_quantity
           or (v_source_batch.expiry_date is not null and v_source_batch.expiry_date < v_today) then
          raise exception 'Selected Batch/Lot is no longer available for %', v_item.name;
        end if;
      end loop;
    end if;

    update public.inventory_balances
    set quantity = quantity - v_quantity,
        updated_at = now()
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
        v_profile.organization_id,
        v_transfer.source_branch_id,
        v_item.product_id,
        'transfer_out',
        -v_quantity,
        v_source.quantity,
        v_source.quantity - v_quantity,
        v_transfer_unit_cost,
        'stock_transfers',
        v_transfer.id,
        concat(v_transfer.transfer_number, ' approved transfer out'),
        v_user_id
      ),
      (
        v_profile.organization_id,
        v_transfer.destination_branch_id,
        v_item.product_id,
        'transfer_in',
        v_quantity,
        v_destination.quantity,
        v_destination.quantity + v_quantity,
        v_transfer_unit_cost,
        'stock_transfers',
        v_transfer.id,
        concat(v_transfer.transfer_number, ' approved transfer in'),
        v_user_id
      );

    if coalesce(v_item.batch_tracking, false) then
      for v_alloc in
        select
          stib.id as transfer_batch_id,
          stib.base_quantity as allocated_quantity,
          stib.source_batch_id
        from public.stock_transfer_item_batches stib
        where stib.transfer_item_id = v_item.id
          and stib.destination_batch_id is null
        order by stib.created_at, stib.id
      loop
        select * into v_source_batch
        from public.inventory_batches b
        where b.id = v_alloc.source_batch_id
        for update;

        v_take := v_alloc.allocated_quantity;

        update public.inventory_batches
        set
          quantity = quantity - v_take,
          status = case
            when quantity - v_take <= 0.0005
              then 'depleted'::public.inventory_batch_status
            else status
          end,
          updated_at = now()
        where id = v_source_batch.id;

        -- Merge only when BOTH lot number and expiry match. A lot with the same
        -- number but a different expiry remains a separate traceable batch.
        select * into v_destination_batch
        from public.inventory_batches b
        where b.organization_id = v_profile.organization_id
          and b.branch_id = v_transfer.destination_branch_id
          and b.product_id = v_item.product_id
          and lower(trim(b.batch_number)) = lower(trim(v_source_batch.batch_number))
          and b.expiry_date is not distinct from v_source_batch.expiry_date
        order by
          case b.status
            when 'active' then 0
            when 'depleted' then 1
            else 2
          end,
          b.created_at,
          b.id
        limit 1
        for update;

        if found then
          v_destination_batch_cost := case
            when v_destination_batch.quantity + v_take <= 0 then v_source_batch.unit_cost
            else round(
              ((v_destination_batch.quantity * v_destination_batch.unit_cost)
                + (v_take * v_source_batch.unit_cost))
              / (v_destination_batch.quantity + v_take),
              4
            )
          end;

          update public.inventory_batches
          set
            initial_quantity = initial_quantity + v_take,
            quantity = quantity + v_take,
            unit_cost = v_destination_batch_cost,
            received_date = least(received_date, v_source_batch.received_date),
            status = case
              when v_source_batch.expiry_date is not null and v_source_batch.expiry_date < v_today
                then 'quarantined'::public.inventory_batch_status
              when v_destination_batch.status = 'quarantined'
                then 'quarantined'::public.inventory_batch_status
              else 'active'::public.inventory_batch_status
            end,
            updated_at = now()
          where id = v_destination_batch.id
          returning id into v_destination_batch_id;
        else
          insert into public.inventory_batches(
            organization_id,
            branch_id,
            product_id,
            batch_number,
            expiry_date,
            received_date,
            source_type,
            source_transfer_item_id,
            initial_quantity,
            quantity,
            unit_cost,
            status,
            notes,
            created_by
          ) values (
            v_profile.organization_id,
            v_transfer.destination_branch_id,
            v_item.product_id,
            v_source_batch.batch_number,
            v_source_batch.expiry_date,
            v_source_batch.received_date,
            'transfer',
            v_item.id,
            v_take,
            v_take,
            v_source_batch.unit_cost,
            case
              when v_source_batch.expiry_date is not null and v_source_batch.expiry_date < v_today
                then 'quarantined'::public.inventory_batch_status
              else 'active'::public.inventory_batch_status
            end,
            v_source_batch.notes,
            v_user_id
          )
          returning id into v_destination_batch_id;
        end if;

        update public.stock_transfer_item_batches
        set
          destination_batch_id = v_destination_batch_id,
          batch_number = v_source_batch.batch_number,
          expiry_date = v_source_batch.expiry_date,
          received_date = v_source_batch.received_date,
          base_unit_cost = v_source_batch.unit_cost
        where id = v_alloc.transfer_batch_id;
      end loop;
    end if;
  end loop;

  update public.stock_transfers
  set
    workflow_version = greatest(workflow_version, 4::smallint),
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
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'approve_stock_transfer',
    'stock_transfer',
    v_transfer.id,
    jsonb_build_object(
      'transfer_number', v_transfer.transfer_number,
      'source_branch_id', v_transfer.source_branch_id,
      'destination_branch_id', v_transfer.destination_branch_id,
      'batch_allocation', 'exact_or_fifo_fefo_fallback',
      'destination_batch_merge', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'transfer_id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'status', 'received',
    'count_status', 'approved',
    'batch_allocation', true,
    'destination_batch_merge', true
  );
end;
$$;

-- Clean an unapproved saved allocation when a workflow transfer is cancelled.
create or replace function public.cancel_stock_transfer_v6(
  p_transfer_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_transfer public.stock_transfers%rowtype;
  v_result jsonb;
begin
  select * into v_transfer
  from public.stock_transfers
  where id = p_transfer_id
    and organization_id = private.current_organization_id();

  if not found then raise exception 'Transfer not found'; end if;

  if v_transfer.workflow_version < 2 then
    return public.cancel_stock_transfer_v3(p_transfer_id, p_reason);
  end if;

  v_result := public.cancel_stock_transfer_v5(p_transfer_id, p_reason);

  delete from public.stock_transfer_item_batches stib
  using public.stock_transfer_items sti
  where stib.transfer_item_id = sti.id
    and sti.transfer_id = p_transfer_id
    and stib.destination_batch_id is null;

  return v_result || jsonb_build_object('batch_allocation_cleared', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- Execute permissions. Old v5 approval is removed from authenticated clients so
-- a cached client cannot ignore a manually saved lot allocation and approve via
-- the older automatic allocator. Service role keeps it for controlled recovery.
-- ----------------------------------------------------------------------------
revoke all on function public.get_stock_transfer_batch_options_v6(uuid) from public, anon;
revoke all on function public.save_stock_transfer_count_v6(uuid, jsonb, text, boolean) from public, anon;
revoke all on function public.approve_stock_transfer_v6(uuid, text) from public, anon;
revoke all on function public.cancel_stock_transfer_v6(uuid, text) from public, anon;

grant execute on function public.get_stock_transfer_batch_options_v6(uuid) to authenticated, service_role;
grant execute on function public.save_stock_transfer_count_v6(uuid, jsonb, text, boolean) to authenticated, service_role;
grant execute on function public.approve_stock_transfer_v6(uuid, text) to authenticated, service_role;
grant execute on function public.cancel_stock_transfer_v6(uuid, text) to authenticated, service_role;

revoke execute on function public.approve_stock_transfer_v5(uuid, text) from authenticated;
grant execute on function public.approve_stock_transfer_v5(uuid, text) to service_role;

commit;
