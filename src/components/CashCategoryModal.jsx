import { useEffect, useState } from "react";
import { Edit3, Plus, Save } from "lucide-react";
import Modal from "./Modal";

const empty = {
  id: null,
  name: "",
  direction: "expense",
  affects_profit: true,
  is_active: true
};

export default function CashCategoryModal({ categories, busy, onClose, onSave }) {
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");

  useEffect(() => {
    setForm(empty);
    setError("");
  }, [categories]);

  function edit(category) {
    setForm({
      id: category.id,
      name: category.name,
      direction: category.direction,
      affects_profit: category.affects_profit,
      is_active: category.is_active
    });
    setError("");
  }

  function reset() {
    setForm(empty);
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("Category name is required.");
      return;
    }
    await onSave(form);
    reset();
  }

  return (
    <Modal title="Cash & expense categories" onClose={onClose} wide>
      <div className="cash-category-layout">
        <section className="cash-category-list">
          <div className="cash-category-heading">
            <div>
              <h3>Categories</h3>
              <p>Inactive categories stay in old records but cannot be selected.</p>
            </div>
            <button type="button" className="secondary-button" onClick={reset}>
              <Plus size={17} /> New
            </button>
          </div>

          <div className="cash-category-rows">
            {(categories || []).map((category) => (
              <button
                type="button"
                className="cash-category-row"
                onClick={() => edit(category)}
                key={category.id}
              >
                <span>
                  <strong>{category.name}</strong>
                  <small>
                    {category.direction === "income" ? "Cash in" : "Expense"}
                    {category.affects_profit ? " · Profit & Loss" : " · Cash only"}
                  </small>
                </span>
                <span className={`status-pill ${category.is_active ? "active" : "inactive"}`}>
                  {category.is_active ? "Active" : "Inactive"}
                </span>
                <Edit3 size={17} />
              </button>
            ))}
          </div>
        </section>

        <form className="cash-category-form" onSubmit={submit}>
          <h3>{form.id ? "Edit category" : "New category"}</h3>

          <label>
            <span>Name</span>
            <input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Example: Delivery expense"
            />
          </label>

          <label>
            <span>Type</span>
            <select
              value={form.direction}
              onChange={(event) => setForm((current) => ({ ...current, direction: event.target.value }))}
            >
              <option value="income">Cash in / Other income</option>
              <option value="expense">Expense / Cash out</option>
            </select>
          </label>

          <label className="toggle-row cash-category-toggle">
            <span>
              <strong>Affects Profit & Loss</strong>
              <small>Turn off for opening balance, owner contribution, transfer, or owner withdrawal.</small>
            </span>
            <input
              type="checkbox"
              checked={form.affects_profit}
              onChange={(event) => setForm((current) => ({ ...current, affects_profit: event.target.checked }))}
            />
          </label>

          <label className="toggle-row cash-category-toggle">
            <span>
              <strong>Active</strong>
              <small>Inactive categories cannot be used for new entries.</small>
            </span>
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))}
            />
          </label>

          {error && <div className="notice error">{error}</div>}

          <button type="submit" className="primary-button" disabled={busy}>
            <Save size={18} />
            {busy ? "Saving…" : "Save category"}
          </button>
        </form>
      </div>
    </Modal>
  );
}
