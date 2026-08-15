-- ============================================================================
-- Tiny POS — Fix: checkout fails for any named customer, only walk-in works
-- Run once, any time after 31_sales_orders_fulfilment.sql.
--
-- Root cause: private.resolve_standard_sales_unit_price() declares
-- v_customer as public.customers%rowtype (a fixed-structure row variable),
-- but only ever selected 3 of the table's columns into it:
--
--   select c.id,c.customer_type,c.price_list_id into v_customer ...
--
-- PL/pgSQL requires a SELECT INTO a %ROWTYPE variable to return exactly the
-- same number of columns as the row type, or it raises a runtime error
-- ("number of source and target fields in assignment does not match").
-- That branch only runs when p_customer_id is not null, so every sale with
-- a selected (non walk-in) customer hit this error during price resolution
-- and rolled back; walk-in sales (customer_id null) skipped the branch
-- entirely and always worked. Fix: select the full row (c.*) instead of
-- three columns, keeping the %rowtype declaration so v_customer.price_list_id
-- still safely evaluates to null for walk-in sales, where this select never
-- runs at all.
-- ============================================================================

begin;

create or replace function private.resolve_standard_sales_unit_price(
  p_organization_id uuid,p_branch_id uuid,p_customer_id uuid,p_product_unit_id uuid,
  p_currency public.currency_code,p_at timestamptz default now()
) returns jsonb language plpgsql security definer
set search_path=public,private,auth,pg_temp as $$
declare v_unit record; v_customer public.customers%rowtype; v_list public.price_lists%rowtype; v_override numeric(14,2);
begin
  select u.id,u.product_id,u.selling_price,u.is_active,p.currency,p.is_active product_active
  into v_unit from public.product_units u join public.products p on p.id=u.product_id
  where u.id=p_product_unit_id and u.organization_id=p_organization_id and p.organization_id=p_organization_id;
  if not found or not v_unit.is_active or not v_unit.product_active then raise exception 'Selling unit is unavailable'; end if;
  if v_unit.currency<>p_currency then raise exception 'Selling unit currency does not match the sale currency'; end if;
  if p_customer_id is not null then
    select c.* into v_customer from public.customers c
     where c.id=p_customer_id and c.organization_id=p_organization_id and c.is_active=true;
    if not found then raise exception 'Customer not found or inactive'; end if;
  end if;
  if v_customer.price_list_id is not null then
    select l.* into v_list from public.price_lists l
     where l.id=v_customer.price_list_id and l.organization_id=p_organization_id
       and l.currency=p_currency and l.is_active=true and (l.branch_id is null or l.branch_id=p_branch_id)
       and (l.starts_at is null or l.starts_at<=p_at) and (l.ends_at is null or l.ends_at>p_at) limit 1;
  end if;
  if v_list.id is null then
    select l.* into v_list from public.price_lists l
     where l.organization_id=p_organization_id and l.currency=p_currency and l.is_active=true
       and (l.branch_id is null or l.branch_id=p_branch_id)
       and l.customer_type in(coalesce(v_customer.customer_type,'all'),'all')
       and (l.starts_at is null or l.starts_at<=p_at) and (l.ends_at is null or l.ends_at>p_at)
     order by case when p_customer_id is not null and l.customer_type=v_customer.customer_type then 0
                   when l.customer_type='all' then 1 else 2 end,
              case when l.branch_id=p_branch_id then 0 else 1 end,l.priority desc,l.created_at desc limit 1;
  end if;
  if v_list.id is not null then
    select i.selling_price into v_override from public.price_list_items i
     where i.price_list_id=v_list.id and i.product_unit_id=v_unit.id limit 1;
  end if;
  return jsonb_build_object('product_unit_id',v_unit.id,'product_id',v_unit.product_id,
    'price_list_id',v_list.id,'price_list_code',v_list.code,'price_list_name',v_list.name,
    'list_price',v_unit.selling_price,'effective_price',coalesce(v_override,v_unit.selling_price),
    'price_adjustment',round(v_unit.selling_price-coalesce(v_override,v_unit.selling_price),2),
    'has_override',v_override is not null);
end; $$;
revoke all on function private.resolve_standard_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) from public,anon;
grant execute on function private.resolve_standard_sales_unit_price(uuid,uuid,uuid,uuid,public.currency_code,timestamptz) to authenticated,service_role;

commit;
