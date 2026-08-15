import { optimizeImageFile } from "./media";

import { printHtmlDocument } from "./listDocuments";

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

export function isoDate(value = new Date()) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

export function monthRange(value = new Date()) {
  const source = typeof value === "string" && /^\d{4}-\d{2}/.test(value)
    ? value.slice(0, 7)
    : `${new Date(value).getFullYear()}-${padDatePart(new Date(value).getMonth() + 1)}`;
  const [year, month] = source.split("-").map(Number);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${padDatePart(month)}-01`,
    end: `${year}-${padDatePart(month)}-${padDatePart(lastDay)}`
  };
}

export function staffDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function staffTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function durationLabel(minutes) {
  const total = Math.max(0, Number(minutes || 0));
  const hours = Math.floor(total / 60);
  const remainder = Math.round(total % 60);
  if (!hours) return `${remainder} min`;
  return `${hours} hr ${remainder} min`;
}

export function commissionMoney(value, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KHR" ? 0 : 2
  }).format(Number(value || 0));
}

export function attendanceStatusLabel(value) {
  const labels = {
    on_time: "On time",
    late: "Late",
    overtime: "Overtime",
    late_overtime: "Late + overtime",
    open: "Checked in",
    absent: "Absent",
    day_off: "Day off",
    worked_day_off: "Worked on day off",
    leave: "Approved leave",
    scheduled: "Scheduled"
  };
  return labels[value] || String(value || "—").replaceAll("_", " ");
}

export function leaveStatusLabel(value) {
  const labels = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    cancelled: "Cancelled"
  };
  return labels[value] || String(value || "—");
}

export async function getMyAttendanceStatus(supabase) {
  const { data, error } = await supabase.rpc("get_my_attendance_status");
  if (error) throw error;
  return data;
}

export async function attendanceCheckIn(supabase, branchId, note = "", location = {}) {
  const { data, error } = await supabase.rpc("attendance_check_in_v2", {
    p_branch_id: branchId || null,
    p_note: note || null,
    p_latitude: location.latitude ?? null,
    p_longitude: location.longitude ?? null,
    p_accuracy_m: location.accuracy ?? null
  });
  if (error) throw error;
  return data;
}

export async function attendanceCheckOut(supabase, note = "", location = {}) {
  const { data, error } = await supabase.rpc("attendance_check_out_v2", {
    p_note: note || null,
    p_latitude: location.latitude ?? null,
    p_longitude: location.longitude ?? null,
    p_accuracy_m: location.accuracy ?? null
  });
  if (error) throw error;
  return data;
}

export async function correctAttendance(supabase, values) {
  const { data, error } = await supabase.rpc("correct_attendance_session", {
    p_session_id: values.id,
    p_check_in_at: values.check_in_at,
    p_check_out_at: values.check_out_at || null,
    p_correction_note: values.correction_note
  });
  if (error) throw error;
  return data;
}

export async function saveManualAttendance(supabase, values) {
  const { data, error } = await supabase.rpc("save_manual_attendance_days", {
    p_user_id: values.user_id,
    p_branch_id: values.branch_id,
    p_month: values.month,
    p_days: values.days.map(Number),
    p_day_type: values.day_type,
    p_check_in_time: values.day_type === "work" ? values.check_in_time : null,
    p_check_out_time: values.day_type === "work" ? values.check_out_time : null,
    p_note: String(values.note || "").trim() || null
  });
  if (error) throw error;
  return data;
}

export async function saveCommissionPlan(supabase, values) {
  const { data, error } = await supabase.rpc("save_commission_plan", {
    p_plan_id: values.id || null,
    p_user_id: values.user_id,
    p_branch_id: values.branch_id || null,
    p_name: values.name,
    p_currency: values.currency,
    p_base_type: values.base_type,
    p_rate_percent: Number(values.rate_percent || 0),
    p_fixed_per_sale: Number(values.fixed_per_sale || 0),
    p_effective_from: values.effective_from,
    p_effective_to: values.effective_to || null,
    p_is_active: Boolean(values.is_active),
    p_notes: values.notes || null
  });
  if (error) throw error;
  return data;
}

export async function recordCommissionPayout(supabase, values) {
  const { data, error } = await supabase.rpc("record_commission_payout", {
    p_user_id: values.user_id,
    p_branch_id: values.branch_id,
    p_currency: values.currency,
    p_period_start: values.period_start,
    p_period_end: values.period_end,
    p_amount: Number(values.amount || 0),
    p_payment_method: values.payment_method,
    p_reference_number: values.reference_number || null,
    p_notes: values.notes || null
  });
  if (error) throw error;
  return data;
}

async function uploadLeaveImage(session, file) {
  if (!file) return { image_url: null, image_public_id: null };
  if (!session?.access_token) throw new Error("Authentication required for image upload.");

  const optimizedFile = await optimizeImageFile(file, {
    maxWidth: 1200,
    maxHeight: 1200,
    quality: 0.82,
    baseName: "leave-attachment"
  });

  const signatureResponse = await fetch("/api/staff-file-signature", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ purpose: "leave-request" })
  });
  const signed = await signatureResponse.json().catch(() => ({}));
  if (!signatureResponse.ok || !signed.ok) {
    throw new Error(signed.error || "Could not prepare the leave image upload.");
  }

  const form = new FormData();
  form.append("file", optimizedFile);
  form.append("api_key", signed.apiKey);
  form.append("timestamp", String(signed.timestamp));
  form.append("folder", signed.folder);
  form.append("public_id", signed.publicId);
  form.append("signature", signed.signature);

  const uploadResponse = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(signed.cloudName)}/image/upload`,
    { method: "POST", body: form }
  );
  const uploaded = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !uploaded.secure_url) {
    throw new Error(uploaded.error?.message || "Could not upload the leave image.");
  }

  return {
    image_url: uploaded.secure_url,
    image_public_id: uploaded.public_id
  };
}

export async function submitLeaveRequest(supabase, session, values) {
  const image = await uploadLeaveImage(session, values.file);
  const { data, error } = await supabase.rpc("submit_my_leave_request", {
    p_date_from: values.date_from,
    p_date_to: values.date_to,
    p_leave_type: values.leave_type,
    p_reason: values.reason,
    p_image_url: image.image_url,
    p_image_public_id: image.image_public_id
  });
  if (error) throw error;
  return data;
}

export async function reviewLeaveRequest(supabase, requestId, status, reviewNote = "") {
  const { data, error } = await supabase.rpc("review_leave_request", {
    p_request_id: requestId,
    p_status: status,
    p_review_note: String(reviewNote || "").trim() || null
  });
  if (error) throw error;
  return data;
}

export async function cancelLeaveRequest(supabase, requestId) {
  const { data, error } = await supabase.rpc("cancel_my_leave_request", {
    p_request_id: requestId
  });
  if (error) throw error;
  return data;
}

function cellValue(column, row) {
  return typeof column.value === "function"
    ? column.value(row)
    : row[column.value];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function printStaffReport({
  title,
  subtitle = "",
  summary = [],
  columns,
  rows,
  orientation = "landscape"
}) {
  const summaryHtml = summary.length
    ? `<section class="print-summary">${summary.map((item) => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join("")}</section>`
    : "";
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = rows.length
    ? rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(cellValue(column, row))}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${columns.length}">No records in the selected period.</td></tr>`;

  printHtmlDocument({
    title,
    page: `A4 ${orientation}`,
    html: `
      <section class="tiny-pos-staff-print-document">
        <header class="print-report-header">
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(subtitle)}</p>
        </header>
        ${summaryHtml}
        <table class="print-report-table">
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </section>`,
    styles: `
      .tiny-pos-print-frame-content{padding:3mm;font-size:9px}
      .print-report-header{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;border-bottom:2px solid #111;padding-bottom:8px}
      .print-report-header h1{margin:0;font-size:20px}.print-report-header p{margin:0;color:#555;text-align:right}
      .print-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:9px 0}
      .print-summary>div{padding:6px 8px;border:1px solid #bbb;display:grid;gap:2px;break-inside:avoid}
      .print-summary span{font-size:8px;color:#555;text-transform:uppercase}.print-summary strong{font-size:11px}
      .print-report-table{width:100%;border-collapse:collapse;table-layout:auto}
      .print-report-table th,.print-report-table td{padding:4px 5px;border:1px solid #888;text-align:left;vertical-align:top;font-size:8px;overflow-wrap:anywhere}
      .print-report-table th{background:#eaf2f8!important;font-weight:800}.print-report-table thead{display:table-header-group}.print-report-table tr{break-inside:avoid}
      ${columns.length > 18 ? '.print-report-table{table-layout:fixed}.print-report-table th,.print-report-table td{padding:2px;font-size:6px;text-align:center}.print-summary{grid-template-columns:repeat(2,minmax(0,1fr))}' : ''}
    `
  });
}

function columnWidth(column, rows) {
  if (Number(column.width) > 0) return Number(column.width);
  let length = String(column.label || "").length;
  for (const row of rows.slice(0, 300)) {
    length = Math.max(length, String(cellValue(column, row) ?? "").length);
  }
  return Math.min(260, Math.max(70, length * 7.2 + 18));
}

export function downloadStaffExcel(filename, columns, rows, summary = [], title = "Tiny POS Report") {
  const summaryRows = summary.map((item) => `
    <Row>
      <Cell ss:StyleID="SummaryLabel"><Data ss:Type="String">${escapeXml(item.label)}</Data></Cell>
      <Cell ss:StyleID="SummaryValue"><Data ss:Type="String">${escapeXml(item.value)}</Data></Cell>
    </Row>`).join("");
  const columnsXml = columns.map((column) => `<Column ss:AutoFitWidth="0" ss:Width="${columnWidth(column, rows).toFixed(0)}"/>`).join("");
  const header = columns.map((column) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(column.label)}</Data></Cell>`).join("");
  const body = rows.map((row) => `<Row>${columns.map((column) => `<Cell ss:StyleID="Body"><Data ss:Type="String">${escapeXml(cellValue(column, row))}</Data></Cell>`).join("")}</Row>`).join("");

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
  <Style ss:ID="Title"><Font ss:Bold="1" ss:Size="16"/><Alignment ss:WrapText="1"/></Style>
  <Style ss:ID="SummaryLabel"><Font ss:Bold="1"/><Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="SummaryValue"><Alignment ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2563EB" ss:Pattern="Solid"/><Alignment ss:WrapText="1" ss:Horizontal="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="Body"><Alignment ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/></Borders></Style>
 </Styles>
 <Worksheet ss:Name="Report">
  <Table>
   ${columnsXml}
   <Row><Cell ss:MergeAcross="${Math.max(0, columns.length - 1)}" ss:StyleID="Title"><Data ss:Type="String">${escapeXml(title)}</Data></Cell></Row>
   ${summaryRows}
   ${summary.length ? "<Row/>" : ""}
   <Row>${header}</Row>
   ${body}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>
 </Worksheet>
</Workbook>`;

  const blob = new Blob(["\ufeff", xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildDayOffMatrix(attendanceRows, staffRows, dateFrom, dateTo) {
  const dates = [];
  const first = new Date(`${dateFrom}T00:00:00Z`);
  const last = new Date(`${dateTo}T00:00:00Z`);
  for (let value = first; value <= last; value.setUTCDate(value.getUTCDate() + 1)) {
    dates.push(value.toISOString().slice(0, 10));
  }
  const byStaffDate = new Map(attendanceRows.map((row) => [`${row.user_id}:${row.business_date}`, row]));
  const rows = staffRows.map((staff, index) => {
    const row = {
      number: index + 1,
      system_id: String(staff.id || "").slice(0, 8),
      full_name: staff.full_name,
      position: staff.role
    };
    for (const date of dates) {
      const attendance = byStaffDate.get(`${staff.id}:${date}`);
      const status = attendance?.attendance_status;
      row[date] = status === "day_off" || status === "worked_day_off"
        ? "Day Off"
        : status === "leave"
          ? "Approved Leave"
          : status === "absent"
            ? "Absent"
            : "Working day";
    }
    return row;
  });
  return {
    columns: [
      { label: "No", value: "number", width: 42 },
      { label: "System ID", value: "system_id", width: 76 },
      { label: "Employee Name", value: "full_name", width: 145 },
      { label: "Position", value: "position", width: 105 },
      ...dates.map((date) => ({ label: String(Number(date.slice(8, 10))), value: date, width: 50 }))
    ],
    rows
  };
}

export async function loadStaffOperations(supabase, profile, access, filters) {
  const permissions = access?.permissions || {};
  const canManageAttendance = Boolean(permissions["*"] || permissions["attendance.manage"]);
  const canManageCommissions = Boolean(permissions["*"] || permissions["commissions.manage"]);
  const canManageLeave = Boolean(permissions["*"] || permissions["leave.manage"] || permissions["attendance.manage"]);
  const userId = canManageAttendance || canManageCommissions || canManageLeave
    ? filters.user_id || null
    : profile.id;
  const branchId = filters.branch_id || null;

  let attendanceQuery = supabase
    .from("attendance_sessions")
    .select(`
      *,
      profiles!attendance_sessions_user_id_fkey(id,full_name,role),
      branches(id,name,code)
    `)
    .gte("business_date", filters.date_from)
    .lte("business_date", filters.date_to)
    .order("check_in_at", { ascending: false })
    .limit(1000);
  if (userId) attendanceQuery = attendanceQuery.eq("user_id", userId);
  if (branchId) attendanceQuery = attendanceQuery.eq("branch_id", branchId);

  let commissionQuery = supabase
    .from("sales_commissions")
    .select(`
      *,
      profiles!sales_commissions_cashier_id_fkey(id,full_name,role),
      branches(id,name,code),
      sales(invoice_number,total_amount,status)
    `)
    .gte("sale_completed_at", `${filters.date_from}T00:00:00`)
    .lte("sale_completed_at", `${filters.date_to}T23:59:59.999`)
    .order("sale_completed_at", { ascending: false })
    .limit(2000);
  if (userId) commissionQuery = commissionQuery.eq("cashier_id", userId);
  if (branchId) commissionQuery = commissionQuery.eq("branch_id", branchId);

  let payoutQuery = supabase
    .from("commission_payouts")
    .select(`
      *,
      profiles!commission_payouts_user_id_fkey(id,full_name,role),
      branches(id,name,code)
    `)
    .gte("period_start", filters.date_from)
    .lte("period_end", filters.date_to)
    .order("paid_at", { ascending: false })
    .limit(1000);
  if (userId) payoutQuery = payoutQuery.eq("user_id", userId);
  if (branchId) payoutQuery = payoutQuery.eq("branch_id", branchId);

  let leaveQuery = supabase
    .from("staff_leave_requests")
    .select(`
      *,
      profiles!staff_leave_requests_user_id_fkey(id,full_name,role,branch_id),
      branches(id,name,code),
      reviewer:profiles!staff_leave_requests_reviewed_by_fkey(id,full_name)
    `)
    .lte("date_from", filters.date_to)
    .gte("date_to", filters.date_from)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (userId) leaveQuery = leaveQuery.eq("user_id", userId);
  if (branchId) leaveQuery = leaveQuery.eq("branch_id", branchId);

  const attendanceReportRequest = supabase.rpc("get_attendance_report", {
    p_date_from: filters.date_from,
    p_date_to: filters.date_to,
    p_branch_id: canManageAttendance ? branchId : null,
    p_user_id: userId
  });

  const [
    statusResult,
    attendanceResult,
    attendanceReportResult,
    commissionResult,
    payoutResult,
    planResult,
    staffResult,
    branchResult,
    leaveResult
  ] = await Promise.all([
    getMyAttendanceStatus(supabase),
    attendanceQuery,
    attendanceReportRequest,
    commissionQuery,
    payoutQuery,
    canManageCommissions
      ? supabase.from("commission_plans").select(`*,profiles!commission_plans_user_id_fkey(id,full_name,role),branches(id,name,code)`).order("created_at", { ascending: false })
      : supabase.from("commission_plans").select(`*,branches(id,name,code)`).eq("user_id", profile.id).order("created_at", { ascending: false }),
    (canManageAttendance || canManageCommissions || canManageLeave)
      ? supabase.from("profiles").select("id,full_name,role,branch_id,is_active").eq("organization_id", profile.organization_id).eq("is_active", true).order("full_name")
      : Promise.resolve({ data: [profile], error: null }),
    supabase.from("branches").select("id,name,code,is_active,latitude,longitude,attendance_radius_m,attendance_geofence_required").eq("organization_id", profile.organization_id).eq("is_active", true).order("name"),
    leaveQuery
  ]);

  for (const result of [
    attendanceResult,
    attendanceReportResult,
    commissionResult,
    payoutResult,
    planResult,
    staffResult,
    branchResult,
    leaveResult
  ]) {
    if (result.error) throw result.error;
  }

  return {
    status: statusResult,
    attendance: attendanceResult.data || [],
    attendanceReport: attendanceReportResult.data || { rows: [], summary: [], settings: {} },
    commissions: commissionResult.data || [],
    payouts: payoutResult.data || [],
    plans: planResult.data || [],
    staff: staffResult.data || [],
    branches: branchResult.data || [],
    leaveRequests: leaveResult.data || []
  };
}
