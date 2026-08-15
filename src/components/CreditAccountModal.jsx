import {
  BadgeDollarSign,
  Save
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

export default function CreditAccountModal({
  open,
  account,
  customers,
  busy,
  onClose,
  onSubmit
}) {
  const [form, setForm] = useState({
    customer_id: "",
    currency: "USD",
    credit_limit: "0",
    allow_unlimited_credit: false,
    payment_terms_days: "30",
    is_on_hold: false,
    notes: ""
  });
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;

    setForm({
      customer_id: account?.customer_id || "",
      currency: account?.currency || "USD",
      credit_limit: String(
        account?.credit_limit || 0
      ),
      allow_unlimited_credit: Boolean(
        account?.allow_unlimited_credit
      ),
      payment_terms_days: String(
        account?.payment_terms_days ?? 30
      ),
      is_on_hold: Boolean(account?.is_on_hold),
      notes: account?.notes || ""
    });
    setError("");
  }, [open, account]);

  const eligibleCustomers = useMemo(() => {
    if (account) return customers;

    return customers.filter((customer) => {
      const currencies = Array.isArray(
        customer.account_currencies
      )
        ? customer.account_currencies
        : [];

      return !currencies.includes(form.currency);
    });
  }, [customers, account, form.currency]);

  if (!open) return null;

  function update(field, value) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
    setError("");
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    const limit = Number(form.credit_limit);
    const terms = Number(form.payment_terms_days);

    if (!form.customer_id) {
      setError("Choose a customer.");
      return;
    }

    if (!Number.isFinite(limit) || limit < 0) {
      setError("Credit limit cannot be negative.");
      return;
    }

    if (
      !Number.isInteger(terms)
      || terms < 0
      || terms > 3650
    ) {
      setError(
        "Payment terms must be a whole number from 0 to 3650 days."
      );
      return;
    }

    if (
      account
      && !form.allow_unlimited_credit
      && limit < Number(account.balance_due || 0)
    ) {
      const confirmed = window.confirm(
        `The new limit ${money(limit, form.currency)} is below the current balance ${money(
          account.balance_due,
          form.currency
        )}. New credit sales will be blocked until the balance is lower. Continue?`
      );

      if (!confirmed) return;
    }

    await onSubmit(form);
  }

  return (
    <Modal
      title={
        account
          ? `Credit settings · ${account.customer?.name}`
          : "Add customer credit account"
      }
      onClose={onClose}
      wide
    >
      <form
        className="credit-account-form"
        onSubmit={submit}
      >
        <section className="credit-account-form-heading">
          <BadgeDollarSign size={24} />
          <div>
            <strong>
              {account
                ? `${account.customer?.customer_code || "Customer"} · ${account.currency}`
                : "Customer credit terms"}
            </strong>
            <span>
              Credit limits and balances are kept
              separately for USD and KHR.
            </span>
          </div>
        </section>

        <div className="form-grid two">
          <label>
            <span>Customer</span>
            <select
              value={form.customer_id}
              disabled={Boolean(account)}
              onChange={(event) =>
                update(
                  "customer_id",
                  event.target.value
                )
              }
            >
              <option value="">
                Choose customer
              </option>
              {eligibleCustomers.map((customer) => (
                <option
                  value={customer.id}
                  key={customer.id}
                >
                  {customer.customer_code}
                  {" · "}
                  {customer.name}
                  {customer.phone
                    ? ` · ${customer.phone}`
                    : ""}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Currency</span>
            <select
              value={form.currency}
              disabled={Boolean(account)}
              onChange={(event) => {
                update(
                  "currency",
                  event.target.value
                );
                if (!account) {
                  update("customer_id", "");
                }
              }}
            >
              <option value="USD">USD</option>
              <option value="KHR">KHR</option>
            </select>
          </label>
        </div>

        <div className="form-grid two">
          <label>
            <span>Credit limit</span>
            <input
              type="number"
              min="0"
              step={
                form.currency === "KHR"
                  ? "1"
                  : "0.01"
              }
              value={form.credit_limit}
              onChange={(event) =>
                update(
                  "credit_limit",
                  event.target.value
                )
              }
              disabled={form.allow_unlimited_credit}
            />
            <label className="credit-unlimited-check">
              <input
                type="checkbox"
                checked={form.allow_unlimited_credit}
                onChange={(event) =>
                  update(
                    "allow_unlimited_credit",
                    event.target.checked
                  )
                }
              />
              <span>Allow any amount</span>
            </label>
          </label>

          <label>
            <span>Payment terms</span>
            <div className="input-with-suffix">
              <input
                type="number"
                min="0"
                max="3650"
                step="1"
                value={form.payment_terms_days}
                onChange={(event) =>
                  update(
                    "payment_terms_days",
                    event.target.value
                  )
                }
              />
              <span>days</span>
            </div>
          </label>
        </div>

        {account && (
          <section className="credit-account-current-box">
            <div>
              <span>Current balance</span>
              <strong>
                {money(
                  account.balance_due,
                  account.currency
                )}
              </strong>
            </div>
            <div>
              <span>Available credit</span>
              <strong>
                {form.allow_unlimited_credit
                  ? "Unlimited"
                  : money(
                      Math.max(
                        0,
                        Number(form.credit_limit || 0)
                          - Number(
                              account.balance_due || 0
                            )
                      ),
                      account.currency
                    )}
              </strong>
            </div>
          </section>
        )}

        <label className="check-row">
          <input
            type="checkbox"
            checked={form.is_on_hold}
            onChange={(event) =>
              update(
                "is_on_hold",
                event.target.checked
              )
            }
          />
          <span>
            Put this account on hold and block new
            credit sales
          </span>
        </label>

        <label>
          <span>Account note</span>
          <textarea
            rows="3"
            value={form.notes}
            onChange={(event) =>
              update("notes", event.target.value)
            }
            placeholder="Optional approval, terms or customer instruction"
          />
        </label>

        {error && (
          <div className="notice error">
            {error}
          </div>
        )}

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
            {busy
              ? "Saving account..."
              : "Save credit account"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
