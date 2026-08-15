-- ============================================================================
-- Tiny POS - Step 7: Returns and refunds
-- Run once in the NEW Supabase project.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

-- Preserve refund tax, cost, profit reversal, and optional payment reference.
alter table public.returns
  add column if not exists tax_refund numeric(14,2) not null default 0
    check (tax_refund >= 0),
  add column if not exists cost_amount numeric(14,4) not null default 0
    check (cost_amount >= 0),
  add column if not exists profit_reversal numeric(14,4) not null default 0,
  add column if not exists refund_reference text;

alter table public.return_items
  add column if not exists tax_refund numeric(14,2) not null default 0
    check (tax_refund >= 0),
  add column if not exists unit_cost numeric(14,4) not null default 0
    check (unit_cost >= 0),
  add column if not exists line_cost numeric(14,4) not null default 0
    check (line_cost >= 0),
  add column if not exists line_profit_reversal numeric(14,4) not null default 0;

create index if not exists returns_sale_processed_idx
  on public.returns (original_sale_id, processed_at desc);

create index if not exists returns_org_branch_processed_idx
  on public.returns (organization_id, branch_id, processed_at desc);

create index if not exists return_items_sale_item_idx
  on public.return_items (sale_item_id);

-- ----------------------------------------------------------------------------
-- Secure transactional return/refund
--
-- p_items example:
-- [
--   {
--     "sale_item_id": "uuid",
--     "quantity": 1,
--     "restock": true
--   }
-- ]
-- ----------------------------------------------------------------------------

create or replace function public.process_sale_return(
  p_sale_id uuid,
  p_items jsonb,
  p_refund_method public.payment_method,
  p_reason text,
  p_refund_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid;
  v_profile record;
  v_sale record;
  v_item record;
  v_sale_item record;
  v_balance record;

  v_return_id uuid;
  v_return_number text;
  v_new_sale_status public.sale_status;
  v_new_payment_status public.payment_status;

  v_previous_returned numeric(14,3);
  v_available numeric(14,3);
  v_requested numeric(14,3);

  v_sale_line_total numeric(14,2);
  v_previous_tax_refunded numeric(14,2);
  v_remaining_tax numeric(14,2);

  v_net_refund numeric(14,2);
  v_tax_refund numeric(14,2);
  v_line_refund numeric(14,2);
  v_unit_refund numeric(14,2);
  v_line_cost numeric(14,4);
  v_profit_reversal numeric(14,4);

  v_total_refund numeric(14,2) := 0;
  v_total_tax_refund numeric(14,2) := 0;
  v_total_cost numeric(14,4) := 0;
  v_total_profit_reversal numeric(14,4) := 0;

  v_total_sold_qty numeric(14,3);
  v_total_returned_qty numeric(14,3);

  v_new_quantity numeric(14,3);
  v_new_average_cost numeric(14,4);
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select
    p.organization_id,
    p.branch_id,
    p.role,
    p.is_active
  into v_profile
  from public.profiles p
  where p.id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Your POS user account is inactive or missing';
  end if;

  if v_profile.role not in ('owner', 'admin', 'manager') then
    raise exception 'Only an owner, admin, or manager can process refunds';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to refund';
  end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'A refund reason is required';
  end if;

  select s.*
  into v_sale
  from public.sales s
  where s.id = p_sale_id
    and s.organization_id = v_profile.organization_id
  for update;

  if not found then
    raise exception 'Sale not found';
  end if;

  if v_sale.branch_id <> v_profile.branch_id then
    raise exception 'This sale belongs to another branch';
  end if;

  if v_sale.status not in ('completed', 'partially_refunded') then
    raise exception 'This sale cannot be refunded because its status is %', v_sale.status;
  end if;

  select coalesce(sum(si.line_total), 0)
  into v_sale_line_total
  from public.sale_items si
  where si.sale_id = v_sale.id;

  select coalesce(sum(ri.tax_refund), 0)
  into v_previous_tax_refunded
  from public.return_items ri
  join public.returns r
    on r.id = ri.return_id
  where r.original_sale_id = v_sale.id
    and r.status = 'completed';

  v_remaining_tax := greatest(v_sale.tax_amount - v_previous_tax_refunded, 0);

  v_return_number := private.next_document_number(
    v_profile.organization_id,
    v_profile.branch_id,
    'RET'
  );

  insert into public.returns (
    organization_id,
    branch_id,
    return_number,
    original_sale_id,
    customer_id,
    status,
    currency,
    refund_amount,
    refund_method,
    reason,
    processed_by,
    processed_at,
    tax_refund,
    cost_amount,
    profit_reversal,
    refund_reference
  )
  values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_return_number,
    v_sale.id,
    v_sale.customer_id,
    'completed',
    v_sale.currency,
    0,
    p_refund_method,
    trim(p_reason),
    v_user_id,
    now(),
    0,
    0,
    0,
    nullif(trim(p_refund_reference), '')
  )
  returning id into v_return_id;

  -- Lock each sale item so two managers cannot refund the same quantity
  -- at the same time.
  for v_item in
    select
      x.sale_item_id,
      sum(x.quantity)::numeric(14,3) as quantity,
      bool_and(coalesce(x.restock, true)) as restock
    from jsonb_to_recordset(p_items)
      as x(sale_item_id uuid, quantity numeric, restock boolean)
    group by x.sale_item_id
    order by x.sale_item_id
  loop
    v_requested := v_item.quantity;

    if v_item.sale_item_id is null
       or v_requested is null
       or v_requested <= 0 then
      raise exception 'Every refund item requires a valid quantity';
    end if;

    select
      si.id,
      si.sale_id,
      si.product_id,
      si.product_name,
      si.quantity,
      si.unit_price,
      si.unit_cost,
      si.line_total,
      p.track_stock
    into v_sale_item
    from public.sale_items si
    left join public.products p
      on p.id = si.product_id
    where si.id = v_item.sale_item_id
      and si.sale_id = v_sale.id
    for update of si;

    if not found then
      raise exception 'Sale item % does not belong to this sale', v_item.sale_item_id;
    end if;

    select coalesce(sum(ri.quantity), 0)
    into v_previous_returned
    from public.return_items ri
    join public.returns r
      on r.id = ri.return_id
    where ri.sale_item_id = v_sale_item.id
      and r.status = 'completed';

    v_available := v_sale_item.quantity - v_previous_returned;

    if v_requested > v_available then
      raise exception
        'Only % of "%" can still be refunded',
        v_available,
        v_sale_item.product_name;
    end if;

    -- Refund the same proportion of the line's net amount and remaining tax.
    v_net_refund := round(
      v_sale_item.line_total * v_requested / v_sale_item.quantity,
      2
    );

    if v_sale_line_total > 0 and v_remaining_tax > 0 then
      v_tax_refund := least(
        v_remaining_tax,
        round(
          v_sale.tax_amount
          * (v_sale_item.line_total / v_sale_line_total)
          * (v_requested / v_sale_item.quantity),
          2
        )
      );
    else
      v_tax_refund := 0;
    end if;

    v_remaining_tax := greatest(v_remaining_tax - v_tax_refund, 0);
    v_line_refund := round(v_net_refund + v_tax_refund, 2);
    v_unit_refund := round(v_line_refund / v_requested, 2);
    v_line_cost := round(v_sale_item.unit_cost * v_requested, 4);
    v_profit_reversal := round(v_net_refund - v_line_cost, 4);

    insert into public.return_items (
      organization_id,
      return_id,
      sale_item_id,
      product_id,
      quantity,
      unit_refund,
      line_refund,
      restock,
      tax_refund,
      unit_cost,
      line_cost,
      line_profit_reversal
    )
    values (
      v_profile.organization_id,
      v_return_id,
      v_sale_item.id,
      v_sale_item.product_id,
      v_requested,
      v_unit_refund,
      v_line_refund,
      coalesce(v_item.restock, true),
      v_tax_refund,
      v_sale_item.unit_cost,
      v_line_cost,
      v_profit_reversal
    );

    v_total_refund := v_total_refund + v_line_refund;
    v_total_tax_refund := v_total_tax_refund + v_tax_refund;
    v_total_cost := v_total_cost + v_line_cost;
    v_total_profit_reversal :=
      v_total_profit_reversal + v_profit_reversal;

    if coalesce(v_item.restock, true)
       and v_sale_item.product_id is not null
       and coalesce(v_sale_item.track_stock, false) then

      insert into public.inventory_balances (
        organization_id,
        branch_id,
        product_id,
        quantity,
        average_cost
      )
      values (
        v_profile.organization_id,
        v_profile.branch_id,
        v_sale_item.product_id,
        0,
        v_sale_item.unit_cost
      )
      on conflict (branch_id, product_id) do nothing;

      select
        ib.quantity,
        ib.average_cost
      into v_balance
      from public.inventory_balances ib
      where ib.branch_id = v_profile.branch_id
        and ib.product_id = v_sale_item.product_id
      for update;

      v_new_quantity := v_balance.quantity + v_requested;

      if v_new_quantity > 0 and v_balance.quantity >= 0 then
        v_new_average_cost := round(
          (
            (v_balance.quantity * v_balance.average_cost)
            + (v_requested * v_sale_item.unit_cost)
          ) / v_new_quantity,
          4
        );
      else
        v_new_average_cost := v_sale_item.unit_cost;
      end if;

      update public.inventory_balances
      set
        quantity = v_new_quantity,
        average_cost = v_new_average_cost,
        updated_at = now()
      where branch_id = v_profile.branch_id
        and product_id = v_sale_item.product_id;

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
        v_sale_item.product_id,
        'customer_return',
        v_requested,
        v_balance.quantity,
        v_new_quantity,
        v_sale_item.unit_cost,
        'returns',
        v_return_id,
        v_return_number,
        v_user_id
      );
    end if;
  end loop;

  if v_total_refund <= 0 then
    raise exception 'Refund amount must be greater than zero';
  end if;

  update public.returns
  set
    refund_amount = v_total_refund,
    tax_refund = v_total_tax_refund,
    cost_amount = v_total_cost,
    profit_reversal = v_total_profit_reversal
  where id = v_return_id;

  select coalesce(sum(si.quantity), 0)
  into v_total_sold_qty
  from public.sale_items si
  where si.sale_id = v_sale.id;

  select coalesce(sum(ri.quantity), 0)
  into v_total_returned_qty
  from public.return_items ri
  join public.returns r
    on r.id = ri.return_id
  where r.original_sale_id = v_sale.id
    and r.status = 'completed';

  if v_total_returned_qty >= v_total_sold_qty then
    v_new_sale_status := 'refunded';
    v_new_payment_status := 'refunded';
  else
    v_new_sale_status := 'partially_refunded';
    v_new_payment_status := 'partial';
  end if;

  update public.sales
  set
    status = v_new_sale_status,
    payment_status = v_new_payment_status,
    updated_at = now()
  where id = v_sale.id;

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
    'process_sale_return',
    'return',
    v_return_id,
    jsonb_build_object(
      'return_number', v_return_number,
      'invoice_number', v_sale.invoice_number,
      'refund_amount', v_total_refund,
      'tax_refund', v_total_tax_refund,
      'cost_amount', v_total_cost,
      'profit_reversal', v_total_profit_reversal,
      'sale_status', v_new_sale_status,
      'reason', trim(p_reason)
    )
  );

  return jsonb_build_object(
    'ok', true,
    'return_id', v_return_id,
    'return_number', v_return_number,
    'sale_id', v_sale.id,
    'invoice_number', v_sale.invoice_number,
    'currency', v_sale.currency,
    'refund_amount', v_total_refund,
    'tax_refund', v_total_tax_refund,
    'cost_amount', v_total_cost,
    'profit_reversal', v_total_profit_reversal,
    'sale_status', v_new_sale_status,
    'processed_at', now()
  );
end;
$$;

revoke all on function public.process_sale_return(
  uuid,
  jsonb,
  public.payment_method,
  text,
  text
) from public, anon;

grant execute on function public.process_sale_return(
  uuid,
  jsonb,
  public.payment_method,
  text,
  text
) to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 7
-- ============================================================================
