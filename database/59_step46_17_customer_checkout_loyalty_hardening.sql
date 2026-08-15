-- ============================================================================
-- Tiny POS Patch 46.17 — Customer checkout / loyalty hardening
-- Run ONCE after database/58_step46_15_product_history_stock_summary.sql.
--
-- Why this is needed:
-- Walk-in sales do not touch the customer loyalty ledger, while named-customer
-- sales can. Older/imported customers may have a NULL loyalty_points value and
-- legacy actor rows can also be unsuitable for the loyalty FK. Either condition
-- must never make a valid customer checkout fail.
--
-- This migration does NOT change sale prices, credit rules, stock, customer
-- selection, or existing loyalty movement history.
-- ============================================================================

begin;

-- Normalize old/imported customer rows so named-customer checkout starts from a
-- deterministic loyalty balance.
update public.customers
set loyalty_points = 0,
    updated_at = now()
where loyalty_points is null;

alter table public.customers
  alter column loyalty_points set default 0;

-- Keep the existing loyalty semantics but make the ledger write null-safe and
-- guarantee that created_by points to an actual auth.users row.
create or replace function private.apply_loyalty_delta(
  p_org uuid,
  p_customer uuid,
  p_delta numeric,
  p_reason text,
  p_table text,
  p_id uuid,
  p_actor uuid default null
)
returns numeric
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  before_points numeric := 0;
  after_points numeric := 0;
  v_actor uuid;
begin
  select coalesce(c.loyalty_points,0)
  into before_points
  from public.customers c
  where c.id=p_customer
    and c.organization_id=p_org
  for update;

  if not found then
    raise exception 'Customer not found for loyalty update';
  end if;

  if coalesce(p_delta,0)=0 then
    return before_points;
  end if;

  after_points := greatest(
    0,
    round(before_points + coalesce(p_delta,0),2)
  );

  if after_points = before_points then
    return after_points;
  end if;

  v_actor := p_actor;

  if v_actor is null
     or not exists(select 1 from auth.users u where u.id=v_actor) then
    v_actor := auth.uid();
  end if;

  if v_actor is null
     or not exists(select 1 from auth.users u where u.id=v_actor) then
    select p.id
    into v_actor
    from public.profiles p
    join auth.users u on u.id=p.id
    where p.organization_id=p_org
      and p.is_active=true
      and p.role in ('owner','admin')
    order by case when p.role='owner' then 0 else 1 end, p.created_at
    limit 1;
  end if;

  if v_actor is null then
    raise exception 'A valid loyalty ledger actor could not be resolved';
  end if;

  update public.customers
  set loyalty_points=after_points,
      updated_at=now()
  where id=p_customer
    and organization_id=p_org;

  insert into public.customer_loyalty_movements(
    organization_id,
    customer_id,
    points_change,
    points_before,
    points_after,
    reason,
    reference_table,
    reference_id,
    created_by
  )
  values(
    p_org,
    p_customer,
    round(after_points-before_points,2),
    before_points,
    after_points,
    coalesce(nullif(trim(p_reason),''),'Loyalty adjustment'),
    nullif(trim(p_table),''),
    p_id,
    v_actor
  );

  return after_points;
end;
$$;

revoke all on function private.apply_loyalty_delta(uuid,uuid,numeric,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function private.apply_loyalty_delta(uuid,uuid,numeric,text,text,uuid,uuid) to service_role;

-- Reinstall the customer-sale loyalty trigger using the hardened ledger helper.
create or replace function private.crm_award_sale_loyalty()
returns trigger
language plpgsql
security definer
set search_path=public,private,auth,pg_temp
as $$
declare
  cfg public.loyalty_program_settings%rowtype;
  basis numeric := 0;
  points numeric := 0;
  v_actor uuid;
begin
  if new.customer_id is null
     or new.status not in ('completed','partially_refunded','refunded') then
    return new;
  end if;

  if exists(
    select 1
    from public.customer_loyalty_movements m
    where m.reference_table='sale'
      and m.reference_id=new.id
  ) then
    return new;
  end if;

  select *
  into cfg
  from public.loyalty_program_settings s
  where s.organization_id=new.organization_id;

  if not found or coalesce(cfg.enabled,false) is not true then
    return new;
  end if;

  if cfg.started_at is not null
     and coalesce(new.completed_at,new.created_at) < cfg.started_at then
    return new;
  end if;

  basis := case
    when coalesce(cfg.award_on_discounted_total,false)
      then coalesce(new.total_amount,0)
    else coalesce(new.subtotal,0)
  end;

  if coalesce(cfg.award_on_tax,false) is not true then
    basis := greatest(0,basis-coalesce(new.tax_amount,0));
  end if;

  points := case
    when new.currency='KHR'
      then floor(basis/1000*coalesce(cfg.khr_points_per_1000,0))
    else floor(basis*coalesce(cfg.usd_points_per_unit,0))
  end;

  if coalesce(points,0) <= 0 then
    return new;
  end if;

  v_actor := coalesce(new.cashier_id,auth.uid());

  perform private.apply_loyalty_delta(
    new.organization_id,
    new.customer_id,
    points,
    'Automatic points from '||new.invoice_number,
    'sale',
    new.id,
    v_actor
  );

  return new;
end;
$$;

revoke all on function private.crm_award_sale_loyalty() from public,anon;

drop trigger if exists crm_award_sale_loyalty on public.sales;
create trigger crm_award_sale_loyalty
after insert or update of status on public.sales
for each row execute function private.crm_award_sale_loyalty();

commit;
