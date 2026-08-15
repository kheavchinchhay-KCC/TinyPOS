import { printElementDocument } from "../lib/listDocuments";
import {
  Printer,
  ReceiptText
} from "lucide-react";
import Modal from "./Modal";
import { money } from "../lib/catalog";
import {
  payableDate,
  payableDateTime,
  payableMethodLabel
} from "../lib/payables";

function transactionLabel(type) {
  const labels = {
    purchase: "Purchase",
    supplier_return: "Supplier return",
    payment: "Payment"
  };

  return labels[type] || type;
}

export default function SupplierStatementModal({
  statement,
  loading,
  shop,
  onClose
}) {
  if (!statement && !loading) return null;

  return (
    <Modal
      title={
        statement
          ? `Supplier statement · ${statement.supplier?.name}`
          : "Supplier statement"
      }
      onClose={onClose}
      wide
    >
      {loading ? (
        <div className="empty-state">
          <p>Loading supplier statement...</p>
        </div>
      ) : (
        <div className="supplier-statement-wrapper">
          <article className="supplier-statement-document">
            <header className="supplier-statement-header">
              <div className="supplier-statement-shop">
                {shop?.shop_logo_url && (
                  <img
                    src={shop.shop_logo_url}
                    alt=""
                  />
                )}

                <div>
                  <h2>
                    {shop?.shop_name
                      || "Tiny POS"}
                  </h2>

                  {shop?.shop_address && (
                    <p>
                      {shop.shop_address}
                    </p>
                  )}

                  {shop?.shop_phone && (
                    <p>{shop.shop_phone}</p>
                  )}

                  {shop?.shop_email && (
                    <p>{shop.shop_email}</p>
                  )}
                </div>
              </div>

              <div className="supplier-statement-title">
                <strong>
                  SUPPLIER STATEMENT
                </strong>
                <span>
                  {payableDate(
                    statement.meta?.from
                  )}
                  {" – "}
                  {payableDate(
                    statement.meta?.to
                  )}
                </span>
                <small>
                  {statement.meta?.scope
                    === "all_branches"
                    ? "All branches"
                    : "Current branch"}
                </small>
              </div>
            </header>

            <section className="supplier-statement-party">
              <div>
                <span>Supplier</span>
                <strong>
                  {statement.supplier?.name}
                </strong>
                <p>
                  {
                    statement.supplier
                      ?.supplier_code
                  }
                </p>

                {statement.supplier
                  ?.contact_name && (
                  <p>
                    {
                      statement.supplier
                        .contact_name
                    }
                  </p>
                )}

                {statement.supplier?.phone && (
                  <p>
                    {statement.supplier.phone}
                  </p>
                )}

                {statement.supplier?.email && (
                  <p>
                    {statement.supplier.email}
                  </p>
                )}

                {statement.supplier?.address && (
                  <p>
                    {statement.supplier.address}
                  </p>
                )}
              </div>

              <div>
                <div>
                  <span>Payment terms</span>
                  <strong>
                    {
                      statement.supplier
                        ?.default_payment_terms_days
                    }
                    {" days"}
                  </strong>
                </div>

                <div>
                  <span>Opening USD</span>
                  <strong>
                    {money(
                      statement.opening?.USD,
                      "USD"
                    )}
                  </strong>
                </div>

                <div>
                  <span>Opening KHR</span>
                  <strong>
                    {money(
                      statement.opening?.KHR,
                      "KHR"
                    )}
                  </strong>
                </div>

                <div>
                  <span>Closing USD</span>
                  <strong>
                    {money(
                      statement.closing?.USD,
                      "USD"
                    )}
                  </strong>
                </div>

                <div>
                  <span>Closing KHR</span>
                  <strong>
                    {money(
                      statement.closing?.KHR,
                      "KHR"
                    )}
                  </strong>
                </div>
              </div>
            </section>

            <table className="supplier-statement-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Reference</th>
                  <th>Branch</th>
                  <th>Description</th>
                  <th>Debit</th>
                  <th>Credit</th>
                  <th>Balance</th>
                </tr>
              </thead>

              <tbody>
                {(statement.transactions || [])
                  .length === 0 ? (
                  <tr>
                    <td
                      colSpan="8"
                      className="supplier-statement-empty"
                    >
                      No transactions in this date
                      range.
                    </td>
                  </tr>
                ) : (
                  statement.transactions.map(
                    (row, index) => (
                      <tr
                        key={`${row.reference}-${row.occurred_at}-${index}`}
                      >
                        <td>
                          {payableDateTime(
                            row.occurred_at
                          )}
                        </td>

                        <td>
                          {transactionLabel(
                            row.transaction_type
                          )}
                        </td>

                        <td>{row.reference}</td>
                        <td>{row.branch_name}</td>
                        <td>{row.description}</td>

                        <td>
                          {Number(row.debit || 0) > 0
                            ? money(
                                row.debit,
                                row.currency
                              )
                            : "—"}
                        </td>

                        <td>
                          {Number(row.credit || 0) > 0
                            ? money(
                                row.credit,
                                row.currency
                              )
                            : "—"}
                        </td>

                        <td>
                          <strong>
                            {money(
                              row.running_balance,
                              row.currency
                            )}
                          </strong>
                        </td>
                      </tr>
                    )
                  )
                )}
              </tbody>
            </table>

            <section className="supplier-statement-open">
              <div className="supplier-statement-section-title">
                <ReceiptText size={20} />
                <strong>
                  Open purchase balances
                </strong>
              </div>

              {(statement.open_invoices || [])
                .length === 0 ? (
                <p>
                  No open purchase balances.
                </p>
              ) : (
                <table className="supplier-open-table">
                  <thead>
                    <tr>
                      <th>Purchase</th>
                      <th>Branch</th>
                      <th>Received</th>
                      <th>Due</th>
                      <th>Total</th>
                      <th>Paid</th>
                      <th>Return credit</th>
                      <th>Balance</th>
                    </tr>
                  </thead>

                  <tbody>
                    {statement.open_invoices.map(
                      (invoice) => (
                        <tr
                          key={
                            invoice.purchase_number
                          }
                        >
                          <td>
                            {
                              invoice.purchase_number
                            }
                          </td>
                          <td>
                            {invoice.branch_name}
                          </td>
                          <td>
                            {payableDateTime(
                              invoice.received_at
                            )}
                          </td>
                          <td>
                            {payableDate(
                              invoice.payment_due_date
                            )}
                          </td>
                          <td>
                            {money(
                              invoice.total_amount,
                              invoice.currency
                            )}
                          </td>
                          <td>
                            {money(
                              invoice.amount_paid,
                              invoice.currency
                            )}
                          </td>
                          <td>
                            {money(
                              invoice.return_credit,
                              invoice.currency
                            )}
                          </td>
                          <td>
                            <strong>
                              {money(
                                invoice.balance_due,
                                invoice.currency
                              )}
                            </strong>
                          </td>
                        </tr>
                      )
                    )}
                  </tbody>
                </table>
              )}
            </section>

            <footer className="supplier-statement-footer">
              <p>
                Generated{" "}
                {payableDateTime(
                  statement.meta?.generated_at
                )}
              </p>
            </footer>
          </article>

          <div className="supplier-statement-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              Close
            </button>

            <button
              type="button"
              className="primary-button"
              onClick={() => printElementDocument({ title: "Supplier Statement", selector: ".supplier-statement-document", page: "A4 portrait" })}
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
