-- ============================================================================
-- Tiny POS Patch 46.23 — Receipt Center + configurable A5/A4 sale invoice.
-- Additive migration. Existing receipt settings and completed sales are kept.
-- ============================================================================

begin;

alter table public.app_settings
  add column if not exists sale_document_type text not null default 'receipt'
    check (sale_document_type in ('receipt','invoice')),
  add column if not exists invoice_paper_size text not null default 'A5'
    check (invoice_paper_size in ('A5','A4')),
  add column if not exists invoice_title text not null default 'INVOICE',
  add column if not exists invoice_title_km text not null default 'វិក្កយបត្រ',
  add column if not exists invoice_footer text not null default 'Thank you for your purchase.',
  add column if not exists invoice_footer_km text not null default 'សូមអរគុណចំពោះការគាំទ្រ!',
  add column if not exists invoice_show_logo boolean not null default true,
  add column if not exists invoice_show_address boolean not null default true,
  add column if not exists invoice_show_contact boolean not null default true,
  add column if not exists invoice_show_tax_id boolean not null default true,
  add column if not exists invoice_show_customer boolean not null default true,
  add column if not exists invoice_show_cashier boolean not null default true,
  add column if not exists invoice_show_received boolean not null default true,
  add column if not exists invoice_show_change boolean not null default true,
  add column if not exists invoice_show_signatures boolean not null default true;

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
    sale_document_type = case when p_settings->>'p_sale_document_type' = 'invoice' then 'invoice' else 'receipt' end,
    invoice_paper_size = case when p_settings->>'p_invoice_paper_size' = 'A4' then 'A4' else 'A5' end,
    invoice_title = coalesce(nullif(trim(p_settings->>'p_invoice_title'), ''), 'INVOICE'),
    invoice_title_km = coalesce(nullif(trim(p_settings->>'p_invoice_title_km'), ''), 'វិក្កយបត្រ'),
    invoice_footer = coalesce(nullif(trim(p_settings->>'p_invoice_footer'), ''), 'Thank you for your purchase.'),
    invoice_footer_km = coalesce(nullif(trim(p_settings->>'p_invoice_footer_km'), ''), 'សូមអរគុណចំពោះការគាំទ្រ!'),
    invoice_show_logo = coalesce((p_settings->>'p_invoice_show_logo')::boolean, true),
    invoice_show_address = coalesce((p_settings->>'p_invoice_show_address')::boolean, true),
    invoice_show_contact = coalesce((p_settings->>'p_invoice_show_contact')::boolean, true),
    invoice_show_tax_id = coalesce((p_settings->>'p_invoice_show_tax_id')::boolean, true),
    invoice_show_customer = coalesce((p_settings->>'p_invoice_show_customer')::boolean, true),
    invoice_show_cashier = coalesce((p_settings->>'p_invoice_show_cashier')::boolean, true),
    invoice_show_received = coalesce((p_settings->>'p_invoice_show_received')::boolean, true),
    invoice_show_change = coalesce((p_settings->>'p_invoice_show_change')::boolean, true),
    invoice_show_signatures = coalesce((p_settings->>'p_invoice_show_signatures')::boolean, true),
    updated_at = now(),
    updated_by = auth.uid()
  where organization_id = v_settings.organization_id
  returning * into v_settings;

  return v_settings;
end;
$$;

revoke all on function public.update_shop_settings_v2(jsonb) from public, anon;
grant execute on function public.update_shop_settings_v2(jsonb) to authenticated, service_role;

commit;
