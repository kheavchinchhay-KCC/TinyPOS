import { useEffect, useState } from "react";
import { Save, Store } from "lucide-react";
import Modal from "./Modal";
import { branchToForm } from "../lib/staff";

export default function BranchFormModal({
  open,
  branch,
  busy,
  onClose,
  onSave
}) {
  const [form, setForm] = useState(() => branchToForm(branch));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm(branchToForm(branch));
    setError("");
  }, [open, branch]);

  if (!open) return null;

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!form.name.trim()) {
      setError("Branch name is required.");
      return;
    }

    if (!/^[A-Z0-9_-]{1,20}$/.test(form.code.trim().toUpperCase())) {
      setError("Branch code may use only A-Z, 0-9, underscore, and dash.");
      return;
    }

    const latitude = form.latitude === "" ? null : Number(form.latitude);
    const longitude = form.longitude === "" ? null : Number(form.longitude);
    const radius = Number(form.attendance_radius_m || 150);

    if (form.attendance_geofence_required) {
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        setError("Enter a valid branch latitude before requiring attendance location.");
        return;
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        setError("Enter a valid branch longitude before requiring attendance location.");
        return;
      }
      if (!Number.isFinite(radius) || radius < 25 || radius > 5000) {
        setError("Attendance radius must be between 25 and 5,000 metres.");
        return;
      }
    }

    try {
      await onSave({
        ...form,
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        latitude,
        longitude,
        attendance_radius_m: radius
      });
    } catch (saveError) {
      setError(saveError?.message || "The branch could not be saved.");
    }
  }

  return (
    <Modal title={branch ? "Edit branch" : "Add branch"} onClose={onClose}>
      <form className="branch-form" onSubmit={submit}>
        <label>
          <span>Branch name *</span>
          <input
            autoFocus
            value={form.name}
            onChange={(event) => update("name", event.target.value)}
            placeholder="For example, Siem Reap Branch"
          />
        </label>

        <label>
          <span>Branch code *</span>
          <input
            value={form.code}
            onChange={(event) =>
              update("code", event.target.value.toUpperCase())
            }
            placeholder="For example, SR"
            maxLength="20"
          />
        </label>

        <label>
          <span>Phone</span>
          <input
            value={form.phone}
            onChange={(event) => update("phone", event.target.value)}
            placeholder="Branch phone"
          />
        </label>

        <label>
          <span>Address</span>
          <textarea
            rows="3"
            value={form.address}
            onChange={(event) => update("address", event.target.value)}
            placeholder="Branch address"
          />
        </label>

        <section className="branch-attendance-location">
          <label className="staff-active-toggle">
            <span>
              <strong>Require branch location for attendance</strong>
              <small>Blocks POS and Telegram check-in from home. Staff must be inside the branch radius.</small>
            </span>
            <input
              type="checkbox"
              checked={Boolean(form.attendance_geofence_required)}
              onChange={(event) => update("attendance_geofence_required", event.target.checked)}
            />
          </label>

          <div className="form-grid three">
            <label>
              <span>Latitude</span>
              <input type="number" step="0.000001" min="-90" max="90" value={form.latitude} onChange={(event) => update("latitude", event.target.value)} placeholder="11.5564" />
            </label>
            <label>
              <span>Longitude</span>
              <input type="number" step="0.000001" min="-180" max="180" value={form.longitude} onChange={(event) => update("longitude", event.target.value)} placeholder="104.9282" />
            </label>
            <label>
              <span>Allowed radius (metres)</span>
              <input type="number" min="25" max="5000" step="10" value={form.attendance_radius_m} onChange={(event) => update("attendance_radius_m", event.target.value)} />
            </label>
          </div>
          <small>Use the branch location from Google Maps. Owners can disable this when attendance is not used.</small>
        </section>

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {branch ? <Save size={18} /> : <Store size={18} />}
            {busy ? "Saving..." : branch ? "Save branch" : "Create branch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
