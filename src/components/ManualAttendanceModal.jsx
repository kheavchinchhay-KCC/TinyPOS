import { CalendarPlus, Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";

function currentMonth() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

function daysInMonth(month) {
  const [year, monthNumber] = String(month || currentMonth()).split("-").map(Number);
  return new Date(year, monthNumber, 0).getDate();
}

export default function ManualAttendanceModal({
  open,
  staff,
  branches,
  busy,
  onClose,
  onSave
}) {
  const [form, setForm] = useState({
    user_id: "",
    branch_id: "",
    month: currentMonth(),
    day_type: "work",
    day_count: 1,
    check_in_time: "07:00",
    check_out_time: "17:00",
    note: ""
  });
  const [selectedDays, setSelectedDays] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const first = staff[0];
    setForm({
      user_id: first?.id || "",
      branch_id: first?.branch_id || branches[0]?.id || "",
      month: currentMonth(),
      day_type: "work",
      day_count: 1,
      check_in_time: "07:00",
      check_out_time: "17:00",
      note: ""
    });
    setSelectedDays([]);
    setError("");
  }, [open, staff, branches]);

  const totalDays = useMemo(() => daysInMonth(form.month), [form.month]);
  const dayNumbers = useMemo(
    () => Array.from({ length: totalDays }, (_, index) => index + 1),
    [totalDays]
  );

  if (!open) return null;

  function changeStaff(userId) {
    const member = staff.find((row) => row.id === userId);
    setForm((current) => ({
      ...current,
      user_id: userId,
      branch_id: member?.branch_id || current.branch_id
    }));
  }

  function changeCount(value) {
    const count = Math.min(totalDays, Math.max(1, Number(value || 1)));
    setForm((current) => ({ ...current, day_count: count }));
    setSelectedDays((current) => current.slice(0, count));
  }

  function toggleDay(day) {
    setError("");
    setSelectedDays((current) => {
      if (current.includes(day)) return current.filter((value) => value !== day);
      if (current.length >= Number(form.day_count || 1)) return current;
      return [...current, day].sort((a, b) => a - b);
    });
  }

  function submit(event) {
    event.preventDefault();
    setError("");
    if (!form.user_id) return setError("Choose a staff member.");
    if (!form.branch_id) return setError("Choose a branch.");
    if (!form.month) return setError("Choose a month.");
    if (selectedDays.length !== Number(form.day_count)) {
      return setError(`Choose exactly ${form.day_count} day${Number(form.day_count) === 1 ? "" : "s"}.`);
    }
    if (form.day_type === "work" && form.check_out_time <= form.check_in_time) {
      return setError("Check-out time must be after check-in time.");
    }
    onSave({
      ...form,
      month: `${form.month}-01`,
      days: selectedDays
    });
  }

  return (
    <Modal title="Set attendance" wide onClose={() => !busy && onClose()}>
      <form className="manual-attendance-form" onSubmit={submit}>
        <div className="manual-attendance-grid">
          <label>
            <span>Staff member</span>
            <select value={form.user_id} onChange={(event) => changeStaff(event.target.value)}>
              <option value="">Choose staff</option>
              {staff.map((row) => (
                <option key={row.id} value={row.id}>{row.full_name} · {row.role}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Branch</span>
            <select value={form.branch_id} onChange={(event) => setForm((current) => ({ ...current, branch_id: event.target.value }))}>
              <option value="">Choose branch</option>
              {branches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label>
          <label>
            <span>Month</span>
            <input type="month" value={form.month} onChange={(event) => {
              setForm((current) => ({ ...current, month: event.target.value }));
              setSelectedDays([]);
            }} />
          </label>
          <label>
            <span>Attendance type</span>
            <select value={form.day_type} onChange={(event) => setForm((current) => ({ ...current, day_type: event.target.value }))}>
              <option value="work">Working day</option>
              <option value="day_off">Day off</option>
              <option value="leave">Approved leave</option>
              <option value="absence">Mark absent</option>
            </select>
          </label>
          <label>
            <span>Number of days to select</span>
            <input type="number" min="1" max={totalDays} value={form.day_count} onChange={(event) => changeCount(event.target.value)} />
          </label>
          {form.day_type === "work" && (
            <>
              <label><span>Check-in time</span><input type="time" value={form.check_in_time} onChange={(event) => setForm((current) => ({ ...current, check_in_time: event.target.value }))} /></label>
              <label><span>Check-out time</span><input type="time" value={form.check_out_time} onChange={(event) => setForm((current) => ({ ...current, check_out_time: event.target.value }))} /></label>
            </>
          )}
        </div>

        <section className="attendance-day-picker">
          <div className="attendance-day-picker-heading">
            <span><CalendarPlus size={19} />Select days in {form.month}</span>
            <strong>{selectedDays.length} / {form.day_count} selected</strong>
          </div>
          <div className="attendance-day-buttons">
            {dayNumbers.map((day) => {
              const active = selectedDays.includes(day);
              const disabled = !active && selectedDays.length >= Number(form.day_count);
              return (
                <button type="button" key={day} className={active ? "active" : ""} disabled={disabled} onClick={() => toggleDay(day)}>
                  {active && <Check size={14} />}{day}
                </button>
              );
            })}
          </div>
        </section>

        <label>
          <span>Note</span>
          <textarea rows="3" value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder="Optional attendance, leave or day-off note" />
        </label>

        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy}>
            <CalendarPlus size={18} />{busy ? "Saving..." : "Save selected days"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
