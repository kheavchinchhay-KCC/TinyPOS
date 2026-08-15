-- ============================================================================
-- Tiny POS Patch 46.21 — Invoice/receipt consistency, bilingual shop identity
-- and receipt logo placement.
-- Additive migration. Existing receipts, sales and settings are preserved.
-- ============================================================================

begin;

alter table public.app_settings
  add column if not exists shop_name_km text,
  add column if not exists shop_address_km text,
  add column if not exists receipt_header_km text,
  add column if not exists receipt_footer_km text,
  add column if not exists receipt_default_language text not null default 'en'
    check (receipt_default_language in ('en','km')),
  add column if not exists receipt_logo_position text not null default 'inline'
    check (receipt_logo_position in ('inline','above'));

create or replace function public.update_shop_settings_v2(
  p_settings jsonb
)
returns public.app_settings
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_settings public.app_settings;
  v_logo_position text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_settings is null then
    raise exception 'Shop settings payload is required';
  end if;

  select public.update_shop_settings(
    p_shop_name => coalesce(p_settings->>'p_shop_name', 'Tiny POS'),
    p_shop_phone => coalesce(p_settings->>'p_shop_phone', ''),
    p_shop_email => coalesce(p_settings->>'p_shop_email', ''),
    p_shop_address => coalesce(p_settings->>'p_shop_address', ''),
    p_tax_id => coalesce(p_settings->>'p_tax_id', ''),
    p_receipt_header => coalesce(p_settings->>'p_receipt_header', ''),
    p_receipt_footer => coalesce(p_settings->>'p_receipt_footer', 'Thank you for your purchase.'),
    p_default_language => case when p_settings->>'p_default_language' = 'km' then 'km' else 'en' end,
    p_default_theme => (case when p_settings->>'p_default_theme' in ('light','dark','system') then p_settings->>'p_default_theme' else 'system' end)::public.theme_mode,
    p_base_currency => (case when p_settings->>'p_base_currency' = 'KHR' then 'KHR' else 'USD' end)::public.currency_code,
    p_usd_to_khr_rate => greatest(1, coalesce((p_settings->>'p_usd_to_khr_rate')::numeric, 4100)),
    p_tax_percent => least(100, greatest(0, coalesce((p_settings->>'p_tax_percent')::numeric, 0))),
    p_low_stock_threshold => greatest(0, coalesce((p_settings->>'p_low_stock_threshold')::numeric, 5)),
    p_allow_negative_stock => coalesce((p_settings->>'p_allow_negative_stock')::boolean, false),
    p_receipt_width_mm => case when (p_settings->>'p_receipt_width_mm')::integer = 58 then 58 else 80 end,
    p_invoice_prefix => coalesce(nullif(trim(p_settings->>'p_invoice_prefix'), ''), 'INV'),
    p_receipt_show_logo => coalesce((p_settings->>'p_receipt_show_logo')::boolean, true),
    p_receipt_show_address => coalesce((p_settings->>'p_receipt_show_address')::boolean, true),
    p_receipt_show_phone => coalesce((p_settings->>'p_receipt_show_phone')::boolean, true),
    p_receipt_show_customer => coalesce((p_settings->>'p_receipt_show_customer')::boolean, true),
    p_receipt_show_cashier => coalesce((p_settings->>'p_receipt_show_cashier')::boolean, true),
    p_receipt_show_barcode => coalesce((p_settings->>'p_receipt_show_barcode')::boolean, true),
    p_label_width_mm => least(120, greatest(20, coalesce((p_settings->>'p_label_width_mm')::numeric, 50))),
    p_label_height_mm => least(100, greatest(15, coalesce((p_settings->>'p_label_height_mm')::numeric, 30))),
    p_label_columns => least(6, greatest(1, coalesce((p_settings->>'p_label_columns')::integer, 3))),
    p_label_show_name => coalesce((p_settings->>'p_label_show_name')::boolean, true),
    p_label_show_price => coalesce((p_settings->>'p_label_show_price')::boolean, true),
    p_label_show_sku => coalesce((p_settings->>'p_label_show_sku')::boolean, true),
    p_label_barcode_format => case when upper(coalesce(p_settings->>'p_label_barcode_format','CODE128')) = 'EAN13' then 'EAN13' else 'CODE128' end
  ) into v_settings;

  v_logo_position := case
    when p_settings->>'p_receipt_logo_position' = 'above' then 'above'
    else 'inline'
  end;

  update public.app_settings
  set
    shop_name_km = nullif(trim(coalesce(p_settings->>'p_shop_name_km','')), ''),
    shop_address_km = nullif(trim(coalesce(p_settings->>'p_shop_address_km','')), ''),
    receipt_header_km = nullif(trim(coalesce(p_settings->>'p_receipt_header_km','')), ''),
    receipt_footer_km = nullif(trim(coalesce(p_settings->>'p_receipt_footer_km','')), ''),
    receipt_default_language = case when p_settings->>'p_receipt_default_language' = 'km' then 'km' else 'en' end,
    receipt_logo_position = v_logo_position,
    updated_at = now(),
    updated_by = auth.uid()
  where organization_id = v_settings.organization_id
  returning * into v_settings;

  return v_settings;
end;
$$;

revoke all on function public.update_shop_settings_v2(jsonb) from public, anon;
grant execute on function public.update_shop_settings_v2(jsonb) to authenticated, service_role;

-- Secure helper used by Returns & Refunds when rebuilding an original sale
-- receipt. It makes the cashier identity and Khmer product names consistent
-- with Invoice Center without exposing unrelated staff records.
create or replace function public.get_sale_receipt_context(
  p_sale_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile record;
  v_sale record;
  v_cashier_name text;
  v_products jsonb;
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

  if not private.has_permission('returns.process', v_user_id)
     and not private.has_permission('invoices.view', v_user_id) then
    raise exception 'Permission required: returns.process or invoices.view';
  end if;

  select s.id, s.organization_id, s.branch_id, s.cashier_id
  into v_sale
  from public.sales s
  where s.id = p_sale_id
    and s.organization_id = v_profile.organization_id;

  if not found then
    raise exception 'Sale not found';
  end if;

  if v_profile.role not in ('owner','admin') and v_sale.branch_id <> v_profile.branch_id then
    raise exception 'This sale belongs to another branch';
  end if;

  select coalesce(
    nullif(trim(p.full_name), ''),
    nullif(split_part(coalesce(p.email,''), '@', 1), ''),
    'POS Staff'
  )
  into v_cashier_name
  from public.profiles p
  where p.id = v_sale.cashier_id;

  v_cashier_name := coalesce(v_cashier_name, 'POS Staff');

  select coalesce(jsonb_object_agg(x.product_id::text, x.name_km), '{}'::jsonb)
  into v_products
  from (
    select distinct si.product_id, pr.name_km
    from public.sale_items si
    left join public.products pr on pr.id = si.product_id
    where si.sale_id = p_sale_id
      and si.product_id is not null
      and nullif(trim(coalesce(pr.name_km,'')), '') is not null
  ) x;

  return jsonb_build_object(
    'cashier_name', v_cashier_name,
    'product_names_km', coalesce(v_products, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.get_sale_receipt_context(uuid) from public, anon;
grant execute on function public.get_sale_receipt_context(uuid) to authenticated, service_role;

commit;
