-- ==========================================================================
-- Tiny POS - Step 46.4.6: New Sale Layout & Per-User View Preferences
-- Run once after Step 47 / Patch 46.4.5.
--
-- Adds per-user New Sale preferences used by the Settings > My Preferences page:
--   * new_sale_layout            layout1 | layout2
--   * sale_product_card_scale    personal product-card size multiplier
--   * sale_show_product_code     show / hide product code in New Sale
--   * sale_stock_display         exact | status
--
-- Safe to run multiple times.
-- ==========================================================================

alter table if exists public.user_preferences
  add column if not exists new_sale_layout text not null default 'layout1',
  add column if not exists sale_product_card_scale numeric(4,2) not null default 1.00,
  add column if not exists sale_show_product_code boolean not null default true,
  add column if not exists sale_stock_display text not null default 'exact';

update public.user_preferences
set new_sale_layout = coalesce(nullif(new_sale_layout, ''), 'layout1'),
    sale_product_card_scale = case
      when sale_product_card_scale is null or sale_product_card_scale < 0.80 then 1.00
      when sale_product_card_scale > 1.45 then 1.45
      else sale_product_card_scale
    end,
    sale_show_product_code = coalesce(sale_show_product_code, true),
    sale_stock_display = case
      when sale_stock_display in ('exact', 'status') then sale_stock_display
      else 'exact'
    end;
