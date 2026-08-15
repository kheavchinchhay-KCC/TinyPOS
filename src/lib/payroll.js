export function payrollMoney(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KHR" ? 0 : 2
  }).format(Number(value || 0));
}

export function payrollDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
}

export function payrollDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function payrollDuration(minutes) {
  const total = Math.max(0, Number(minutes || 0));
  return `${Math.floor(total / 60)}h ${Math.round(total % 60)}m`;
}

export function currentMonthRange(value = new Date()) {
  const year = value.getFullYear();
  const month = value.getMonth();
  const local = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  return {
    start: local(new Date(year, month, 1)),
    end: local(new Date(year, month + 1, 0)),
    payDate: local(new Date(year, month + 1, 0))
  };
}

export async function saveCompensationProfile(supabase, values) {
  const { data, error } = await supabase.rpc("save_payroll_compensation_profile", {
    p_profile_id: values.id || null,
    p_user_id: values.user_id,
    p_branch_id: values.branch_id,
    p_currency: values.currency,
    p_pay_basis: values.pay_basis,
    p_base_salary: Number(values.base_salary || 0),
    p_hourly_rate: Number(values.hourly_rate || 0),
    p_overtime_rate: Number(values.overtime_rate || 0),
    p_standard_minutes_per_day: Number(values.standard_minutes_per_day || 480),
    p_fixed_allowance: Number(values.fixed_allowance || 0),
    p_fixed_deduction: Number(values.fixed_deduction || 0),
    p_prorate_monthly_by_attendance: Boolean(values.prorate_monthly_by_attendance),
    p_effective_from: values.effective_from,
    p_effective_to: values.effective_to || null,
    p_is_active: Boolean(values.is_active),
    p_notes: values.notes || null
  });
  if (error) throw error;
  return data;
}

export async function createPayrollRun(supabase, values) {
  const { data, error } = await supabase.rpc("create_payroll_run", {
    p_branch_id: values.branch_id || null,
    p_period_start: values.period_start,
    p_period_end: values.period_end,
    p_pay_date: values.pay_date,
    p_currency: values.currency,
    p_notes: values.notes || null
  });
  if (error) throw error;
  return data;
}

export async function refreshPayrollRun(supabase, id) {
  const { data, error } = await supabase.rpc("refresh_payroll_run", { p_payroll_run_id: id });
  if (error) throw error;
  return data;
}

export async function adjustPayrollLine(supabase, values) {
  const { data, error } = await supabase.rpc("update_payroll_line_adjustment", {
    p_payroll_line_id: values.id,
    p_manual_allowance: Number(values.manual_allowance || 0),
    p_manual_deduction: Number(values.manual_deduction || 0),
    p_notes: values.notes || null
  });
  if (error) throw error;
  return data;
}

export async function approvePayrollRun(supabase, id) {
  const { data, error } = await supabase.rpc("approve_payroll_run", { p_payroll_run_id: id });
  if (error) throw error;
  return data;
}

export async function payPayrollLine(supabase, values) {
  const { data, error } = await supabase.rpc("record_payroll_payment", {
    p_payroll_line_id: values.payroll_line_id,
    p_amount: Number(values.amount || 0),
    p_payment_method: values.payment_method,
    p_reference_number: values.reference_number || null,
    p_notes: values.notes || null,
    p_paid_at: values.paid_at || new Date().toISOString()
  });
  if (error) throw error;
  return data;
}

export async function voidPayrollRun(supabase, id, reason) {
  const { data, error } = await supabase.rpc("void_payroll_run", {
    p_payroll_run_id: id,
    p_reason: reason
  });
  if (error) throw error;
  return data;
}

export async function loadPayrollWorkspace(supabase, profile, access, filters = {}) {
  const manage = Boolean(access?.permissions?.["*"] || access?.permissions?.["payroll.manage"]);
  const branchId = filters.branch_id || null;
  const userId = manage ? filters.user_id || null : profile.id;

  let runQuery = supabase
    .from("payroll_runs")
    .select("*,branches(id,name,code),profiles!payroll_runs_created_by_fkey(full_name)")
    .gte("period_end", filters.date_from)
    .lte("period_start", filters.date_to)
    .order("period_end", { ascending: false })
    .limit(200);
  if (branchId) runQuery = runQuery.eq("branch_id", branchId);

  let lineQuery = supabase
    .from("payroll_run_lines")
    .select(`
      *,profiles!payroll_run_lines_user_id_fkey(id,full_name,role,email),
      branches(id,name,code),payroll_runs!inner(id,run_number,period_start,period_end,pay_date,status,currency,branch_id)
    `)
    .gte("payroll_runs.period_end", filters.date_from)
    .lte("payroll_runs.period_start", filters.date_to)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (branchId) lineQuery = lineQuery.eq("branch_id", branchId);
  if (userId) lineQuery = lineQuery.eq("user_id", userId);

  let paymentQuery = supabase
    .from("payroll_payments")
    .select(`
      *,payroll_run_lines!inner(user_id,branch_id,profiles!payroll_run_lines_user_id_fkey(full_name)),
      payroll_runs!inner(run_number,currency,period_start,period_end)
    `)
    .eq("status", "active")
    .order("paid_at", { ascending: false })
    .limit(500);
  if (userId) paymentQuery = paymentQuery.eq("payroll_run_lines.user_id", userId);
  if (branchId) paymentQuery = paymentQuery.eq("payroll_run_lines.branch_id", branchId);

  const results = await Promise.all([
    runQuery,
    lineQuery,
    paymentQuery,
    manage
      ? supabase.from("payroll_compensation_profiles").select(`*,profiles!payroll_compensation_profiles_user_id_fkey(id,full_name,role,email,is_active),branches(id,name,code)`).order("created_at", { ascending: false })
      : supabase.from("payroll_compensation_profiles").select(`*,profiles!payroll_compensation_profiles_user_id_fkey(id,full_name,role,email,is_active),branches(id,name,code)`).eq("user_id", profile.id),
    manage
      ? supabase.from("profiles").select("id,full_name,email,role,branch_id,is_active").eq("organization_id", profile.organization_id).eq("is_active", true).order("full_name")
      : Promise.resolve({ data: [profile], error: null }),
    supabase.from("branches").select("id,name,code,is_active").eq("organization_id", profile.organization_id).eq("is_active", true).order("name")
  ]);

  for (const result of results) if (result.error) throw result.error;
  return {
    runs: results[0].data || [],
    lines: results[1].data || [],
    payments: results[2].data || [],
    profiles: results[3].data || [],
    staff: results[4].data || [],
    branches: results[5].data || []
  };
}
