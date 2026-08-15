import { printElementDocument } from "../lib/listDocuments";
import {
  HandCoins,
  Printer,
  ReceiptText
} from "lucide-react";
import Modal from "./Modal";
import { money } from "../lib/catalog";
import {
  creditDate,
  creditDateTime
} from "../lib/creditAccounts";

function entrySign(value) {
  return Number(value || 0) > 0 ? "+" : "";
}

export default function CreditStatementModal({
  statement,
  loading,
  canReceivePayment,
  onReceivePayment,
  onClose
}) {
  if (!statement && !loading) return null;

  const account = statement?.account;
  const customer = account?.customer;

  return (
    <Modal
      title={
        account
          ? `Credit statement · ${customer?.name}`
          : "Credit statement"
      }
      onClose={onClose}
      wide
      className="credit-statement-modal"
    >
      {loading ? (
        <div className="empty-state">
          <p>Loading credit statement...</p>
        </div>
      ) : (
        <div className="credit-statement-wrapper">
          <article className="credit-statement-document">
            <header className="credit-statement-header">
              <div>
                <p className="eyebrow">
                  CUSTOMER CREDIT STATEMENT
                </p>
                <h2>{customer?.name}</h2>
                <span>
                  {customer?.customer_code}
                  {customer?.company_name
                    ? ` · ${customer.company_name}`
                    : ""}
                </span>
                <small>
                  {[customer?.phone, customer?.email]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </div>

              <div className="credit-statement-balance">
                <span>Balance due</span>
                <strong>
                  {money(
                    account.balance_due,
                    account.currency
                  )}
                </strong>
                <small>
                  Available credit {account.allow_unlimited_credit
                    ? "Unlimited"
                    : money(
                        account.available_credit,
                        account.currency
                      )}
                </small>
              </div>
            </header>

            <section className="credit-statement-summary">
              <div>
                <span>Currency</span>
                <strong>{account.currency}</strong>
              </div>
              <div>
                <span>Credit limit</span>
                <strong>
                  {account.allow_unlimited_credit
                    ? "Unlimited"
                    : money(
                        account.credit_limit,
                        account.currency
                      )}
                </strong>
              </div>
              <div>
                <span>Payment terms</span>
                <strong>
                  {account.payment_terms_days} days
                </strong>
              </div>
              <div>
                <span>Account status</span>
                <strong>
                  {account.is_on_hold
                    ? "On hold"
                    : "Active"}
                </strong>
              </div>
            </section>

            <section className="credit-statement-section">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">
                    OUTSTANDING INVOICES
                  </p>
                  <h3>
                    {(statement.invoices || []).filter(
                      (invoice) =>
                        Number(
                          invoice.outstanding_amount || 0
                        ) > 0
                    ).length} open invoice(s)
                  </h3>
                </div>
                <ReceiptText size={21} />
              </div>

              <div className="credit-statement-table-wrap">
                <table className="credit-statement-table">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Branch</th>
                      <th>Sale date</th>
                      <th>Due date</th>
                      <th>Credit amount</th>
                      <th>Paid</th>
                      <th>Outstanding</th>
                    </tr>
                  </thead>

                  <tbody>
                    {(statement.invoices || []).map(
                      (invoice) => (
                        <tr
                          key={invoice.id}
                          className={
                            invoice.is_overdue
                              ? "credit-invoice-overdue"
                              : ""
                          }
                        >
                          <td data-label="Invoice">
                            <strong>
                              {invoice.invoice_number}
                            </strong>
                            <small>
                              {String(
                                invoice.payment_status
                              ).replaceAll("_", " ")}
                            </small>
                          </td>
                          <td data-label="Branch">
                            {invoice.branch_name}
                          </td>
                          <td data-label="Sale date">
                            {creditDateTime(
                              invoice.completed_at
                            )}
                          </td>
                          <td data-label="Due date">
                            <strong>
                              {creditDate(
                                invoice.credit_due_date
                              )}
                            </strong>
                            {invoice.is_overdue && (
                              <small>Overdue</small>
                            )}
                          </td>
                          <td data-label="Credit amount">
                            {money(
                              invoice.credit_amount,
                              account.currency
                            )}
                          </td>
                          <td data-label="Paid">
                            {money(
                              invoice.paid_amount,
                              account.currency
                            )}
                          </td>
                          <td data-label="Outstanding">
                            <strong>
                              {money(
                                invoice.outstanding_amount,
                                account.currency
                              )}
                            </strong>
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="credit-statement-section">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">
                    PAYMENTS
                  </p>
                  <h3>Customer collections</h3>
                </div>
                <HandCoins size={21} />
              </div>

              {(statement.payments || []).length === 0 ? (
                <p className="muted">
                  No customer payments recorded yet.
                </p>
              ) : (
                <div className="credit-payment-history-list">
                  {statement.payments.map((payment) => (
                    <article key={payment.id}>
                      <div>
                        <strong>
                          {payment.payment_number}
                        </strong>
                        <span>
                          {creditDateTime(
                            payment.paid_at
                          )}
                          {" · "}
                          {payment.branch_name}
                          {" · "}
                          {String(
                            payment.method
                          ).toUpperCase()}
                        </span>
                        {payment.reference_number && (
                          <small>
                            Ref: {payment.reference_number}
                          </small>
                        )}
                      </div>

                      <div>
                        <strong>
                          {money(
                            payment.amount,
                            account.currency
                          )}
                        </strong>
                        <small>
                          {(payment.allocations || [])
                            .map(
                              (allocation) =>
                                `${allocation.invoice_number}: ${money(
                                  allocation.amount,
                                  account.currency
                                )}`
                            )
                            .join(" · ")}
                        </small>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section className="credit-statement-section">
              <div className="panel-title-row">
                <div>
                  <p className="eyebrow">
                    LEDGER
                  </p>
                  <h3>Account activity</h3>
                </div>
              </div>

              <div className="credit-ledger-list">
                {(statement.entries || []).map((entry) => (
                  <article key={entry.id}>
                    <div>
                      <strong>
                        {entry.description}
                      </strong>
                      <span>
                        {creditDateTime(entry.created_at)}
                        {entry.invoice_number
                          ? ` · ${entry.invoice_number}`
                          : ""}
                        {entry.payment_number
                          ? ` · ${entry.payment_number}`
                          : ""}
                        {entry.return_number
                          ? ` · ${entry.return_number}`
                          : ""}
                      </span>
                    </div>

                    <div>
                      <strong
                        className={
                          Number(entry.amount_change) > 0
                            ? "credit-ledger-debit"
                            : "credit-ledger-credit"
                        }
                      >
                        {entrySign(entry.amount_change)}
                        {money(
                          entry.amount_change,
                          account.currency
                        )}
                      </strong>
                      <small>
                        Balance {money(
                          entry.balance_after,
                          account.currency
                        )}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            {account.notes && (
              <footer className="credit-statement-note">
                <strong>Account note</strong>
                <p>{account.notes}</p>
              </footer>
            )}
          </article>

          <div className="receipt-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              Close
            </button>

            {canReceivePayment
              && Number(account.balance_due || 0) > 0 && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    onReceivePayment(account)
                  }
                >
                  <HandCoins size={18} />
                  Receive payment
                </button>
              )}

            <button
              type="button"
              className="primary-button"
              onClick={() => printElementDocument({ title: "Customer Credit Statement", selector: ".credit-statement-document", page: "A4 portrait" })}
            >
              <Printer size={18} />
              Print statement
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
