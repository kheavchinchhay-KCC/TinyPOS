-- ============================================================================
-- Tiny POS - Step 35: Batch, Lot, Expiry and FIFO/FEFO Inventory
-- Run once in the NEW Supabase project after Step 34.
--
-- Adds traceable inventory batches, expiry controls, FIFO/FEFO sale allocation,
-- batch-aware receiving, customer returns, supplier returns and branch transfers.
-- Existing aggregate inventory remains the accounting source of truth while
-- batch quantities provide traceability and picking control.
-- ============================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'inventory_picking_policy') then
    create type public.inventory_picking_policy as enum ('fifo','fefo');
  end if;
  if not exists (select 1 from pg_type where typname = 'inventory_batch_status') then
    create type public.inventory_batch_status as enum ('active','quarantined','depleted');
  end if;
end
$$;

alter table public.products
  add column if not exists batch_tracking boolean not null default false,
  add column if not exists expiry_tracking boolean not null default false,
  add column if not exists picking_policy public.inventory_picking_policy not null default 'fifo',
  add column if not exists default_shelf_life_days integer;

alter table public.products
  drop constraint if exists products_expiry_requires_batch_check;
alter table public.products
  add constraint products_expiry_requires_batch_check
  check (not expiry_tracking or batch_tracking);

alter table public.products
  drop constraint if exists products_shelf_life_days_check;
alter table public.products
  add constraint products_shelf_life_days_check
  check (default_shelf_life_days is null or default_shelf_life_days > 0);

create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  batch_number text not null check (length(trim(batch_number)) between 1 and 100),
  expiry_date date,
  received_date date not null default current_date,
  source_type text not null default 'opening'
    check (source_type in ('opening','manual','purchase','transfer','customer_return')),
  purchase_receipt_item_id uuid references public.purchase_receipt_items(id) on delete set null,
  source_transfer_item_id uuid references public.stock_transfer_items(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  initial_quantity numeric(14,3) not null check (initial_quantity >= 0),
  quantity numeric(14,3) not null check (quantity >= 0),
  unit_cost numeric(14,4) not null default 0 check (unit_cost >= 0),
  status public.inventory_batch_status not null default 'active',
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quantity <= initial_quantity or source_type in ('manual','customer_return'))
);

create index if not exists inventory_batches_product_pick_idx
  on public.inventory_batches(branch_id,product_id,status,expiry_date,received_date,created_at)
  where quantity > 0;
create index if not exists inventory_batches_expiry_idx
  on public.inventory_batches(organization_id,branch_id,expiry_date)
  where quantity > 0 and expiry_date is not null;
create index if not exists inventory_batches_lot_idx
  on public.inventory_batches(organization_id,product_id,batch_number);

drop trigger if exists set_inventory_batches_updated_at on public.inventory_batches;
create trigger set_inventory_batches_updated_at
before update on public.inventory_batches
for each row execute function public.set_updated_at();

create table if not exists public.purchase_receipt_item_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  receipt_item_id uuid not null references public.purchase_receipt_items(id) on delete cascade,
  inventory_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  purchase_unit_quantity numeric(14,3) not null check (purchase_unit_quantity > 0),
  base_quantity numeric(14,3) not null check (base_quantity > 0),
  unit_cost numeric(14,4) not null check (unit_cost >= 0),
  created_at timestamptz not null default now()
);
create index if not exists purchase_receipt_item_batches_receipt_idx
  on public.purchase_receipt_item_batches(receipt_item_id);

create table if not exists public.sale_item_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sale_item_id uuid not null references public.sale_items(id) on delete cascade,
  inventory_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  base_quantity numeric(14,3) not null check (base_quantity > 0),
  base_unit_cost numeric(14,4) not null check (base_unit_cost >= 0),
  cost_total numeric(14,4) not null check (cost_total >= 0),
  allocation_order integer not null check (allocation_order > 0),
  created_at timestamptz not null default now(),
  unique(sale_item_id,inventory_batch_id)
);
create index if not exists sale_item_batches_sale_idx on public.sale_item_batches(sale_item_id);

create table if not exists public.return_item_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  return_item_id uuid not null references public.return_items(id) on delete cascade,
  sale_item_batch_id uuid references public.sale_item_batches(id) on delete restrict,
  inventory_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  base_quantity numeric(14,3) not null check (base_quantity > 0),
  restocked boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists return_item_batches_return_idx on public.return_item_batches(return_item_id);

create table if not exists public.purchase_return_item_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  purchase_return_item_id uuid not null references public.purchase_return_items(id) on delete cascade,
  inventory_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  base_quantity numeric(14,3) not null check (base_quantity > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.stock_transfer_item_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  transfer_item_id uuid not null references public.stock_transfer_items(id) on delete cascade,
  source_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  destination_batch_id uuid references public.inventory_batches(id) on delete set null,
  batch_number text not null,
  expiry_date date,
  received_date date not null,
  base_quantity numeric(14,3) not null check (base_quantity > 0),
  base_unit_cost numeric(14,4) not null check (base_unit_cost >= 0),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists stock_transfer_item_batches_transfer_idx on public.stock_transfer_item_batches(transfer_item_id);

alter table public.inventory_batches enable row level security;
alter table public.purchase_receipt_item_batches enable row level security;
alter table public.sale_item_batches enable row level security;
alter table public.return_item_batches enable row level security;
alter table public.purchase_return_item_batches enable row level security;
alter table public.stock_transfer_item_batches enable row level security;

drop policy if exists inventory_batches_read on public.inventory_batches;
create policy inventory_batches_read on public.inventory_batches
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and branch_id=(select private.current_branch_id())
  and (
    private.has_permission('inventory.view',auth.uid())
    or private.has_permission('inventory.adjust',auth.uid())
    or private.has_permission('purchases.receive',auth.uid())
  )
);

drop policy if exists purchase_receipt_item_batches_read on public.purchase_receipt_item_batches;
create policy purchase_receipt_item_batches_read on public.purchase_receipt_item_batches
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and exists(
    select 1 from public.purchase_receipt_items pri
    join public.purchase_receipts pr on pr.id=pri.receipt_id
    where pri.id=receipt_item_id and pr.branch_id=(select private.current_branch_id())
  )
  and (
    private.has_permission('inventory.view',auth.uid())
    or private.has_permission('purchases.receive',auth.uid())
  )
);

drop policy if exists sale_item_batches_read on public.sale_item_batches;
create policy sale_item_batches_read on public.sale_item_batches
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and exists(
    select 1 from public.sale_items si join public.sales s on s.id=si.sale_id
    where si.id=sale_item_id and s.branch_id=(select private.current_branch_id())
  )
  and (
    private.has_permission('inventory.view',auth.uid())
    or private.has_permission('invoices.view',auth.uid())
    or private.has_permission('returns.process',auth.uid())
  )
);

drop policy if exists return_item_batches_read on public.return_item_batches;
create policy return_item_batches_read on public.return_item_batches
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and exists(
    select 1 from public.return_items ri join public.returns r on r.id=ri.return_id
    where ri.id=return_item_id and r.branch_id=(select private.current_branch_id())
  )
  and (
    private.has_permission('inventory.view',auth.uid())
    or private.has_permission('returns.process',auth.uid())
  )
);

drop policy if exists purchase_return_item_batches_read on public.purchase_return_item_batches;
create policy purchase_return_item_batches_read on public.purchase_return_item_batches
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and exists(
    select 1 from public.purchase_return_items pri
    join public.purchase_returns pr on pr.id=pri.purchase_return_id
    where pri.id=purchase_return_item_id and pr.branch_id=(select private.current_branch_id())
  )
  and (
    private.has_permission('inventory.view',auth.uid())
    or private.has_permission('purchases.supplier_return',auth.uid())
  )
);

drop policy if exists stock_transfer_item_batches_read on public.stock_transfer_item_batches;
create policy stock_transfer_item_batches_read on public.stock_transfer_item_batches
for select to authenticated using (
  organization_id=(select private.current_organization_id())
  and exists(
    select 1 from public.stock_transfer_items sti
    join public.stock_transfers st on st.id=sti.transfer_id
    where sti.id=transfer_item_id
      and ((st.source_branch_id=(select private.current_branch_id()))
        or (st.destination_branch_id=(select private.current_branch_id())))
  )
  and (
    private.has_permission('inventory.view',auth.uid())
    or private.has_permission('transfers.create',auth.uid())
    or private.has_permission('transfers.receive',auth.uid())
  )
);

revoke all on public.inventory_batches from anon;
revoke all on public.purchase_receipt_item_batches from anon;
revoke all on public.sale_item_batches from anon;
revoke all on public.return_item_batches from anon;
revoke all on public.purchase_return_item_batches from anon;
revoke all on public.stock_transfer_item_batches from anon;
grant select on public.inventory_batches,public.purchase_receipt_item_batches,
  public.sale_item_batches,public.return_item_batches,
  public.purchase_return_item_batches,public.stock_transfer_item_batches to authenticated;
grant all on public.inventory_batches,public.purchase_receipt_item_batches,
  public.sale_item_batches,public.return_item_batches,
  public.purchase_return_item_batches,public.stock_transfer_item_batches to service_role;

create or replace function private.batch_business_date(p_organization_id uuid)
returns date language sql stable security definer
set search_path=public,private,auth,pg_temp as $$
  select (timezone(coalesce(nullif(trim(s.timezone),''),'Asia/Phnom_Penh'),now()))::date
  from public.app_settings s where s.organization_id=p_organization_id
$$;
revoke all on function private.batch_business_date(uuid) from public;
grant execute on function private.batch_business_date(uuid) to authenticated,service_role;

create or replace function public.save_product_batch_settings(
  p_product_id uuid,
  p_batch_tracking boolean,
  p_expiry_tracking boolean default false,
  p_picking_policy public.inventory_picking_policy default 'fifo',
  p_default_shelf_life_days integer default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_product public.products%rowtype;
begin
  perform private.require_permission('products.manage');
  v_org := private.current_organization_id();
  select * into v_product from public.products
   where id=p_product_id and organization_id=v_org for update;
  if not found then raise exception 'Product not found'; end if;
  if coalesce(p_expiry_tracking,false) and not coalesce(p_batch_tracking,false) then
    raise exception 'Expiry tracking requires batch tracking';
  end if;
  if p_default_shelf_life_days is not null and p_default_shelf_life_days <= 0 then
    raise exception 'Default shelf life must be greater than zero';
  end if;
  if not coalesce(p_batch_tracking,false) and exists(
    select 1 from public.inventory_batches b where b.product_id=p_product_id and b.quantity>0
  ) then raise exception 'Remove or write off remaining batch quantities before disabling batch tracking'; end if;
  update public.products set
    batch_tracking=coalesce(p_batch_tracking,false),
    expiry_tracking=coalesce(p_expiry_tracking,false),
    picking_policy=coalesce(p_picking_policy,'fifo'),
    default_shelf_life_days=case when p_expiry_tracking then p_default_shelf_life_days else null end,
    updated_at=now()
  where id=p_product_id returning * into v_product;
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,private.current_branch_id(),auth.uid(),'save_batch_settings','product',p_product_id,
    jsonb_build_object('batch_tracking',v_product.batch_tracking,'expiry_tracking',v_product.expiry_tracking,
      'picking_policy',v_product.picking_policy,'default_shelf_life_days',v_product.default_shelf_life_days));
  return jsonb_build_object('ok',true,'product_id',p_product_id,'batch_tracking',v_product.batch_tracking,
    'expiry_tracking',v_product.expiry_tracking,'picking_policy',v_product.picking_policy,
    'default_shelf_life_days',v_product.default_shelf_life_days);
end; $$;
revoke all on function public.save_product_batch_settings(uuid,boolean,boolean,public.inventory_picking_policy,integer) from public,anon;
grant execute on function public.save_product_batch_settings(uuid,boolean,boolean,public.inventory_picking_policy,integer) to authenticated,service_role;

create or replace function public.create_inventory_batch(
  p_product_id uuid,p_batch_number text,p_expiry_date date,p_quantity numeric,
  p_unit_cost numeric default null,p_received_date date default current_date,
  p_notes text default null,p_assign_existing_stock boolean default true
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_product public.products%rowtype; v_balance public.inventory_balances%rowtype;
 v_assigned numeric(14,3); v_batch public.inventory_batches%rowtype; v_date date;
begin
  perform private.require_permission('inventory.adjust');
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  v_date:=coalesce(p_received_date,private.batch_business_date(v_org),current_date);
  if p_quantity is null or p_quantity<=0 then raise exception 'Batch quantity must be greater than zero'; end if;
  if p_batch_number is null or length(trim(p_batch_number))=0 then raise exception 'Batch or lot number is required'; end if;
  select * into v_product from public.products where id=p_product_id and organization_id=v_org and is_active=true for update;
  if not found then raise exception 'Product not found or inactive'; end if;
  if not v_product.track_stock or not v_product.batch_tracking then raise exception 'Enable stock and batch tracking for this product first'; end if;
  if v_product.expiry_tracking and p_expiry_date is null then raise exception 'Expiry date is required for this product'; end if;
  if p_expiry_date is not null and p_expiry_date < v_date then raise exception 'Expiry date cannot be before the received date'; end if;
  insert into public.inventory_balances(organization_id,branch_id,product_id,quantity,average_cost)
  values(v_org,v_branch,p_product_id,0,coalesce(p_unit_cost,v_product.default_cost,0))
  on conflict(branch_id,product_id) do nothing;
  select * into v_balance from public.inventory_balances where branch_id=v_branch and product_id=p_product_id for update;
  select coalesce(sum(quantity),0) into v_assigned from public.inventory_batches
   where branch_id=v_branch and product_id=p_product_id;
  if p_assign_existing_stock then
    if v_assigned + p_quantity > v_balance.quantity + 0.0005 then
      raise exception 'Only % unassigned base units are available',greatest(v_balance.quantity-v_assigned,0);
    end if;
  else
    update public.inventory_balances set quantity=quantity+p_quantity,updated_at=now() where id=v_balance.id;
    insert into public.stock_movements(organization_id,branch_id,product_id,movement_type,quantity_change,
      quantity_before,quantity_after,unit_cost,reference_table,notes,created_by)
    values(v_org,v_branch,p_product_id,'adjustment',p_quantity,v_balance.quantity,v_balance.quantity+p_quantity,
      coalesce(p_unit_cost,v_balance.average_cost,v_product.default_cost,0),'inventory_batches',
      'New stock added as batch '||trim(p_batch_number),auth.uid());
  end if;
  insert into public.inventory_batches(organization_id,branch_id,product_id,batch_number,expiry_date,received_date,
    source_type,initial_quantity,quantity,unit_cost,status,notes,created_by)
  values(v_org,v_branch,p_product_id,trim(p_batch_number),p_expiry_date,v_date,
    case when p_assign_existing_stock then 'opening' else 'manual' end,p_quantity,p_quantity,
    coalesce(p_unit_cost,v_balance.average_cost,v_product.default_cost,0),'active',nullif(trim(p_notes),''),auth.uid())
  returning * into v_batch;
  return jsonb_build_object('ok',true,'batch',to_jsonb(v_batch),'assigned_existing_stock',p_assign_existing_stock);
end; $$;
revoke all on function public.create_inventory_batch(uuid,text,date,numeric,numeric,date,text,boolean) from public,anon;
grant execute on function public.create_inventory_batch(uuid,text,date,numeric,numeric,date,text,boolean) to authenticated,service_role;

create or replace function public.adjust_inventory_batch(
  p_batch_id uuid,p_quantity_change numeric,p_reason text,p_notes text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_batch public.inventory_batches%rowtype; v_balance public.inventory_balances%rowtype;
 v_after numeric(14,3); v_balance_after numeric(14,3);
begin
  perform private.require_permission('inventory.adjust');
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  if p_quantity_change is null or abs(p_quantity_change)<0.0005 then raise exception 'Quantity change cannot be zero'; end if;
  if p_reason is null or length(trim(p_reason))<3 then raise exception 'Adjustment reason is required'; end if;
  select * into v_batch from public.inventory_batches where id=p_batch_id and organization_id=v_org and branch_id=v_branch for update;
  if not found then raise exception 'Batch not found'; end if;
  select * into v_balance from public.inventory_balances where branch_id=v_branch and product_id=v_batch.product_id for update;
  if not found then raise exception 'Inventory balance not found'; end if;
  v_after:=round(v_batch.quantity+p_quantity_change,3);
  v_balance_after:=round(v_balance.quantity+p_quantity_change,3);
  if v_after<0 then raise exception 'Batch quantity cannot be negative'; end if;
  if v_balance_after<0 then raise exception 'Inventory quantity cannot be negative'; end if;
  update public.inventory_batches set quantity=v_after,
    initial_quantity=greatest(initial_quantity,v_after),
    status=case when v_after<=0 then 'depleted'::public.inventory_batch_status
      when status='depleted' then 'active'::public.inventory_batch_status else status end,
    updated_at=now() where id=v_batch.id returning * into v_batch;
  update public.inventory_balances set quantity=v_balance_after,updated_at=now() where id=v_balance.id;
  insert into public.stock_movements(organization_id,branch_id,product_id,movement_type,quantity_change,
    quantity_before,quantity_after,unit_cost,reference_table,reference_id,notes,created_by)
  values(v_org,v_branch,v_batch.product_id,'adjustment',p_quantity_change,v_balance.quantity,v_balance_after,
    v_batch.unit_cost,'inventory_batches',v_batch.id,trim(p_reason)||coalesce(' · '||nullif(trim(p_notes),''),''),auth.uid());
  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_org,v_branch,auth.uid(),'adjust_inventory_batch','inventory_batch',v_batch.id,
    jsonb_build_object('batch_number',v_batch.batch_number,'quantity_change',p_quantity_change,'quantity_after',v_after,'reason',trim(p_reason)));
  return jsonb_build_object('ok',true,'batch',to_jsonb(v_batch),'inventory_quantity_after',v_balance_after);
end; $$;
revoke all on function public.adjust_inventory_batch(uuid,numeric,text,text) from public,anon;
grant execute on function public.adjust_inventory_batch(uuid,numeric,text,text) to authenticated,service_role;

create or replace function public.set_inventory_batch_status(
  p_batch_id uuid,p_status public.inventory_batch_status,p_reason text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_batch public.inventory_batches%rowtype; v_today date;
begin
  perform private.require_permission('inventory.adjust');
  if p_status not in ('active','quarantined') then raise exception 'Choose Active or Quarantined'; end if;
  select * into v_batch from public.inventory_batches where id=p_batch_id
    and organization_id=private.current_organization_id() and branch_id=private.current_branch_id() for update;
  if not found then raise exception 'Batch not found'; end if;
  if v_batch.quantity<=0 then raise exception 'A depleted batch cannot be activated or quarantined'; end if;
  v_today:=coalesce(private.batch_business_date(v_batch.organization_id),current_date);
  if p_status='active' and v_batch.expiry_date is not null and v_batch.expiry_date<v_today then
    raise exception 'An expired batch cannot be released for sale';
  end if;
  update public.inventory_batches set status=p_status,
    notes=case when nullif(trim(p_reason),'') is null then notes
      else concat_ws(E'\n',notes,upper(p_status::text)||': '||trim(p_reason)) end,updated_at=now()
  where id=p_batch_id returning * into v_batch;
  return jsonb_build_object('ok',true,'batch',to_jsonb(v_batch));
end; $$;
revoke all on function public.set_inventory_batch_status(uuid,public.inventory_batch_status,text) from public,anon;
grant execute on function public.set_inventory_batch_status(uuid,public.inventory_batch_status,text) to authenticated,service_role;

-- Batch-aware partial receiving. Batch quantities are entered in each PO line's purchase unit.
create or replace function public.receive_purchase_order_v5(
  p_purchase_id uuid,p_items jsonb,p_batch_allocations jsonb default '[]'::jsonb,
  p_amount_paid numeric default 0,p_payment_method public.payment_method default 'cash',
  p_payment_reference text default null,p_supplier_invoice_number text default null,
  p_received_at timestamptz default now(),p_notes text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_org uuid; v_branch uuid; v_input record; v_pi public.purchase_items%rowtype; v_product public.products%rowtype;
 v_requested numeric(14,3); v_allocated numeric(14,3); v_result jsonb; v_receipt_id uuid; v_receipt_item public.purchase_receipt_items%rowtype;
 v_alloc record; v_batch_id uuid; v_base numeric(14,3); v_expiry date; v_count integer:=0; v_received_date date;
begin
  perform private.require_permission('purchases.receive');
  v_org:=private.current_organization_id(); v_branch:=private.current_branch_id();
  if p_batch_allocations is null or jsonb_typeof(p_batch_allocations)<>'array' then p_batch_allocations:='[]'::jsonb; end if;
  v_received_date:=(coalesce(p_received_at,now()))::date;
  for v_input in select x.purchase_item_id,sum(x.quantity)::numeric(14,3) quantity
    from jsonb_to_recordset(p_items) x(purchase_item_id uuid,quantity numeric)
    group by x.purchase_item_id loop
    select * into v_pi from public.purchase_items where id=v_input.purchase_item_id and purchase_id=p_purchase_id;
    if not found then raise exception 'A selected receipt item is invalid'; end if;
    select * into v_product from public.products where id=v_pi.product_id and organization_id=v_org;
    if v_product.batch_tracking then
      select coalesce(sum(a.quantity),0)::numeric(14,3) into v_allocated
      from jsonb_to_recordset(p_batch_allocations) a(purchase_item_id uuid,batch_number text,expiry_date date,quantity numeric,notes text)
      where a.purchase_item_id=v_pi.id;
      if abs(v_allocated-v_input.quantity)>0.0005 then
        raise exception 'Batch quantities for % must total % %',v_product.name,v_input.quantity,v_pi.purchase_unit_name;
      end if;
      for v_alloc in select * from jsonb_to_recordset(p_batch_allocations)
        a(purchase_item_id uuid,batch_number text,expiry_date date,quantity numeric,notes text)
        where a.purchase_item_id=v_pi.id loop
        if v_alloc.batch_number is null or length(trim(v_alloc.batch_number))=0 or v_alloc.quantity<=0 then
          raise exception 'Every batch for % needs a lot number and quantity',v_product.name;
        end if;
        v_expiry:=coalesce(v_alloc.expiry_date,
          case when v_product.default_shelf_life_days is not null then v_received_date+v_product.default_shelf_life_days else null end);
        if v_product.expiry_tracking and v_expiry is null then raise exception 'Expiry date is required for %',v_product.name; end if;
        if v_expiry is not null and v_expiry<v_received_date then raise exception 'Expiry date for % cannot be before received date',v_product.name; end if;
      end loop;
    end if;
  end loop;
  v_result:=public.receive_purchase_order_v4(p_purchase_id,p_items,p_amount_paid,p_payment_method,
    p_payment_reference,p_supplier_invoice_number,p_received_at,p_notes);
  v_receipt_id:=(v_result->>'receipt_id')::uuid;
  for v_alloc in select * from jsonb_to_recordset(p_batch_allocations)
    a(purchase_item_id uuid,batch_number text,expiry_date date,quantity numeric,notes text) loop
    select * into v_pi from public.purchase_items where id=v_alloc.purchase_item_id and purchase_id=p_purchase_id;
    select * into v_product from public.products where id=v_pi.product_id;
    if not v_product.batch_tracking then continue; end if;
    select * into v_receipt_item from public.purchase_receipt_items
      where receipt_id=v_receipt_id and purchase_item_id=v_pi.id;
    if not found then raise exception 'Batch allocation does not match a received line'; end if;
    v_base:=round(v_alloc.quantity*v_pi.unit_factor,3);
    v_expiry:=coalesce(v_alloc.expiry_date,
      case when v_product.default_shelf_life_days is not null then v_received_date+v_product.default_shelf_life_days else null end);
    insert into public.inventory_batches(organization_id,branch_id,product_id,batch_number,expiry_date,received_date,
      source_type,purchase_receipt_item_id,supplier_id,initial_quantity,quantity,unit_cost,status,notes,created_by)
    select v_org,v_branch,v_product.id,trim(v_alloc.batch_number),v_expiry,v_received_date,'purchase',v_receipt_item.id,
      p.supplier_id,v_base,v_base,v_receipt_item.base_unit_cost,'active',nullif(trim(v_alloc.notes),''),auth.uid()
    from public.purchases p where p.id=p_purchase_id returning id into v_batch_id;
    insert into public.purchase_receipt_item_batches(organization_id,receipt_item_id,inventory_batch_id,
      purchase_unit_quantity,base_quantity,unit_cost)
    values(v_org,v_receipt_item.id,v_batch_id,v_alloc.quantity,v_base,v_receipt_item.base_unit_cost);
    v_count:=v_count+1;
  end loop;
  return v_result||jsonb_build_object('batch_count',v_count,'batch_tracking',true);
end; $$;
revoke all on function public.receive_purchase_order_v5(uuid,jsonb,jsonb,numeric,public.payment_method,text,text,timestamptz,text) from public,anon;
grant execute on function public.receive_purchase_order_v5(uuid,jsonb,jsonb,numeric,public.payment_method,text,text,timestamptz,text) to authenticated,service_role;

-- FIFO/FEFO checkout. The existing secure checkout runs first inside the same transaction;
-- any batch allocation failure rolls the entire invoice back.
create or replace function public.complete_sale_v8(
  p_items jsonb,p_payment_method text,p_amount_received numeric,p_customer_id uuid default null,
  p_manual_discount_type public.discount_type default 'none',p_manual_discount_value numeric default 0,
  p_coupon_code text default null,p_currency public.currency_code default 'USD',p_notes text default null,
  p_payment_reference text default null,p_idempotency_key text default null,p_source_quote_id uuid default null,
  p_approval_request_id uuid default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_result jsonb; v_sale_id uuid; v_sale public.sales%rowtype; v_si record; v_batch public.inventory_batches%rowtype;
 v_remaining numeric(14,3); v_take numeric(14,3); v_order integer; v_cost numeric(14,4); v_today date; v_total_cost numeric(14,4);
begin
  v_result:=public.complete_sale_v7(p_items,p_payment_method,p_amount_received,p_customer_id,
    p_manual_discount_type,p_manual_discount_value,p_coupon_code,p_currency,p_notes,p_payment_reference,
    p_idempotency_key,p_source_quote_id,p_approval_request_id);
  v_sale_id:=(v_result->>'sale_id')::uuid;
  if exists(select 1 from public.sale_item_batches sib join public.sale_items si on si.id=sib.sale_item_id where si.sale_id=v_sale_id) then
    return v_result;
  end if;
  select * into v_sale from public.sales where id=v_sale_id for update;
  v_today:=coalesce(private.batch_business_date(v_sale.organization_id),current_date);
  for v_si in select si.*,p.batch_tracking,p.expiry_tracking,p.picking_policy
    from public.sale_items si join public.products p on p.id=si.product_id
    where si.sale_id=v_sale_id and p.track_stock=true and p.batch_tracking=true
    order by si.product_id loop
    v_remaining:=v_si.base_quantity; v_order:=0; v_cost:=0;
    for v_batch in select * from public.inventory_batches b
      where b.organization_id=v_sale.organization_id and b.branch_id=v_sale.branch_id
        and b.product_id=v_si.product_id and b.status='active' and b.quantity>0
        and (b.expiry_date is null or b.expiry_date>=v_today)
      order by
        case when v_si.picking_policy='fefo' then coalesce(b.expiry_date,'9999-12-31'::date) end,
        b.received_date,b.created_at,b.id
      for update loop
      exit when v_remaining<=0.0005;
      v_take:=least(v_remaining,v_batch.quantity); v_order:=v_order+1;
      update public.inventory_batches set quantity=round(quantity-v_take,3),
        status=case when quantity-v_take<=0.0005 then 'depleted'::public.inventory_batch_status else status end,
        updated_at=now() where id=v_batch.id;
      insert into public.sale_item_batches(organization_id,sale_item_id,inventory_batch_id,base_quantity,
        base_unit_cost,cost_total,allocation_order)
      values(v_sale.organization_id,v_si.id,v_batch.id,v_take,v_batch.unit_cost,round(v_take*v_batch.unit_cost,4),v_order);
      v_cost:=v_cost+round(v_take*v_batch.unit_cost,4); v_remaining:=round(v_remaining-v_take,3);
    end loop;
    if v_remaining>0.0005 then raise exception 'Insufficient non-expired batch stock for %',v_si.product_name; end if;
    update public.sale_items set
      unit_cost=case when quantity>0 then round(v_cost/quantity,4) else 0 end,
      line_profit=round(line_total-v_cost,4)
    where id=v_si.id;
    update public.stock_movements set unit_cost=case when v_si.base_quantity>0 then round(v_cost/v_si.base_quantity,4) else unit_cost end
      where reference_table='sales' and reference_id=v_sale_id and product_id=v_si.product_id and movement_type='sale';
  end loop;
  select coalesce(sum(unit_cost*quantity),0),coalesce(sum(line_profit),0)
    into v_total_cost,v_cost from public.sale_items where sale_id=v_sale_id;
  update public.sales set cost_amount=round(v_total_cost,4),gross_profit=round(v_cost,4),updated_at=now() where id=v_sale_id;
  return v_result||jsonb_build_object('batch_cost_amount',round(v_total_cost,4),'gross_profit',round(v_cost,4));
end; $$;
revoke all on function public.complete_sale_v8(jsonb,text,numeric,uuid,public.discount_type,numeric,text,public.currency_code,text,text,text,uuid,uuid) from public,anon;
grant execute on function public.complete_sale_v8(jsonb,text,numeric,uuid,public.discount_type,numeric,text,public.currency_code,text,text,text,uuid,uuid) to authenticated,service_role;

create or replace function public.process_sale_return_v4(
  p_sale_id uuid,p_items jsonb,p_refund_method text,p_reason text,p_refund_reference text default null,
  p_approval_request_id uuid default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare
  v_result jsonb;
  v_return_id uuid;
  v_ri record;
  v_alloc record;
  v_restored numeric(14,3);
  v_available numeric(14,3);
  v_take numeric(14,3);
  v_remaining numeric(14,3);
  v_today date;
  v_org uuid;
  v_branch uuid;
  v_legacy_batch_id uuid;
  v_legacy_batch_number text;
begin
  v_result:=public.process_sale_return_v3(
    p_sale_id,p_items,p_refund_method,p_reason,p_refund_reference,p_approval_request_id
  );
  v_return_id:=(v_result->>'return_id')::uuid;

  if exists(
    select 1
    from public.return_item_batches
    where return_item_id in(
      select id from public.return_items where return_id=v_return_id
    )
  ) then
    return v_result;
  end if;

  v_org:=private.current_organization_id();
  v_branch:=private.current_branch_id();
  v_today:=coalesce(private.batch_business_date(v_org),current_date);

  for v_ri in
    select
      ri.*,
      p.batch_tracking,
      p.expiry_tracking,
      p.name as product_name
    from public.return_items ri
    join public.products p on p.id=ri.product_id
    where ri.return_id=v_return_id
      and ri.restock=true
      and p.batch_tracking=true
  loop
    v_remaining:=v_ri.base_quantity;

    for v_alloc in
      select sib.*
      from public.sale_item_batches sib
      where sib.sale_item_id=v_ri.sale_item_id
      order by sib.allocation_order,sib.created_at
    loop
      exit when v_remaining<=0.0005;

      select coalesce(sum(rib.base_quantity),0)
      into v_restored
      from public.return_item_batches rib
      where rib.sale_item_batch_id=v_alloc.id
        and rib.restocked=true;

      v_available:=greatest(v_alloc.base_quantity-v_restored,0);
      if v_available<=0 then continue; end if;

      v_take:=least(v_remaining,v_available);

      update public.inventory_batches
      set quantity=quantity+v_take,
          initial_quantity=greatest(initial_quantity,quantity+v_take),
          status=case
            when expiry_date is not null and expiry_date<v_today
              then 'quarantined'::public.inventory_batch_status
            else 'active'::public.inventory_batch_status
          end,
          updated_at=now()
      where id=v_alloc.inventory_batch_id;

      insert into public.return_item_batches(
        organization_id,return_item_id,sale_item_batch_id,inventory_batch_id,base_quantity,restocked
      ) values(
        v_org,v_ri.id,v_alloc.id,v_alloc.inventory_batch_id,v_take,true
      );

      v_remaining:=round(v_remaining-v_take,3);
    end loop;

    -- Sales completed before batch tracing was enabled do not have enough
    -- sale_item_batches rows. Preserve the return instead of blocking it by
    -- creating a clearly marked customer-return batch for the unmatched part.
    if v_remaining>0.0005 then
      v_legacy_batch_number:=concat(
        'RETURN-',
        upper(substr(replace(v_return_id::text,'-',''),1,8)),
        '-',
        upper(substr(replace(v_ri.id::text,'-',''),1,8))
      );

      insert into public.inventory_batches(
        organization_id,branch_id,product_id,batch_number,received_date,source_type,
        initial_quantity,quantity,unit_cost,status,notes,created_by
      ) values(
        v_org,
        v_branch,
        v_ri.product_id,
        v_legacy_batch_number,
        v_today,
        'customer_return',
        v_remaining,
        v_remaining,
        coalesce(v_ri.unit_cost,0),
        case
          when v_ri.expiry_tracking
            then 'quarantined'::public.inventory_batch_status
          else 'active'::public.inventory_batch_status
        end,
        concat(
          'Legacy batch recovery for return ',v_return_id::text,
          '. Original sale batch trace was incomplete. Product: ',v_ri.product_name
        ),
        auth.uid()
      ) returning id into v_legacy_batch_id;

      insert into public.return_item_batches(
        organization_id,return_item_id,sale_item_batch_id,inventory_batch_id,base_quantity,restocked
      ) values(
        v_org,v_ri.id,null,v_legacy_batch_id,v_remaining,true
      );
    end if;
  end loop;

  return v_result||jsonb_build_object(
    'batch_restocked',true,
    'legacy_batch_fallback_supported',true
  );
end; $$;
revoke all on function public.process_sale_return_v4(uuid,jsonb,text,text,text,uuid) from public,anon;
grant execute on function public.process_sale_return_v4(uuid,jsonb,text,text,text,uuid) to authenticated,service_role;

create or replace function public.process_supplier_return_v5(
  p_purchase_id uuid,p_items jsonb,p_reason text,p_supplier_reference text default null
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_result jsonb; v_return_id uuid; v_pri record; v_product public.products%rowtype; v_batch public.inventory_batches%rowtype;
 v_remaining numeric(14,3); v_take numeric(14,3);
begin
  -- Base function validates received quantities and aggregate stock. Batch changes below are atomic with it.
  v_result:=public.process_supplier_return_v4(p_purchase_id,p_items,p_reason,p_supplier_reference);
  v_return_id:=(v_result->>'return_id')::uuid;
  for v_pri in select pri.*,pi.product_id from public.purchase_return_items pri
    join public.purchase_items pi on pi.id=pri.purchase_item_id where pri.purchase_return_id=v_return_id loop
    select * into v_product from public.products where id=v_pri.product_id;
    if not v_product.batch_tracking then continue; end if;
    v_remaining:=v_pri.base_quantity;
    for v_batch in select b.* from public.inventory_batches b
      where b.branch_id=private.current_branch_id() and b.product_id=v_product.id and b.quantity>0
      order by
        case when b.purchase_receipt_item_id in(
          select pri2.id from public.purchase_receipt_items pri2 where pri2.purchase_item_id=v_pri.purchase_item_id
        ) then 0 else 1 end,
        case when v_product.picking_policy='fefo' then coalesce(b.expiry_date,'9999-12-31'::date) end,
        b.received_date,b.created_at for update loop
      exit when v_remaining<=0.0005;
      v_take:=least(v_remaining,v_batch.quantity);
      update public.inventory_batches set quantity=quantity-v_take,
        status=case when quantity-v_take<=0.0005 then 'depleted'::public.inventory_batch_status else status end,
        updated_at=now() where id=v_batch.id;
      insert into public.purchase_return_item_batches(organization_id,purchase_return_item_id,inventory_batch_id,base_quantity)
      values(private.current_organization_id(),v_pri.id,v_batch.id,v_take);
      v_remaining:=round(v_remaining-v_take,3);
    end loop;
    if v_remaining>0.0005 then raise exception 'Insufficient batch quantity for supplier return of %',v_product.name; end if;
  end loop;
  return v_result||jsonb_build_object('batch_allocated',true);
end; $$;
revoke all on function public.process_supplier_return_v5(uuid,jsonb,text,text) from public,anon;
grant execute on function public.process_supplier_return_v5(uuid,jsonb,text,text) to authenticated,service_role;

create or replace function public.create_stock_transfer_v3(p_destination_branch_id uuid,p_items jsonb,p_notes text default null)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v_result jsonb; v_transfer_id uuid; v_ti record; v_product public.products%rowtype; v_batch public.inventory_batches%rowtype;
 v_remaining numeric(14,3); v_take numeric(14,3);
begin
  v_result:=public.create_stock_transfer_v2(p_destination_branch_id,p_items,p_notes);
  v_transfer_id:=(v_result->>'transfer_id')::uuid;
  for v_ti in select * from public.stock_transfer_items where transfer_id=v_transfer_id loop
    select * into v_product from public.products where id=v_ti.product_id;
    if not v_product.batch_tracking then continue; end if;
    v_remaining:=v_ti.quantity;
    for v_batch in select * from public.inventory_batches b where b.branch_id=private.current_branch_id()
      and b.product_id=v_product.id and b.status='active' and b.quantity>0
      and (b.expiry_date is null or b.expiry_date>=coalesce(private.batch_business_date(b.organization_id),current_date))
      order by case when v_product.picking_policy='fefo' then coalesce(b.expiry_date,'9999-12-31'::date) end,
        b.received_date,b.created_at for update loop
      exit when v_remaining<=0.0005; v_take:=least(v_remaining,v_batch.quantity);
      update public.inventory_batches set quantity=quantity-v_take,
        status=case when quantity-v_take<=0.0005 then 'depleted'::public.inventory_batch_status else status end,updated_at=now()
      where id=v_batch.id;
      insert into public.stock_transfer_item_batches(organization_id,transfer_item_id,source_batch_id,batch_number,
        expiry_date,received_date,base_quantity,base_unit_cost,notes)
      values(v_batch.organization_id,v_ti.id,v_batch.id,v_batch.batch_number,v_batch.expiry_date,v_batch.received_date,
        v_take,v_batch.unit_cost,v_batch.notes);
      v_remaining:=round(v_remaining-v_take,3);
    end loop;
    if v_remaining>0.0005 then raise exception 'Insufficient non-expired batch stock for transfer of %',v_product.name; end if;
  end loop;
  return v_result||jsonb_build_object('batch_allocated',true);
end; $$;
revoke all on function public.create_stock_transfer_v3(uuid,jsonb,text) from public,anon;
grant execute on function public.create_stock_transfer_v3(uuid,jsonb,text) to authenticated,service_role;

create or replace function public.receive_stock_transfer_v3(p_transfer_id uuid,p_notes text default null)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v_result jsonb; v_transfer public.stock_transfers%rowtype; v_row record; v_dest_batch uuid;
begin
  select * into v_transfer from public.stock_transfers where id=p_transfer_id and organization_id=private.current_organization_id();
  if not found then raise exception 'Transfer not found'; end if;
  v_result:=public.receive_stock_transfer_v2(p_transfer_id,p_notes);
  for v_row in select stib.*,sti.product_id from public.stock_transfer_item_batches stib
    join public.stock_transfer_items sti on sti.id=stib.transfer_item_id where sti.transfer_id=p_transfer_id loop
    insert into public.inventory_batches(organization_id,branch_id,product_id,batch_number,expiry_date,received_date,
      source_type,source_transfer_item_id,initial_quantity,quantity,unit_cost,status,notes,created_by)
    values(v_transfer.organization_id,v_transfer.destination_branch_id,v_row.product_id,v_row.batch_number,v_row.expiry_date,
      v_row.received_date,'transfer',v_row.transfer_item_id,v_row.base_quantity,v_row.base_quantity,v_row.base_unit_cost,
      case when v_row.expiry_date is not null and v_row.expiry_date<current_date then 'quarantined' else 'active' end,
      v_row.notes,auth.uid()) returning id into v_dest_batch;
    update public.stock_transfer_item_batches set destination_batch_id=v_dest_batch where id=v_row.id;
  end loop;
  return v_result||jsonb_build_object('batch_received',true);
end; $$;
revoke all on function public.receive_stock_transfer_v3(uuid,text) from public,anon;
grant execute on function public.receive_stock_transfer_v3(uuid,text) to authenticated,service_role;

create or replace function public.cancel_stock_transfer_v3(p_transfer_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,private,auth,pg_temp as $$
declare v_result jsonb; v_row record; v_today date;
begin
  v_result:=public.cancel_stock_transfer_v2(p_transfer_id,p_reason);
  v_today:=coalesce(private.batch_business_date(private.current_organization_id()),current_date);
  for v_row in select stib.* from public.stock_transfer_item_batches stib join public.stock_transfer_items sti on sti.id=stib.transfer_item_id
    where sti.transfer_id=p_transfer_id loop
    update public.inventory_batches set quantity=quantity+v_row.base_quantity,
      initial_quantity=greatest(initial_quantity,quantity+v_row.base_quantity),
      status=case when expiry_date is not null and expiry_date<v_today then 'quarantined'::public.inventory_batch_status else 'active'::public.inventory_batch_status end,
      updated_at=now() where id=v_row.source_batch_id;
  end loop;
  return v_result||jsonb_build_object('batch_restored',true);
end; $$;
revoke all on function public.cancel_stock_transfer_v3(uuid,text) from public,anon;
grant execute on function public.cancel_stock_transfer_v3(uuid,text) to authenticated,service_role;

-- Hide older public entry points so the frontend cannot bypass batch allocation.
revoke execute on function public.complete_sale_v7(jsonb,text,numeric,uuid,public.discount_type,numeric,text,public.currency_code,text,text,text,uuid,uuid) from authenticated;
revoke execute on function public.process_sale_return_v3(uuid,jsonb,text,text,text,uuid) from authenticated;
revoke execute on function public.receive_purchase_order_v4(uuid,jsonb,numeric,public.payment_method,text,text,timestamptz,text) from authenticated;
revoke execute on function public.process_supplier_return_v4(uuid,jsonb,text,text) from authenticated;
revoke execute on function public.create_stock_transfer_v2(uuid,jsonb,text) from authenticated;
revoke execute on function public.receive_stock_transfer_v2(uuid,text) from authenticated;
revoke execute on function public.cancel_stock_transfer_v2(uuid,text) from authenticated;

commit;
-- ============================================================================
-- END STEP 35
-- ============================================================================
