import {
  Copy,
  LayoutGrid,
  Printer,
  RotateCcw,
  Table2
} from "lucide-react";
import { useEffect, useState } from "react";
import Modal from "./Modal";
import {
  money,
  stockNumber
} from "../lib/catalog";
import {
  invoiceDate,
  invoiceDateTime,
  invoiceStatusLabel,
  paymentMethodLabel
} from "../lib/invoices";

export default function InvoiceDetailModal({
  invoice,
  canViewProfit,
  canRefund,
  onClose,
  onPrint,
  onOpenReturn
}) {
  const [itemViewMode, setItemViewMode] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 850px)").matches
      ? "cards"
      : "table"
  );

  useEffect(() => {
    if (!invoice?.id) return;
    setItemViewMode(
      typeof window !== "undefined" && window.matchMedia("(max-width: 850px)").matches
        ? "cards"
        : "table"
    );
  }, [invoice?.id]);

  if (!invoice) return null;

  async function copyNumber() {
    try {
      await navigator.clipboard.writeText(
        invoice.invoice_number
      );
    } catch {
      window.prompt(
        "Copy invoice number:",
        invoice.invoice_number
      );
    }
  }

  return (
    <Modal
      title={invoice.invoice_number}
      onClose={onClose}
      wide
    >
      <div className="invoice-detail">
        <section className="invoice-detail-header">
          <div>
            <span>Invoice</span>
            <strong>
              {invoice.invoice_number}
            </strong>
            <small>
              {invoiceDateTime(
                invoice.completed_at
                || invoice.created_at
              )}
            </small>
          </div>

          <div>
            <span>Branch</span>
            <strong>
              {invoice.branch_name}
            </strong>
            <small>
              {invoice.branch_code || "—"}
            </small>
          </div>

          <div>
            <span>Customer</span>
            <strong>
              {invoice.customer?.name
                || "Walk-in customer"}
            </strong>
            <small>
              {[
                invoice.customer?.customer_code,
                invoice.customer?.phone
              ]
                .filter(Boolean)
                .join(" · ")
                || "No customer profile"}
            </small>
          </div>

          <div>
            <span>Cashier</span>
            <strong>
              {invoice.cashier_name}
            </strong>
          </div>
        </section>

        <section className="invoice-detail-badges">
          <span className={`invoice-status ${invoice.status}`}>
            {invoiceStatusLabel(invoice.status)}
          </span>

          <span className={`invoice-payment-status ${invoice.payment_status}`}>
            {invoiceStatusLabel(
              invoice.payment_status
            )}
          </span>

          <span className="invoice-payment-method">
            {paymentMethodLabel(
              invoice.payment_method
            )}
          </span>

          {invoice.source_quote_number && (
            <span>
              Quote {invoice.source_quote_number}
            </span>
          )}

          {invoice.price_list_name && (
            <span>
              Price list: {invoice.price_list_name}
            </span>
          )}
        </section>

        <section className="invoice-detail-items">
          <div className="invoice-detail-items-toolbar">
            <div>
              <strong>Invoice items</strong>
              <small>{(invoice.items || []).length} item{(invoice.items || []).length === 1 ? "" : "s"}</small>
            </div>
            <div className="invoice-detail-view-toggle" aria-label="Invoice item view">
              <button
                type="button"
                className={itemViewMode === "table" ? "active" : ""}
                onClick={() => setItemViewMode("table")}
              >
                <Table2 size={17} /> Table
              </button>
              <button
                type="button"
                className={itemViewMode === "cards" ? "active" : ""}
                onClick={() => setItemViewMode("cards")}
              >
                <LayoutGrid size={17} /> Cards
              </button>
            </div>
          </div>

          {itemViewMode === "cards" ? (
            <div className="invoice-detail-item-card-grid">
              {(invoice.items || []).map((item) => (
                <article className="invoice-detail-item-card" key={item.id}>
                  <header>
                    <div>
                      <strong>{item.product_name}</strong>
                      <small>{item.barcode || "No barcode"}</small>
                    </div>
                    <strong>{money(item.line_total, invoice.currency)}</strong>
                  </header>
                  <div className="invoice-detail-item-fields">
                    <div><span>Quantity</span><strong>{stockNumber(item.quantity)} {item.sale_unit_name || "pcs"}</strong><small>{stockNumber(item.base_quantity)} base units</small></div>
                    <div><span>List price</span><strong>{money(item.list_price, invoice.currency)}</strong></div>
                    <div><span>Sale price</span><strong>{money(item.unit_price, invoice.currency)}</strong></div>
                    <div><span>Discount</span><strong>{money(item.discount_amount, invoice.currency)}</strong></div>
                    {canViewProfit && <div><span>Profit</span><strong>{money(item.line_profit, invoice.currency)}</strong></div>}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="invoice-detail-table-wrap">
              <table className="invoice-detail-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Quantity</th>
                    <th>List price</th>
                    <th>Sale price</th>
                    <th>Discount</th>
                    <th>Total</th>
                    {canViewProfit && <th>Profit</th>}
                  </tr>
                </thead>

                <tbody>
                  {(invoice.items || []).map((item) => (
                    <tr key={item.id}>
                      <td data-label="Product">
                        <strong>{item.product_name}</strong>
                        <small>{item.barcode || "No barcode"}</small>
                      </td>
                      <td data-label="Quantity">
                        {stockNumber(item.quantity)} {item.sale_unit_name || "pcs"}
                        <small>{stockNumber(item.base_quantity)} base units</small>
                      </td>
                      <td data-label="List price">{money(item.list_price, invoice.currency)}</td>
                      <td data-label="Sale price">{money(item.unit_price, invoice.currency)}</td>
                      <td data-label="Discount">{money(item.discount_amount, invoice.currency)}</td>
                      <td data-label="Total"><strong>{money(item.line_total, invoice.currency)}</strong></td>
                      {canViewProfit && <td data-label="Profit">{money(item.line_profit, invoice.currency)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="invoice-detail-columns">
          <section className="invoice-detail-section">
            <h3>Payments</h3>

            {invoice.credit_account_id && (
              <article className="invoice-credit-summary">
                <div>
                  <span>Credit due date</span>
                  <strong>
                    {invoiceDate(
                      invoice.credit_due_date
                    )}
                  </strong>
                </div>

                <div>
                  <span>Credit invoice</span>
                  <strong>
                    {money(
                      invoice.credit_amount,
                      invoice.currency
                    )}
                  </strong>
                </div>

                <div>
                  <span>Outstanding</span>
                  <strong>
                    {money(
                      invoice.credit_outstanding,
                      invoice.currency
                    )}
                  </strong>
                </div>
              </article>
            )}

            {(invoice.payments || []).length === 0 ? (
              <p className="muted">
                {invoice.credit_account_id
                  ? "No credit collections recorded yet."
                  : "No payment records."}
              </p>
            ) : (
              <div className="invoice-payment-list">
                {invoice.payments.map((payment) => (
                  <article key={payment.id}>
                    <div>
                      <strong>
                        {paymentMethodLabel(
                          payment.method
                        )}
                      </strong>
                      <span>
                        {invoiceDateTime(
                          payment.paid_at
                        )}
                        {payment.is_credit_collection
                          ? " · Credit collection"
                          : ""}
                      </span>
                    </div>

                    <div>
                      <strong>
                        {money(
                          payment.amount,
                          payment.currency
                        )}
                      </strong>
                      <span>
                        {payment.reference_number
                          || "No reference"}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="invoice-detail-section">
            <h3>Returns & refunds</h3>

            {(invoice.returns || []).length === 0 ? (
              <p className="muted">
                No returns for this invoice.
              </p>
            ) : (
              <div className="invoice-return-list">
                {invoice.returns.map((refund) => (
                  <article key={refund.id}>
                    <div>
                      <strong>
                        {refund.return_number}
                      </strong>
                      <span>
                        {invoiceDateTime(
                          refund.processed_at
                        )}
                        {" · "}
                        {paymentMethodLabel(
                          refund.refund_method
                        )}
                      </span>
                    </div>

                    <div>
                      <strong>
                        -{money(
                          refund.refund_amount,
                          refund.currency
                        )}
                      </strong>
                      <span>
                        {refund.reason || "No reason"}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="invoice-detail-total-grid">
          <div>
            <span>Subtotal</span>
            <strong>
              {money(
                invoice.subtotal,
                invoice.currency
              )}
            </strong>
          </div>

          <div>
            <span>Price adjustment</span>
            <strong>
              {money(
                invoice.price_adjustment_amount,
                invoice.currency
              )}
            </strong>
          </div>

          <div>
            <span>Discount</span>
            <strong>
              -{money(
                invoice.discount_amount,
                invoice.currency
              )}
            </strong>
          </div>

          <div>
            <span>Tax</span>
            <strong>
              {money(
                invoice.tax_amount,
                invoice.currency
              )}
            </strong>
          </div>

          <div>
            <span>Gross total</span>
            <strong>
              {money(
                invoice.total_amount,
                invoice.currency
              )}
            </strong>
          </div>

          <div>
            <span>Refunded</span>
            <strong>
              -{money(
                invoice.refunded_amount,
                invoice.currency
              )}
            </strong>
          </div>

          <div className="invoice-net-total">
            <span>Net total</span>
            <strong>
              {money(
                invoice.net_total,
                invoice.currency
              )}
            </strong>
          </div>

          {canViewProfit && (
            <div>
              <span>Net profit</span>
              <strong>
                {money(
                  invoice.net_profit,
                  invoice.currency
                )}
              </strong>
            </div>
          )}
        </section>

        {invoice.notes && (
          <section className="invoice-detail-notes">
            <strong>Invoice note</strong>
            <p>{invoice.notes}</p>
          </section>
        )}

        <div className="modal-actions invoice-detail-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={copyNumber}
          >
            <Copy size={17} />
            Copy number
          </button>

          {canRefund
            && !["voided", "refunded"]
              .includes(invoice.status) && (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                onOpenReturn(invoice)
              }
            >
              <RotateCcw size={17} />
              Return / refund
            </button>
          )}

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
            onClick={() => onPrint(invoice)}
          >
            <Printer size={18} />
            Reprint receipt
          </button>
        </div>
      </div>
    </Modal>
  );
}
