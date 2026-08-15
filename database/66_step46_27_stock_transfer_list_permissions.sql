-- ============================================================================
-- Tiny POS - Step 46.27: stock-transfer list visibility for granular roles
-- Run ONCE after the latest migration in the project (currently 65 in the
-- uploaded baseline).
--
-- Goals:
--   * Let inventory-view / transfer-authorized users read transfer headers.
--   * Let the same users read transfer line items for transfers touching the
--     user's current branch.
--   * Keep organization and branch boundaries enforced.
--   * Do NOT add a broad table-level read permission that exposes transfers
--     from unrelated organizations/branches.
--
-- No data is changed and no old migration is rerun.
-- ============================================================================

begin;

drop policy if exists stock_transfers_select_management on public.stock_transfers;
create policy stock_transfers_select_management
on public.stock_transfers
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and (
    (select private.has_permission('branches.all', auth.uid()))
    or source_branch_id = (select private.current_branch_id())
    or destination_branch_id = (select private.current_branch_id())
  )
  and (
    (select private.has_permission('inventory.view', auth.uid()))
    or (select private.has_permission('transfers.create', auth.uid()))
    or (select private.has_permission('transfers.edit', auth.uid()))
    or (select private.has_permission('transfers.count', auth.uid()))
    or (select private.has_permission('transfers.receive', auth.uid()))
    or (select private.has_permission('transfers.cancel', auth.uid()))
    or (select private.has_permission('transfers.approve', auth.uid()))
    or (select private.has_permission('approvals.review', auth.uid()))
  )
);

drop policy if exists stock_transfer_items_select_management on public.stock_transfer_items;
create policy stock_transfer_items_select_management
on public.stock_transfer_items
for select to authenticated
using (
  organization_id = (select private.current_organization_id())
  and exists (
    select 1
    from public.stock_transfers st
    where st.id = stock_transfer_items.transfer_id
      and st.organization_id = (select private.current_organization_id())
      and (
        (select private.has_permission('branches.all', auth.uid()))
        or st.source_branch_id = (select private.current_branch_id())
        or st.destination_branch_id = (select private.current_branch_id())
      )
      and (
        (select private.has_permission('inventory.view', auth.uid()))
        or (select private.has_permission('transfers.create', auth.uid()))
        or (select private.has_permission('transfers.edit', auth.uid()))
        or (select private.has_permission('transfers.count', auth.uid()))
        or (select private.has_permission('transfers.receive', auth.uid()))
        or (select private.has_permission('transfers.cancel', auth.uid()))
        or (select private.has_permission('transfers.approve', auth.uid()))
        or (select private.has_permission('approvals.review', auth.uid()))
      )
  )
);

commit;

-- After running, test as a stock keeper with:
--   inventory.view = ON
--   transfers.count = ON
-- and (only if they should create requests):
--   transfers.create = ON
