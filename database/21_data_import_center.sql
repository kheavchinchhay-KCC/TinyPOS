-- ============================================================================
-- Tiny POS - Step 23: CSV Import and Migration Center
-- Run once in the NEW Supabase project after Step 22.
--
-- Supported imports:
--   products       Products, categories and opening stock for new products
--   product_units  Box, Pack, Carton and other package units
--   customers      Customer profile and optional opening loyalty balance
--   suppliers      Supplier profile and supplier code
--
-- Maximum rows per import job: 1,000
-- This migration does not delete existing business data.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. IMPORT JOB HISTORY
-- ----------------------------------------------------------------------------

create table if not exists public.data_import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  branch_id uuid not null
    references public.branches(id) on delete restrict,
  import_type text not null
    check (import_type in (
      'products',
      'product_units',
      'customers',
      'suppliers'
    )),
  duplicate_mode text not null
    check (duplicate_mode in ('skip','update','error')),
  file_name text,
  status text not null default 'processing'
    check (status in (
      'processing',
      'completed',
      'completed_with_errors',
      'failed'
    )),
  total_rows integer not null default 0 check (total_rows >= 0),
  created_rows integer not null default 0 check (created_rows >= 0),
  updated_rows integer not null default 0 check (updated_rows >= 0),
  skipped_rows integer not null default 0 check (skipped_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  summary jsonb not null default '{}'::jsonb,
  created_by uuid not null
    references auth.users(id) on delete restrict,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists data_import_jobs_org_started_idx
  on public.data_import_jobs (
    organization_id,
    started_at desc
  );

create table if not exists public.data_import_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  job_id uuid not null
    references public.data_import_jobs(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  row_data jsonb not null default '{}'::jsonb,
  error_message text not null,
  created_at timestamptz not null default now()
);

create index if not exists data_import_errors_job_row_idx
  on public.data_import_errors (job_id, row_number);

drop trigger if exists set_data_import_jobs_updated_at
  on public.data_import_jobs;

create trigger set_data_import_jobs_updated_at
before update on public.data_import_jobs
for each row execute function public.set_updated_at();

alter table public.data_import_jobs enable row level security;
alter table public.data_import_errors enable row level security;

drop policy if exists data_import_jobs_select_admin
  on public.data_import_jobs;

create policy data_import_jobs_select_admin
on public.data_import_jobs
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin']::public.app_role[]
  ))
);

drop policy if exists data_import_errors_select_admin
  on public.data_import_errors;

create policy data_import_errors_select_admin
on public.data_import_errors
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (select private.has_any_role(
    array['owner','admin']::public.app_role[]
  ))
);

revoke all on public.data_import_jobs from anon;
revoke all on public.data_import_errors from anon;
grant select on public.data_import_jobs to authenticated;
grant select on public.data_import_errors to authenticated;
grant all on public.data_import_jobs to service_role;
grant all on public.data_import_errors to service_role;

-- ----------------------------------------------------------------------------
-- 2. PARSING HELPERS
-- ----------------------------------------------------------------------------

create or replace function private.import_boolean(
  p_value text,
  p_default boolean
)
returns boolean
language plpgsql
immutable
as $$
declare
  v text := lower(trim(coalesce(p_value, '')));
begin
  if v = '' then return p_default; end if;
  if v in ('true','yes','y','1','active','enabled') then return true; end if;
  if v in ('false','no','n','0','inactive','disabled') then return false; end if;
  raise exception 'Invalid boolean value: %', p_value;
end;
$$;

create or replace function private.import_number(
  p_value text,
  p_default numeric,
  p_label text
)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_value is null or trim(p_value) = '' then
    return p_default;
  end if;
  return trim(p_value)::numeric;
exception
  when invalid_text_representation then
    raise exception '% must be a valid number: %', p_label, p_value;
end;
$$;

revoke all on function private.import_boolean(text, boolean) from public;
revoke all on function private.import_number(text, numeric, text) from public;

-- ----------------------------------------------------------------------------
-- 3. PRODUCT ROW IMPORT
-- ----------------------------------------------------------------------------

create or replace function private.import_product_row(
  p_organization_id uuid,
  p_branch_id uuid,
  p_user_id uuid,
  p_row jsonb,
  p_duplicate_mode text
)
returns text
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_name text := nullif(trim(p_row ->> 'name'), '');
  v_name_km text := nullif(trim(p_row ->> 'name_km'), '');
  v_sku text := nullif(upper(trim(p_row ->> 'sku')), '');
  v_barcode text := nullif(trim(p_row ->> 'barcode'), '');
  v_category_name text := nullif(trim(p_row ->> 'category'), '');
  v_description text := nullif(trim(p_row ->> 'description'), '');
  v_unit_name text := coalesce(nullif(trim(p_row ->> 'unit_name'), ''), 'pcs');
  v_currency_text text := upper(coalesce(nullif(trim(p_row ->> 'currency'), ''), 'USD'));
  v_currency public.currency_code;
  v_selling_price numeric;
  v_default_cost numeric;
  v_low_stock numeric;
  v_opening_stock numeric;
  v_track_stock boolean;
  v_allow_negative boolean;
  v_is_active boolean;
  v_category_id uuid;
  v_match_ids uuid[];
  v_product public.products%rowtype;
  v_result jsonb;
  v_counter bigint;
begin
  if v_name is null then raise exception 'Product name is required'; end if;

  if v_currency_text not in ('USD','KHR') then
    raise exception 'Currency must be USD or KHR';
  end if;
  v_currency := v_currency_text::public.currency_code;

  v_selling_price := private.import_number(p_row ->> 'selling_price', 0, 'Selling price');
  v_default_cost := private.import_number(p_row ->> 'default_cost', 0, 'Default cost');
  v_low_stock := private.import_number(p_row ->> 'low_stock_threshold', 5, 'Low-stock threshold');
  v_opening_stock := private.import_number(p_row ->> 'opening_stock', 0, 'Opening stock');
  v_track_stock := private.import_boolean(p_row ->> 'track_stock', true);
  v_allow_negative := private.import_boolean(p_row ->> 'allow_negative_stock', false);
  v_is_active := private.import_boolean(p_row ->> 'is_active', true);

  if v_selling_price < 0 or v_default_cost < 0 or v_low_stock < 0 or v_opening_stock < 0 then
    raise exception 'Price, cost, low-stock threshold and opening stock cannot be negative';
  end if;

  if v_category_name is not null then
    select category_row.id into v_category_id
    from public.categories category_row
    where category_row.organization_id = p_organization_id
      and lower(category_row.name) = lower(v_category_name)
    limit 1;

    if v_category_id is null then
      insert into public.categories (
        organization_id,
        name,
        is_active,
        created_by
      ) values (
        p_organization_id,
        v_category_name,
        true,
        p_user_id
      )
      returning id into v_category_id;
    end if;
  end if;

  select array_agg(distinct product_row.id)
  into v_match_ids
  from public.products product_row
  where product_row.organization_id = p_organization_id
    and (
      (v_sku is not null and upper(product_row.sku) = v_sku)
      or
      (v_barcode is not null and product_row.barcode = v_barcode)
    );

  if coalesce(cardinality(v_match_ids), 0) > 1 then
    raise exception 'SKU and barcode match different existing products';
  end if;

  if coalesce(cardinality(v_match_ids), 0) = 1 then
    select * into strict v_product
    from public.products
    where id = v_match_ids[1];

    if p_duplicate_mode = 'skip' then return 'skipped'; end if;
    if p_duplicate_mode = 'error' then
      raise exception 'Product already exists: %', v_product.sku;
    end if;

    select public.update_pos_product(
      v_product.id,
      v_name,
      coalesce(v_category_id, v_product.category_id),
      coalesce(v_name_km, v_product.name_km),
      coalesce(v_sku, v_product.sku),
      coalesce(v_barcode, v_product.barcode),
      coalesce(v_description, v_product.description),
      case when nullif(trim(p_row ->> 'unit_name'), '') is null then v_product.unit_name else v_unit_name end,
      case when nullif(trim(p_row ->> 'selling_price'), '') is null then v_product.selling_price else v_selling_price end,
      case when nullif(trim(p_row ->> 'default_cost'), '') is null then v_product.default_cost else v_default_cost end,
      case when nullif(trim(p_row ->> 'currency'), '') is null then v_product.currency else v_currency end,
      case when nullif(trim(p_row ->> 'track_stock'), '') is null then v_product.track_stock else v_track_stock end,
      case when nullif(trim(p_row ->> 'allow_negative_stock'), '') is null then v_product.allow_negative_stock else v_allow_negative end,
      case when nullif(trim(p_row ->> 'low_stock_threshold'), '') is null then v_product.low_stock_threshold else v_low_stock end,
      case when nullif(trim(p_row ->> 'is_active'), '') is null then v_product.is_active else v_is_active end
    ) into v_result;

    if coalesce(v_sku, v_product.sku) ~ '^P[0-9]+$' then
      v_counter := substring(coalesce(v_sku, v_product.sku) from 2)::bigint;
      insert into public.product_counters (organization_id, last_number, updated_at)
      values (p_organization_id, v_counter, now())
      on conflict (organization_id)
      do update set
        last_number = greatest(public.product_counters.last_number, excluded.last_number),
        updated_at = now();
    end if;

    return 'updated';
  end if;

  select public.create_pos_product(
    v_name,
    v_category_id,
    v_name_km,
    v_sku,
    v_barcode,
    v_description,
    v_unit_name,
    v_selling_price,
    v_default_cost,
    v_currency,
    v_track_stock,
    v_allow_negative,
    v_low_stock,
    case when v_track_stock then v_opening_stock else 0 end,
    v_is_active
  ) into v_result;

  if v_sku ~ '^P[0-9]+$' then
    v_counter := substring(v_sku from 2)::bigint;
    insert into public.product_counters (organization_id, last_number, updated_at)
    values (p_organization_id, v_counter, now())
    on conflict (organization_id)
    do update set
      last_number = greatest(public.product_counters.last_number, excluded.last_number),
      updated_at = now();
  end if;

  return 'created';
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. CUSTOMER ROW IMPORT
-- ----------------------------------------------------------------------------

create or replace function private.import_customer_row(
  p_organization_id uuid,
  p_branch_id uuid,
  p_user_id uuid,
  p_row jsonb,
  p_duplicate_mode text
)
returns text
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_code text := nullif(upper(trim(p_row ->> 'customer_code')), '');
  v_name text := nullif(trim(p_row ->> 'name'), '');
  v_type text := lower(coalesce(nullif(trim(p_row ->> 'customer_type'), ''), 'regular'));
  v_company text := nullif(trim(p_row ->> 'company_name'), '');
  v_phone text := nullif(trim(p_row ->> 'phone'), '');
  v_email text := nullif(lower(trim(p_row ->> 'email')), '');
  v_address text := nullif(trim(p_row ->> 'address'), '');
  v_notes text := nullif(trim(p_row ->> 'notes'), '');
  v_birth date;
  v_credit numeric;
  v_points numeric;
  v_is_active boolean;
  v_match_ids uuid[];
  v_customer public.customers%rowtype;
  v_old_points numeric;
  v_new_points numeric;
begin
  if v_name is null then raise exception 'Customer name is required'; end if;
  if v_type not in ('regular','vip','wholesale') then
    raise exception 'Customer type must be regular, vip or wholesale';
  end if;

  if nullif(trim(p_row ->> 'date_of_birth'), '') is not null then
    v_birth := trim(p_row ->> 'date_of_birth')::date;
  end if;

  v_credit := private.import_number(p_row ->> 'credit_limit', 0, 'Credit limit');
  v_points := private.import_number(p_row ->> 'loyalty_points', 0, 'Loyalty points');
  v_is_active := private.import_boolean(p_row ->> 'is_active', true);

  if v_credit < 0 or v_points < 0 then
    raise exception 'Credit limit and loyalty points cannot be negative';
  end if;

  select array_agg(distinct customer_row.id)
  into v_match_ids
  from public.customers customer_row
  where customer_row.organization_id = p_organization_id
    and (
      (v_code is not null and upper(customer_row.customer_code) = v_code)
      or (v_phone is not null and customer_row.phone = v_phone)
      or (v_email is not null and lower(customer_row.email) = v_email)
    );

  if coalesce(cardinality(v_match_ids), 0) > 1 then
    raise exception 'Customer code, phone or email match different customers';
  end if;

  if coalesce(cardinality(v_match_ids), 0) = 1 then
    select * into strict v_customer
    from public.customers
    where id = v_match_ids[1]
    for update;

    if p_duplicate_mode = 'skip' then return 'skipped'; end if;
    if p_duplicate_mode = 'error' then
      raise exception 'Customer already exists: %', v_customer.customer_code;
    end if;

    v_old_points := v_customer.loyalty_points;
    v_new_points := case
      when nullif(trim(p_row ->> 'loyalty_points'), '') is null then v_old_points
      else v_points
    end;

    update public.customers
    set
      customer_code = coalesce(v_code, customer_code),
      customer_type = case when nullif(trim(p_row ->> 'customer_type'), '') is null then customer_type else v_type end,
      name = v_name,
      company_name = coalesce(v_company, company_name),
      phone = coalesce(v_phone, phone),
      email = coalesce(v_email, email),
      address = coalesce(v_address, address),
      date_of_birth = coalesce(v_birth, date_of_birth),
      credit_limit = case when nullif(trim(p_row ->> 'credit_limit'), '') is null then credit_limit else v_credit end,
      loyalty_points = v_new_points,
      notes = coalesce(v_notes, notes),
      is_active = case when nullif(trim(p_row ->> 'is_active'), '') is null then is_active else v_is_active end,
      updated_at = now()
    where id = v_customer.id
    returning * into v_customer;

    if v_new_points <> v_old_points then
      insert into public.customer_loyalty_movements (
        organization_id, customer_id, points_change,
        points_before, points_after, reason,
        reference_table, reference_id, created_by
      ) values (
        p_organization_id,
        v_customer.id,
        v_new_points - v_old_points,
        v_old_points,
        v_new_points,
        'CSV import balance update',
        'data_import_jobs',
        null,
        p_user_id
      );
    end if;

    insert into public.audit_logs (
      organization_id, branch_id, user_id, action,
      entity_type, entity_id, new_data
    ) values (
      p_organization_id, p_branch_id, p_user_id,
      'import_update_customer', 'customer', v_customer.id,
      to_jsonb(v_customer)
    );

    return 'updated';
  end if;

  insert into public.customers (
    organization_id, customer_code, customer_type,
    name, company_name, phone, email, address,
    date_of_birth, loyalty_points, credit_limit,
    notes, is_active, created_by
  ) values (
    p_organization_id, v_code, v_type,
    v_name, v_company, v_phone, v_email, v_address,
    v_birth, v_points, v_credit,
    v_notes, v_is_active, p_user_id
  ) returning * into v_customer;

  if v_points > 0 then
    insert into public.customer_loyalty_movements (
      organization_id, customer_id, points_change,
      points_before, points_after, reason,
      reference_table, reference_id, created_by
    ) values (
      p_organization_id, v_customer.id, v_points,
      0, v_points, 'CSV import opening balance',
      'data_import_jobs', null, p_user_id
    );
  end if;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action,
    entity_type, entity_id, new_data
  ) values (
    p_organization_id, p_branch_id, p_user_id,
    'import_create_customer', 'customer', v_customer.id,
    to_jsonb(v_customer)
  );

  return 'created';
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. SUPPLIER ROW IMPORT
-- ----------------------------------------------------------------------------

create or replace function private.import_supplier_row(
  p_organization_id uuid,
  p_branch_id uuid,
  p_user_id uuid,
  p_row jsonb,
  p_duplicate_mode text
)
returns text
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_code text := nullif(upper(trim(p_row ->> 'supplier_code')), '');
  v_name text := nullif(trim(p_row ->> 'name'), '');
  v_contact text := nullif(trim(p_row ->> 'contact_name'), '');
  v_phone text := nullif(trim(p_row ->> 'phone'), '');
  v_email text := nullif(lower(trim(p_row ->> 'email')), '');
  v_address text := nullif(trim(p_row ->> 'address'), '');
  v_tax_id text := nullif(trim(p_row ->> 'tax_id'), '');
  v_notes text := nullif(trim(p_row ->> 'notes'), '');
  v_is_active boolean;
  v_match_ids uuid[];
  v_supplier public.suppliers%rowtype;
  v_counter integer;
begin
  if v_name is null then raise exception 'Supplier name is required'; end if;
  v_is_active := private.import_boolean(p_row ->> 'is_active', true);

  select array_agg(distinct supplier_row.id)
  into v_match_ids
  from public.suppliers supplier_row
  where supplier_row.organization_id = p_organization_id
    and (
      (v_code is not null and upper(supplier_row.supplier_code) = v_code)
      or (v_email is not null and lower(supplier_row.email) = v_email)
      or (v_phone is not null and supplier_row.phone = v_phone)
      or lower(supplier_row.name) = lower(v_name)
    );

  if coalesce(cardinality(v_match_ids), 0) > 1 then
    raise exception 'Supplier code, name, phone or email match different suppliers';
  end if;

  if coalesce(cardinality(v_match_ids), 0) = 1 then
    select * into strict v_supplier
    from public.suppliers
    where id = v_match_ids[1];

    if p_duplicate_mode = 'skip' then return 'skipped'; end if;
    if p_duplicate_mode = 'error' then
      raise exception 'Supplier already exists: %', v_supplier.supplier_code;
    end if;

    update public.suppliers
    set
      supplier_code = coalesce(v_code, supplier_code),
      name = v_name,
      contact_name = coalesce(v_contact, contact_name),
      phone = coalesce(v_phone, phone),
      email = coalesce(v_email, email),
      address = coalesce(v_address, address),
      tax_id = coalesce(v_tax_id, tax_id),
      notes = coalesce(v_notes, notes),
      is_active = case when nullif(trim(p_row ->> 'is_active'), '') is null then is_active else v_is_active end,
      updated_at = now()
    where id = v_supplier.id
    returning * into v_supplier;

    if v_supplier.supplier_code ~ '^S[0-9]+$' then
      v_counter := substring(v_supplier.supplier_code from 2)::integer;
      insert into public.supplier_code_counters (organization_id, last_number)
      values (p_organization_id, v_counter)
      on conflict (organization_id)
      do update set
        last_number = greatest(public.supplier_code_counters.last_number, excluded.last_number);
    end if;

    insert into public.audit_logs (
      organization_id, branch_id, user_id, action,
      entity_type, entity_id, new_data
    ) values (
      p_organization_id, p_branch_id, p_user_id,
      'import_update_supplier', 'supplier', v_supplier.id,
      to_jsonb(v_supplier)
    );

    return 'updated';
  end if;

  insert into public.suppliers (
    organization_id, supplier_code, name,
    contact_name, phone, email, address,
    tax_id, notes, is_active, created_by
  ) values (
    p_organization_id, v_code, v_name,
    v_contact, v_phone, v_email, v_address,
    v_tax_id, v_notes, v_is_active, p_user_id
  ) returning * into v_supplier;

  if v_supplier.supplier_code ~ '^S[0-9]+$' then
    v_counter := substring(v_supplier.supplier_code from 2)::integer;
    insert into public.supplier_code_counters (organization_id, last_number)
    values (p_organization_id, v_counter)
    on conflict (organization_id)
    do update set
      last_number = greatest(public.supplier_code_counters.last_number, excluded.last_number);
  end if;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action,
    entity_type, entity_id, new_data
  ) values (
    p_organization_id, p_branch_id, p_user_id,
    'import_create_supplier', 'supplier', v_supplier.id,
    to_jsonb(v_supplier)
  );

  return 'created';
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. PRODUCT PACKAGE UNIT ROW IMPORT
-- ----------------------------------------------------------------------------

create or replace function private.import_product_unit_row(
  p_organization_id uuid,
  p_branch_id uuid,
  p_user_id uuid,
  p_row jsonb,
  p_duplicate_mode text
)
returns text
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_product_sku text := nullif(upper(trim(p_row ->> 'product_sku')), '');
  v_product_barcode text := nullif(trim(p_row ->> 'product_barcode'), '');
  v_name text := nullif(trim(p_row ->> 'unit_name'), '');
  v_short text := nullif(trim(p_row ->> 'short_name'), '');
  v_barcode text := nullif(trim(p_row ->> 'barcode'), '');
  v_factor numeric;
  v_price numeric;
  v_sort integer;
  v_active boolean;
  v_product_ids uuid[];
  v_unit_ids uuid[];
  v_product public.products%rowtype;
  v_unit public.product_units%rowtype;
begin
  if v_product_sku is null and v_product_barcode is null then
    raise exception 'Product SKU or product barcode is required';
  end if;
  if v_name is null then raise exception 'Unit name is required'; end if;

  v_factor := private.import_number(p_row ->> 'conversion_factor', null, 'Conversion factor');
  v_price := private.import_number(p_row ->> 'selling_price', null, 'Selling price');
  v_sort := private.import_number(p_row ->> 'sort_order', 10, 'Sort order')::integer;
  v_active := private.import_boolean(p_row ->> 'is_active', true);

  if v_factor is null or v_factor <= 0 then
    raise exception 'Conversion factor must be greater than zero';
  end if;
  if v_price is null or v_price < 0 then
    raise exception 'Selling price cannot be negative';
  end if;

  select array_agg(distinct product_row.id)
  into v_product_ids
  from public.products product_row
  where product_row.organization_id = p_organization_id
    and (
      (v_product_sku is not null and upper(product_row.sku) = v_product_sku)
      or
      (v_product_barcode is not null and product_row.barcode = v_product_barcode)
    );

  if coalesce(cardinality(v_product_ids), 0) = 0 then
    raise exception 'Product not found for SKU/barcode';
  end if;
  if cardinality(v_product_ids) > 1 then
    raise exception 'Product SKU and barcode match different products';
  end if;

  select * into strict v_product
  from public.products
  where id = v_product_ids[1];

  select array_agg(distinct unit_row.id)
  into v_unit_ids
  from public.product_units unit_row
  where unit_row.organization_id = p_organization_id
    and unit_row.product_id = v_product.id
    and (
      lower(unit_row.name) = lower(v_name)
      or (v_barcode is not null and unit_row.barcode = v_barcode)
    );

  if coalesce(cardinality(v_unit_ids), 0) > 1 then
    raise exception 'Unit name and barcode match different units';
  end if;

  if coalesce(cardinality(v_unit_ids), 0) = 1 then
    select * into strict v_unit
    from public.product_units
    where id = v_unit_ids[1];

    if p_duplicate_mode = 'skip' then return 'skipped'; end if;
    if p_duplicate_mode = 'error' then
      raise exception 'Product unit already exists: %', v_unit.name;
    end if;

    if v_unit.is_base and v_factor <> 1 then
      raise exception 'The base unit conversion factor must remain 1';
    end if;

    update public.product_units
    set
      name = v_name,
      short_name = coalesce(v_short, short_name),
      conversion_factor = case when is_base then 1 else v_factor end,
      selling_price = v_price,
      barcode = coalesce(v_barcode, barcode),
      is_active = v_active,
      sort_order = v_sort,
      updated_at = now()
    where id = v_unit.id
    returning * into v_unit;

    insert into public.audit_logs (
      organization_id, branch_id, user_id, action,
      entity_type, entity_id, new_data
    ) values (
      p_organization_id, p_branch_id, p_user_id,
      'import_update_product_unit', 'product_unit', v_unit.id,
      to_jsonb(v_unit)
    );

    return 'updated';
  end if;

  insert into public.product_units (
    organization_id, product_id, name,
    short_name, conversion_factor, selling_price,
    barcode, is_base, is_active, sort_order,
    created_by
  ) values (
    p_organization_id, v_product.id, v_name,
    v_short, v_factor, v_price,
    v_barcode, false, v_active, v_sort,
    p_user_id
  ) returning * into v_unit;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action,
    entity_type, entity_id, new_data
  ) values (
    p_organization_id, p_branch_id, p_user_id,
    'import_create_product_unit', 'product_unit', v_unit.id,
    to_jsonb(v_unit)
  );

  return 'created';
end;
$$;

revoke all on function private.import_product_row(uuid,uuid,uuid,jsonb,text) from public;
revoke all on function private.import_customer_row(uuid,uuid,uuid,jsonb,text) from public;
revoke all on function private.import_supplier_row(uuid,uuid,uuid,jsonb,text) from public;
revoke all on function private.import_product_unit_row(uuid,uuid,uuid,jsonb,text) from public;

-- ----------------------------------------------------------------------------
-- 7. RUN ONE IMPORT JOB
-- ----------------------------------------------------------------------------

create or replace function public.run_data_import(
  p_import_type text,
  p_rows jsonb,
  p_duplicate_mode text default 'skip',
  p_file_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_job public.data_import_jobs%rowtype;
  v_row record;
  v_action text;
  v_created integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
  v_total integer;
  v_status text;
  v_errors jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true or v_profile.branch_id is null then
    raise exception 'Active POS profile and branch are required';
  end if;

  if v_profile.role not in ('owner','admin') then
    raise exception 'Only the owner or an admin can import business data';
  end if;

  if p_import_type not in ('products','product_units','customers','suppliers') then
    raise exception 'Unsupported import type: %', p_import_type;
  end if;

  if p_duplicate_mode not in ('skip','update','error') then
    raise exception 'Duplicate mode must be skip, update or error';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Import rows must be a JSON array';
  end if;

  v_total := jsonb_array_length(p_rows);
  if v_total = 0 then raise exception 'The import file has no data rows'; end if;
  if v_total > 1000 then raise exception 'A single import job cannot exceed 1,000 rows'; end if;

  insert into public.data_import_jobs (
    organization_id, branch_id, import_type,
    duplicate_mode, file_name, status,
    total_rows, created_by, started_at
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    p_import_type,
    p_duplicate_mode,
    nullif(trim(p_file_name), ''),
    'processing',
    v_total,
    v_user_id,
    now()
  ) returning * into v_job;

  for v_row in
    select value as row_data, (ordinality::integer + 1) as row_number
    from jsonb_array_elements(p_rows) with ordinality
  loop
    begin
      case p_import_type
        when 'products' then
          v_action := private.import_product_row(
            v_profile.organization_id,
            v_profile.branch_id,
            v_user_id,
            v_row.row_data,
            p_duplicate_mode
          );
        when 'product_units' then
          v_action := private.import_product_unit_row(
            v_profile.organization_id,
            v_profile.branch_id,
            v_user_id,
            v_row.row_data,
            p_duplicate_mode
          );
        when 'customers' then
          v_action := private.import_customer_row(
            v_profile.organization_id,
            v_profile.branch_id,
            v_user_id,
            v_row.row_data,
            p_duplicate_mode
          );
        when 'suppliers' then
          v_action := private.import_supplier_row(
            v_profile.organization_id,
            v_profile.branch_id,
            v_user_id,
            v_row.row_data,
            p_duplicate_mode
          );
      end case;

      if v_action = 'created' then v_created := v_created + 1;
      elsif v_action = 'updated' then v_updated := v_updated + 1;
      else v_skipped := v_skipped + 1;
      end if;
    exception
      when others then
        v_failed := v_failed + 1;
        insert into public.data_import_errors (
          organization_id, job_id, row_number,
          row_data, error_message
        ) values (
          v_profile.organization_id,
          v_job.id,
          v_row.row_number,
          v_row.row_data,
          sqlerrm
        );
    end;
  end loop;

  v_status := case when v_failed > 0 then 'completed_with_errors' else 'completed' end;

  update public.data_import_jobs
  set
    status = v_status,
    created_rows = v_created,
    updated_rows = v_updated,
    skipped_rows = v_skipped,
    failed_rows = v_failed,
    summary = jsonb_build_object(
      'created', v_created,
      'updated', v_updated,
      'skipped', v_skipped,
      'failed', v_failed
    ),
    completed_at = now(),
    updated_at = now()
  where id = v_job.id
  returning * into v_job;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'row_number', error_row.row_number,
      'error_message', error_row.error_message,
      'row_data', error_row.row_data
    ) order by error_row.row_number
  ), '[]'::jsonb)
  into v_errors
  from public.data_import_errors error_row
  where error_row.job_id = v_job.id;

  insert into public.audit_logs (
    organization_id, branch_id, user_id, action,
    entity_type, entity_id, new_data
  ) values (
    v_profile.organization_id,
    v_profile.branch_id,
    v_user_id,
    'run_data_import',
    'data_import_job',
    v_job.id,
    jsonb_build_object(
      'import_type', p_import_type,
      'duplicate_mode', p_duplicate_mode,
      'file_name', p_file_name,
      'total_rows', v_total,
      'created_rows', v_created,
      'updated_rows', v_updated,
      'skipped_rows', v_skipped,
      'failed_rows', v_failed
    )
  );

  return jsonb_build_object(
    'ok', true,
    'job', to_jsonb(v_job),
    'errors', v_errors
  );
end;
$$;

revoke all on function public.run_data_import(text,jsonb,text,text)
  from public, anon;

grant execute on function public.run_data_import(text,jsonb,text,text)
  to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 23
-- ============================================================================
