# Migration file numbering

Migrations in this folder are meant to run in filename order
(`ls database/*.sql | sort`). Two things look like gaps/collisions
at a glance; neither affects install order or correctness:

- **No file numbered 57.** Nothing in the codebase, `PATCH_MANIFEST.txt`,
  or `STEP46_PATCH_MANIFEST.json` references a file 57 — it was never
  assigned. Safe to leave as-is.
- **Two files numbered 63** (`63_step46_24_receipt_center_invoice_settings_fix.sql`
  and `63_step46_25_backup_center_scheduling_drive.sql`). They were
  packaged as separate add-on patches without checking the next free
  number. `PATCH_MANIFEST.txt` explicitly instructs installers to run
  `63_step46_25_backup_center_scheduling_drive.sql` by that exact name,
  so it hasn't been renamed. The `step46_24` vs `step46_25` suffix (and
  plain alphabetical sort) already orders them correctly — 46.24 before
  46.25 — so no manual reordering is needed to install safely.

Latest migration as of this note: `70_fix_customer_checkout_rowtype_mismatch.sql`.
Run `VERIFY.sql` after installing to confirm the latest patches applied.
