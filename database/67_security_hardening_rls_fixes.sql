-- ============================================================================
-- Tiny POS — Security hardening: RLS fix
-- Safe to run once, any time after 12_purchase_orders_suppliers.sql.
-- Does not touch or replace any existing table, function, or data.
-- ============================================================================

begin;

-- supplier_code_counters was created in 12_purchase_orders_suppliers.sql
-- without row level security enabled, unlike its sibling counter tables
-- (product_counters, customer_counters), which both lock the table down
-- to service_role only. This closes that gap using the same pattern.
alter table public.supplier_code_counters enable row level security;
revoke all on public.supplier_code_counters from anon, authenticated;
grant all on public.supplier_code_counters to service_role;

commit;
