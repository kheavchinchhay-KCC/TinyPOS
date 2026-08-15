export function defaultCashRange() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return {
    from: today,
    to: today,
    branchId: "",
    allBranches: false
  };
}

export async function loadCashExpenseWorkspace(supabase, filters) {
  const { data, error } = await supabase.rpc(
    "get_cash_expense_workspace",
    {
      p_from: filters.from,
      p_to: filters.to,
      p_branch_id: filters.allBranches
        ? null
        : filters.branchId || null,
      p_all_branches: Boolean(filters.allBranches)
    }
  );

  if (error) throw error;
  return data;
}

export async function saveCashEntry(supabase, values) {
  const { data, error } = await supabase.rpc("save_cash_entry_v2", {
    p_entry_id: values.id || null,
    p_direction: values.direction,
    p_category_id: values.category_id,
    p_method: values.method,
    p_currency: values.currency,
    p_amount: Number(values.amount),
    p_entry_at: new Date(values.entry_at).toISOString(),
    p_reference_number: values.reference_number.trim() || null,
    p_remark: values.remark.trim() || null
  });

  if (error) throw error;
  return data;
}

export async function saveCashCategory(supabase, values) {
  const { data, error } = await supabase.rpc("save_cash_category", {
    p_category_id: values.id || null,
    p_name: values.name.trim(),
    p_direction: values.direction,
    p_affects_profit: Boolean(values.affects_profit),
    p_is_active: Boolean(values.is_active)
  });

  if (error) throw error;
  return data;
}

export async function voidCashEntry(supabase, entryId, reason) {
  const { data, error } = await supabase.rpc("void_cash_entry_v2", {
    p_entry_id: entryId,
    p_reason: reason.trim()
  });

  if (error) throw error;
  return data;
}

export function cashMethodLabel(method) {
  const labels = {
    cash: "Cash",
    bank: "Bank",
    khqr: "KHQR",
    card: "Card",
    other: "Other"
  };

  return labels[method] || method || "Other";
}

export function localDateTimeValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000)
    .toISOString()
    .slice(0, 16);
}
