-- Optional verification after the latest patches (through
-- database/69_storefront_phone_lookup_rate_limit.sql).
-- Each block should return the row(s) described in its comment; an empty
-- result means that migration has not been applied yet.

-- Patch 46.24: invoice settings columns on app_settings.
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'app_settings'
  and column_name in ('invoice_show_shop_name','invoice_show_product_code')
order by column_name;
-- expect: 2 rows

select proname
from pg_proc
join pg_namespace n on n.oid = pg_proc.pronamespace
where n.nspname = 'public'
  and proname = 'update_shop_settings_v2';
-- expect: 1 row

-- Patch 46.35 (database/68_...): cash_register.override permission and the
-- v2 close function that enforces it.
select permission_key, risk_level, default_roles
from public.permission_definitions
where permission_key = 'cash_register.override';
-- expect: 1 row, risk_level = 'critical', default_roles = '{}'

select proname
from pg_proc
join pg_namespace n on n.oid = pg_proc.pronamespace
where n.nspname = 'public'
  and proname = 'close_cash_register_v2';
-- expect: 1 row

-- database/69_storefront_phone_lookup_rate_limit.sql: throttle table +
-- three-argument find_public_orders_by_phone.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'storefront_lookup_attempts';
-- expect: 1 row

select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'find_public_orders_by_phone';
-- expect: 1 row, args = 'p_slug text, p_phone text, p_source_ip_hash text
-- DEFAULT NULL::text' (the old two-argument overload should be gone)

-- database/70_fix_customer_checkout_rowtype_mismatch.sql: checkout-for-named-
-- customer fix. Confirms the function selects the full customer row instead
-- of the 3-column partial select that caused every named-customer checkout
-- to fail with "number of source and target fields in assignment does not
-- match" (walk-in sales were unaffected since they skip this branch).
select prosrc like '%select c.* into v_customer%' as fix_applied
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'private'
  and p.proname = 'resolve_standard_sales_unit_price';
-- expect: 1 row, fix_applied = true
