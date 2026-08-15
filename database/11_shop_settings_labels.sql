-- ============================================================================
-- Tiny POS - Step 13: Shop settings, receipt branding, barcode and price labels
-- Run once in the NEW Supabase project.
-- This migration does not delete or reset existing data.
-- ============================================================================

begin;

alter table public.app_settings
  add column if not exists shop_email text,
  add column if not exists tax_id text,
  add column if not exists receipt_header text,
  add column if not exists receipt_show_logo boolean not null default true,
  add column if not exists receipt_show_address boolean not null default true,
  add column if not exists receipt_show_phone boolean not null default true,
  add column if not exists receipt_show_customer boolean not null default true,
  add column if not exists receipt_show_cashier boolean not null default true,
  add column if not exists receipt_show_barcode boolean not null default true,
  add column if not exists shop_logo_url text,
  add column if not exists shop_logo_public_id text,
  add column if not exists label_width_mm numeric(7,2) not null default 50
    check (label_width_mm between 20 and 120),
  add column if not exists label_height_mm numeric(7,2) not null default 30
    check (label_height_mm between 15 and 100),
  add column if not exists label_columns integer not null default 3
    check (label_columns between 1 and 6),
  add column if not exists label_show_name boolean not null default true,
  add column if not exists label_show_price boolean not null default true,
  add column if not exists label_show_sku boolean not null default true,
  add column if not exists label_barcode_format text not null default 'CODE128'
    check (label_barcode_format in ('CODE128', 'EAN13'));

create or replace function public.update_shop_settings(
  p_shop_name text,
  p_shop_phone text,
  p_shop_email text,
  p_shop_address text,
  p_tax_id text,
  p_receipt_header text,
  p_receipt_footer text,
  p_default_language text,
  p_default_theme public.theme_mode,
  p_base_currency public.currency_code,
  p_usd_to_khr_rate numeric,
  p_tax_percent numeric,
  p_low_stock_threshold numeric,
  p_allow_negative_stock boolean,
  p_receipt_width_mm integer,
  p_invoice_prefix text,
  p_receipt_show_logo boolean,
  p_receipt_show_address boolean,
  p_receipt_show_phone boolean,
  p_receipt_show_customer boolean,
  p_receipt_show_cashier boolean,
  p_receipt_show_barcode boolean,
  p_label_width_mm numeric,
  p_label_height_mm numeric,
  p_label_columns integer,
  p_label_show_name boolean,
  p_label_show_price boolean,
  p_label_show_sku boolean,
  p_label_barcode_format text
)
returns public.app_settings
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_settings public.app_settings;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile not found';
  end if;

  if v_profile.role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can change shop settings';
  end if;

  if p_shop_name is null or length(trim(p_shop_name)) < 1 then
    raise exception 'Shop name is required';
  end if;

  if p_default_language not in ('en', 'km') then
    raise exception 'Invalid default language';
  end if;

  if p_usd_to_khr_rate is null or p_usd_to_khr_rate <= 0 then
    raise exception 'USD to KHR rate must be greater than zero';
  end if;

  if p_tax_percent is null or p_tax_percent < 0 or p_tax_percent > 100 then
    raise exception 'Tax percentage must be between 0 and 100';
  end if;

  if p_low_stock_threshold is null or p_low_stock_threshold < 0 then
    raise exception 'Low stock threshold cannot be negative';
  end if;

  if p_receipt_width_mm not in (58, 80) then
    raise exception 'Receipt width must be 58 mm or 80 mm';
  end if;

  if upper(trim(p_invoice_prefix)) !~ '^[A-Z0-9_-]{1,12}$' then
    raise exception 'Invoice prefix may contain only A-Z, 0-9, underscore, and dash';
  end if;

  if p_label_width_mm < 20 or p_label_width_mm > 120
     or p_label_height_mm < 15 or p_label_height_mm > 100 then
    raise exception 'Label dimensions are outside the supported range';
  end if;

  if p_label_columns < 1 or p_label_columns > 6 then
    raise exception 'Label columns must be between 1 and 6';
  end if;

  if upper(trim(p_label_barcode_format)) not in ('CODE128', 'EAN13') then
    raise exception 'Barcode format must be CODE128 or EAN13';
  end if;

  update public.app_settings
  set
    shop_name = trim(p_shop_name),
    shop_phone = nullif(trim(p_shop_phone), ''),
    shop_email = nullif(trim(p_shop_email), ''),
    shop_address = nullif(trim(p_shop_address), ''),
    tax_id = nullif(trim(p_tax_id), ''),
    receipt_header = nullif(trim(p_receipt_header), ''),
    receipt_footer = nullif(trim(p_receipt_footer), ''),
    default_language = p_default_language,
    default_theme = p_default_theme,
    base_currency = p_base_currency,
    usd_to_khr_rate = round(p_usd_to_khr_rate, 4),
    tax_percent = round(p_tax_percent, 4),
    low_stock_threshold = round(p_low_stock_threshold, 3),
    allow_negative_stock = coalesce(p_allow_negative_stock, false),
    receipt_width_mm = p_receipt_width_mm,
    invoice_prefix = upper(trim(p_invoice_prefix)),
    receipt_show_logo = coalesce(p_receipt_show_logo, true),
    receipt_show_address = coalesce(p_receipt_show_address, true),
    receipt_show_phone = coalesce(p_receipt_show_phone, true),
    receipt_show_customer = coalesce(p_receipt_show_customer, true),
    receipt_show_cashier = coalesce(p_receipt_show_cashier, true),
    receipt_show_barcode = coalesce(p_receipt_show_barcode, true),
    label_width_mm = round(p_label_width_mm, 2),
    label_height_mm = round(p_label_height_mm, 2),
    label_columns = p_label_columns,
    label_show_name = coalesce(p_label_show_name, true),
    label_show_price = coalesce(p_label_show_price, true),
    label_show_sku = coalesce(p_label_show_sku, true),
    label_barcode_format = upper(trim(p_label_barcode_format)),
    updated_by = v_user_id,
    updated_at = now()
  where organization_id = v_profile.organization_id
  returning * into v_settings;

  if not found then
    raise exception 'Shop settings row not found';
  end if;

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
    'update_shop_settings',
    'app_settings',
    v_profile.organization_id,
    jsonb_build_object(
      'shop_name', v_settings.shop_name,
      'base_currency', v_settings.base_currency,
      'receipt_width_mm', v_settings.receipt_width_mm,
      'label_width_mm', v_settings.label_width_mm,
      'label_height_mm', v_settings.label_height_mm,
      'label_columns', v_settings.label_columns
    )
  );

  return v_settings;
end;
$$;

create or replace function public.set_shop_logo(
  p_logo_url text default null,
  p_logo_public_id text default null
)
returns public.app_settings
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_settings public.app_settings;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select organization_id, branch_id, role, is_active
  into v_profile
  from public.profiles
  where id = v_user_id;

  if not found or v_profile.is_active is not true then
    raise exception 'Active POS profile not found';
  end if;

  if v_profile.role not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can change the shop logo';
  end if;

  if p_logo_url is not null and p_logo_url !~ '^https://' then
    raise exception 'Shop logo must use an HTTPS URL';
  end if;

  update public.app_settings
  set
    shop_logo_url = nullif(trim(p_logo_url), ''),
    shop_logo_public_id = nullif(trim(p_logo_public_id), ''),
    updated_by = v_user_id,
    updated_at = now()
  where organization_id = v_profile.organization_id
  returning * into v_settings;

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
    case when v_settings.shop_logo_url is null
      then 'remove_shop_logo'
      else 'update_shop_logo'
    end,
    'app_settings',
    v_profile.organization_id,
    jsonb_build_object(
      'shop_logo_url', v_settings.shop_logo_url,
      'shop_logo_public_id', v_settings.shop_logo_public_id
    )
  );

  return v_settings;
end;
$$;

revoke all on function public.update_shop_settings(
  text, text, text, text, text, text, text, text,
  public.theme_mode, public.currency_code, numeric, numeric, numeric,
  boolean, integer, text, boolean, boolean, boolean, boolean, boolean,
  boolean, numeric, numeric, integer, boolean, boolean, boolean, text
) from public, anon;

grant execute on function public.update_shop_settings(
  text, text, text, text, text, text, text, text,
  public.theme_mode, public.currency_code, numeric, numeric, numeric,
  boolean, integer, text, boolean, boolean, boolean, boolean, boolean,
  boolean, numeric, numeric, integer, boolean, boolean, boolean, text
) to authenticated, service_role;

revoke all on function public.set_shop_logo(text, text) from public, anon;
grant execute on function public.set_shop_logo(text, text)
  to authenticated, service_role;

commit;

-- ============================================================================
-- END STEP 13
-- ============================================================================
