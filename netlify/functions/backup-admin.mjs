import { hasEffectivePermission } from "./_permission.mjs";
import { createClient } from "@supabase/supabase-js";


// Step 45 security boundary: integration API keys, webhook secrets, external
// mappings, request logs and delivery queues are intentionally not included in
// business backups. Restored environments must create new credentials.
const STEP45_SECURITY_TABLES_EXCLUDED_FROM_BACKUP = Object.freeze([
  "integration_api_clients",
  "integration_api_rate_windows",
  "integration_api_request_logs",
  "integration_external_references",
  "integration_webhook_endpoints",
  "integration_webhook_secrets",
  "integration_events",
  "integration_webhook_deliveries",
  "integration_webhook_attempts"
]);
void STEP45_SECURITY_TABLES_EXCLUDED_FROM_BACKUP;

const BACKUP_FORMAT = "tiny-pos-business-backup";
const BACKUP_VERSION = 1;
const PAGE_SIZE = 750;
const INSERT_SIZE = 300;
const OPTIONAL_TABLES = new Set([
  "custom_staff_roles",
  "coupons",
  "coupon_redemptions",
  "cash_register_sessions",
  "product_units",
  "stock_count_sessions",
  "stock_count_items",
  "data_import_jobs",
  "data_import_errors",
  "customer_credit_accounts",
  "customer_credit_payments",
  "customer_credit_payment_allocations",
  "customer_credit_entries",
  "sales_quotes",
  "sales_quote_items",
  "price_lists",
  "price_list_items",
  "supplier_payment_batches",
  "purchase_receipts",
  "purchase_receipt_items",
  "user_permission_overrides",
  "user_approval_limits",
  "inventory_batches",
  "purchase_receipt_item_batches",
  "sale_item_batches",
  "return_item_batches",
  "purchase_return_item_batches",
  "stock_transfer_item_batches",
  "sales_orders",
  "sales_order_items",
  "stock_reservations",
  "sales_order_deliveries",
  "sales_order_delivery_items",
  "attendance_sessions",
  "commission_plans",
  "sales_commissions",
  "commission_payouts",
  "accounting_accounts",
  "accounting_mappings",
  "accounting_periods",
  "accounting_journal_entries",
  "accounting_journal_lines",
  "payroll_compensation_profiles",
  "payroll_runs",
  "payroll_run_lines",
  "payroll_payments",
  "online_store_settings",
  "online_orders",
  "online_order_items",
  "online_order_status_history",
  "crm_tags",
  "crm_customer_tags",
  "crm_segments",
  "loyalty_program_settings",
  "customer_contact_logs",
  "customer_campaigns",
  "demand_planning_settings",
  "demand_forecast_runs",
  "demand_forecast_items"
]);

const DIRECT_ORG_TABLES = [
  "app_settings",
  "custom_staff_roles",
  "branches",
  "online_store_settings",
  "accounting_accounts",
  "accounting_mappings",
  "accounting_periods",
  "accounting_journal_entries",
  "accounting_journal_lines",
  "payroll_compensation_profiles",
  "payroll_runs",
  "payroll_run_lines",
  "payroll_payments",
  "user_permission_overrides",
  "user_approval_limits",
  "categories",
  "suppliers",
  "price_lists",
  "crm_tags",
  "crm_segments",
  "customers",
  "customer_counters",
  "customer_loyalty_movements",
  "crm_customer_tags",
  "loyalty_program_settings",
  "customer_contact_logs",
  "customer_credit_accounts",
  "customer_credit_payments",
  "customer_credit_payment_allocations",
  "customer_credit_entries",
  "coupons",
  "customer_campaigns",
  "coupon_redemptions",
  "products",
  "product_images",
  "product_units",
  "inventory_balances",
  "reorder_rules",
  "demand_planning_settings",
  "demand_forecast_runs",
  "demand_forecast_items",
  "document_counters",
  "price_list_items",
  "sales_quotes",
  "sales_quote_items",
  "sales_orders",
  "sales_order_items",
  "stock_reservations",
  "sales_order_deliveries",
  "sales_order_delivery_items",
  "online_orders",
  "online_order_items",
  "online_order_status_history",
  "sales",
  "sale_items",
  "payments",
  "purchases",
  "purchase_items",
  "purchase_receipts",
  "purchase_receipt_items",
  "supplier_payment_batches",
  "purchase_payments",
  "returns",
  "return_items",
  "inventory_adjustments",
  "inventory_adjustment_items",
  "stock_count_sessions",
  "stock_count_items",
  "parked_sales",
  "stock_movements",
  "cash_categories",
  "cash_entries",
  "cash_register_sessions",
  "stock_transfers",
  "stock_transfer_items",
  "purchase_returns",
  "purchase_return_items",
  "inventory_batches",
  "purchase_receipt_item_batches",
  "sale_item_batches",
  "return_item_batches",
  "purchase_return_item_batches",
  "stock_transfer_item_batches",
  "supplier_code_counters",
  "data_import_jobs",
  "data_import_errors",
  "attendance_sessions",
  "commission_plans",
  "sales_commissions",
  "commission_payouts",
  "audit_logs"
];

const DELETE_ORDER = [
  "custom_staff_roles",
  "customer_campaigns",
  "customer_contact_logs",
  "crm_customer_tags",
  "loyalty_program_settings",
  "crm_segments",
  "crm_tags",
  "online_order_status_history",
  "online_order_items",
  "online_orders",
  "online_store_settings",
  "payroll_payments",
  "payroll_run_lines",
  "payroll_runs",
  "payroll_compensation_profiles",
  "accounting_journal_lines",
  "accounting_journal_entries",
  "accounting_periods",
  "accounting_mappings",
  "accounting_accounts",
  "user_permission_overrides",
  "user_approval_limits",
  "commission_payouts",
  "sales_commissions",
  "commission_plans",
  "attendance_sessions",
  "data_import_errors",
  "data_import_jobs",
  "coupon_redemptions",
  "customer_credit_entries",
  "customer_credit_payment_allocations",
  "return_item_batches",
  "purchase_return_item_batches",
  "sale_item_batches",
  "stock_transfer_item_batches",
  "purchase_receipt_item_batches",
  "inventory_batches",
  "return_items",
  "returns",
  "payments",
  "customer_credit_payments",
  "sale_items",
  "sales",
  "sales_order_delivery_items",
  "sales_order_deliveries",
  "stock_reservations",
  "sales_order_items",
  "sales_orders",
  "sales_quote_items",
  "sales_quotes",
  "price_list_items",
  "price_lists",
  "customer_credit_accounts",
  "coupons",
  "purchase_payments",
  "supplier_payment_batches",
  "purchase_return_items",
  "purchase_returns",
  "purchase_receipt_items",
  "purchase_receipts",
  "purchase_items",
  "purchases",
  "stock_transfer_items",
  "stock_transfers",
  "stock_count_items",
  "stock_count_sessions",
  "inventory_adjustment_items",
  "inventory_adjustments",
  "parked_sales",
  "stock_movements",
  "cash_entries",
  "cash_register_sessions",
  "cash_categories",
  "customer_loyalty_movements",
  "customer_counters",
  "demand_forecast_items",
  "demand_forecast_runs",
  "demand_planning_settings",
  "reorder_rules",
  "inventory_balances",
  "product_units",
  "product_images",
  "products",
  "categories",
  "supplier_code_counters",
  "suppliers",
  "customers",
  "document_counters",
  "audit_logs",
  "app_settings"
];

const INSERT_ORDER = [
  "app_settings",
  "custom_staff_roles",
  "online_store_settings",
  "accounting_accounts",
  "accounting_mappings",
  "accounting_periods",
  "accounting_journal_entries",
  "accounting_journal_lines",
  "payroll_compensation_profiles",
  "payroll_runs",
  "payroll_run_lines",
  "payroll_payments",
  "user_approval_limits",
  "user_permission_overrides",
  "attendance_sessions",
  "commission_plans",
  "commission_payouts",
  "categories",
  "suppliers",
  "price_lists",
  "customers",
  "customer_credit_accounts",
  "customer_counters",
  "supplier_code_counters",
  "coupons",
  "products",
  "product_units",
  "price_list_items",
  "product_images",
  "inventory_balances",
  "reorder_rules",
  "demand_planning_settings",
  "demand_forecast_runs",
  "demand_forecast_items",
  "document_counters",
  "sales_quotes",
  "sales_quote_items",
  "sales_orders",
  "sales_order_items",
  "stock_reservations",
  "sales_order_deliveries",
  "sales_order_delivery_items",
  "online_orders",
  "online_order_items",
  "online_order_status_history",
  "cash_categories",
  "cash_register_sessions",
  "cash_entries",
  "purchases",
  "purchase_items",
  "purchase_receipts",
  "purchase_receipt_items",
  "supplier_payment_batches",
  "purchase_payments",
  "sales",
  "sale_items",
  "customer_credit_payments",
  "payments",
  "customer_credit_payment_allocations",
  "coupon_redemptions",
  "returns",
  "return_items",
  "sales_commissions",
  "customer_credit_entries",
  "inventory_adjustments",
  "inventory_adjustment_items",
  "stock_count_sessions",
  "stock_count_items",
  "parked_sales",
  "stock_movements",
  "stock_transfers",
  "stock_transfer_items",
  "purchase_returns",
  "purchase_return_items",
  "inventory_batches",
  "purchase_receipt_item_batches",
  "sale_item_batches",
  "return_item_batches",
  "purchase_return_item_batches",
  "stock_transfer_item_batches",
  "customer_loyalty_movements",
  "data_import_jobs",
  "data_import_errors",
  "audit_logs"
];

const USER_REFERENCE_COLUMNS = [
  "created_by",
  "updated_by",
  "voided_by",
  "cashier_id",
  "received_by",
  "processed_by",
  "parked_by",
  "user_id",
  "cancelled_by",
  "ordered_by",
  "paid_by",
  "requested_by",
  "redeemed_by",
  "opened_by",
  "closed_by",
  "started_by",
  "completed_by",
  "counted_by",
  "sent_by",
  "accepted_by",
  "converted_by",
  "confirmed_by",
  "reserved_by",
  "released_by",
  "changed_by"
];

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function cleanFilenamePart(value) {
  return String(value || "tiny-pos")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "tiny-pos";
}


async function ensureBackupSchedule(admin, profile) {
  const { data: existing, error } = await admin
    .from("backup_schedules")
    .select("*")
    .eq("organization_id", profile.organization_id)
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing;

  const { data: settings } = await admin
    .from("app_settings")
    .select("timezone")
    .eq("organization_id", profile.organization_id)
    .maybeSingle();

  const { data, error: insertError } = await admin
    .from("backup_schedules")
    .insert({
      organization_id: profile.organization_id,
      is_enabled: false,
      frequency_days: 1,
      backup_time: "23:00",
      timezone: settings?.timezone || "Asia/Phnom_Penh",
      created_by: profile.id,
      updated_by: profile.id
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  return data;
}

function timezoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedLocalToUtc({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const p = timezoneParts(new Date(guess), timeZone);
    const rendered = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second || 0)
    );
    guess -= rendered - target;
  }
  return new Date(guess);
}

function nextBackupAt(schedule, fromDate = new Date(), afterSuccessfulRun = false) {
  const timeZone = schedule.timezone || "Asia/Phnom_Penh";
  const p = timezoneParts(fromDate, timeZone);
  const [hourText, minuteText] = String(schedule.backup_time || "23:00").split(":");
  const base = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  let addDays = afterSuccessfulRun ? Number(schedule.frequency_days || 1) : 0;
  let localDate = new Date(base.getTime() + addDays * 86400000);
  let candidate = zonedLocalToUtc({
    year: localDate.getUTCFullYear(),
    month: localDate.getUTCMonth() + 1,
    day: localDate.getUTCDate(),
    hour: Number(hourText || 23),
    minute: Number(minuteText || 0)
  }, timeZone);

  if (!afterSuccessfulRun && candidate <= fromDate) {
    localDate = new Date(base.getTime() + Number(schedule.frequency_days || 1) * 86400000);
    candidate = zonedLocalToUtc({
      year: localDate.getUTCFullYear(),
      month: localDate.getUTCMonth() + 1,
      day: localDate.getUTCDate(),
      hour: Number(hourText || 23),
      minute: Number(minuteText || 0)
    }, timeZone);
  }
  return candidate.toISOString();
}

let serverCrcTable = null;
function serverCrc32(bytes) {
  if (!serverCrcTable) {
    serverCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      serverCrcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = serverCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZipBuffer(entries) {
  const normalized = entries.map((entry) => {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ""), "utf8");
    return { ...entry, name, data, crc: serverCrc32(data) };
  });
  const date = new Date();
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of normalized) {
    const local = Buffer.alloc(30 + entry.name.length + entry.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(entry.crc >>> 0, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28);
    entry.name.copy(local, 30);
    entry.data.copy(local, 30 + entry.name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + entry.name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(entry.crc >>> 0, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    entry.name.copy(central, 46);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function collectCloudinaryUrls(value, path = "backup", output = [], seen = new Set()) {
  if (value == null) return output;
  if (typeof value === "string") {
    if (/res\.cloudinary\.com\//i.test(value) && !seen.has(value)) {
      seen.add(value);
      output.push({ path, url: value });
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCloudinaryUrls(item, `${path}[${index}]`, output, seen));
  } else if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => collectCloudinaryUrls(item, `${path}.${key}`, output, seen));
  }
  return output;
}

function buildBackupZipBuffer(backup) {
  const assets = collectCloudinaryUrls(backup);
  const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const assetCsv = ["source_path,cloudinary_url", ...assets.map((item) => `${csvCell(item.path)},${csvCell(item.url)}`)].join("\n");
  const manifest = {
    format: "tiny-pos-backup-package",
    package_version: 1,
    created_at: backup.created_at,
    source: backup.source,
    business_backup_version: backup.version,
    row_counts: backup.row_counts,
    cloudinary_asset_count: assets.length,
    excludes: ["Supabase Auth passwords", "Netlify/API secrets", "Cloudinary image binaries"]
  };
  const readme = [
    "Tiny POS Backup Package",
    "business-backup.json is used by Restore.",
    "cloudinary-assets.csv lists external Cloudinary files referenced by the POS.",
    "Passwords and private environment/API secrets are intentionally excluded."
  ].join("\n");
  return createStoredZipBuffer([
    { name: "business-backup.json", data: JSON.stringify(backup, null, 2) },
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "cloudinary-assets.csv", data: assetCsv },
    { name: "README.txt", data: readme }
  ]);
}

async function uploadBackupToStorage(admin, profile, backup, trigger = "manual") {
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  const shop = cleanFilenamePart(backup.source.organization.name);
  const filename = `${shop}-backup-${date}.zip`;
  const storagePath = `${profile.organization_id}/${filename}`;
  const zip = buildBackupZipBuffer(backup);

  const { error: uploadError } = await admin.storage
    .from("tiny-pos-backups")
    .upload(storagePath, zip, {
      contentType: "application/zip",
      cacheControl: "3600",
      upsert: false
    });
  if (uploadError) throw uploadError;

  const { data: record, error: recordError } = await admin
    .from("backup_storage_files")
    .insert({
      organization_id: profile.organization_id,
      storage_path: storagePath,
      filename,
      size_bytes: zip.length,
      trigger,
      created_by: profile.id,
      created_at: new Date().toISOString()
    })
    .select("id,filename,size_bytes,storage_path,trigger,created_at")
    .single();
  if (recordError) throw recordError;

  return {
    filename,
    size: zip.length,
    storage_path: storagePath,
    backup_id: record.id,
    destination: "supabase_storage",
    trigger,
    created_at: backup.created_at
  };
}

async function saveSchedule(admin, profile, incoming) {
  const current = await ensureBackupSchedule(admin, profile);
  const frequencyDays = Math.max(1, Math.min(90, Number(incoming.frequency_days || current.frequency_days || 1)));
  const backupTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(incoming.backup_time || ""))
    ? incoming.backup_time
    : String(current.backup_time || "23:00").slice(0, 5);
  const timezone = String(incoming.timezone || current.timezone || "Asia/Phnom_Penh").trim();
  const nextSchedule = {
    ...current,
    frequency_days: frequencyDays,
    backup_time: backupTime,
    timezone,
    is_enabled: Boolean(incoming.is_enabled)
  };
  const nextAt = nextSchedule.is_enabled ? nextBackupAt(nextSchedule) : null;
  const { data, error } = await admin.from("backup_schedules").upsert({
    organization_id: profile.organization_id,
    is_enabled: nextSchedule.is_enabled,
    frequency_days: frequencyDays,
    backup_time: backupTime,
    timezone,
    destination: "supabase_storage",
    next_backup_at: nextAt,
    updated_by: profile.id,
    updated_at: new Date().toISOString()
  }, { onConflict: "organization_id" }).select("*").single();
  if (error) throw error;
  return data;
}

async function backupCenterSettings(admin, profile) {
  const schedule = await ensureBackupSchedule(admin, profile);
  const { data: files, error: filesError } = await admin
    .from("backup_storage_files")
    .select("id,filename,size_bytes,storage_path,trigger,created_at")
    .eq("organization_id", profile.organization_id)
    .order("created_at", { ascending: false })
    .limit(30);
  if (filesError) throw filesError;
  return {
    ok: true,
    schedule: {
      is_enabled: schedule.is_enabled,
      frequency_days: schedule.frequency_days,
      backup_time: String(schedule.backup_time || "23:00").slice(0, 5),
      timezone: schedule.timezone,
      last_backup_at: schedule.last_backup_at,
      next_backup_at: schedule.next_backup_at,
      last_status: schedule.last_status,
      last_error: schedule.last_error
    },
    storage: {
      bucket: "tiny-pos-backups",
      files: files || []
    }
  };
}

async function runStorageBackup(admin, profile, trigger = "manual") {
  const schedule = await ensureBackupSchedule(admin, profile);
  await admin.from("backup_schedules").update({
    last_status: "running",
    last_error: null,
    updated_at: new Date().toISOString()
  }).eq("organization_id", profile.organization_id);

  try {
    const backup = await createBackup(admin, profile);
    const details = await uploadBackupToStorage(admin, profile, backup, trigger);
    const completedAt = new Date();
    const nextAt = schedule.is_enabled ? nextBackupAt(schedule, completedAt, true) : null;
    await admin.from("backup_schedules").update({
      last_backup_at: completedAt.toISOString(),
      next_backup_at: nextAt,
      last_status: "completed",
      last_error: null,
      updated_at: completedAt.toISOString()
    }).eq("organization_id", profile.organization_id);
    await logOperation(admin, profile, "export", "completed", backup, details);
    return { ok: true, ...details, next_backup_at: nextAt };
  } catch (error) {
    const retryAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    await admin.from("backup_schedules").update({
      last_status: "failed",
      last_error: error.message,
      next_backup_at: schedule.is_enabled ? retryAt : null,
      updated_at: new Date().toISOString()
    }).eq("organization_id", profile.organization_id);
    throw error;
  }
}

export async function runScheduledBackups() {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data: schedules, error } = await admin
    .from("backup_schedules")
    .select("*")
    .eq("is_enabled", true)
    .lte("next_backup_at", now)
    .order("next_backup_at", { ascending: true })
    .limit(20);
  if (error) throw error;

  const results = [];
  for (const schedule of schedules || []) {
    const { data: profile } = await admin
      .from("profiles")
      .select("id,organization_id,branch_id,email,full_name,role,is_active")
      .eq("organization_id", schedule.organization_id)
      .eq("is_active", true)
      .in("role", ["owner", "admin"])
      .order("role", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!profile) {
      await admin.from("backup_schedules").update({
        last_status: "failed",
        last_error: "No active owner/admin profile is available for scheduled backup.",
        next_backup_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
      }).eq("organization_id", schedule.organization_id);
      results.push({ organization_id: schedule.organization_id, ok: false, error: "No owner/admin profile" });
      continue;
    }
    try {
      const result = await runStorageBackup(admin, profile, "scheduled");
      results.push({ organization_id: schedule.organization_id, ok: true, filename: result.filename });
    } catch (error) {
      await logOperation(admin, profile, "export", "failed", null, {
        destination: "supabase_storage",
        trigger: "scheduled",
        error: error.message
      });
      results.push({ organization_id: schedule.organization_id, ok: false, error: error.message });
    }
  }
  return { ok: true, checked_at: now, processed: results.length, results };
}

function createAdminClient() {
  const url = process.env.SUPABASE_URL;
  const secret =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw Object.assign(
      new Error(
        "Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
      ),
      { status: 500 }
    );
  }

  return createClient(url, secret, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  });
}

async function authenticate(request, admin) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw Object.assign(new Error("Authentication required."), {
      status: 401
    });
  }

  const {
    data: { user },
    error: userError
  } = await admin.auth.getUser(token);

  if (userError || !user) {
    throw Object.assign(
      new Error("Your login session is invalid or expired."),
      { status: 401 }
    );
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select(
      "id,organization_id,branch_id,email,full_name,role,is_active"
    )
    .eq("id", user.id)
    .single();

  if (profileError || !profile?.is_active) {
    throw Object.assign(new Error("Active POS profile not found."), {
      status: 403
    });
  }

  if (!await hasEffectivePermission(
    admin,
    profile,
    "audit_backup.manage",
    ["owner", "admin"]
  )) {
    throw Object.assign(
      new Error("Permission required: audit_backup.manage"),
      { status: 403 }
    );
  }

  return { user, profile };
}

async function selectAll(queryFactory) {
  const rows = [];
  let from = 0;

  while (true) {
    const { data, error } = await queryFactory().range(
      from,
      from + PAGE_SIZE - 1
    );

    if (error) throw error;

    const page = data || [];
    rows.push(...page);

    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

async function loadOrganization(admin, organizationId) {
  const { data, error } = await admin
    .from("organizations")
    .select("*")
    .eq("id", organizationId)
    .single();

  if (error || !data) {
    throw new Error("Organization not found.");
  }

  return data;
}

async function createBackup(admin, caller) {
  const organization = await loadOrganization(
    admin,
    caller.organization_id
  );

  const profiles = await selectAll(() =>
    admin
      .from("profiles")
      .select(
        "id,organization_id,branch_id,email,full_name,role,custom_role_id,phone,avatar_url,is_active,last_login_at,created_at,updated_at"
      )
      .eq("organization_id", caller.organization_id)
  );

  const profileIds = profiles.map((profile) => profile.id);
  let preferences = [];

  if (profileIds.length > 0) {
    for (let index = 0; index < profileIds.length; index += 150) {
      const ids = profileIds.slice(index, index + 150);
      const { data, error } = await admin
        .from("user_preferences")
        .select("*")
        .in("user_id", ids);

      if (error) throw error;
      preferences.push(...(data || []));
    }
  }

  const tables = {};

  for (const table of DIRECT_ORG_TABLES) {
    tables[table] = await selectAll(() =>
      admin
        .from(table)
        .select("*")
        .eq("organization_id", caller.organization_id)
    );
  }

  const rowCounts = Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [
      table,
      rows.length
    ])
  );
  rowCounts.profiles = profiles.length;
  rowCounts.user_preferences = preferences.length;

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    source: {
      organization,
      schema_step: "46.25"
    },
    staff: profiles,
    user_preferences: preferences,
    tables,
    row_counts: rowCounts
  };
}

function validateBackupDocument(backup) {
  const problems = [];

  if (!backup || typeof backup !== "object") {
    problems.push("The uploaded file is not a JSON backup object.");
  } else {
    if (backup.format !== BACKUP_FORMAT) {
      problems.push("This is not a Tiny POS business backup.");
    }

    if (Number(backup.version) !== BACKUP_VERSION) {
      problems.push(
        `Unsupported backup version: ${backup.version ?? "missing"}.`
      );
    }

    if (!backup.source?.organization?.id) {
      problems.push("Source organization information is missing.");
    }

    if (!backup.tables || typeof backup.tables !== "object") {
      problems.push("Backup table data is missing.");
    }

    for (const table of DIRECT_ORG_TABLES) {
      if (
        !Array.isArray(backup.tables?.[table]) &&
        !OPTIONAL_TABLES.has(table)
      ) {
        problems.push(`Table ${table} is missing or invalid.`);
      }
    }

    if (!Array.isArray(backup.staff)) {
      problems.push("Staff manifest is missing.");
    }

    if (!Array.isArray(backup.user_preferences)) {
      problems.push("User preferences are missing.");
    }

    if (!Array.isArray(backup.tables?.branches) || backup.tables.branches.length === 0) {
      problems.push("The backup contains no branches.");
    }

    if (!Array.isArray(backup.tables?.app_settings) || backup.tables.app_settings.length !== 1) {
      problems.push("The backup must contain one shop settings record.");
    }
  }

  const rowCounts =
    backup?.tables && typeof backup.tables === "object"
      ? Object.fromEntries(
          Object.entries(backup.tables).map(([table, rows]) => [
            table,
            Array.isArray(rows) ? rows.length : 0
          ])
        )
      : {};

  return {
    valid: problems.length === 0,
    problems,
    row_counts: rowCounts,
    created_at: backup?.created_at || null,
    source_organization:
      backup?.source?.organization?.name || null,
    source_code: backup?.source?.organization?.code || null,
    version: backup?.version || null
  };
}

async function logOperation(
  admin,
  caller,
  action,
  status,
  backup,
  details = {}
) {
  const rowCounts =
    backup?.row_counts ||
    Object.fromEntries(
      Object.entries(backup?.tables || {}).map(([table, rows]) => [
        table,
        Array.isArray(rows) ? rows.length : 0
      ])
    );

  const { error } = await admin.from("data_backup_logs").insert({
    organization_id: caller.organization_id,
    branch_id: caller.branch_id,
    requested_by: caller.id,
    action,
    status,
    filename: details.filename || null,
    backup_version: Number(backup?.version || BACKUP_VERSION),
    source_organization_name:
      backup?.source?.organization?.name || null,
    row_counts: rowCounts,
    details
  });

  if (error) {
    console.error("Could not write backup log:", error.message);
  }
}

function mapUserId(sourceId, userMap, fallbackUserId) {
  if (!sourceId) return null;
  return userMap.get(sourceId) || fallbackUserId;
}

function transformRows(
  table,
  rows,
  targetOrganizationId,
  userMap,
  fallbackUserId
) {
  return (rows || []).map((sourceRow) => {
    const row = { ...sourceRow };

    if ("organization_id" in row) {
      row.organization_id = targetOrganizationId;
    }

    for (const column of USER_REFERENCE_COLUMNS) {
      if (column in row && row[column]) {
        row[column] = mapUserId(
          row[column],
          userMap,
          fallbackUserId
        );
      }
    }

    if (table === "stock_count_sessions" && row.status === "counting") {
      const cancelledAt = new Date().toISOString();

      row.status = "cancelled";
      row.cancelled_by = fallbackUserId;
      row.cancelled_at = cancelledAt;
      row.completed_by = null;
      row.completed_at = null;
      row.cancellation_reason = [
        row.cancellation_reason,
        "Automatically cancelled during backup restore."
      ].filter(Boolean).join(" ");
    }

    if (table === "cash_register_sessions" && row.status === "open") {
      const closedAt = new Date().toISOString();
      const expectedUsd = Number(
        row.expected_cash_usd ?? row.opening_cash_usd ?? 0
      );
      const expectedKhr = Number(
        row.expected_cash_khr ?? row.opening_cash_khr ?? 0
      );

      row.status = "closed";
      row.expected_cash_usd = expectedUsd;
      row.expected_cash_khr = expectedKhr;
      row.counted_cash_usd = expectedUsd;
      row.counted_cash_khr = expectedKhr;
      row.variance_usd = 0;
      row.variance_khr = 0;
      row.closed_by = fallbackUserId;
      row.closed_at = closedAt;
      row.closing_note = [
        row.closing_note,
        "Automatically closed during backup restore."
      ].filter(Boolean).join(" ");
    }

    if (table === "audit_logs") {
      delete row.id;
    }

    return row;
  });
}

async function insertChunks(admin, table, rows) {
  if (!rows.length) return;

  for (let index = 0; index < rows.length; index += INSERT_SIZE) {
    const chunk = rows.slice(index, index + INSERT_SIZE);
    const { error } = await admin.from(table).insert(chunk);
    if (error) {
      throw new Error(
        `Restore failed while inserting ${table}: ${error.message}`
      );
    }
  }
}

async function deleteOrganizationRows(admin, table, organizationId) {
  const { error } = await admin
    .from(table)
    .delete()
    .eq("organization_id", organizationId);

  if (error) {
    throw new Error(
      `Could not clear ${table}: ${error.message}`
    );
  }
}

async function restoreBackup(admin, caller, backup) {
  const validation = validateBackupDocument(backup);

  if (!validation.valid) {
    throw Object.assign(
      new Error(validation.problems.join(" ")),
      { status: 400 }
    );
  }

  const targetProfiles = await selectAll(() =>
    admin
      .from("profiles")
      .select(
        "id,organization_id,branch_id,email,full_name,role,custom_role_id,is_active"
      )
      .eq("organization_id", caller.organization_id)
  );

  const targetByEmail = new Map(
    targetProfiles
      .filter((profile) => profile.email)
      .map((profile) => [
        String(profile.email).toLowerCase(),
        profile
      ])
  );

  const userMap = new Map();
  const missingStaff = [];

  for (const sourceProfile of backup.staff || []) {
    const email = String(sourceProfile.email || "").toLowerCase();
    const target = email ? targetByEmail.get(email) : null;

    if (target) {
      userMap.set(sourceProfile.id, target.id);
    } else {
      userMap.set(sourceProfile.id, caller.id);
      missingStaff.push({
        email: sourceProfile.email || null,
        full_name: sourceProfile.full_name || "Unknown staff",
        role: sourceProfile.role || "cashier"
      });
    }
  }

  // Clear branch assignments before replacing branch rows.
  const { error: clearBranchError } = await admin
    .from("profiles")
    .update({ branch_id: null })
    .eq("organization_id", caller.organization_id);

  if (clearBranchError) throw clearBranchError;

  for (const table of DELETE_ORDER) {
    await deleteOrganizationRows(
      admin,
      table,
      caller.organization_id
    );
  }

  const { error: branchDeleteError } = await admin
    .from("branches")
    .delete()
    .eq("organization_id", caller.organization_id);

  if (branchDeleteError) {
    throw new Error(
      `Could not replace branches: ${branchDeleteError.message}`
    );
  }

  const sourceBranches = transformRows(
    "branches",
    backup.tables.branches,
    caller.organization_id,
    userMap,
    caller.id
  );

  if (sourceBranches.length === 0) {
    throw new Error("The backup contains no branches.");
  }

  await insertChunks(admin, "branches", sourceBranches);

  const sourceOrganization = backup.source.organization || {};
  const { error: organizationError } = await admin
    .from("organizations")
    .update({
      name: sourceOrganization.name || "Tiny POS",
      logo_url: sourceOrganization.logo_url || null,
      is_active: sourceOrganization.is_active !== false,
      updated_at: new Date().toISOString()
    })
    .eq("id", caller.organization_id);

  if (organizationError) throw organizationError;

  for (const table of INSERT_ORDER) {
    if (table === "branches") continue;

    const rows = transformRows(
      table,
      backup.tables[table] || [],
      caller.organization_id,
      userMap,
      caller.id
    );

    await insertChunks(admin, table, rows);
  }

  // Restore matching staff information without creating Auth users.
  const branchBySourceId = new Map(
    (backup.tables.branches || []).map((branch) => [
      branch.id,
      branch.id
    ])
  );

  for (const sourceProfile of backup.staff || []) {
    const email = String(sourceProfile.email || "").toLowerCase();
    const target = email ? targetByEmail.get(email) : null;
    if (!target) continue;

    const nextRole =
      target.id === caller.id
        ? "owner"
        : sourceProfile.role === "owner"
          ? target.role
          : sourceProfile.role;

    const nextBranchId =
      branchBySourceId.get(sourceProfile.branch_id) ||
      sourceBranches[0]?.id ||
      null;

    const { error } = await admin
      .from("profiles")
      .update({
        branch_id: nextBranchId,
        full_name: sourceProfile.full_name || target.full_name,
        phone: sourceProfile.phone || null,
        avatar_url: sourceProfile.avatar_url || null,
        role: nextRole,
        custom_role_id:
          target.id === caller.id
            ? null
            : sourceProfile.custom_role_id || null,
        is_active:
          target.id === caller.id
            ? true
            : sourceProfile.is_active !== false,
        updated_at: new Date().toISOString()
      })
      .eq("id", target.id)
      .eq("organization_id", caller.organization_id);

    if (error) throw error;
  }

  // Ensure every current target user has a valid branch.
  const primaryBranchId = sourceBranches[0].id;
  const { error: remainingBranchError } = await admin
    .from("profiles")
    .update({ branch_id: primaryBranchId })
    .eq("organization_id", caller.organization_id)
    .is("branch_id", null);

  if (remainingBranchError) throw remainingBranchError;

  // Restore matching personal preferences.
  for (const sourcePreference of backup.user_preferences || []) {
    const targetUserId = userMap.get(sourcePreference.user_id);
    if (!targetUserId) continue;

    const { user_id: _ignored, ...preferenceValues } =
      sourcePreference;

    const { error } = await admin
      .from("user_preferences")
      .upsert(
        {
          ...preferenceValues,
          user_id: targetUserId
        },
        { onConflict: "user_id" }
      );

    if (error) throw error;
  }

  return {
    ok: true,
    restored_tables: Object.fromEntries(
      INSERT_ORDER.map((table) => [
        table,
        Array.isArray(backup.tables[table])
          ? backup.tables[table].length
          : 0
      ])
    ),
    restored_branches: sourceBranches.length,
    active_branch_id: primaryBranchId,
    missing_staff: missingStaff
  };
}

export default async (request) => {
  const admin = createAdminClient();
  let caller;
  let body = {};

  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "POST required." }, 405);
    }

    ({ profile: caller } = await authenticate(request, admin));
    body = await request.json();
    const action = String(body.action || "").trim();

    if (action === "settings_get") {
      return json(await backupCenterSettings(admin, caller));
    }

    if (action === "settings_save") {
      await saveSchedule(admin, caller, body.settings || {});
      return json(await backupCenterSettings(admin, caller));
    }

    if (action === "storage_backup") {
      return json(await runStorageBackup(admin, caller, "manual"));
    }

    if (action === "storage_download") {
      const fileId = String(body.file_id || "").trim();
      if (!fileId) return json({ ok: false, error: "Backup file ID is required." }, 400);
      const { data: file, error: fileError } = await admin
        .from("backup_storage_files")
        .select("*")
        .eq("id", fileId)
        .eq("organization_id", caller.organization_id)
        .maybeSingle();
      if (fileError) throw fileError;
      if (!file) return json({ ok: false, error: "Backup file was not found." }, 404);
      const { data: blob, error: downloadError } = await admin.storage
        .from("tiny-pos-backups")
        .download(file.storage_path);
      if (downloadError) throw downloadError;
      const arrayBuffer = await blob.arrayBuffer();
      return new Response(arrayBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${file.filename.replaceAll('"', '')}"`,
          "Cache-Control": "no-store"
        }
      });
    }

    if (action === "export") {
      const backup = await createBackup(admin, caller);
      const date = new Date().toISOString().slice(0, 10);
      const shop = cleanFilenamePart(
        backup.source.organization.name
      );
      const filename = `${shop}-backup-${date}.zip`;

      await logOperation(
        admin,
        caller,
        "export",
        "completed",
        backup,
        { filename, destination: "download", trigger: "manual" }
      );

      return json(backup, 200, {
        "Content-Disposition": `attachment; filename="${filename}"`
      });
    }

    if (action === "validate") {
      const validation = validateBackupDocument(body.backup);

      await logOperation(
        admin,
        caller,
        "validate",
        validation.valid ? "completed" : "failed",
        body.backup,
        {
          problems: validation.problems
        }
      );

      return json({
        ok: validation.valid,
        validation
      }, validation.valid ? 200 : 400);
    }

    if (action === "restore") {
      if (caller.role !== "owner") {
        throw Object.assign(
          new Error("Only the owner can restore a backup."),
          { status: 403 }
        );
      }

      if (body.confirmation !== "RESTORE TINY POS") {
        throw Object.assign(
          new Error(
            'Type exactly "RESTORE TINY POS" to confirm.'
          ),
          { status: 400 }
        );
      }

      if (body.current_backup_downloaded !== true) {
        throw Object.assign(
          new Error(
            "Download a current safety backup before restoring."
          ),
          { status: 400 }
        );
      }

      const result = await restoreBackup(
        admin,
        caller,
        body.backup
      );

      const restoredCaller = {
        ...caller,
        branch_id: result.active_branch_id
      };

      await logOperation(
        admin,
        restoredCaller,
        "restore",
        "completed",
        body.backup,
        {
          restored_tables: result.restored_tables,
          missing_staff: result.missing_staff
        }
      );

      await admin.from("audit_logs").insert({
        organization_id: caller.organization_id,
        branch_id: result.active_branch_id,
        user_id: caller.id,
        action: "restore_business_backup",
        entity_type: "organization",
        entity_id: caller.organization_id,
        new_data: {
          source_organization:
            body.backup?.source?.organization?.name || null,
          backup_created_at: body.backup?.created_at || null,
          missing_staff: result.missing_staff
        }
      });

      return json(result);
    }

    return json(
      { ok: false, error: "Unknown backup action." },
      400
    );
  } catch (error) {
    console.error(error);

    if (caller) {
      await logOperation(
        admin,
        caller,
        String(body?.action || "validate"),
        "failed",
        body?.backup,
        { error: error.message }
      );
    }

    return json(
      { ok: false, error: error.message || "Backup request failed." },
      Number(error.status || 500)
    );
  }
};