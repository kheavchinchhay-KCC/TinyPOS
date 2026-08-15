import { printElementDocument } from "../lib/listDocuments";
import { Printer } from "lucide-react";
import Modal from "./Modal";
import { money, stockNumber } from "../lib/catalog";
import {
  dateOnly,
  dateTime,
  purchaseBalance,
  purchasePaymentStatus,
  purchaseReceivingStatusLabel,
  purchaseItemRemainingQuantity
} from "../lib/purchaseOrders";

export default function PurchaseOrderPrintModal({
  purchase,
  shop,
  branch,
  onClose,
  onPrintReceipt
}) {
  if (!purchase) return null;

  return (
    <Modal
      title={purchase.purchase_number}
      onClose={onClose}
      wide
    >
      <div className="po-print-wrapper">
        <article className="po-print-document">
          <header className="po-print-header">
            <div className="po-print-shop">
              {shop?.shop_logo_url && (
                <img
                  src={shop.shop_logo_url}
                  alt=""
                />
              )}
              <div>
                <h2>{shop?.shop_name || "Tiny POS"}</h2>
                {shop?.shop_address && (
                  <p>{shop.shop_address}</p>
                )}
                {shop?.shop_phone && (
                  <p>{shop.shop_phone}</p>
                )}
                {shop?.shop_email && (
                  <p>{shop.shop_email}</p>
                )}
              </div>
            </div>

            <div className="po-print-title">
              <strong>PURCHASE ORDER</strong>
              <span>{purchase.purchase_number}</span>
            </div>
          </header>

          <section className="po-print-parties">
            <div>
              <span>Supplier</span>
              <strong>
                {purchase.suppliers?.name || "—"}
              </strong>
              <p>
                {purchase.suppliers?.supplier_code || ""}
              </p>
              {purchase.suppliers?.contact_name && (
                <p>{purchase.suppliers.contact_name}</p>
              )}
              {purchase.suppliers?.phone && (
                <p>{purchase.suppliers.phone}</p>
              )}
              {purchase.suppliers?.email && (
                <p>{purchase.suppliers.email}</p>
              )}
              {purchase.suppliers?.address && (
                <p>{purchase.suppliers.address}</p>
              )}
            </div>

            <div>
              <div>
                <span>Branch</span>
                <strong>
                  {branch?.name || "Main Branch"}
                </strong>
              </div>
              <div>
                <span>Created</span>
                <strong>
                  {dateTime(purchase.created_at)}
                </strong>
              </div>
              <div>
                <span>Expected</span>
                <strong>
                  {dateOnly(purchase.expected_date)}
                </strong>
              </div>
              <div>
                <span>Status</span>
                <strong>
                  {purchaseReceivingStatusLabel(purchase).toUpperCase()}
                </strong>
              </div>
              <div>
                <span>Payment</span>
                <strong>
                  {purchasePaymentStatus(
                    purchase
                  ).toUpperCase()}
                </strong>
              </div>
            </div>
          </section>

          <table className="po-print-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>Code</th>
                <th>Ordered</th>
                <th>Received</th>
                <th>Remaining</th>
                <th>Base received</th>
                <th>Cost per purchase unit</th>
                <th>Total</th>
              </tr>
            </thead>

            <tbody>
              {(purchase.purchase_items || []).map(
                (item, index) => (
                  <tr key={item.id}>
                    <td data-label="#">{index + 1}</td>
                    <td data-label="Product">
                      {item.products?.name || "Product"}
                    </td>
                    <td data-label="Code">
                      {item.products?.sku
                        || item.products?.barcode
                        || "—"}
                    </td>
                    <td data-label="Ordered">
                      {stockNumber(item.quantity)}
                      {" "}
                      {item.purchase_unit_name || "pcs"}
                    </td>
                    <td data-label="Received">
                      {stockNumber(item.received_quantity)}
                      {" "}
                      {item.purchase_unit_name || "pcs"}
                    </td>
                    <td data-label="Remaining">
                      {stockNumber(
                        purchaseItemRemainingQuantity(item)
                      )}
                      {" "}
                      {item.purchase_unit_name || "pcs"}
                    </td>
                    <td data-label="Base received">
                      {stockNumber(item.base_received_quantity)}
                      {" "}
                      {item.products?.unit_name || "pcs"}
                    </td>
                    <td data-label="Cost / unit">
                      {money(
                        item.unit_cost,
                        purchase.currency
                      )}
                    </td>
                    <td data-label="Total">
                      {money(
                        item.line_total,
                        purchase.currency
                      )}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>

          <section className="po-print-bottom">
            <div className="po-print-notes">
              {purchase.payment_terms && (
                <p>
                  <strong>Payment terms:</strong>
                  {" "}
                  {purchase.payment_terms}
                </p>
              )}
              {purchase.delivery_address && (
                <p>
                  <strong>Delivery:</strong>
                  {" "}
                  {purchase.delivery_address}
                </p>
              )}
              {purchase.supplier_invoice_number && (
                <p>
                  <strong>Supplier invoice:</strong>
                  {" "}
                  {purchase.supplier_invoice_number}
                </p>
              )}
              {purchase.notes && (
                <p>
                  <strong>Notes:</strong>
                  {" "}
                  {purchase.notes}
                </p>
              )}
            </div>

            <div className="po-print-totals">
              <div>
                <span>Subtotal</span>
                <strong>
                  {money(
                    purchase.subtotal,
                    purchase.currency
                  )}
                </strong>
              </div>
              <div>
                <span>Discount</span>
                <strong>
                  -{money(
                    purchase.discount_amount,
                    purchase.currency
                  )}
                </strong>
              </div>
              <div>
                <span>Tax</span>
                <strong>
                  {money(
                    purchase.tax_amount,
                    purchase.currency
                  )}
                </strong>
              </div>
              <div className="po-print-grand">
                <span>Total</span>
                <strong>
                  {money(
                    purchase.total_amount,
                    purchase.currency
                  )}
                </strong>
              </div>
              <div>
                <span>Paid</span>
                <strong>
                  {money(
                    purchase.amount_paid,
                    purchase.currency
                  )}
                </strong>
              </div>
              <div>
                <span>Balance due</span>
                <strong>
                  {money(
                    purchaseBalance(purchase),
                    purchase.currency
                  )}
                </strong>
              </div>
            </div>
          </section>

          {(purchase.purchase_receipts || []).length > 0 && (
            <section className="po-receipt-history-print">
              <div className="panel-title-row">
                <div>
                  <strong>Goods-received notes</strong>
                  <span>
                    {(purchase.purchase_receipts || []).length}
                    {" receipt event"}
                    {(purchase.purchase_receipts || []).length === 1
                      ? ""
                      : "s"}
                  </span>
                </div>
              </div>

              <div className="po-receipt-history-list">
                {(purchase.purchase_receipts || []).map((receipt) => {
                  const value = (
                    receipt.purchase_receipt_items || []
                  ).reduce(
                    (sum, item) =>
                      sum + Number(item.line_total || 0),
                    0
                  );

                  return (
                    <article key={receipt.id}>
                      <div>
                        <strong>{receipt.receipt_number}</strong>
                        <span>{dateTime(receipt.received_at)}</span>
                      </div>

                      <div>
                        <span>Items</span>
                        <strong>
                          {(receipt.purchase_receipt_items || []).length}
                        </strong>
                      </div>

                      <div>
                        <span>Value</span>
                        <strong>
                          {money(value, purchase.currency)}
                        </strong>
                      </div>

                      <button
                        type="button"
                        className="secondary-button compact"
                        onClick={() => onPrintReceipt?.(receipt)}
                      >
                        View GRN
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <footer className="po-print-signatures">
            <div><span>Prepared by</span></div>
            <div><span>Approved by</span></div>
            <div><span>Supplier signature</span></div>
          </footer>
        </article>

        <div className="po-print-actions">
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
            onClick={() => printElementDocument({
              title: `Purchase Order ${purchase.purchase_number}`,
              selector: ".po-print-document",
              page: "A4 portrait",
              styles: `
                .po-print-document{width:100%!important;max-width:none!important;margin:0!important;padding:0!important;box-shadow:none!important;font-size:10px!important}
                .po-print-header{gap:14px!important;padding-bottom:8px!important}.po-print-title strong{font-size:18px!important}
                .po-print-parties{gap:18px!important;padding:10px 0!important}.po-print-table th,.po-print-table td{padding:4px!important;font-size:8px!important}
                .po-print-bottom{grid-template-columns:1fr 230px!important;gap:15px!important;padding-top:10px!important}
                .po-receipt-history-print{break-before:auto!important;break-inside:auto!important}.po-print-signatures{margin-top:24px!important;break-inside:avoid!important}
              `
            })}
          >
            <Printer size={18} />
            Print purchase order
          </button>
        </div>
      </div>
    </Modal>
  );
}
