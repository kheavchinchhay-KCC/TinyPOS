-- ============================================================================
-- Tiny POS Step 46.4.12
-- Custom-role access recovery, refund approvals, dashboard/Telegram actions,
-- stock-count custom-role support, and counted stock-transfer approval workflow.
-- Run once after migration 48.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Permission catalogue additions for the counted transfer workflow.
-- ---------------------------------------------------------------------------
insert into public.permission_definitions(
  permission_key,module_key,label,description,risk_level,default_roles,approval_action,sort_order,is_active
) values
  ('transfers.edit','Inventory','Edit Pending Stock Transfers','Edit a workflow transfer before destination counting starts.','sensitive',array['owner','admin','manager']::public.app_role[],false,94,true),
  ('transfers.count','Inventory','Count Received Transfer Units','Enter exact received quantities and keep or submit a destination count.','sensitive',array['owner','admin','manager']::public.app_role[],false,95,true),
  ('transfers.approve','Inventory','Approve Counted Stock Transfers','Apply source deduction and destination receipt after final branch approval.','critical',array['owner','admin','manager']::public.app_role[],false,96,true)
on conflict(permission_key) do update set
  module_key=excluded.module_key,
  label=excluded.label,
  description=excluded.description,
  risk_level=excluded.risk_level,
  default_roles=excluded.default_roles,
  approval_action=excluded.approval_action,
  sort_order=excluded.sort_order,
  is_active=true;

-- ---------------------------------------------------------------------------
-- Transfer workflow metadata. Existing transfers stay workflow version 1.
-- ---------------------------------------------------------------------------
alter table public.stock_transfers
  add column if not exists workflow_version smallint not null default 1,
  add column if not exists count_status text not null default 'pending',
  add column if not exists count_notes text,
  add column if not exists counted_by uuid references public.profiles(id) on delete set null,
  add column if not exists counted_at timestamptz,
  add column if not exists submitted_by uuid references public.profiles(id) on delete set null,
  add column if not exists submitted_at timestamptz,
  add column if not exists approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists approval_note text;

alter table public.stock_transfer_items
  add column if not exists counted_quantity numeric(14,3),
  add column if not exists count_note text;

do $constraints$
begin
  if not exists(
    select 1 from pg_constraint
    where conname='stock_transfers_count_status_check'
      and conrelid='public.stock_transfers'::regclass
  ) then
    alter table public.stock_transfers
      add constraint stock_transfers_count_status_check
      check(count_status in('pending','counting','awaiting_approval','approved','cancelled'));
  end if;

  if not exists(
    select 1 from pg_constraint
    where conname='stock_transfer_items_counted_quantity_check'
      and conrelid='public.stock_transfer_items'::regclass
  ) then
    alter table public.stock_transfer_items
      add constraint stock_transfer_items_counted_quantity_check
      check(counted_quantity is null or counted_quantity>=0);
  end if;
end
$constraints$;

create index if not exists stock_transfers_count_status_idx
  on public.stock_transfers(organization_id,count_status,created_at desc);

-- ---------------------------------------------------------------------------
-- Approval events for Dashboard + Telegram outbox.
-- ---------------------------------------------------------------------------
create or replace function private.queue_approval_telegram_event()
returns trigger
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_type text;
  v_actor uuid;
  v_key text;
begin
  if tg_op='INSERT' then
    v_type:='approval_requested';
    v_actor:=new.requested_by;
    v_key:=v_type||':'||new.id::text;
  elsif tg_op='UPDATE'
    and new.status is distinct from old.status
    and new.status in('approved','rejected') then
    v_type:='approval_'||new.status;
    v_actor:=coalesce(new.reviewed_by,new.requested_by);
    v_key:=v_type||':'||new.id::text;
  else
    return new;
  end if;

  insert into public.telegram_operational_events(
    organization_id,branch_id,actor_user_id,event_type,event_key,entity_type,entity_id,payload
  ) values(
    new.organization_id,new.branch_id,v_actor,v_type,v_key,'approval_request',new.id,
    jsonb_build_object(
      'user_id',new.requested_by,
      'permission_key',new.permission_key,
      'action_type',new.action_type,
      'action_summary',new.action_summary,
      'amount',new.amount,
      'currency',new.currency,
      'status',new.status,
      'review_note',new.review_note,
      'reviewed_by',new.reviewed_by
    )
  ) on conflict(event_key) do nothing;

  return new;
end;
$$;

drop trigger if exists queue_approval_telegram_event on public.approval_requests;
create trigger queue_approval_telegram_event
after insert or update of status on public.approval_requests
for each row execute function private.queue_approval_telegram_event();

-- ---------------------------------------------------------------------------
-- Workflow version 2: create/edit without stock deduction.
-- ---------------------------------------------------------------------------
create or replace function public.create_stock_transfer_v4(
  p_destination_branch_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user_id uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_destination public.branches%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_transfer_id uuid;
  v_transfer_number text;
  v_total_items integer:=0;
  v_total_units numeric(14,3):=0;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('transfers.create');

  select * into v_profile from public.profiles where id=v_user_id and is_active=true;
  if not found or v_profile.branch_id is null then raise exception 'Active profile and branch required'; end if;

  select * into v_destination from public.branches
  where id=p_destination_branch_id and organization_id=v_profile.organization_id and is_active=true;
  if not found then raise exception 'Destination branch not found or inactive'; end if;
  if v_destination.id=v_profile.branch_id then raise exception 'Source and destination branches must be different'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then
    raise exception 'Add at least one product to the transfer';
  end if;

  for v_item in
    select x.product_id,sum(x.quantity)::numeric(14,3) quantity
    from jsonb_to_recordset(p_items) x(product_id uuid,quantity numeric)
    group by x.product_id order by x.product_id
  loop
    if v_item.product_id is null or v_item.quantity is null or v_item.quantity<=0 then
      raise exception 'Every transfer item requires a product and quantity greater than zero';
    end if;
    select * into v_product from public.products
      where id=v_item.product_id and organization_id=v_profile.organization_id and is_active=true and track_stock=true;
    if not found then raise exception 'A transfer product is missing, inactive, or does not track stock'; end if;

    insert into public.inventory_balances(organization_id,branch_id,product_id,quantity,average_cost)
    values(v_profile.organization_id,v_profile.branch_id,v_product.id,0,coalesce(v_product.default_cost,0))
    on conflict(branch_id,product_id) do nothing;

    select * into v_balance from public.inventory_balances
      where branch_id=v_profile.branch_id and product_id=v_product.id;
    if coalesce(v_balance.quantity,0)<v_item.quantity then
      raise exception 'Not enough stock for %. Available %, requested %',v_product.name,v_balance.quantity,v_item.quantity;
    end if;
    v_total_items:=v_total_items+1;
    v_total_units:=v_total_units+v_item.quantity;
  end loop;

  v_transfer_number:=private.next_document_number(v_profile.organization_id,v_profile.branch_id,'TRF');
  insert into public.stock_transfers(
    organization_id,transfer_number,source_branch_id,destination_branch_id,status,notes,created_by,
    workflow_version,count_status
  ) values(
    v_profile.organization_id,v_transfer_number,v_profile.branch_id,v_destination.id,'pending',nullif(trim(p_notes),''),v_user_id,
    2,'pending'
  ) returning id into v_transfer_id;

  for v_item in
    select x.product_id,sum(x.quantity)::numeric(14,3) quantity
    from jsonb_to_recordset(p_items) x(product_id uuid,quantity numeric)
    group by x.product_id order by x.product_id
  loop
    select * into strict v_product from public.products where id=v_item.product_id;
    select * into strict v_balance from public.inventory_balances
      where branch_id=v_profile.branch_id and product_id=v_item.product_id;
    insert into public.stock_transfer_items(
      organization_id,transfer_id,product_id,quantity,unit_cost,counted_quantity
    ) values(
      v_profile.organization_id,v_transfer_id,v_item.product_id,v_item.quantity,
      coalesce(nullif(v_balance.average_cost,0),v_product.default_cost,0),null
    );
  end loop;

  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_profile.organization_id,v_profile.branch_id,v_user_id,'create_stock_transfer_pending','stock_transfer',v_transfer_id,
    jsonb_build_object('transfer_number',v_transfer_number,'destination_branch_id',v_destination.id,'item_count',v_total_items,'total_units',v_total_units,'workflow_version',2));

  return jsonb_build_object('ok',true,'transfer_id',v_transfer_id,'transfer_number',v_transfer_number,'status','pending','count_status','pending','item_count',v_total_items,'total_units',v_total_units);
end;
$$;

create or replace function public.update_stock_transfer_v4(
  p_transfer_id uuid,
  p_destination_branch_id uuid,
  p_items jsonb,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user_id uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_destination public.branches%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_balance public.inventory_balances%rowtype;
  v_total integer:=0;
begin
  perform private.require_permission('transfers.edit');
  select * into v_profile from public.profiles where id=v_user_id and is_active=true;
  select * into v_transfer from public.stock_transfers
    where id=p_transfer_id and organization_id=v_profile.organization_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if v_transfer.workflow_version<2 or v_transfer.status<>'pending' or v_transfer.count_status not in('pending') then
    raise exception 'Only an uncounted pending workflow transfer can be edited';
  end if;
  if v_transfer.source_branch_id<>v_profile.branch_id and not private.has_permission('branches.all',v_user_id) then
    raise exception 'Switch to the source branch before editing';
  end if;

  select * into v_destination from public.branches
    where id=p_destination_branch_id and organization_id=v_profile.organization_id and is_active=true;
  if not found or v_destination.id=v_transfer.source_branch_id then raise exception 'Choose a valid destination branch'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Add at least one product'; end if;

  delete from public.stock_transfer_items where transfer_id=v_transfer.id;
  for v_item in
    select x.product_id,sum(x.quantity)::numeric(14,3) quantity
    from jsonb_to_recordset(p_items) x(product_id uuid,quantity numeric)
    group by x.product_id order by x.product_id
  loop
    if v_item.quantity is null or v_item.quantity<=0 then raise exception 'Transfer quantities must be greater than zero'; end if;
    select * into v_product from public.products
      where id=v_item.product_id and organization_id=v_profile.organization_id and is_active=true and track_stock=true;
    if not found then raise exception 'Transfer product missing or inactive'; end if;
    insert into public.inventory_balances(organization_id,branch_id,product_id,quantity,average_cost)
    values(v_profile.organization_id,v_transfer.source_branch_id,v_product.id,0,coalesce(v_product.default_cost,0))
    on conflict(branch_id,product_id) do nothing;
    select * into v_balance from public.inventory_balances
      where branch_id=v_transfer.source_branch_id and product_id=v_product.id;
    if v_balance.quantity<v_item.quantity then raise exception 'Not enough stock for %',v_product.name; end if;
    insert into public.stock_transfer_items(organization_id,transfer_id,product_id,quantity,unit_cost)
    values(v_profile.organization_id,v_transfer.id,v_product.id,v_item.quantity,coalesce(nullif(v_balance.average_cost,0),v_product.default_cost,0));
    v_total:=v_total+1;
  end loop;

  update public.stock_transfers set destination_branch_id=v_destination.id,notes=nullif(trim(p_notes),''),updated_at=now()
  where id=v_transfer.id;
  return jsonb_build_object('ok',true,'transfer_id',v_transfer.id,'transfer_number',v_transfer.transfer_number,'status','pending','item_count',v_total);
end;
$$;

create or replace function public.save_stock_transfer_count_v4(
  p_transfer_id uuid,
  p_items jsonb,
  p_notes text default null,
  p_submit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user_id uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_quantity numeric;
  v_saved integer:=0;
begin
  if not private.has_permission('transfers.count',v_user_id)
     and not private.has_permission('transfers.receive',v_user_id) then
    raise exception 'Permission required: transfers.count';
  end if;
  select * into v_profile from public.profiles where id=v_user_id and is_active=true;
  select * into v_transfer from public.stock_transfers
    where id=p_transfer_id and organization_id=v_profile.organization_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if v_transfer.workflow_version<2 or v_transfer.status<>'pending' or v_transfer.count_status not in('pending','counting') then
    raise exception 'This transfer is not open for counting';
  end if;
  if v_transfer.destination_branch_id<>v_profile.branch_id and not private.has_permission('branches.all',v_user_id) then
    raise exception 'Switch to the destination branch before counting';
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'Count items are required'; end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_product_id:=nullif(v_item->>'product_id','')::uuid;
    v_quantity:=case when not(v_item?'counted_quantity') or v_item->'counted_quantity'='null'::jsonb then null else (v_item->>'counted_quantity')::numeric end;
    if v_product_id is null then raise exception 'Every count row requires a product'; end if;
    if v_quantity is not null and v_quantity<0 then raise exception 'Counted quantity cannot be negative'; end if;
    update public.stock_transfer_items set
      counted_quantity=v_quantity,
      count_note=nullif(trim(coalesce(v_item->>'note','')),'' )
    where transfer_id=v_transfer.id and product_id=v_product_id;
    if not found then raise exception 'A counted product is not part of this transfer'; end if;
    v_saved:=v_saved+1;
  end loop;

  if p_submit and exists(select 1 from public.stock_transfer_items where transfer_id=v_transfer.id and counted_quantity is null) then
    raise exception 'Count every product before submitting for approval';
  end if;

  update public.stock_transfers set
    count_status=case when p_submit then 'awaiting_approval' else 'counting' end,
    count_notes=nullif(trim(p_notes),''),
    counted_by=v_user_id,
    counted_at=now(),
    submitted_by=case when p_submit then v_user_id else submitted_by end,
    submitted_at=case when p_submit then now() else submitted_at end,
    updated_at=now()
  where id=v_transfer.id;

  return jsonb_build_object('ok',true,'transfer_id',v_transfer.id,'transfer_number',v_transfer.transfer_number,'count_status',case when p_submit then 'awaiting_approval' else 'counting' end,'saved_items',v_saved);
end;
$$;

create or replace function public.reopen_stock_transfer_count_v4(
  p_transfer_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare v_user_id uuid:=auth.uid(); v_transfer public.stock_transfers%rowtype;
begin
  if not private.has_permission('transfers.approve',v_user_id)
     and not private.has_permission('approvals.review',v_user_id) then
    raise exception 'Permission required: transfers.approve';
  end if;
  select * into v_transfer from public.stock_transfers where id=p_transfer_id and organization_id=private.current_organization_id() for update;
  if not found then raise exception 'Transfer not found'; end if;
  if v_transfer.status<>'pending' or v_transfer.count_status<>'awaiting_approval' then raise exception 'Only a submitted count can return to counting'; end if;
  update public.stock_transfers set count_status='counting',approval_note=nullif(trim(p_note),''),submitted_by=null,submitted_at=null,updated_at=now() where id=v_transfer.id;
  return jsonb_build_object('ok',true,'transfer_id',v_transfer.id,'transfer_number',v_transfer.transfer_number,'count_status','counting');
end;
$$;

create or replace function public.approve_stock_transfer_v4(
  p_transfer_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user_id uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_transfer public.stock_transfers%rowtype;
  v_item record;
  v_product public.products%rowtype;
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
  if not private.has_permission('transfers.approve',v_user_id)
     and not private.has_permission('approvals.review',v_user_id) then
    raise exception 'Permission required: transfers.approve';
  end if;
  select * into v_profile from public.profiles where id=v_user_id and is_active=true;
  select * into v_transfer from public.stock_transfers
    where id=p_transfer_id and organization_id=v_profile.organization_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if v_transfer.workflow_version<2 or v_transfer.status<>'pending' or v_transfer.count_status<>'awaiting_approval' then
    raise exception 'This transfer is not waiting for approval';
  end if;
  if v_transfer.destination_branch_id<>v_profile.branch_id and not private.has_permission('branches.all',v_user_id) then
    raise exception 'Switch to the destination branch before approval';
  end if;

  v_today:=coalesce(private.batch_business_date(v_profile.organization_id),current_date);

  for v_item in
    select sti.*,p.name,p.default_cost,p.batch_tracking,p.expiry_tracking,p.picking_policy,p.unit_name
    from public.stock_transfer_items sti join public.products p on p.id=sti.product_id
    where sti.transfer_id=v_transfer.id order by sti.product_id
  loop
    if v_item.counted_quantity is null then raise exception 'Every product must be counted before approval'; end if;
    v_quantity:=v_item.counted_quantity;
    if v_quantity<=0 then continue; end if;

    insert into public.inventory_balances(organization_id,branch_id,product_id,quantity,average_cost)
    values(v_profile.organization_id,v_transfer.source_branch_id,v_item.product_id,0,coalesce(v_item.unit_cost,v_item.default_cost,0))
    on conflict(branch_id,product_id) do nothing;
    select * into v_source from public.inventory_balances
      where branch_id=v_transfer.source_branch_id and product_id=v_item.product_id for update;
    if v_source.quantity<v_quantity then
      raise exception 'Not enough source stock for %. Available %, counted %',v_item.name,v_source.quantity,v_quantity;
    end if;

    insert into public.inventory_balances(organization_id,branch_id,product_id,quantity,average_cost)
    values(v_profile.organization_id,v_transfer.destination_branch_id,v_item.product_id,0,coalesce(v_item.unit_cost,v_item.default_cost,0))
    on conflict(branch_id,product_id) do nothing;
    select * into v_destination from public.inventory_balances
      where branch_id=v_transfer.destination_branch_id and product_id=v_item.product_id for update;

    v_new_average:=case
      when v_destination.quantity+v_quantity<=0 then coalesce(v_item.unit_cost,0)
      else round(((v_destination.quantity*v_destination.average_cost)+(v_quantity*coalesce(v_item.unit_cost,0)))/(v_destination.quantity+v_quantity),4)
    end;

    update public.inventory_balances set quantity=quantity-v_quantity,updated_at=now() where id=v_source.id;
    update public.inventory_balances set quantity=quantity+v_quantity,average_cost=v_new_average,updated_at=now() where id=v_destination.id;

    insert into public.stock_movements(organization_id,branch_id,product_id,movement_type,quantity_change,quantity_before,quantity_after,unit_cost,reference_table,reference_id,notes,created_by)
    values
      (v_profile.organization_id,v_transfer.source_branch_id,v_item.product_id,'transfer_out',-v_quantity,v_source.quantity,v_source.quantity-v_quantity,coalesce(v_item.unit_cost,0),'stock_transfers',v_transfer.id,concat(v_transfer.transfer_number,' approved transfer out'),v_user_id),
      (v_profile.organization_id,v_transfer.destination_branch_id,v_item.product_id,'transfer_in',v_quantity,v_destination.quantity,v_destination.quantity+v_quantity,coalesce(v_item.unit_cost,0),'stock_transfers',v_transfer.id,concat(v_transfer.transfer_number,' approved transfer in'),v_user_id);

    if coalesce(v_item.batch_tracking,false) then
      v_remaining:=v_quantity;
      for v_batch in
        select * from public.inventory_batches b
        where b.branch_id=v_transfer.source_branch_id and b.product_id=v_item.product_id
          and b.status='active' and b.quantity>0
          and (b.expiry_date is null or b.expiry_date>=v_today)
        order by case when v_item.picking_policy='fefo' then coalesce(b.expiry_date,'9999-12-31'::date) end,b.received_date,b.created_at
        for update
      loop
        exit when v_remaining<=0.0005;
        v_take:=least(v_remaining,v_batch.quantity);
        update public.inventory_batches set quantity=quantity-v_take,
          status=case when quantity-v_take<=0.0005 then 'depleted'::public.inventory_batch_status else status end,
          updated_at=now() where id=v_batch.id;
        insert into public.stock_transfer_item_batches(organization_id,transfer_item_id,source_batch_id,batch_number,expiry_date,received_date,base_quantity,base_unit_cost,notes)
        values(v_profile.organization_id,v_item.id,v_batch.id,v_batch.batch_number,v_batch.expiry_date,v_batch.received_date,v_take,v_batch.unit_cost,v_batch.notes)
        returning id into v_transfer_batch_id;
        insert into public.inventory_batches(organization_id,branch_id,product_id,batch_number,expiry_date,received_date,source_type,source_transfer_item_id,initial_quantity,quantity,unit_cost,status,notes,created_by)
        values(v_profile.organization_id,v_transfer.destination_branch_id,v_item.product_id,v_batch.batch_number,v_batch.expiry_date,v_batch.received_date,'transfer',v_item.id,v_take,v_take,v_batch.unit_cost,
          case when v_batch.expiry_date is not null and v_batch.expiry_date<v_today then 'quarantined'::public.inventory_batch_status else 'active'::public.inventory_batch_status end,
          v_batch.notes,v_user_id)
        returning id into v_destination_batch_id;
        update public.stock_transfer_item_batches set destination_batch_id=v_destination_batch_id where id=v_transfer_batch_id;
        v_remaining:=round(v_remaining-v_take,3);
      end loop;
      if v_remaining>0.0005 then raise exception 'Insufficient active batch stock for %',v_item.name; end if;
    end if;
  end loop;

  update public.stock_transfers set
    status='received',count_status='approved',received_by=v_user_id,received_at=now(),
    approved_by=v_user_id,approved_at=now(),approval_note=nullif(trim(p_note),''),receive_notes=coalesce(count_notes,receive_notes),updated_at=now()
  where id=v_transfer.id;

  insert into public.audit_logs(organization_id,branch_id,user_id,action,entity_type,entity_id,new_data)
  values(v_profile.organization_id,v_transfer.destination_branch_id,v_user_id,'approve_stock_transfer','stock_transfer',v_transfer.id,
    jsonb_build_object('transfer_number',v_transfer.transfer_number,'source_branch_id',v_transfer.source_branch_id,'destination_branch_id',v_transfer.destination_branch_id));

  return jsonb_build_object('ok',true,'transfer_id',v_transfer.id,'transfer_number',v_transfer.transfer_number,'status','received','count_status','approved');
end;
$$;

create or replace function public.cancel_stock_transfer_v4(p_transfer_id uuid,p_reason text)
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare v_user_id uuid:=auth.uid(); v_transfer public.stock_transfers%rowtype;
begin
  perform private.require_permission('transfers.cancel');
  select * into v_transfer from public.stock_transfers where id=p_transfer_id and organization_id=private.current_organization_id() for update;
  if not found then raise exception 'Transfer not found'; end if;
  if v_transfer.workflow_version<2 then return public.cancel_stock_transfer_v3(p_transfer_id,p_reason); end if;
  if v_transfer.status<>'pending' then raise exception 'Only pending transfers can be cancelled'; end if;
  if p_reason is null or length(trim(p_reason))<3 then raise exception 'Cancellation reason is required'; end if;
  update public.stock_transfers set status='cancelled',count_status='cancelled',cancelled_by=v_user_id,cancelled_at=now(),cancel_reason=trim(p_reason),updated_at=now() where id=v_transfer.id;
  return jsonb_build_object('ok',true,'transfer_id',v_transfer.id,'transfer_number',v_transfer.transfer_number,'status','cancelled');
end;
$$;

revoke all on function public.create_stock_transfer_v4(uuid,jsonb,text) from public,anon;
revoke all on function public.update_stock_transfer_v4(uuid,uuid,jsonb,text) from public,anon;
revoke all on function public.save_stock_transfer_count_v4(uuid,jsonb,text,boolean) from public,anon;
revoke all on function public.reopen_stock_transfer_count_v4(uuid,text) from public,anon;
revoke all on function public.approve_stock_transfer_v4(uuid,text) from public,anon;
revoke all on function public.cancel_stock_transfer_v4(uuid,text) from public,anon;

grant execute on function public.create_stock_transfer_v4(uuid,jsonb,text) to authenticated,service_role;
grant execute on function public.update_stock_transfer_v4(uuid,uuid,jsonb,text) to authenticated,service_role;
grant execute on function public.save_stock_transfer_count_v4(uuid,jsonb,text,boolean) to authenticated,service_role;
grant execute on function public.reopen_stock_transfer_count_v4(uuid,text) to authenticated,service_role;
grant execute on function public.approve_stock_transfer_v4(uuid,text) to authenticated,service_role;
grant execute on function public.cancel_stock_transfer_v4(uuid,text) to authenticated,service_role;

-- The following existing stock-count/refund functions are redefined below so
-- granular/custom permissions are honored instead of hard-coded base roles.
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

  if not private.has_permission('stock_counts.manage', v_user_id) then
    raise exception 'Permission required: stock_counts.manage';
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

  if not private.has_permission('stock_counts.manage', v_user_id) then
    raise exception 'Permission required: stock_counts.manage';
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

  if not private.has_permission('stock_counts.manage', v_user_id) then
    raise exception 'Permission required: stock_counts.manage';
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

  if not private.has_permission('stock_counts.manage', v_user_id) then
    raise exception 'Permission required: stock_counts.manage';
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

  if not private.has_permission('stock_counts.manage', v_user_id) then
    raise exception 'Permission required: stock_counts.manage';
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
  v_user_id uuid := auth.uid();
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
  v_base_return_quantity numeric(14,3);

  v_sale_line_total numeric(14,2);
  v_previous_tax_refunded numeric(14,2);
  v_remaining_tax numeric(14,2);

  v_net_refund numeric(14,2);
  v_tax_refund numeric(14,2);
  v_line_refund numeric(14,2);
  v_unit_refund numeric(14,2);
  v_line_cost numeric(14,4);
  v_profit_reversal numeric(14,4);
  v_base_unit_cost numeric(14,4);

  v_total_refund numeric(14,2) := 0;
  v_total_tax_refund numeric(14,2) := 0;
  v_total_cost numeric(14,4) := 0;
  v_total_profit_reversal numeric(14,4) := 0;

  v_total_sold_qty numeric(14,3);
  v_total_returned_qty numeric(14,3);

  v_new_quantity numeric(14,3);
  v_new_average_cost numeric(14,4);
begin
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
    raise exception 'Your POS account is inactive or missing';
  end if;

  if not private.has_permission('returns.process', v_user_id) then
    raise exception 'Permission required: returns.process';
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

  if v_sale.status not in ('completed','partially_refunded') then
    raise exception
      'This sale cannot be refunded because its status is %',
      v_sale.status;
  end if;

  select coalesce(sum(si.line_total), 0)
  into v_sale_line_total
  from public.sale_items si
  where si.sale_id = v_sale.id;

  select coalesce(sum(ri.tax_refund), 0)
  into v_previous_tax_refunded
  from public.return_items ri
  join public.returns r on r.id = ri.return_id
  where r.original_sale_id = v_sale.id
    and r.status = 'completed';

  v_remaining_tax := greatest(
    v_sale.tax_amount - v_previous_tax_refunded,
    0
  );

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

  for v_item in
    select
      x.sale_item_id,
      sum(x.quantity)::numeric(14,3) as quantity,
      bool_and(coalesce(x.restock, true)) as restock
    from jsonb_to_recordset(p_items)
      as x(
        sale_item_id uuid,
        quantity numeric,
        restock boolean
      )
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
      si.base_quantity,
      si.sale_unit_name,
      si.unit_factor,
      si.unit_price,
      si.unit_cost,
      si.line_total,
      p.track_stock
    into v_sale_item
    from public.sale_items si
    left join public.products p on p.id = si.product_id
    where si.id = v_item.sale_item_id
      and si.sale_id = v_sale.id
    for update of si;

    if not found then
      raise exception
        'Sale item % does not belong to this sale',
        v_item.sale_item_id;
    end if;

    select coalesce(sum(ri.quantity), 0)
    into v_previous_returned
    from public.return_items ri
    join public.returns r on r.id = ri.return_id
    where ri.sale_item_id = v_sale_item.id
      and r.status = 'completed';

    v_available := v_sale_item.quantity - v_previous_returned;

    if v_requested > v_available then
      raise exception
        'Only % % of "%" can still be refunded',
        v_available,
        v_sale_item.sale_unit_name,
        v_sale_item.product_name;
    end if;

    v_base_return_quantity := round(
      v_requested * v_sale_item.unit_factor,
      3
    );

    v_net_refund := round(
      v_sale_item.line_total
        * v_requested / v_sale_item.quantity,
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

    v_remaining_tax := greatest(
      v_remaining_tax - v_tax_refund,
      0
    );
    v_line_refund := round(v_net_refund + v_tax_refund, 2);
    v_unit_refund := round(v_line_refund / v_requested, 2);
    v_line_cost := round(
      v_sale_item.unit_cost * v_requested,
      4
    );
    v_profit_reversal := round(
      v_net_refund - v_line_cost,
      4
    );

    insert into public.return_items (
      organization_id,
      return_id,
      sale_item_id,
      product_id,
      quantity,
      base_quantity,
      return_unit_name,
      unit_factor,
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
      v_base_return_quantity,
      v_sale_item.sale_unit_name,
      v_sale_item.unit_factor,
      v_unit_refund,
      v_line_refund,
      coalesce(v_item.restock, true),
      v_tax_refund,
      v_sale_item.unit_cost,
      v_line_cost,
      v_profit_reversal
    );

    v_total_refund := v_total_refund + v_line_refund;
    v_total_tax_refund :=
      v_total_tax_refund + v_tax_refund;
    v_total_cost := v_total_cost + v_line_cost;
    v_total_profit_reversal :=
      v_total_profit_reversal + v_profit_reversal;

    if coalesce(v_item.restock, true)
       and v_sale_item.product_id is not null
       and coalesce(v_sale_item.track_stock, false) then

      v_base_unit_cost := case
        when v_sale_item.unit_factor > 0
          then v_sale_item.unit_cost / v_sale_item.unit_factor
        else v_sale_item.unit_cost
      end;

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
        v_base_unit_cost
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

      v_new_quantity :=
        v_balance.quantity + v_base_return_quantity;

      if v_new_quantity > 0 and v_balance.quantity >= 0 then
        v_new_average_cost := round(
          (
            (v_balance.quantity * v_balance.average_cost)
            + (v_base_return_quantity * v_base_unit_cost)
          ) / v_new_quantity,
          4
        );
      else
        v_new_average_cost := v_base_unit_cost;
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
        v_base_return_quantity,
        v_balance.quantity,
        v_new_quantity,
        v_base_unit_cost,
        'returns',
        v_return_id,
        format(
          '%s · %s %s (%s base units)',
          v_return_number,
          v_requested,
          v_sale_item.sale_unit_name,
          v_base_return_quantity
        ),
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
  join public.returns r on r.id = ri.return_id
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
      'reason', trim(p_reason),
      'unit_aware', true
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
commit;
-- ============================================================================
-- END STEP 46.4.12
-- ============================================================================
