function localIsoDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Phnom_Penh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function roleName(profile) {
  return String(profile?.role || "").trim().toLowerCase();
}

function branchScoped(query, profile, allBranches) {
  const role = roleName(profile);
  if (allBranches && ["owner", "admin"].includes(role)) return query;
  return profile?.branch_id ? query.eq("branch_id", profile.branch_id) : query;
}

function uniqueAlerts(alerts) {
  const seen = new Set();
  return alerts.filter((alert) => {
    const key = String(alert?.key || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadApprovalAlerts(supabase, profile, allBranches, canReview) {
  if (!profile?.organization_id) return [];
  const alerts = [];
  const now = new Date();

  if (canReview) {
    let query = supabase
      .from("approval_requests")
      .select("id,branch_id,action_summary,amount,currency,requested_at,expires_at,status,requested_by")
      .eq("organization_id", profile.organization_id)
      .eq("status", "pending")
      .gt("expires_at", now.toISOString())
      .order("requested_at", { ascending: true })
      .limit(12);
    query = branchScoped(query, profile, allBranches);
    const { data, error } = await query;
    if (error) throw error;

    for (const request of data || []) {
      if (request.requested_by === profile.id) continue;
      alerts.push({
        key: `approval-request-${request.id}`,
        severity: "warning",
        title: "Approval request waiting",
        detail: request.action_summary || "A staff action needs one-time approval.",
        amount: request.amount,
        currency: request.currency,
        link: "/access-control?tab=approvals"
      });
    }
  }

  const recentSince = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { data: ownRequests, error: ownError } = await supabase
    .from("approval_requests")
    .select("id,action_summary,status,review_note,reviewed_at,amount,currency")
    .eq("organization_id", profile.organization_id)
    .eq("requested_by", profile.id)
    .in("status", ["approved", "rejected"])
    .gte("reviewed_at", recentSince)
    .order("reviewed_at", { ascending: false })
    .limit(6);
  if (ownError) throw ownError;

  for (const request of ownRequests || []) {
    alerts.push({
      key: `approval-result-${request.id}-${request.status}`,
      severity: request.status === "approved" ? "success" : "danger",
      title: request.status === "approved" ? "Approval granted" : "Approval rejected",
      detail: [request.action_summary, request.review_note].filter(Boolean).join(" · "),
      amount: request.amount,
      currency: request.currency,
      link: "/access-control?tab=approvals"
    });
  }

  return alerts;
}

async function loadLeaveAndAbsenceAlerts(supabase, profile, allBranches, canManageAttendance) {
  if (!profile?.organization_id) return [];
  const alerts = [];
  const role = roleName(profile);

  if (canManageAttendance) {
    let leaveQuery = supabase
      .from("staff_leave_requests")
      .select("id,branch_id,user_id,date_from,date_to,leave_type,reason,status,created_at")
      .eq("organization_id", profile.organization_id)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(12);
    leaveQuery = branchScoped(leaveQuery, profile, allBranches);
    const { data: leaves, error: leaveError } = await leaveQuery;
    if (leaveError) throw leaveError;

    const userIds = [...new Set((leaves || []).map((row) => row.user_id).filter(Boolean))];
    let profileMap = new Map();
    if (userIds.length) {
      const { data: staffRows, error: staffError } = await supabase
        .from("profiles")
        .select("id,full_name")
        .in("id", userIds);
      if (staffError) throw staffError;
      profileMap = new Map((staffRows || []).map((row) => [row.id, row.full_name]));
    }

    for (const leave of leaves || []) {
      alerts.push({
        key: `leave-request-${leave.id}`,
        severity: "warning",
        title: "Take-leave request",
        detail: `${profileMap.get(leave.user_id) || "Staff"} · ${leave.date_from}${leave.date_to !== leave.date_from ? ` to ${leave.date_to}` : ""} · ${leave.leave_type || "leave"}`,
        link: "/staff-operations?tab=leave"
      });
    }

    const today = localIsoDate();
    const branchId = allBranches && ["owner", "admin"].includes(role) ? null : profile.branch_id || null;
    const { data: report, error: reportError } = await supabase.rpc("get_attendance_report", {
      p_date_from: today,
      p_date_to: today,
      p_user_id: null,
      p_branch_id: branchId
    });
    if (reportError) throw reportError;
    const absentRows = (report?.rows || []).filter((row) => row.attendance_status === "absent" && row.user_id !== profile.id);
    if (absentRows.length) {
      const names = absentRows.slice(0, 4).map((row) => row.full_name).join(", ");
      alerts.push({
        key: `attendance-absent-${today}-${branchId || "all"}`,
        severity: "danger",
        title: `${absentRows.length} staff absent today`,
        detail: `${names}${absentRows.length > 4 ? ` and ${absentRows.length - 4} more` : ""}`,
        link: "/staff-operations?tab=attendance"
      });
    }
  } else {
    const recentSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("staff_leave_requests")
      .select("id,date_from,date_to,leave_type,status,review_note,updated_at")
      .eq("organization_id", profile.organization_id)
      .eq("user_id", profile.id)
      .in("status", ["approved", "rejected"])
      .gte("updated_at", recentSince)
      .order("updated_at", { ascending: false })
      .limit(4);
    if (error) throw error;
    for (const leave of data || []) {
      alerts.push({
        key: `leave-result-${leave.id}-${leave.status}`,
        severity: leave.status === "approved" ? "success" : "danger",
        title: leave.status === "approved" ? "Leave approved" : "Leave rejected",
        detail: `${leave.date_from}${leave.date_to !== leave.date_from ? ` to ${leave.date_to}` : ""}${leave.review_note ? ` · ${leave.review_note}` : ""}`,
        link: "/staff-operations?tab=leave"
      });
    }
  }

  return alerts;
}


async function loadOnlineOrderAlerts(
  supabase,
  profile,
  allBranches,
  canReceiveOnlineOrders
) {
  if (!profile?.organization_id || !canReceiveOnlineOrders) return [];

  let query = supabase
    .from("online_orders")
    .select(`
      id,
      branch_id,
      order_number,
      status,
      payment_status,
      payment_method,
      fulfilment_type,
      currency,
      customer_name,
      customer_phone,
      total_amount,
      bank_slip_url,
      created_at,
      branches(name)
    `)
    .eq("organization_id", profile.organization_id)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(12);

  query = branchScoped(query, profile, allBranches);
  const { data, error } = await query;
  if (error) throw error;

  return (data || []).map((order) => ({
    key: `online-order-${order.id}`,
    severity: order.payment_method === "bank_transfer" ? "warning" : "info",
    title: `Online order ${order.order_number}`,
    detail: [
      order.customer_name,
      order.customer_phone,
      order.fulfilment_type === "delivery" ? "Delivery" : "Pickup",
      order.payment_method === "bank_transfer"
        ? (order.bank_slip_url ? "Bank slip attached" : "Bank slip missing")
        : String(order.payment_method || "").replaceAll("_", " "),
      order.branches?.name
    ].filter(Boolean).join(" · "),
    amount: order.total_amount,
    currency: order.currency,
    link: "/online-store?tab=orders&status=pending"
  }));
}

export async function loadDashboardActionCenter(
  supabase,
  allBranches = false,
  context = {}
) {
  const { data, error } = await supabase.rpc(
    "get_dashboard_action_center",
    { p_all_branches: Boolean(allBranches) }
  );

  if (error) throw error;

  const profile = context.profile;
  if (!profile) return data;

  const [approvalAlerts, attendanceAlerts, onlineOrderAlerts] = await Promise.all([
    loadApprovalAlerts(supabase, profile, allBranches, Boolean(context.canReviewApprovals)),
    loadLeaveAndAbsenceAlerts(supabase, profile, allBranches, Boolean(context.canManageAttendance)),
    loadOnlineOrderAlerts(supabase, profile, allBranches, Boolean(context.canReceiveOnlineOrders))
  ]);

  return {
    ...(data || {}),
    alerts: uniqueAlerts([
      ...approvalAlerts,
      ...attendanceAlerts,
      ...onlineOrderAlerts,
      ...((data?.alerts || []))
    ])
  };
}

export function dashboardDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function dashboardDay(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short"
  }).format(new Date(`${value}T00:00:00`));
}

export function dashboardPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "No previous-month comparison";
  }

  const sign = number > 0 ? "+" : "";

  return `${sign}${number.toLocaleString("en-US", {
    maximumFractionDigits: 1
  })}% vs previous month`;
}

export function paymentMethodLabel(method) {
  const labels = {
    cash: "Cash",
    bank: "Bank",
    khqr: "KHQR",
    card: "Card",
    other: "Other"
  };

  return labels[method] || String(method || "Other");
}
