import {
  BadgeDollarSign,
  CalendarDays,
  CalendarPlus,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  FileSpreadsheet,
  Image as ImageIcon,
  LogIn,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Send,
  Umbrella,
  WalletCards,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import AttendanceCorrectionModal from "../components/AttendanceCorrectionModal";
import CommissionPlanModal from "../components/CommissionPlanModal";
import CommissionPayoutModal from "../components/CommissionPayoutModal";
import LeaveRequestModal from "../components/LeaveRequestModal";
import MediaImage from "../components/MediaImage";
import MediaPreviewModal from "../components/MediaPreviewModal";
import ManualAttendanceModal from "../components/ManualAttendanceModal";
import DateRangePresetFields from "../components/DateRangePresetFields";
import ResponsiveDataList from "../components/ResponsiveDataList";
import {
  attendanceCheckIn,
  attendanceCheckOut,
  attendanceStatusLabel,
  buildDayOffMatrix,
  cancelLeaveRequest,
  commissionMoney,
  correctAttendance,
  downloadStaffExcel,
  durationLabel,
  isoDate,
  leaveStatusLabel,
  loadStaffOperations,
  monthRange,
  printStaffReport,
  recordCommissionPayout,
  reviewLeaveRequest,
  saveCommissionPlan,
  saveManualAttendance,
  staffDateTime,
  staffTime,
  submitLeaveRequest
} from "../lib/staffOperations";
import { notifyTelegramEvent } from "../lib/telegram";

function currentPosition() {
  if (!navigator.geolocation) {
    return Promise.reject(new Error("This device does not support location. Attendance check-in requires branch location verification."));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      }),
      (error) => reject(new Error(
        error.code === 1
          ? "Location permission was denied. Allow precise location for Tiny POS and try again."
          : "Your location could not be verified. Move near the branch and try again."
      )),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
    );
  });
}

const attendanceColumns = [
  { label: "Date", value: "business_date" },
  { label: "Day", value: "weekday_name" },
  { label: "Staff", value: "full_name" },
  { label: "Role", value: "role" },
  { label: "Branch", value: (row) => row.branch_name || "—" },
  { label: "Check-in", value: (row) => staffTime(row.check_in_at) },
  { label: "Check-out", value: (row) => staffTime(row.check_out_at) },
  { label: "Status", value: (row) => attendanceStatusLabel(row.attendance_status) },
  { label: "Late", value: (row) => durationLabel(row.late_minutes) },
  { label: "Overtime", value: (row) => durationLabel(row.overtime_minutes) },
  { label: "Worked", value: (row) => durationLabel(row.total_minutes) },
  { label: "Note", value: (row) => row.note || "" }
];

const leaveColumns = [
  { label: "Requested", value: (row) => staffDateTime(row.created_at) },
  { label: "Staff", value: (row) => row.profiles?.full_name || "—" },
  { label: "Role", value: (row) => row.profiles?.role || "—" },
  { label: "Branch", value: (row) => row.branches?.name || "—" },
  { label: "From", value: "date_from" },
  { label: "To", value: "date_to" },
  { label: "Type", value: (row) => String(row.leave_type || "").replaceAll("_", " ") },
  { label: "Reason", value: "reason" },
  { label: "Status", value: (row) => leaveStatusLabel(row.status) },
  { label: "Reviewed by", value: (row) => row.reviewer?.full_name || "—" },
  { label: "Review note", value: (row) => row.review_note || "" },
  { label: "Picture", value: (row) => row.image_url ? "Attached" : "—" }
];

const commissionColumns = [
  { label: "Date", value: (row) => staffDateTime(row.sale_completed_at) },
  { label: "Staff", value: (row) => row.profiles?.full_name || "—" },
  { label: "Invoice", value: (row) => row.sales?.invoice_number || "—" },
  { label: "Branch", value: (row) => row.branches?.name || "—" },
  { label: "Currency", value: "currency" },
  { label: "Base", value: "commissionable_amount" },
  { label: "Rate %", value: (row) => Number(row.rate_percent || 0).toFixed(2) },
  { label: "Fixed", value: "fixed_per_sale" },
  { label: "Refund", value: "refunded_amount" },
  { label: "Commission", value: "commission_amount" },
  { label: "Status", value: "status" }
];

function initialTab() {
  const value = new URLSearchParams(window.location.search).get("tab");
  return ["attendance", "dayoff", "leave", "commission", "plans"].includes(value)
    ? value
    : "attendance";
}

function PageSizeControl({ value, onChange }) {
  return (
    <label className="staff-page-size">
      <span>Rows</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {[30, 60, 90, 120].map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
  );
}

function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="staff-pagination">
      <button type="button" className="secondary-button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page <strong>{page}</strong> of <strong>{pages}</strong></span>
      <button type="button" className="secondary-button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </div>
  );
}

export default function StaffOperationsPage() {
  const { supabase, session, profile, access, can } = useAuth();
  const today = useMemo(() => isoDate(), []);
  const [filters, setFilters] = useState({
    date_from: today,
    date_to: today,
    branch_id: "",
    user_id: ""
  });
  const [workspace, setWorkspace] = useState({
    status: null,
    attendance: [],
    attendanceReport: { rows: [], summary: [], settings: {} },
    commissions: [],
    payouts: [],
    plans: [],
    staff: [],
    branches: [],
    leaveRequests: []
  });
  const [tab, setTab] = useState(initialTab);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState(null);
  const [manualAttendance, setManualAttendance] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [plan, setPlan] = useState(undefined);
  const [payout, setPayout] = useState(false);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);

  const canManageAttendance = can("attendance.manage");
  const canManageCommissions = can("commissions.manage");
  const canPayCommissions = can("commissions.pay");
  const canViewCommission = can("commissions.view_self") || canManageCommissions;
  const canRequestLeave = can("leave.request") || can("staff_operations.self") || canManageAttendance;
  const canManageLeave = can("leave.manage") || canManageAttendance;

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.id) return;
    try {
      setLoading(true);
      setWorkspace(await loadStaffOperations(supabase, profile, access, filters));
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, access, filters]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setPage(1); }, [tab, pageSize, filters]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1" && canRequestLeave) setLeaveOpen(true);
  }, [canRequestLeave]);

  const totals = useMemo(() => {
    const earned = { USD: 0, KHR: 0 };
    const paid = { USD: 0, KHR: 0 };
    for (const row of workspace.commissions) earned[row.currency] += Number(row.commission_amount || 0);
    for (const row of workspace.payouts) paid[row.currency] += Number(row.amount || 0);
    return {
      earned,
      paid,
      outstanding: {
        USD: Math.max(0, earned.USD - paid.USD),
        KHR: Math.max(0, earned.KHR - paid.KHR)
      }
    };
  }, [workspace.commissions, workspace.payouts]);

  const attendanceRows = workspace.attendanceReport?.rows || [];
  const dayOffRows = attendanceRows.filter((row) => ["day_off", "worked_day_off", "leave"].includes(row.attendance_status));
  const reportSummary = workspace.attendanceReport?.summary || [];
  const attendanceTotals = useMemo(() => reportSummary.reduce((total, row) => ({
    calendar_days: total.calendar_days + Number(row.calendar_days || 0),
    present_days: total.present_days + Number(row.present_days || 0),
    on_time_days: total.on_time_days + Number(row.on_time_days || 0),
    late_days: total.late_days + Number(row.late_days || 0),
    overtime_days: total.overtime_days + Number(row.overtime_days || 0),
    absent_days: total.absent_days + Number(row.absent_days || 0),
    day_off_days: total.day_off_days + Number(row.day_off_days || 0),
    leave_days: total.leave_days + Number(row.leave_days || 0),
    work_minutes: total.work_minutes + Number(row.work_minutes || 0),
    overtime_minutes: total.overtime_minutes + Number(row.overtime_minutes || 0),
    late_minutes: total.late_minutes + Number(row.late_minutes || 0)
  }), {
    calendar_days: 0,
    present_days: 0,
    on_time_days: 0,
    late_days: 0,
    overtime_days: 0,
    absent_days: 0,
    day_off_days: 0,
    leave_days: 0,
    work_minutes: 0,
    overtime_minutes: 0,
    late_minutes: 0
  }), [reportSummary]);

  const leaveTotals = useMemo(() => workspace.leaveRequests.reduce((result, row) => {
    result[row.status] = Number(result[row.status] || 0) + 1;
    return result;
  }, { pending: 0, approved: 0, rejected: 0, cancelled: 0 }), [workspace.leaveRequests]);

  const selectedStaff = workspace.staff.find((row) => row.id === filters.user_id);
  const selectedBranch = workspace.branches.find((row) => row.id === filters.branch_id);
  const selectionText = `${selectedStaff?.full_name || (canManageAttendance || canManageLeave ? "All staff" : profile?.full_name)} · ${selectedBranch?.name || "All accessible branches"} · ${filters.date_from} to ${filters.date_to}`;

  const attendancePrintSummary = [
    { label: "Selected filters", value: selectionText },
    { label: "Present", value: attendanceTotals.present_days },
    { label: "On time", value: attendanceTotals.on_time_days },
    { label: "Late", value: attendanceTotals.late_days },
    { label: "Overtime", value: attendanceTotals.overtime_days },
    { label: "Absent", value: attendanceTotals.absent_days },
    { label: "Day off", value: attendanceTotals.day_off_days },
    { label: "Approved leave", value: attendanceTotals.leave_days },
    { label: "Worked", value: durationLabel(attendanceTotals.work_minutes) },
    { label: "Late time", value: durationLabel(attendanceTotals.late_minutes) },
    { label: "OT time", value: durationLabel(attendanceTotals.overtime_minutes) }
  ];

  const availableStaffForMatrix = useMemo(() => workspace.staff.filter((row) =>
    (!filters.user_id || row.id === filters.user_id)
    && (!filters.branch_id || row.branch_id === filters.branch_id)
  ), [workspace.staff, filters.user_id, filters.branch_id]);
  const dayOffMatrix = useMemo(() => buildDayOffMatrix(
    attendanceRows,
    availableStaffForMatrix,
    filters.date_from,
    filters.date_to
  ), [attendanceRows, availableStaffForMatrix, filters.date_from, filters.date_to]);

  const allRows = tab === "attendance"
    ? attendanceRows
    : tab === "dayoff"
      ? dayOffRows
      : tab === "leave"
        ? workspace.leaveRequests
        : tab === "commission"
          ? workspace.commissions
          : [];
  const pagedRows = allRows.slice((page - 1) * pageSize, page * pageSize);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function selectTab(next) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    url.searchParams.delete("new");
    window.history.replaceState({}, "", url);
  }

  function showDayOffList() {
    const range = monthRange(filters.date_from);
    setFilters((current) => ({ ...current, date_from: range.start, date_to: range.end }));
    selectTab("dayoff");
  }

  async function check(action) {
    try {
      setBusy(action);
      const branch = workspace.branches.find((row) => row.id === profile.branch_id) || profile.branches;
      const location = branch?.attendance_geofence_required === false ? {} : await currentPosition();
      if (action === "check-in") await attendanceCheckIn(supabase, profile.branch_id, note, location);
      else await attendanceCheckOut(supabase, note, location);
      setNote("");
      announce("success", action === "check-in" ? "Checked in at the branch successfully." : "Checked out successfully.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function saveCorrection(values) {
    try {
      setBusy("correction");
      await correctAttendance(supabase, values);
      setCorrection(null);
      announce("success", "Attendance correction saved.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function saveManual(values) {
    try {
      setBusy("manual-attendance");
      const result = await saveManualAttendance(supabase, values);
      setManualAttendance(false);
      announce("success", `${result.saved_days} attendance day${Number(result.saved_days) === 1 ? "" : "s"} saved.`);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function saveLeave(values) {
    try {
      setBusy("leave");
      const result = await submitLeaveRequest(supabase, session, values);
      setLeaveOpen(false);
      selectTab("leave");
      announce("success", "Leave request submitted and waiting for manager approval.");
      void notifyTelegramEvent(session, "leave_requested", result.id);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function reviewLeave(row, status) {
    const label = status === "approved" ? "approve" : "reject";
    if (!window.confirm(`${label[0].toUpperCase()}${label.slice(1)} ${row.profiles?.full_name}'s leave request?`)) return;
    const reviewNote = window.prompt("Review note (optional):", "") || "";
    try {
      setBusy(`leave-${row.id}`);
      const result = await reviewLeaveRequest(supabase, row.id, status, reviewNote);
      announce("success", `Leave request ${status}.`);
      void notifyTelegramEvent(session, `leave_${status}`, result.id);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function cancelLeave(row) {
    if (!window.confirm("Cancel this pending leave request?")) return;
    try {
      setBusy(`leave-${row.id}`);
      const result = await cancelLeaveRequest(supabase, row.id);
      announce("success", "Leave request cancelled.");
      void notifyTelegramEvent(session, "leave_cancelled", result.id);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function savePlan(values) {
    try {
      setBusy("plan");
      await saveCommissionPlan(supabase, values);
      setPlan(undefined);
      announce("success", "Commission plan saved and matching sales recalculated.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function savePayout(values) {
    try {
      setBusy("payout");
      await recordCommissionPayout(supabase, values);
      setPayout(false);
      announce("success", "Commission payout recorded.");
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  function reportDefinition() {
    if (tab === "commission") {
      return {
        title: "Sales Commission Report",
        columns: commissionColumns,
        rows: workspace.commissions,
        summary: [
          { label: "Selected filters", value: selectionText },
          { label: "Earned USD", value: commissionMoney(totals.earned.USD, "USD") },
          { label: "Paid USD", value: commissionMoney(totals.paid.USD, "USD") },
          { label: "Outstanding USD", value: commissionMoney(totals.outstanding.USD, "USD") },
          { label: "Earned KHR", value: commissionMoney(totals.earned.KHR, "KHR") },
          { label: "Paid KHR", value: commissionMoney(totals.paid.KHR, "KHR") },
          { label: "Outstanding KHR", value: commissionMoney(totals.outstanding.KHR, "KHR") }
        ],
        filename: `commission-${filters.date_from}-${filters.date_to}.xls`
      };
    }
    if (tab === "leave") {
      return {
        title: "Staff Take Leave Requests",
        columns: leaveColumns,
        rows: workspace.leaveRequests,
        summary: [
          { label: "Selected filters", value: selectionText },
          { label: "Pending", value: leaveTotals.pending },
          { label: "Approved", value: leaveTotals.approved },
          { label: "Rejected", value: leaveTotals.rejected },
          { label: "Cancelled", value: leaveTotals.cancelled }
        ],
        filename: `take-leave-${filters.date_from}-${filters.date_to}.xls`
      };
    }
    if (tab === "dayoff") {
      return {
        title: "Employee Day-Off Schedule",
        columns: dayOffMatrix.columns,
        rows: dayOffMatrix.rows,
        summary: [
          { label: "Selected filters", value: selectionText },
          { label: "Purpose", value: "Manager-set Day-Off schedule and approved leave; separate from pending Take Leave requests." }
        ],
        filename: `day-off-list-${filters.date_from}-${filters.date_to}.xls`
      };
    }
    return {
      title: "Daily Attendance Report",
      columns: attendanceColumns,
      rows: attendanceRows,
      summary: attendancePrintSummary,
      filename: `attendance-${filters.date_from}-${filters.date_to}.xls`
    };
  }

  function printCurrent() {
    const report = reportDefinition();
    printStaffReport({ ...report, subtitle: selectionText, orientation: "landscape" });
  }

  function exportCurrent() {
    const report = reportDefinition();
    downloadStaffExcel(report.filename, report.columns, report.rows, report.summary, report.title);
  }

  function openCorrection(row) {
    if (!row.session_id) return;
    const record = workspace.attendance.find((item) => item.id === row.session_id);
    if (record) setCorrection(record);
  }

  const status = workspace.status;
  const elapsed = status?.elapsed_minutes || 0;
  const printableTab = ["attendance", "dayoff", "leave", "commission"].includes(tab);

  return (
    <div className="page-stack staff-operations-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">STAFF OPERATIONS</p>
          <h1>Attendance & Commission</h1>
          <p className="muted">Daily attendance, manager day-off schedules, staff leave requests and commission reports.</p>
        </div>
        <div className="page-heading-actions">
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading}>
            <RefreshCw size={18} className={loading ? "spin" : ""} />Refresh
          </button>
        </div>
      </div>

      {message && <div className={`notice ${messageType}`}>{message}</div>}

      <section className={`attendance-clock-card ${status?.checked_in ? "active" : ""}`}>
        <div className="attendance-clock-icon">{status?.checked_in ? <CheckCircle2 size={30} /> : <Clock3 size={30} />}</div>
        <div className="attendance-clock-copy">
          <span>{status?.checked_in ? "Currently checked in" : "Not checked in"}</span>
          <strong>{status?.checked_in ? durationLabel(elapsed) : profile?.branches?.name || "Assigned branch"}</strong>
          <small>{status?.checked_in ? `Since ${staffDateTime(status.session?.check_in_at)}` : "Check-in verifies that this device is inside the branch attendance radius."}</small>
          {profile?.branches?.attendance_geofence_required !== false && (
            <span className="attendance-location-chip"><MapPin size={15} />Branch location required · {profile?.branches?.attendance_radius_m || 150} m</span>
          )}
        </div>
        <label className="attendance-note"><span>Optional note</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Shift or handover note" /></label>
        <button type="button" className={status?.checked_in ? "danger-button" : "primary-button"} disabled={Boolean(busy)} onClick={() => check(status?.checked_in ? "check-out" : "check-in")}>
          {status?.checked_in ? <LogOut size={18} /> : <LogIn size={18} />}
          {busy ? "Saving..." : status?.checked_in ? "Check out" : "Check in"}
        </button>
      </section>

      <div className="staff-tabs" role="tablist">
        <button type="button" className={tab === "attendance" ? "active" : ""} onClick={() => selectTab("attendance")}><CalendarDays size={18} />Attendance</button>
        {canRequestLeave && <button type="button" className={tab === "leave" ? "active" : ""} onClick={() => selectTab("leave")}><Send size={18} />Take Leave</button>}
        <button type="button" className={tab === "dayoff" ? "active" : ""} onClick={() => selectTab("dayoff")}><Umbrella size={18} />Day-Off List</button>
        {canViewCommission && <button type="button" className={tab === "commission" ? "active" : ""} onClick={() => selectTab("commission")}><BadgeDollarSign size={18} />Commission</button>}
        {canManageCommissions && <button type="button" className={tab === "plans" ? "active" : ""} onClick={() => selectTab("plans")}><WalletCards size={18} />Plans & payouts</button>}
      </div>

      <section className="panel staff-filter-panel">
        <div className="staff-filters">
          <DateRangePresetFields
            from={filters.date_from}
            to={filters.date_to}
            onChange={(range) =>
              setFilters((current) => ({
                ...current,
                date_from: range.from,
                date_to: range.to
              }))
            }
          />
          {(canManageAttendance || canManageCommissions || canManageLeave) && (
            <label><span>Branch</span><select value={filters.branch_id} onChange={(event) => setFilters((current) => ({ ...current, branch_id: event.target.value }))}><option value="">Accessible branches</option>{workspace.branches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          )}
          {(canManageAttendance || canManageCommissions || canManageLeave) && (
            <label><span>Staff member</span><select value={filters.user_id} onChange={(event) => setFilters((current) => ({ ...current, user_id: event.target.value }))}><option value="">All staff</option>{workspace.staff.map((row) => <option key={row.id} value={row.id}>{row.full_name}</option>)}</select></label>
          )}
        </div>
        <div className="staff-report-toolbar">
          <span><strong>Selected:</strong> {selectionText}</span>
          <div>
            {canManageAttendance && <button type="button" className="primary-button" onClick={() => setManualAttendance(true)}><CalendarPlus size={18} />Set attendance</button>}
            {canRequestLeave && <button type="button" className="secondary-button" onClick={() => setLeaveOpen(true)}><Send size={18} />Take Leave</button>}
            <button type="button" className="secondary-button" onClick={showDayOffList}><FileSpreadsheet size={18} />Day-Off List</button>
            {printableTab && <button type="button" className="secondary-button" onClick={printCurrent}><Printer size={18} />Print</button>}
            {printableTab && <button type="button" className="secondary-button" onClick={exportCurrent}><Download size={18} />Export Excel</button>}
          </div>
        </div>
      </section>

      {(tab === "attendance" || tab === "dayoff") && (
        <div className="staff-metric-grid attendance-metric-grid">
          <article><span>Present days</span><strong>{attendanceTotals.present_days}</strong></article>
          <article><span>On time</span><strong>{attendanceTotals.on_time_days}</strong></article>
          <article><span>Late</span><strong>{attendanceTotals.late_days}</strong><small>{durationLabel(attendanceTotals.late_minutes)}</small></article>
          <article><span>Overtime</span><strong>{attendanceTotals.overtime_days}</strong><small>{durationLabel(attendanceTotals.overtime_minutes)}</small></article>
          <article><span>Absent</span><strong>{attendanceTotals.absent_days}</strong></article>
          <article><span>Day off</span><strong>{attendanceTotals.day_off_days}</strong></article>
          <article><span>Approved leave</span><strong>{attendanceTotals.leave_days}</strong></article>
          <article><span>Total worked</span><strong>{durationLabel(attendanceTotals.work_minutes)}</strong></article>
        </div>
      )}

      {tab === "leave" && (
        <div className="staff-metric-grid leave-metric-grid">
          <article><span>Pending</span><strong>{leaveTotals.pending}</strong></article>
          <article><span>Approved</span><strong>{leaveTotals.approved}</strong></article>
          <article><span>Rejected</span><strong>{leaveTotals.rejected}</strong></article>
          <article><span>Cancelled</span><strong>{leaveTotals.cancelled}</strong></article>
        </div>
      )}

      {tab === "attendance" && (
        <section className="panel staff-report-panel">
          <div className="panel-title-row">
            <div><p className="eyebrow">DAILY TIMESHEET</p><h2>Daily attendance report</h2><p className="muted">Defaults to the current date and all accessible staff.</p></div>
            <div className="staff-table-tools"><PageSizeControl value={pageSize} onChange={setPageSize} /><span className="status-pill">{attendanceRows.length} staff-days</span></div>
          </div>
          <div className="staff-horizontal-scroll attendance-report-table">
            <table><thead><tr><th>Date</th><th>Staff</th><th>Branch</th><th>Check-in</th><th>Check-out</th><th>Worked</th><th>Late</th><th>Overtime</th><th>Status</th><th>Note</th>{canManageAttendance && <th />}</tr></thead><tbody>
              {pagedRows.map((row) => <tr key={`${row.user_id}-${row.business_date}`}><td><strong>{row.business_date}</strong><small>{row.weekday_name}</small></td><td><strong>{row.full_name}</strong><small>{row.role}</small></td><td>{row.branch_name || "—"}</td><td>{staffTime(row.check_in_at)}<small>{row.check_in_source || "—"}</small></td><td>{staffTime(row.check_out_at)}<small>{row.check_out_source || "—"}</small></td><td>{row.session_id ? durationLabel(row.total_minutes) : "—"}</td><td>{Number(row.late_minutes || 0) ? durationLabel(row.late_minutes) : "—"}</td><td>{Number(row.overtime_minutes || 0) ? durationLabel(row.overtime_minutes) : "—"}</td><td><span className={`status-pill attendance-${row.attendance_status}`}>{attendanceStatusLabel(row.attendance_status)}</span></td><td>{row.note || "—"}</td>{canManageAttendance && <td>{row.session_id && <button type="button" className="icon-button" onClick={() => openCorrection(row)} title="Correct attendance"><Pencil size={17} /></button>}</td>}</tr>)}
              {!pagedRows.length && <tr><td colSpan={canManageAttendance ? 11 : 10} className="empty-table">No attendance days in this period.</td></tr>}
            </tbody></table>
          </div>
          <Pagination page={page} pageSize={pageSize} total={attendanceRows.length} onPage={setPage} />
        </section>
      )}

      {tab === "dayoff" && (
        <section className="panel staff-report-panel">
          <div className="panel-title-row">
            <div><p className="eyebrow">MANAGER SCHEDULE</p><h2>Day-Off List</h2><p className="muted">Manager-set days off and approved leave. Pending Take Leave requests are shown in their own tab.</p></div>
            <div className="staff-table-tools"><PageSizeControl value={pageSize} onChange={setPageSize} /><span className="status-pill">{dayOffRows.length} days</span></div>
          </div>
          <div className="staff-horizontal-scroll"><table><thead><tr><th>Date</th><th>Day</th><th>Staff</th><th>Branch</th><th>Type</th><th>Worked</th><th>Note</th></tr></thead><tbody>
            {pagedRows.map((row) => <tr key={`${row.user_id}-${row.business_date}`}><td>{row.business_date}</td><td>{row.weekday_name}</td><td><strong>{row.full_name}</strong><small>{row.role}</small></td><td>{row.branch_name || "—"}</td><td><span className={`status-pill attendance-${row.attendance_status}`}>{attendanceStatusLabel(row.attendance_status)}</span></td><td>{row.session_id ? durationLabel(row.total_minutes) : "—"}</td><td>{row.note || "—"}</td></tr>)}
            {!pagedRows.length && <tr><td colSpan="7" className="empty-table">No day-off or approved leave records in this period.</td></tr>}
          </tbody></table></div>
          <Pagination page={page} pageSize={pageSize} total={dayOffRows.length} onPage={setPage} />
        </section>
      )}

      {tab === "leave" && (
        <section className="panel staff-report-panel">
          <div className="panel-title-row">
            <div><p className="eyebrow">STAFF REQUESTS</p><h2>Take Leave</h2><p className="muted">Staff requests remain pending until a manager approves or rejects them.</p></div>
            <div className="staff-table-tools"><PageSizeControl value={pageSize} onChange={setPageSize} /><span className="status-pill">{workspace.leaveRequests.length} requests</span></div>
          </div>
          <div className="staff-horizontal-scroll take-leave-table"><table><thead><tr><th>Requested</th><th>Staff</th><th>Branch</th><th>Dates</th><th>Type</th><th>Reason</th><th>Picture</th><th>Status</th><th>Reviewed by</th><th>Review note</th><th>Actions</th></tr></thead><tbody>
            {pagedRows.map((row) => {
              const own = row.user_id === profile.id;
              return <tr key={row.id}><td>{staffDateTime(row.created_at)}</td><td><strong>{row.profiles?.full_name}</strong><small>{row.profiles?.role}</small></td><td>{row.branches?.name || "—"}</td><td><strong>{row.date_from}</strong><small>to {row.date_to}</small></td><td>{String(row.leave_type || "").replaceAll("_", " ")}</td><td className="leave-reason-cell">{row.reason}</td><td>{row.image_url ? <button type="button" className="leave-image-link" onClick={() => setPreviewMedia({ src: row.image_url, title: `${row.profiles?.full_name || "Staff"} · Leave attachment`, downloadName: `leave-${row.id}` })}><MediaImage src={row.image_url} alt="Leave attachment" width={90} height={70} /><span><ImageIcon size={16} />View</span></button> : "—"}</td><td><span className={`status-pill leave-${row.status}`}>{leaveStatusLabel(row.status)}</span></td><td>{row.reviewer?.full_name || "—"}</td><td>{row.review_note || "—"}</td><td><div className="leave-row-actions">{canManageLeave && row.status === "pending" && <><button type="button" className="success-icon-button" disabled={busy === `leave-${row.id}`} onClick={() => reviewLeave(row, "approved")} title="Approve"><Check size={17} /></button><button type="button" className="danger-icon-button" disabled={busy === `leave-${row.id}`} onClick={() => reviewLeave(row, "rejected")} title="Reject"><X size={17} /></button></>}{own && row.status === "pending" && <button type="button" className="secondary-button compact-button" disabled={busy === `leave-${row.id}`} onClick={() => cancelLeave(row)}>Cancel</button>}</div></td></tr>;
            })}
            {!pagedRows.length && <tr><td colSpan="11" className="empty-table">No leave requests in this period.</td></tr>}
          </tbody></table></div>
          <Pagination page={page} pageSize={pageSize} total={workspace.leaveRequests.length} onPage={setPage} />
        </section>
      )}

      {tab === "commission" && canViewCommission && (
        <>
          <div className="staff-metric-grid"><article><span>Earned USD</span><strong>{commissionMoney(totals.earned.USD, "USD")}</strong></article><article><span>Paid USD</span><strong>{commissionMoney(totals.paid.USD, "USD")}</strong></article><article><span>Outstanding USD</span><strong>{commissionMoney(totals.outstanding.USD, "USD")}</strong></article><article><span>Outstanding KHR</span><strong>{commissionMoney(totals.outstanding.KHR, "KHR")}</strong></article></div>
          <section className="panel staff-report-panel"><div className="panel-title-row"><div><p className="eyebrow">EARNINGS</p><h2>Sales commission ledger</h2></div><div className="staff-table-tools"><PageSizeControl value={pageSize} onChange={setPageSize} /><span className="status-pill">{workspace.commissions.length} sales</span></div></div><div className="staff-horizontal-scroll"><table><thead><tr><th>Date</th><th>Staff</th><th>Invoice</th><th>Branch</th><th>Base</th><th>Rate</th><th>Refund</th><th>Commission</th><th>Status</th></tr></thead><tbody>{pagedRows.map((row) => <tr key={row.id}><td>{staffDateTime(row.sale_completed_at)}</td><td>{row.profiles?.full_name}</td><td>{row.sales?.invoice_number}</td><td>{row.branches?.name}</td><td>{commissionMoney(row.commissionable_amount, row.currency)}<small>{row.base_type.replaceAll("_", " ")}</small></td><td>{Number(row.rate_percent || 0).toFixed(2)}%<small>+ {commissionMoney(row.fixed_per_sale, row.currency)}</small></td><td>{commissionMoney(row.refunded_amount, row.currency)}</td><td><strong>{commissionMoney(row.commission_amount, row.currency)}</strong></td><td><span className={`status-pill ${row.status}`}>{row.status}</span></td></tr>)}{!pagedRows.length && <tr><td colSpan="9" className="empty-table">No commission records in this period.</td></tr>}</tbody></table></div><Pagination page={page} pageSize={pageSize} total={workspace.commissions.length} onPage={setPage} /></section>
        </>
      )}

      {tab === "plans" && canManageCommissions && (
        <div className="staff-plan-grid staff-plan-grid-responsive">
          <ResponsiveDataList
            storageKey="tiny-pos-commission-plans"
            title="Commission plans"
            subtitle="Commission rules for staff and branches."
            rows={workspace.plans}
            filename="tiny-pos-commission-plans.xls"
            printTitle="Commission Plans"
            emptyTitle="No commission plans yet"
            emptyText="Create the first commission plan to start calculating staff commission."
            headingExtra={<button type="button" className="primary-button" onClick={() => setPlan(null)}><Plus size={18} />New plan</button>}
            columns={[
              { label: "Plan", width: 180, value: (row) => row.name || "—", render: (row) => <><strong>{row.name || "—"}</strong><small>{row.base_type?.replaceAll("_", " ") || "—"}</small></> },
              { label: "Staff", width: 160, value: (row) => row.profiles?.full_name || "All staff" },
              { label: "Branch", width: 160, value: (row) => row.branches?.name || "All branches" },
              { label: "Currency", width: 90, value: (row) => row.currency || "USD" },
              { label: "Rate", width: 95, value: (row) => `${Number(row.rate_percent || 0).toFixed(2)}%` },
              { label: "Fixed / sale", width: 120, value: (row) => commissionMoney(row.fixed_per_sale, row.currency) },
              { label: "Status", width: 100, value: (row) => row.is_active ? "Active" : "Inactive", render: (row) => <span className={`status-pill ${row.is_active ? "active" : "inactive"}`}>{row.is_active ? "Active" : "Inactive"}</span> },
              { label: "Actions", actionsOnly: true, excludeDocument: true, render: (row) => <button type="button" className="secondary-button compact-button" onClick={() => setPlan(row)}><Pencil size={16} />Edit</button> }
            ]}
            renderCard={(row) => (
              <article className="responsive-data-card commission-plan-card">
                <header><div><strong>{row.name || "—"}</strong><small>{row.profiles?.full_name || "All staff"} · {row.branches?.name || "All branches"}</small></div><span className={`status-pill ${row.is_active ? "active" : "inactive"}`}>{row.is_active ? "Active" : "Inactive"}</span></header>
                <div><span>Base</span><strong>{row.base_type?.replaceAll("_", " ") || "—"}</strong></div>
                <div><span>Rate</span><strong>{Number(row.rate_percent || 0).toFixed(2)}%</strong></div>
                <div><span>Fixed / sale</span><strong>{commissionMoney(row.fixed_per_sale, row.currency)}</strong></div>
                <div><span>Currency</span><strong>{row.currency || "USD"}</strong></div>
                <footer><button type="button" className="secondary-button compact-button" onClick={() => setPlan(row)}><Pencil size={16} />Edit plan</button></footer>
              </article>
            )}
          />

          <ResponsiveDataList
            storageKey="tiny-pos-commission-payouts"
            title="Payment history"
            subtitle="Commission payouts recorded for the selected period."
            rows={workspace.payouts}
            filename="tiny-pos-commission-payouts.xls"
            printTitle="Commission Payouts"
            emptyTitle="No commission payouts in this period"
            emptyText="Change the date or staff filter, or record a new payout."
            headingExtra={canPayCommissions ? <button type="button" className="primary-button" onClick={() => setPayout(true)}><Plus size={18} />Record payout</button> : null}
            columns={[
              { label: "Paid at", width: 170, value: (row) => staffDateTime(row.paid_at) },
              { label: "Staff", width: 160, value: (row) => row.profiles?.full_name || "—" },
              { label: "Branch", width: 160, value: (row) => row.branches?.name || "—" },
              { label: "Period", width: 190, value: (row) => `${row.period_start || "—"} → ${row.period_end || "—"}` },
              { label: "Method", width: 130, value: (row) => row.payment_method || "—", render: (row) => <>{row.payment_method || "—"}<small>{row.reference_number || "—"}</small></> },
              { label: "Amount", width: 120, value: (row) => commissionMoney(row.amount, row.currency), render: (row) => <strong>{commissionMoney(row.amount, row.currency)}</strong> }
            ]}
            renderCard={(row) => (
              <article className="responsive-data-card commission-payout-card">
                <header><div><strong>{row.profiles?.full_name || "—"}</strong><small>{staffDateTime(row.paid_at)}</small></div><strong>{commissionMoney(row.amount, row.currency)}</strong></header>
                <div><span>Branch</span><strong>{row.branches?.name || "—"}</strong></div>
                <div><span>Period</span><strong>{row.period_start || "—"} → {row.period_end || "—"}</strong></div>
                <div><span>Method</span><strong>{row.payment_method || "—"}</strong><small>{row.reference_number || "—"}</small></div>
              </article>
            )}
          />
        </div>
      )}

      {correction && <AttendanceCorrectionModal session={correction} busy={busy === "correction"} onClose={() => setCorrection(null)} onSave={saveCorrection} />}
      <ManualAttendanceModal open={manualAttendance} staff={workspace.staff} branches={workspace.branches} busy={busy === "manual-attendance"} onClose={() => setManualAttendance(false)} onSave={saveManual} />
      <LeaveRequestModal open={leaveOpen} busy={busy === "leave"} onClose={() => setLeaveOpen(false)} onSave={saveLeave} />
      <MediaPreviewModal
        open={Boolean(previewMedia)}
        src={previewMedia?.src}
        title={previewMedia?.title || "Leave attachment"}
        downloadName={previewMedia?.downloadName || "leave-attachment"}
        onClose={() => setPreviewMedia(null)}
      />
      {plan !== undefined && <CommissionPlanModal plan={plan} staff={workspace.staff} branches={workspace.branches} busy={busy === "plan"} onClose={() => setPlan(undefined)} onSave={savePlan} />}
      {payout && <CommissionPayoutModal staff={workspace.staff} branches={workspace.branches} busy={busy === "payout"} onClose={() => setPayout(false)} onSave={savePayout} />}
    </div>
  );
}
