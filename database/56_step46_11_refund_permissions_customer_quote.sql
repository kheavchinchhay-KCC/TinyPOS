-- ============================================================================
-- Tiny POS Patch 46.11 — Quote reset, branch-wide refunds, refund date access
-- Run ONCE after database/55_step46_10_stock_transfer_requests_units.sql.
-- Additive / compatibility migration. No sales, refunds, customers or staff are
-- deleted. Existing amount-based approval limits remain active.
-- ============================================================================

begin;

-- Cashiers can open Returns & Refunds by default. Individual permission
-- overrides still win, so an intentionally disabled cashier stays disabled.
update public.permission_definitions
set default_roles = case
  when 'cashier'::public.app_role = any(default_roles) then default_roles
  else array_append(default_roles, 'cashier'::public.app_role)
end
where permission_key = 'returns.process';

-- Per-user date window. Amount limits live separately in user_approval_limits.
create table if not exists public.user_refund_permissions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  refund_window text not null default 'current_date'
    check (refund_window in ('current_date','this_week','this_month','any_date')),
  is_customized boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists user_refund_permissions_org_idx
  on public.user_refund_permissions(organization_id, refund_window);

alter table public.user_refund_permissions enable row level security;
revoke all on public.user_refund_permissions from anon, authenticated;
grant all on public.user_refund_permissions to service_role;

create or replace function private.default_refund_window(
  p_role public.app_role
) returns text
language sql
immutable
as $$
  select case p_role
    when 'owner' then 'any_date'
    when 'admin' then 'any_date'
    when 'manager' then 'this_week'
    when 'cashier' then 'current_date'
    else 'current_date'
  end;
$$;

revoke all on function private.default_refund_window(public.app_role) from public;
grant execute on function private.default_refund_window(public.app_role) to authenticated, service_role;

insert into public.user_refund_permissions(
  user_id, organization_id, refund_window, is_customized
)
select
  p.id,
  p.organization_id,
  private.default_refund_window(p.role),
  false
from public.profiles p
on conflict (user_id) do nothing;

create or replace function private.sync_profile_refund_permission()
returns trigger
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
begin
  insert into public.user_refund_permissions(
    user_id, organization_id, refund_window, is_customized, updated_at
  )
  values(
    new.id, new.organization_id, private.default_refund_window(new.role), false, now()
  )
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    refund_window = case
      when public.user_refund_permissions.is_customized then public.user_refund_permissions.refund_window
      else excluded.refund_window
    end,
    updated_at = now();

  return new;
end;
$$;

revoke all on function private.sync_profile_refund_permission() from public;

drop trigger if exists sync_profile_refund_permission on public.profiles;
create trigger sync_profile_refund_permission
after insert or update of role, organization_id on public.profiles
for each row execute function private.sync_profile_refund_permission();

create or replace function private.effective_refund_window(
  p_user_id uuid default auth.uid()
) returns text
language plpgsql
stable
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_window text;
begin
  select * into v_profile
  from public.profiles
  where id=p_user_id and is_active=true;

  if not found then return 'current_date'; end if;
  if v_profile.role in ('owner','admin') then return 'any_date'; end if;

  select refund_window into v_window
  from public.user_refund_permissions
  where user_id=p_user_id;

  return coalesce(v_window, private.default_refund_window(v_profile.role));
end;
$$;

revoke all on function private.effective_refund_window(uuid) from public;
grant execute on function private.effective_refund_window(uuid) to authenticated, service_role;

create or replace function private.refund_window_info(
  p_user_id uuid default auth.uid()
) returns jsonb
language plpgsql
stable
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_timezone text := 'Asia/Phnom_Penh';
  v_today date;
  v_from date;
  v_to date;
  v_window text;
  v_label text;
begin
  select * into v_profile
  from public.profiles
  where id=p_user_id and is_active=true;
  if not found then raise exception 'Active POS profile required'; end if;

  select coalesce(nullif(trim(s.timezone),''),'Asia/Phnom_Penh')
    into v_timezone
  from public.app_settings s
  where s.organization_id=v_profile.organization_id;

  v_today := (timezone(coalesce(v_timezone,'Asia/Phnom_Penh'), now()))::date;
  v_window := private.effective_refund_window(p_user_id);

  if v_window='current_date' then
    v_from:=v_today; v_to:=v_today; v_label:='Current date';
  elsif v_window='this_week' then
    v_from:=v_today - (extract(isodow from v_today)::integer - 1);
    v_to:=v_from + 6;
    v_label:='This week';
  elsif v_window='this_month' then
    v_from:=date_trunc('month',v_today)::date;
    v_to:=(date_trunc('month',v_today)+interval '1 month - 1 day')::date;
    v_label:='This month';
  else
    v_from:=null; v_to:=null; v_label:='Any date';
  end if;

  return jsonb_build_object(
    'window',v_window,
    'label',v_label,
    'from',v_from,
    'to',v_to
  );
end;
$$;

revoke all on function private.refund_window_info(uuid) from public;
grant execute on function private.refund_window_info(uuid) to authenticated, service_role;

create or replace function private.refund_sale_allowed(
  p_user_id uuid,
  p_sale_at timestamptz
) returns boolean
language plpgsql
stable
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_timezone text := 'Asia/Phnom_Penh';
  v_today date;
  v_sale_date date;
  v_window text;
  v_week_start date;
  v_month_start date;
begin
  if p_sale_at is null then return false; end if;

  select * into v_profile
  from public.profiles
  where id=p_user_id and is_active=true;
  if not found then return false; end if;

  select coalesce(nullif(trim(s.timezone),''),'Asia/Phnom_Penh')
    into v_timezone
  from public.app_settings s
  where s.organization_id=v_profile.organization_id;

  v_timezone:=coalesce(v_timezone,'Asia/Phnom_Penh');
  v_today:=(timezone(v_timezone,now()))::date;
  v_sale_date:=(timezone(v_timezone,p_sale_at))::date;
  v_window:=private.effective_refund_window(p_user_id);

  if v_window='any_date' then return true; end if;
  if v_window='current_date' then return v_sale_date=v_today; end if;

  if v_window='this_week' then
    v_week_start:=v_today-(extract(isodow from v_today)::integer-1);
    return v_sale_date between v_week_start and v_week_start+6;
  end if;

  if v_window='this_month' then
    v_month_start:=date_trunc('month',v_today)::date;
    return v_sale_date between v_month_start and (date_trunc('month',v_today)+interval '1 month - 1 day')::date;
  end if;

  return false;
end;
$$;

revoke all on function private.refund_sale_allowed(uuid,timestamptz) from public;
grant execute on function private.refund_sale_allowed(uuid,timestamptz) to authenticated, service_role;

-- Access & Approvals > Refund Permissions workspace.
create or replace function public.get_refund_permission_workspace()
returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user_id uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_staff jsonb:='[]'::jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('access.manage');

  select * into v_profile from public.profiles
  where id=v_user_id and is_active=true;
  if not found then raise exception 'Active POS profile required'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,
    'full_name',p.full_name,
    'email',p.email,
    'phone',p.phone,
    'role',p.role,
    'role_key',case when p.custom_role_id is not null then 'custom:'||p.custom_role_id::text else p.role::text end,
    'role_label',coalesce(cr.name,initcap(p.role::text)),
    'branch_id',p.branch_id,
    'branch_name',b.name,
    'branch_code',b.code,
    'is_active',p.is_active,
    'can_refund',private.has_permission('returns.process',p.id),
    'refund_window',private.effective_refund_window(p.id),
    'window_locked',p.role in ('owner','admin')
  ) order by p.full_name,p.email),'[]'::jsonb)
  into v_staff
  from public.profiles p
  left join public.branches b on b.id=p.branch_id
  left join public.custom_staff_roles cr on cr.id=p.custom_role_id
  where p.organization_id=v_profile.organization_id;

  return jsonb_build_object(
    'staff',v_staff,
    'windows',jsonb_build_array(
      jsonb_build_object('value','current_date','label','Current date'),
      jsonb_build_object('value','this_week','label','This week'),
      jsonb_build_object('value','this_month','label','This month'),
      jsonb_build_object('value','any_date','label','Any date')
    )
  );
end;
$$;

revoke all on function public.get_refund_permission_workspace() from public,anon;
grant execute on function public.get_refund_permission_workspace() to authenticated,service_role;

create or replace function public.save_user_refund_window(
  p_user_id uuid,
  p_refund_window text
) returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_caller_id uuid:=auth.uid();
  v_caller public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_window text;
begin
  if v_caller_id is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('access.manage');

  if p_refund_window not in ('current_date','this_week','this_month','any_date') then
    raise exception 'Invalid refund permission window';
  end if;

  select * into v_caller from public.profiles
  where id=v_caller_id and is_active=true;

  select * into v_target from public.profiles
  where id=p_user_id and organization_id=v_caller.organization_id;
  if not found then raise exception 'Staff account not found'; end if;

  v_window:=case when v_target.role in ('owner','admin') then 'any_date' else p_refund_window end;

  insert into public.user_refund_permissions(
    user_id,organization_id,refund_window,is_customized,updated_by,updated_at
  ) values(
    v_target.id,v_target.organization_id,v_window,true,v_caller_id,now()
  )
  on conflict(user_id) do update set
    organization_id=excluded.organization_id,
    refund_window=excluded.refund_window,
    is_customized=true,
    updated_by=excluded.updated_by,
    updated_at=now();

  insert into public.audit_logs(
    organization_id,branch_id,user_id,action,entity_type,entity_id,new_data
  ) values(
    v_target.organization_id,v_target.branch_id,v_caller_id,
    'save_refund_permission','profile',v_target.id,
    jsonb_build_object('target_name',v_target.full_name,'target_role',v_target.role,'refund_window',v_window)
  );

  return jsonb_build_object('ok',true,'user_id',v_target.id,'refund_window',v_window);
end;
$$;

revoke all on function public.save_user_refund_window(uuid,text) from public,anon;
grant execute on function public.save_user_refund_window(uuid,text) to authenticated,service_role;

-- Branch-wide refund workspace. This deliberately does not filter by cashier_id.
-- The caller still must have returns.process and the current branch is enforced.
create or replace function public.get_returns_workspace_v2(
  p_from date,
  p_to date
) returns jsonb
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  v_user_id uuid:=auth.uid();
  v_profile public.profiles%rowtype;
  v_timezone text:='Asia/Phnom_Penh';
  v_sales jsonb:='[]'::jsonb;
  v_returns jsonb:='[]'::jsonb;
  v_policy jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  perform private.require_permission('returns.process');

  select * into v_profile from public.profiles
  where id=v_user_id and is_active=true and branch_id is not null;
  if not found then raise exception 'Active POS profile and branch are required'; end if;

  if p_from is null or p_to is null or p_from>p_to then
    raise exception 'A valid From / To date range is required';
  end if;

  select coalesce(nullif(trim(s.timezone),''),'Asia/Phnom_Penh')
    into v_timezone
  from public.app_settings s
  where s.organization_id=v_profile.organization_id;
  v_timezone:=coalesce(v_timezone,'Asia/Phnom_Penh');
  v_policy:=private.refund_window_info(v_user_id);

  select coalesce(jsonb_agg(to_jsonb(q) order by q.sort_at desc),'[]'::jsonb)
  into v_sales
  from (
    select
      s.id, s.organization_id, s.branch_id, s.invoice_number, s.customer_id,
      s.cashier_id, cashier.full_name as cashier_name, s.status, s.payment_status,
      s.currency, s.subtotal, s.discount_amount, s.tax_amount, s.total_amount,
      s.paid_amount, s.change_amount, s.cost_amount, s.gross_profit,
      s.credit_account_id, s.credit_due_date, s.credit_amount, s.notes,
      s.created_at, s.completed_at, coalesce(s.completed_at,s.created_at) as sort_at,
      case when c.id is null then null else jsonb_build_object(
        'id',c.id,'name',c.name,'phone',c.phone
      ) end as customers,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',p.id,'method',p.method,'amount',p.amount,'tendered_amount',p.tendered_amount,
        'change_amount',p.change_amount,'reference_number',p.reference_number,'paid_at',p.paid_at
      ) order by p.paid_at) from public.payments p where p.sale_id=s.id),'[]'::jsonb) as payments,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',si.id,'product_id',si.product_id,'product_name',si.product_name,'barcode',si.barcode,
        'quantity',si.quantity,'base_quantity',si.base_quantity,'sale_unit_name',si.sale_unit_name,
        'unit_factor',si.unit_factor,'unit_price',si.unit_price,'unit_cost',si.unit_cost,
        'discount_amount',si.discount_amount,'tax_amount',si.tax_amount,'line_total',si.line_total,
        'line_profit',si.line_profit,
        'returned_quantity',coalesce((select sum(ri.quantity) from public.return_items ri join public.returns rr on rr.id=ri.return_id where ri.sale_item_id=si.id and rr.status='completed'),0),
        'returnable_quantity',greatest(si.quantity-coalesce((select sum(ri.quantity) from public.return_items ri join public.returns rr on rr.id=ri.return_id where ri.sale_item_id=si.id and rr.status='completed'),0),0)
      ) order by si.id) from public.sale_items si where si.sale_id=s.id),'[]'::jsonb) as sale_items,
      coalesce((select sum(r.refund_amount) from public.returns r where r.original_sale_id=s.id and r.status='completed'),0) as refunded_amount,
      coalesce((select sum(ri.tax_refund) from public.return_items ri join public.returns r on r.id=ri.return_id where r.original_sale_id=s.id and r.status='completed'),0) as previous_tax_refunded,
      private.refund_sale_allowed(v_user_id,coalesce(s.completed_at,s.created_at)) as refund_allowed,
      case when private.refund_sale_allowed(v_user_id,coalesce(s.completed_at,s.created_at)) then null
           else 'Allowed refund period: '||(v_policy->>'label') end as refund_block_reason
    from public.sales s
    left join public.customers c on c.id=s.customer_id
    left join public.profiles cashier on cashier.id=s.cashier_id
    where s.organization_id=v_profile.organization_id
      and s.branch_id=v_profile.branch_id
      and s.status in ('completed','partially_refunded','refunded')
      and (timezone(v_timezone,coalesce(s.completed_at,s.created_at)))::date between p_from and p_to
    order by coalesce(s.completed_at,s.created_at) desc
    limit 300
  ) q;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.processed_at desc),'[]'::jsonb)
  into v_returns
  from (
    select
      r.id,r.organization_id,r.branch_id,r.return_number,r.original_sale_id,r.customer_id,
      r.status,r.currency,r.refund_amount,
      case when coalesce(r.credit_refund_amount,0)>0 then 'credit' else r.refund_method::text end as refund_method,
      r.refund_reference,r.credit_account_id,r.credit_refund_amount,r.reason,r.processed_by,r.processed_at,
      r.tax_refund,r.cost_amount,r.profit_reversal,
      jsonb_build_object(
        'id',s.id,'invoice_number',s.invoice_number,'completed_at',s.completed_at,
        'cashier_id',s.cashier_id,'cashier_name',cashier.full_name,
        'customers',case when c.id is null then null else jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone) end
      ) as sales,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id',ri.id,'sale_item_id',ri.sale_item_id,'product_id',ri.product_id,'quantity',ri.quantity,
        'base_quantity',ri.base_quantity,'return_unit_name',ri.return_unit_name,'unit_factor',ri.unit_factor,
        'unit_refund',ri.unit_refund,'line_refund',ri.line_refund,'restock',ri.restock,'tax_refund',ri.tax_refund,
        'unit_cost',ri.unit_cost,'line_cost',ri.line_cost,'line_profit_reversal',ri.line_profit_reversal,
        'sale_items',jsonb_build_object('product_name',si.product_name,'barcode',si.barcode,'sale_unit_name',si.sale_unit_name,'unit_factor',si.unit_factor,'unit_price',si.unit_price)
      ) order by ri.id)
      from public.return_items ri
      left join public.sale_items si on si.id=ri.sale_item_id
      where ri.return_id=r.id),'[]'::jsonb) as return_items
    from public.returns r
    join public.sales s on s.id=r.original_sale_id
    left join public.customers c on c.id=s.customer_id
    left join public.profiles cashier on cashier.id=s.cashier_id
    where r.organization_id=v_profile.organization_id
      and r.branch_id=v_profile.branch_id
      and r.status='completed'
      and (timezone(v_timezone,r.processed_at))::date between p_from and p_to
    order by r.processed_at desc
    limit 300
  ) q;

  return jsonb_build_object(
    'sales',v_sales,
    'returns',v_returns,
    'refund_policy',v_policy
  );
end;
$$;

revoke all on function public.get_returns_workspace_v2(date,date) from public,anon;
grant execute on function public.get_returns_workspace_v2(date,date) to authenticated,service_role;

-- Replace only the old hard-coded role gate in the established transactional
-- return core. All refund math, stock restoration, audit and receipt behavior
-- remain unchanged; permission + date window now decide who may process.
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
  v_policy jsonb;

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


  if not private.refund_sale_allowed(
    v_user_id,
    coalesce(v_sale.completed_at, v_sale.created_at)
  ) then
    v_policy := private.refund_window_info(v_user_id);
    raise exception
      'This invoice is outside your refund date permission (%).',
      coalesce(v_policy ->> 'label', 'restricted');
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
revoke all on function public.process_sale_return(
  uuid, jsonb, public.payment_method, text, text
) from public,anon;
grant execute on function public.process_sale_return(
  uuid, jsonb, public.payment_method, text, text
) to authenticated,service_role;

commit;
