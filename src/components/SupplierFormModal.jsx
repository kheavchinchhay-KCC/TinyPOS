import { useEffect, useState } from "react";
import Modal from "./Modal";

function blankSupplier() {
  return {
    supplier_id: null,
    name: "",
    contact_name: "",
    phone: "",
    email: "",
    address: "",
    tax_id: "",
    notes: "",
    is_active: true
  };
}

export default function SupplierFormModal({ supplier, open, busy, onClose, onSave }) {
  const [form, setForm] = useState(blankSupplier);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;

    setForm(
      supplier
        ? {
            supplier_id: supplier.id,
            name: supplier.name || "",
            contact_name: supplier.contact_name || "",
            phone: supplier.phone || "",
            email: supplier.email || "",
            address: supplier.address || "",
            tax_id: supplier.tax_id || "",
            notes: supplier.notes || "",
            is_active: supplier.is_active !== false
          }
        : blankSupplier()
    );
    setError("");
  }, [open, supplier]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();

    if (form.name.trim().length < 2) {
      setError("Supplier name is required.");
      return;
    }

    await onSave(form);
  }

  if (!open) return null;

  return (
    <Modal title={supplier ? `Edit ${supplier.name}` : "New supplier"} onClose={onClose} wide className="supplier-form-dialog" bodyClassName="supplier-form-dialog-body" closeDisabled={busy}>
      <form className="supplier-form" onSubmit={submit}>
        {supplier?.supplier_code && (
          <div className="supplier-code-banner">
            <span>Supplier code</span>
            <strong>{supplier.supplier_code}</strong>
          </div>
        )}

        <div className="form-grid two">
          <label>
            <span>Supplier name</span>
            <input
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              autoFocus
            />
          </label>

          <label>
            <span>Contact person</span>
            <input
              value={form.contact_name}
              onChange={(event) => update("contact_name", event.target.value)}
            />
          </label>

          <label>
            <span>Phone</span>
            <input
              value={form.phone}
              onChange={(event) => update("phone", event.target.value)}
            />
          </label>

          <label>
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => update("email", event.target.value)}
            />
          </label>

          <label>
            <span>Tax ID</span>
            <input
              value={form.tax_id}
              onChange={(event) => update("tax_id", event.target.value)}
            />
          </label>

          <label className="supplier-status-field">
            <span>Status</span>
            <select
              value={form.is_active ? "active" : "inactive"}
              onChange={(event) => update("is_active", event.target.value === "active")}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>

          <label className="supplier-wide-field">
            <span>Address</span>
            <textarea
              rows="2"
              value={form.address}
              onChange={(event) => update("address", event.target.value)}
            />
          </label>

          <label className="supplier-wide-field">
            <span>Notes</span>
            <textarea
              rows="3"
              value={form.notes}
              onChange={(event) => update("notes", event.target.value)}
            />
          </label>
        </div>

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Saving..." : "Save supplier"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
