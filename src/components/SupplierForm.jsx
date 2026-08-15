import { useState } from "react";
import { Save } from "lucide-react";

const initial = { name: "", phone: "", email: "", address: "", notes: "" };

export default function SupplierForm({ busy, onCancel, onSave }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");

  function setField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("Supplier name is required.");
      return;
    }

    try {
      await onSave(form);
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  return (
    <form className="inventory-form" onSubmit={submit}>
      {error && <div className="notice error">{error}</div>}
      <label><span>Supplier name *</span><input value={form.name} onChange={(e) => setField("name", e.target.value)} /></label>
      <div className="form-grid two">
        <label><span>Phone</span><input value={form.phone} onChange={(e) => setField("phone", e.target.value)} /></label>
        <label><span>Email</span><input type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} /></label>
      </div>
      <label><span>Address</span><textarea rows="2" value={form.address} onChange={(e) => setField("address", e.target.value)} /></label>
      <label><span>Notes</span><textarea rows="2" value={form.notes} onChange={(e) => setField("notes", e.target.value)} /></label>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy}><Save size={18} /> {busy ? "Saving..." : "Create supplier"}</button>
      </div>
    </form>
  );
}
