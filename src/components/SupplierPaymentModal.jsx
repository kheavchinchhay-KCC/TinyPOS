import {
  Banknote,
  HandCoins
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";
import { money } from "../lib/catalog";
import {
  payableDate,
  payableMethodLabel
} from "../lib/payables";

export default function SupplierPaymentModal({
  supplier,
  invoices,
  currentBranchId,
  currentBranchName,
  busy,
  onClose,
  onSubmit
}) {
  const currentInvoices = useMemo(
    () =>
      (invoices || [])
        .filter(
          (invoice) =>
            invoice.supplier_id
              === supplier?.supplier_id
            && invoice.branch_id
              === currentBranchId
        )
        .sort(
          (a, b) =>
            String(a.due_date)
              .localeCompare(
                String(b.due_date)
              )
            || String(a.purchase_number)
              .localeCompare(
                String(b.purchase_number)
              )
        ),
    [
      invoices,
      supplier,
      currentBranchId
    ]
  );

  const balances = useMemo(() => ({
    USD: currentInvoices
      .filter(
        (invoice) =>
          invoice.currency === "USD"
      )
      .reduce(
        (sum, invoice) =>
          sum
          + Number(invoice.balance_due || 0),
        0
      ),

    KHR: currentInvoices
      .filter(
        (invoice) =>
          invoice.currency === "KHR"
      )
      .reduce(
        (sum, invoice) =>
          sum
          + Number(invoice.balance_due || 0),
        0
      )
  }), [currentInvoices]);

  const availableCurrencies = useMemo(
    () =>
      ["USD", "KHR"].filter(
        (currency) =>
          balances[currency] > 0
      ),
    [balances]
  );

  const [currency, setCurrency] =
    useState("USD");
  const [amount, setAmount] =
    useState("");
  const [method, setMethod] =
    useState("bank");
  const [reference, setReference] =
    useState("");
  const [notes, setNotes] =
    useState("");
  const [error, setError] =
    useState("");

  useEffect(() => {
    if (!supplier) return;

    const initial =
      availableCurrencies[0]
      || "USD";

    setCurrency(initial);
    setAmount("");
    setMethod("bank");
    setReference("");
    setNotes("");
    setError("");
  }, [
    supplier,
    availableCurrencies.join("|")
  ]);

  const allocationPreview = useMemo(() => {
    let remaining = Math.max(
      0,
      Number(amount || 0)
    );

    const rows = [];

    for (const invoice of currentInvoices) {
      if (
        invoice.currency !== currency
        || remaining <= 0
      ) {
        continue;
      }

      const allocated = Math.min(
        remaining,
        Number(
          invoice.balance_due || 0
        )
      );

      if (allocated > 0) {
        rows.push({
          ...invoice,
          allocated
        });
        remaining -= allocated;
      }
    }

    return rows;
  }, [
    currentInvoices,
    currency,
    amount
  ]);

  if (!supplier) return null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    const value = Number(amount);
    const outstanding =
      Number(balances[currency] || 0);

    if (
      !Number.isFinite(value)
      || value <= 0
    ) {
      setError(
        "Payment amount must be greater than zero."
      );
      return;
    }

    if (value > outstanding) {
      setError(
        `Payment cannot exceed ${money(
          outstanding,
          currency
        )}.`
      );
      return;
    }

    await onSubmit({
      supplier_id:
        supplier.supplier_id,
      currency,
      amount: value,
      method,
      reference_number:
        reference,
      notes
    });
  }

  return (
    <Modal
      title={`Pay supplier · ${supplier.name}`}
      onClose={() => !busy && onClose()}
      wide
    >
      <form
        className="supplier-payment-form"
        onSubmit={submit}
      >
        <section className="supplier-payment-summary">
          <div>
            <span>Payment branch</span>
            <strong>
              {currentBranchName
                || "Current branch"}
            </strong>
          </div>

          <div>
            <span>USD outstanding</span>
            <strong>
              {money(
                balances.USD,
                "USD"
              )}
            </strong>
          </div>

          <div>
            <span>KHR outstanding</span>
            <strong>
              {money(
                balances.KHR,
                "KHR"
              )}
            </strong>
          </div>
        </section>

        {availableCurrencies.length === 0 ? (
          <div className="notice warning">
            This supplier has no unpaid purchase
            in your current branch.
          </div>
        ) : (
          <>
            <div className="form-grid three">
              <label>
                <span>Currency</span>
                <select
                  value={currency}
                  onChange={(event) => {
                    setCurrency(
                      event.target.value
                    );
                    setAmount("");
                    setError("");
                  }}
                >
                  {availableCurrencies.map(
                    (value) => (
                      <option
                        value={value}
                        key={value}
                      >
                        {value}
                      </option>
                    )
                  )}
                </select>
              </label>

              <label>
                <span>Payment amount</span>
                <input
                  type="number"
                  min="0"
                  step={
                    currency === "KHR"
                      ? "1"
                      : "0.01"
                  }
                  value={amount}
                  onChange={(event) =>
                    setAmount(
                      event.target.value
                    )
                  }
                  placeholder={money(
                    balances[currency],
                    currency
                  )}
                  autoFocus
                />
              </label>

              <label>
                <span>Payment method</span>
                <select
                  value={method}
                  onChange={(event) =>
                    setMethod(
                      event.target.value
                    )
                  }
                >
                  {[
                    "cash",
                    "bank",
                    "khqr",
                    "card",
                    "other"
                  ].map((value) => (
                    <option
                      value={value}
                      key={value}
                    >
                      {payableMethodLabel(
                        value
                      )}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {method === "cash" && (
              <div className="notice warning supplier-cash-notice">
                <Banknote size={19} />
                <span>
                  Cash supplier payments require
                  an open Cash Register for the
                  current branch.
                </span>
              </div>
            )}

            <div className="form-grid two">
              <label>
                <span>Reference number</span>
                <input
                  value={reference}
                  onChange={(event) =>
                    setReference(
                      event.target.value
                    )
                  }
                  placeholder="Bank transfer, cheque or receipt number"
                />
              </label>

              <label>
                <span>Payment note</span>
                <input
                  value={notes}
                  onChange={(event) =>
                    setNotes(
                      event.target.value
                    )
                  }
                  placeholder="Optional note"
                />
              </label>
            </div>

            <section className="supplier-allocation-preview">
              <div className="panel-title-row">
                <div>
                  <strong>
                    Oldest-due allocation
                  </strong>
                  <span className="muted">
                    The payment is applied to the
                    oldest due purchases first.
                  </span>
                </div>
                <HandCoins size={21} />
              </div>

              {allocationPreview.length === 0 ? (
                <p className="muted">
                  Enter a payment amount to preview
                  the allocation.
                </p>
              ) : (
                <div className="supplier-allocation-list">
                  {allocationPreview.map(
                    (invoice) => (
                      <article
                        key={invoice.id}
                      >
                        <div>
                          <strong>
                            {
                              invoice.purchase_number
                            }
                          </strong>
                          <span>
                            Due{" "}
                            {payableDate(
                              invoice.due_date
                            )}
                          </span>
                        </div>

                        <span>
                          Balance{" "}
                          {money(
                            invoice.balance_due,
                            currency
                          )}
                        </span>

                        <strong>
                          {money(
                            invoice.allocated,
                            currency
                          )}
                        </strong>
                      </article>
                    )
                  )}
                </div>
              )}
            </section>
          </>
        )}

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
            disabled={
              busy
              || availableCurrencies.length === 0
            }
          >
            <HandCoins size={18} />
            {busy
              ? "Recording payment..."
              : "Record supplier payment"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
