-- ============================================================================
-- Tiny POS - Step 46.15: Product history + all-branch stock summary
-- Run once AFTER Step 46.14.
--
-- Adds one read-only workspace RPC for Products > View.
-- It does not rewrite inventory, sales, purchase, refund, transfer or batch data.
-- ============================================================================

begin;

create index if not exists stock_movements_org_product_created_idx
  on public.stock_movements (organization_id, product_id, created_at desc);

create index if not exists inventory_batches_org_product_branch_idx
  on public.inventory_batches (organization_id, product_id, branch_id, expiry_date);

create or replace function public.get_product_stock_workspace(
  p_product_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_branch_id uuid;
  v_product public.products%rowtype;
  v_history jsonb := '[]'::jsonb;
  v_stock_summary jsonb := '[]'::jsonb;
  v_total_stock numeric := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  perform private.require_permission('products.manage');

  select p.organization_id, p.branch_id
  into v_organization_id, v_branch_id
  from public.profiles p
  where p.id = v_user_id
    and p.is_active = true;

  if v_organization_id is null then
    raise exception 'Active user profile is required';
  end if;

  select *
  into v_product
  from public.products p
  where p.id = p_product_id
    and p.organization_id = v_organization_id;

  if not found then
    raise exception 'Product not found';
  end if;

  with movement_rows as (
    select
      sm.id,
      sm.movement_type::text as movement_type,
      sm.quantity_change,
      sm.quantity_before,
      sm.quantity_after,
      sm.unit_cost,
      sm.reference_table,
      sm.reference_id,
      sm.notes,
      sm.created_at,
      sm.branch_id,
      b.name as branch_name,
      b.code as branch_code,
      coalesce(pr.full_name, pr.email, 'System') as created_by_name,
      case
        when sm.reference_table = 'sales' then
          (select s.invoice_number from public.sales s where s.id = sm.reference_id)
        when sm.reference_table = 'purchases' then
          (select pu.purchase_number from public.purchases pu where pu.id = sm.reference_id)
        when sm.reference_table = 'purchase_receipts' then
          (select grn.receipt_number from public.purchase_receipts grn where grn.id = sm.reference_id)
        when sm.reference_table = 'stock_transfers' then
          (select st.transfer_number from public.stock_transfers st where st.id = sm.reference_id)
        when sm.reference_table = 'returns' then
          (select r.return_number from public.returns r where r.id = sm.reference_id)
        when sm.reference_table = 'purchase_returns' then
          (select sr.return_number from public.purchase_returns sr where sr.id = sm.reference_id)
        when sm.reference_table = 'inventory_adjustments' then
          (select ia.adjustment_number from public.inventory_adjustments ia where ia.id = sm.reference_id)
        when sm.reference_table = 'stock_count_sessions' then
          (select sc.count_number from public.stock_count_sessions sc where sc.id = sm.reference_id)
        when sm.reference_table = 'inventory_batches' then
          (select ib.batch_number from public.inventory_batches ib where ib.id = sm.reference_id)
        when sm.reference_table = 'products' then v_product.sku
        else null
      end as resolved_code,
      case
        when sm.reference_table = 'stock_count_sessions' then 'Stock count'
        when sm.movement_type::text = 'opening' then 'Opening stock'
        when sm.movement_type::text = 'sale' then 'Sale'
        when sm.movement_type::text = 'sale_void' then 'Voided sale'
        when sm.movement_type::text = 'purchase' and sm.reference_table = 'purchase_receipts' then 'Purchase receipt'
        when sm.movement_type::text = 'purchase' then 'Purchase received'
        when sm.movement_type::text = 'purchase_cancel' then 'Purchase cancelled'
        when sm.movement_type::text = 'customer_return' then 'Customer refund / return'
        when sm.movement_type::text = 'supplier_return' then 'Supplier return'
        when sm.movement_type::text = 'transfer_in' then 'Stock transfer IN'
        when sm.movement_type::text = 'transfer_out' then 'Stock transfer OUT'
        when sm.movement_type::text = 'adjustment' and sm.reference_table = 'inventory_batches' then 'Batch adjustment'
        when sm.movement_type::text = 'adjustment' then 'Inventory adjustment'
        else initcap(replace(sm.movement_type::text, '_', ' '))
      end as type_label
    from public.stock_movements sm
    left join public.branches b on b.id = sm.branch_id
    left join public.profiles pr on pr.id = sm.created_by
    where sm.organization_id = v_organization_id
      and sm.product_id = p_product_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', mr.id,
        'code', coalesce(
          nullif(mr.resolved_code, ''),
          nullif(split_part(coalesce(mr.notes, ''), ' · ', 1), ''),
          'MOV-' || upper(left(mr.id::text, 8))
        ),
        'type', mr.type_label,
        'movement_type', mr.movement_type,
        'branch_id', mr.branch_id,
        'branch_name', coalesce(mr.branch_name, 'Unknown branch'),
        'branch_code', mr.branch_code,
        'created_by', mr.created_by_name,
        'created_at', mr.created_at,
        'amount', mr.quantity_change,
        'quantity_before', mr.quantity_before,
        'current_stock', mr.quantity_after,
        'unit_cost', mr.unit_cost,
        'reference_table', mr.reference_table,
        'reference_id', mr.reference_id,
        'notes', mr.notes
      )
      order by mr.created_at desc, mr.id desc
    ),
    '[]'::jsonb
  )
  into v_history
  from movement_rows mr;

  with batch_stats as (
    select
      ib.branch_id,
      count(*) filter (where ib.quantity > 0) as active_batches,
      coalesce(sum(ib.quantity) filter (where ib.quantity > 0), 0) as batch_quantity,
      min(ib.expiry_date) filter (where ib.quantity > 0 and ib.expiry_date is not null) as nearest_expiry,
      coalesce(sum(ib.quantity) filter (
        where ib.quantity > 0
          and ib.expiry_date is not null
          and ib.expiry_date <= current_date + 30
      ), 0) as expiring_30_days
    from public.inventory_batches ib
    where ib.organization_id = v_organization_id
      and ib.product_id = p_product_id
    group by ib.branch_id
  ), branch_rows as (
    select
      b.id,
      b.name,
      b.code,
      b.is_active,
      coalesce(ibal.quantity, 0) as quantity,
      coalesce(nullif(ibal.average_cost, 0), v_product.default_cost, 0) as average_cost,
      coalesce(bs.active_batches, 0) as active_batches,
      coalesce(bs.batch_quantity, 0) as batch_quantity,
      bs.nearest_expiry,
      coalesce(bs.expiring_30_days, 0) as expiring_30_days,
      (b.id = v_branch_id) as is_current_branch
    from public.branches b
    left join public.inventory_balances ibal
      on ibal.branch_id = b.id
     and ibal.product_id = p_product_id
    left join batch_stats bs
      on bs.branch_id = b.id
    where b.organization_id = v_organization_id
  )
  select
    coalesce(sum(br.quantity), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'branch_id', br.id,
          'branch_name', br.name,
          'branch_code', br.code,
          'branch_active', br.is_active,
          'is_current_branch', br.is_current_branch,
          'quantity', br.quantity,
          'unit_name', v_product.unit_name,
          'average_cost', br.average_cost,
          'stock_value', round(br.quantity * br.average_cost, 2),
          'active_batches', br.active_batches,
          'batch_quantity', br.batch_quantity,
          'nearest_expiry', br.nearest_expiry,
          'expiring_30_days', br.expiring_30_days,
          'low_stock_threshold', v_product.low_stock_threshold
        )
        order by br.is_current_branch desc, br.is_active desc, br.name
      ),
      '[]'::jsonb
    )
  into v_total_stock, v_stock_summary
  from branch_rows br;

  return jsonb_build_object(
    'product', jsonb_build_object(
      'id', v_product.id,
      'name', v_product.name,
      'name_km', v_product.name_km,
      'sku', v_product.sku,
      'barcode', v_product.barcode,
      'unit_name', v_product.unit_name,
      'currency', v_product.currency,
      'selling_price', v_product.selling_price,
      'default_cost', v_product.default_cost,
      'track_stock', v_product.track_stock,
      'batch_tracking', v_product.batch_tracking,
      'expiry_tracking', v_product.expiry_tracking,
      'picking_policy', v_product.picking_policy,
      'low_stock_threshold', v_product.low_stock_threshold
    ),
    'current_branch_id', v_branch_id,
    'total_stock', v_total_stock,
    'history', v_history,
    'stock_summary', v_stock_summary
  );
end;
$$;

revoke all on function public.get_product_stock_workspace(uuid) from public, anon;
grant execute on function public.get_product_stock_workspace(uuid) to authenticated, service_role;

commit;

-- ============================================================================
-- END Step 46.15
-- ============================================================================
