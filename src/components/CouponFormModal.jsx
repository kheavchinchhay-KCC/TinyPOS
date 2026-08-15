import { useEffect, useState } from "react";
import { Save, TicketPercent } from "lucide-react";
import Modal from "./Modal";
import { toLocalDateTime } from "../lib/coupons";

function defaultStart() {
  const date = new Date();
  date.setSeconds(0, 0);
  return toLocalDateTime(date.toISOString());
}

const emptyForm = {
  id: null,
  code: "",
  name: "",
  description: "",
  discount_type: "percent",
  discount_value: "",
  max_discount_amount: "",
  minimum_spend: "0",
  currency: "USD",
  branch_id: "",
  customer_type: "",
  starts_at: defaultStart(),
  ends_at: "",
  usage_limit: "",
  per_customer_limit: "",
  is_active: true
};

export default function CouponFormModal({
  coupon,
  branches,
  baseCurrency,
  busy,
  onClose,
  onSubmit
}) {
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!coupon) {
      setForm({
        ...emptyForm,
        currency: baseCurrency || "USD",
        starts_at: defaultStart()
      });
      return;
    }

    setForm({
      id: coupon.id,
      code: coupon.code || "",
      name: coupon.name || "",
      description: coupon.description || "",
      discount_type: coupon.discount_type || "percent",
      discount_value: String(coupon.discount_value || ""),
      max_discount_amount:
        coupon.max_discount_amount === null
          ? ""
          : String(coupon.max_discount_amount),
      minimum_spend: String(coupon.minimum_spend || 0),
      currency: coupon.currency || baseCurrency || "USD",
      branch_id: coupon.branch_id || "",
      customer_type: coupon.customer_type || "",
      starts_at: toLocalDateTime(coupon.starts_at),
      ends_at: toLocalDateTime(coupon.ends_at),
      usage_limit:
        coupon.usage_limit === null ? "" : String(coupon.usage_limit),
      per_customer_limit:
        coupon.per_customer_limit === null
          ? ""
          : String(coupon.per_customer_limit),
      is_active: coupon.is_active !== false
    });
  }, [coupon, baseCurrency]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!form.code.trim() || !form.name.trim()) {
      setError("Coupon code and name are required.");
      return;
    }

    const discountValue = Number(form.discount_value);
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      setError("Discount value must be greater than zero.");
      return;
    }

    if (form.discount_type === "percent" && discountValue > 100) {
      setError("Percentage discount cannot exceed 100.");
      return;
    }

    if (
      form.ends_at &&
      new Date(form.ends_at).getTime() <= new Date(form.starts_at).getTime()
    ) {
      setError("End date must be after the start date.");
      return;
    }

    try {
      await onSubmit(form);
    } catch (submitError) {
      setError(submitError.message);
    }
  }

  return (
    <Modal
      title={coupon ? "Edit coupon" : "Create coupon"}
      onClose={onClose}
      wide
    >
      <form className="coupon-form" onSubmit={submit}>
        <div className="coupon-form-heading">
          <TicketPercent size={25} />
          <div>
            <strong>{coupon ? coupon.code : "New promotion"}</strong>
            <span>
              Coupons cannot be combined with a manual sale discount.
            </span>
          </div>
        </div>

        <div className="coupon-form-grid">
          <label>
            <span>Coupon code *</span>
            <input
              value={form.code}
              onChange={(event) =>
                update("code", event.target.value.toUpperCase())
              }
              placeholder="WELCOME10"
              maxLength="30"
              autoFocus
            />
          </label>

          <label>
            <span>Promotion name *</span>
            <input
              value={form.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="Welcome discount"
            />
          </label>

          <label>
            <span>Discount type</span>
            <select
              value={form.discount_type}
              onChange={(event) =>
                update("discount_type", event.target.value)
              }
            >
              <option value="percent">Percentage</option>
              <option value="fixed">Fixed amount</option>
            </select>
          </label>

          <label>
            <span>
              {form.discount_type === "percent"
                ? "Discount percent"
                : "Discount amount"}
            </span>
            <input
              type="number"
              min="0.01"
              max={form.discount_type === "percent" ? "100" : undefined}
              step="0.01"
              value={form.discount_value}
              onChange={(event) =>
                update("discount_value", event.target.value)
              }
            />
          </label>

          <label>
            <span>Currency</span>
            <select
              value={form.currency}
              onChange={(event) => update("currency", event.target.value)}
            >
              <option value="USD">USD</option>
              <option value="KHR">KHR</option>
            </select>
          </label>

          <label>
            <span>Minimum spend</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.minimum_spend}
              onChange={(event) =>
                update("minimum_spend", event.target.value)
              }
            />
          </label>

          {form.discount_type === "percent" && (
            <label>
              <span>Maximum discount</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.max_discount_amount}
                onChange={(event) =>
                  update("max_discount_amount", event.target.value)
                }
                placeholder="No maximum"
              />
            </label>
          )}

          <label>
            <span>Valid branch</span>
            <select
              value={form.branch_id}
              onChange={(event) => update("branch_id", event.target.value)}
            >
              <option value="">All branches</option>
              {branches.map((branch) => (
                <option value={branch.id} key={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Customer type</span>
            <select
              value={form.customer_type}
              onChange={(event) =>
                update("customer_type", event.target.value)
              }
            >
              <option value="">All customers</option>
              <option value="regular">Regular only</option>
              <option value="vip">VIP only</option>
              <option value="wholesale">Wholesale only</option>
            </select>
          </label>

          <label>
            <span>Start date and time</span>
            <input
              type="datetime-local"
              value={form.starts_at}
              onChange={(event) =>
                update("starts_at", event.target.value)
              }
            />
          </label>

          <label>
            <span>End date and time</span>
            <input
              type="datetime-local"
              value={form.ends_at}
              onChange={(event) => update("ends_at", event.target.value)}
            />
          </label>

          <label>
            <span>Total usage limit</span>
            <input
              type="number"
              min="1"
              step="1"
              value={form.usage_limit}
              onChange={(event) =>
                update("usage_limit", event.target.value)
              }
              placeholder="Unlimited"
            />
          </label>

          <label>
            <span>Limit per customer</span>
            <input
              type="number"
              min="1"
              step="1"
              value={form.per_customer_limit}
              onChange={(event) =>
                update("per_customer_limit", event.target.value)
              }
              placeholder="Unlimited"
            />
          </label>

          <label className="coupon-description-field">
            <span>Description</span>
            <textarea
              rows="3"
              value={form.description}
              onChange={(event) =>
                update("description", event.target.value)
              }
              placeholder="Optional staff note about this promotion"
            />
          </label>
        </div>

        <label className="toggle-row coupon-active-toggle">
          <span>
            <strong>Active</strong>
            <small>Cashiers can apply this coupon while it is active.</small>
          </span>
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(event) => update("is_active", event.target.checked)}
          />
        </label>

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
            <Save size={18} />
            {busy ? "Saving..." : coupon ? "Save changes" : "Create coupon"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
