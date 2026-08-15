import { useEffect, useState } from "react";
import { Save, UserPlus } from "lucide-react";
import Modal from "./Modal";
import { customerToForm, emptyCustomerForm } from "../lib/customers";

export default function CustomerFormModal({
  open,
  customer,
  busy,
  onClose,
  onSave
}) {
  const [form, setForm] = useState(emptyCustomerForm);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm(customer ? customerToForm(customer) : emptyCustomerForm());
    setError("");
  }, [open, customer]);

  if (!open) return null;

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!form.name.trim()) {
      setError("Customer name is required.");
      return;
    }

    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      setError("Enter a valid email address.");
      return;
    }

    if (Number(form.credit_limit || 0) < 0) {
      setError("Credit limit cannot be negative.");
      return;
    }

    await onSave(form);
  }

  return (
    <Modal
      title={customer ? "Edit customer" : "Add customer"}
      onClose={onClose}
      wide
    >
      <form className="customer-form" onSubmit={submit}>
        <div className="customer-form-grid">
          <label>
            <span>Customer code</span>
            <input
              value={form.customer_code}
              onChange={(event) =>
                update("customer_code", event.target.value.toUpperCase())
              }
              placeholder="Automatic, for example C000001"
            />
          </label>

          <label>
            <span>Customer type</span>
            <select
              value={form.customer_type}
              onChange={(event) =>
                update("customer_type", event.target.value)
              }
            >
              <option value="regular">Regular</option>
              <option value="vip">VIP</option>
              <option value="wholesale">Wholesale</option>
            </select>
          </label>

          <label className="customer-form-name">
            <span>Name *</span>
            <input
              autoFocus
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="Customer name"
            />
          </label>

          <label>
            <span>Company</span>
            <input
              value={form.company_name}
              onChange={(event) =>
                update("company_name", event.target.value)
              }
              placeholder="Optional company name"
            />
          </label>

          <label>
            <span>Phone</span>
            <input
              value={form.phone}
              onChange={(event) => update("phone", event.target.value)}
              placeholder="Phone number"
            />
          </label>

          <label>
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => update("email", event.target.value)}
              placeholder="customer@example.com"
            />
          </label>

          <label>
            <span>Date of birth</span>
            <input
              type="date"
              value={form.date_of_birth}
              onChange={(event) =>
                update("date_of_birth", event.target.value)
              }
            />
          </label>

          <label>
            <span>Credit limit</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.credit_limit}
              onChange={(event) =>
                update("credit_limit", event.target.value)
              }
              disabled={form.allow_unlimited_credit}
            />
            <small className="customer-credit-help">
              Default 0 blocks credit. Enter an exact limit when needed.
            </small>
          </label>

          <div className="customer-credit-mode">
            <span>Credit permission</span>
            <div className="customer-credit-toggle" role="group" aria-label="Customer credit permission">
              <button
                type="button"
                className={!form.allow_unlimited_credit ? "active" : ""}
                onClick={() => update("allow_unlimited_credit", false)}
              >
                Default / limit
              </button>
              <button
                type="button"
                className={form.allow_unlimited_credit ? "active" : ""}
                onClick={() => update("allow_unlimited_credit", true)}
              >
                Allow any amount
              </button>
            </div>
            <small>
              Allow any amount removes the credit ceiling but still tracks the balance due.
            </small>
          </div>

          <label className="customer-form-wide">
            <span>Address</span>
            <textarea
              rows="2"
              value={form.address}
              onChange={(event) => update("address", event.target.value)}
              placeholder="Customer address"
            />
          </label>

          <label className="customer-form-wide">
            <span>Notes</span>
            <textarea
              rows="3"
              value={form.notes}
              onChange={(event) => update("notes", event.target.value)}
              placeholder="Preferences, delivery notes, or other information"
            />
          </label>

          <label className="customer-active-toggle">
            <span>
              <strong>Active customer</strong>
              <small>
                Inactive customers remain in history but cannot be selected
                for a new sale.
              </small>
            </span>
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(event) =>
                update("is_active", event.target.checked)
              }
            />
          </label>
        </div>

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
          <button
            type="submit"
            className="primary-button"
            disabled={busy}
          >
            {customer ? <Save size={18} /> : <UserPlus size={18} />}
            {busy
              ? "Saving..."
              : customer
                ? "Save customer"
                : "Add customer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
