export function isoDate(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function monthRange(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return {
    start: isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))),
    end: isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)))
  };
}

export function accountingMoney(value, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: currency === "KHR" ? 0 : 2
  }).format(Number(value || 0));
}

export function accountingDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
}

export async function loadAccountingWorkspace(supabase) {
  const { data, error } = await supabase.rpc("get_accounting_workspace");
  if (error) throw error;
  return data || {};
}

export async function loadAccountingReport(supabase, filters) {
  const { data, error } = await supabase.rpc("get_accounting_report", {
    p_from: filters.date_from,
    p_to: filters.date_to,
    p_branch_id: filters.branch_id || null
  });
  if (error) throw error;
  return data || {};
}

export async function saveAccountingAccount(supabase, values) {
  const { data, error } = await supabase.rpc("save_accounting_account", {
    p_account_id: values.id || null,
    p_code: values.code,
    p_name: values.name,
    p_account_type: values.account_type,
    p_normal_balance: values.normal_balance,
    p_is_active: Boolean(values.is_active),
    p_description: values.description || null
  });
  if (error) throw error;
  return data;
}

export async function saveAccountingMapping(supabase, values) {
  const { data, error } = await supabase.rpc("save_accounting_mapping", {
    p_mapping_key: values.mapping_key,
    p_account_id: values.account_id
  });
  if (error) throw error;
  return data;
}

export async function saveManualJournal(supabase, values) {
  const { data, error } = await supabase.rpc("save_manual_journal", {
    p_journal_id: values.id || null,
    p_branch_id: values.branch_id || null,
    p_entry_date: values.entry_date,
    p_currency: values.currency,
    p_description: values.description,
    p_reference_number: values.reference_number || null,
    p_source_type: values.source_type,
    p_lines: values.lines.map((line) => ({
      account_id: line.account_id,
      description: line.description || null,
      debit: Number(line.debit || 0),
      credit: Number(line.credit || 0)
    }))
  });
  if (error) throw error;
  return data;
}

export async function voidManualJournal(supabase, id, reason) {
  const { data, error } = await supabase.rpc("void_manual_journal", {
    p_journal_id: id,
    p_reason: reason
  });
  if (error) throw error;
  return data;
}

export async function setAccountingPeriodStatus(supabase, values) {
  const { data, error } = await supabase.rpc("set_accounting_period_status", {
    p_branch_id: values.branch_id || null,
    p_year: Number(values.year),
    p_month: Number(values.month),
    p_status: values.status,
    p_notes: values.notes || null
  });
  if (error) throw error;
  return data;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function downloadAccountingCsv(filename, columns, rows) {
  const content = [
    columns.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(
      typeof column.value === "function" ? column.value(row) : row[column.value]
    )).join(","))
  ].join("\r\n");
  const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
