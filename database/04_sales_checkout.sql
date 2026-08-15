-- Tiny POS Step 6: sales performance indexes
-- Run once in the NEW Supabase project.

begin;

create index if not exists sales_branch_status_created_idx
  on public.sales (branch_id, status, created_at desc);

create index if not exists parked_sales_branch_created_idx
  on public.parked_sales (branch_id, created_at desc);

create index if not exists customers_org_active_name_idx
  on public.customers (organization_id, is_active, name);

create index if not exists payments_sale_method_idx
  on public.payments (sale_id, method);

commit;
