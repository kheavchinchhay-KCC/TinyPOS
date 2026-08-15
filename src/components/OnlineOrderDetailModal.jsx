import { Download, ReceiptText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  onlineDate,
  onlineDateTime,
  onlineMoney,
  onlineStatusLabel
} from "../lib/onlineStore";
import MediaImage from "./MediaImage";
import MediaPreviewModal from "./MediaPreviewModal";
import { downloadMediaFile } from "../lib/media";

const nextStatuses = [
  ["preparing", "Preparing"],
  ["ready", "Ready for customer"],
  ["partially_fulfilled", "Partially fulfilled"],
  ["fulfilled", "Fulfilled"],
  ["cancelled", "Cancelled"],
  ["rejected", "Rejected"]
];

export default function OnlineOrderDetailModal({
  order,
  busy,
  canReceive,
  canManage,
  canFulfill,
  onClose,
  onConfirm,
  onStatus,
  onOpenSalesOrder
}) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState(order?.status === "confirmed" ? "preparing" : "ready");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mediaError, setMediaError] = useState("");
  const closed = useMemo(
    () => ["fulfilled", "cancelled", "rejected"].includes(order?.status),
    [order?.status]
  );

  useEffect(() => {
    if (!order) return;
    setNote("");
    setStatus(order.status === "confirmed" ? "preparing" : "ready");
  }, [order?.id, order?.status]);

  if (!order) return null;

  async function changeStatus() {
    await onStatus(order.id, status, note);
    setNote("");
  }

  return (
    <div className="modal-backdrop">
      <div className="modal wide online-order-detail">
        <div className="modal-head">
          <div>
            <p className="eyebrow">CUSTOMER WEB ORDER</p>
            <h2>{order.order_number}</h2>
            <span className={`status-badge ${order.status}`}>{onlineStatusLabel(order.status)}</span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="online-order-summary-grid">
          <div><small>Customer</small><strong>{order.customer_name}</strong><span>{order.customer_phone}</span>{order.customer_email && <span>{order.customer_email}</span>}</div>
          <div><small>Fulfilment</small><strong>{order.fulfilment_type === "delivery" ? "Delivery" : "Branch pickup"}</strong><span>Requested: {onlineDate(order.requested_date)}</span></div>
          <div><small>Payment</small><strong>{String(order.payment_method).replaceAll("_", " ")}</strong><span>{String(order.payment_status).replaceAll("_", " ")}</span>{order.bank_reference && <span>Ref: {order.bank_reference}</span>}</div>
          <div><small>Created</small><strong>{onlineDateTime(order.created_at)}</strong><span>{order.branches?.name || "Current branch"}</span></div>
        </div>

        {order.bank_slip_url && (
          <section className="online-bank-slip-card">
            <button type="button" className="online-bank-slip-preview" onClick={() => setPreviewOpen(true)}>
              <MediaImage src={order.bank_slip_url} alt="Customer bank slip" width={520} height={380} />
            </button>
            <div>
              <p className="eyebrow">BANK TRANSFER EVIDENCE</p>
              <h3>Customer payment slip</h3>
              <p>Review this evidence before receiving the order. The payment remains pending confirmation until staff verifies it.</p>
              {mediaError && <div className="notice error">{mediaError}</div>}
              <div className="button-row">
                <button type="button" className="secondary-button" onClick={() => setPreviewOpen(true)}>View slip</button>
                <button type="button" className="secondary-button" onClick={async () => {
                  try {
                    setMediaError("");
                    await downloadMediaFile(order.bank_slip_url, `${order.order_number}-bank-slip`);
                  } catch (error) {
                    setMediaError(error.message);
                  }
                }}><Download size={17} />Download</button>
              </div>
            </div>
          </section>
        )}

        {order.delivery_address && <section className="online-order-note"><strong>Delivery address</strong><p>{order.delivery_address}</p></section>}
        {order.customer_note && <section className="online-order-note"><strong>Customer note</strong><p>{order.customer_note}</p></section>}

        {order.sales_order_id && (
          <section className="online-order-sales-order-link">
            <div>
              <small>Reserved Sales Order</small>
              <strong>{order.sales_orders?.order_number || "Sales Order ready"}</strong>
              <span>{order.sales_orders?.status ? `Status: ${String(order.sales_orders.status).replaceAll("_", " ")}` : "Stock reservation created"}</span>
            </div>
            {canFulfill && (
              <button type="button" className="secondary-button" onClick={() => onOpenSalesOrder(order.sales_order_id)}>
                Open Sales Order / issue receipt
              </button>
            )}
          </section>
        )}

        <section className="online-order-products-section">
          <div className="online-order-section-heading">
            <div>
              <p className="eyebrow">ORDER ITEMS</p>
              <h3>Products</h3>
            </div>
            <strong>{(order.online_order_items || []).length} lines</strong>
          </div>

          <div className="online-order-items-list" role="table" aria-label="Online order products">
            <div className="online-order-item-row online-order-item-head" role="row">
              <span>Product</span>
              <span>Unit</span>
              <span>Qty</span>
              <span>Price</span>
              <span>Total</span>
            </div>
            {(order.online_order_items || []).map((item) => (
              <div className="online-order-item-row" role="row" key={item.id}>
                <div className="online-order-item-product" role="cell">
                  <strong>{item.product_name}</strong>
                  <small>{item.sku || item.barcode || "—"}</small>
                </div>
                <div className="online-order-item-value" data-label="Unit" role="cell"><strong>{item.unit_name}</strong></div>
                <div className="online-order-item-value" data-label="Qty" role="cell"><strong>{item.quantity}</strong></div>
                <div className="online-order-item-value" data-label="Price" role="cell"><strong>{onlineMoney(item.unit_price, order.currency)}</strong></div>
                <div className="online-order-item-value online-order-line-total" data-label="Total" role="cell"><strong>{onlineMoney(item.line_total, order.currency)}</strong></div>
              </div>
            ))}
          </div>
        </section>

        <div className="online-order-totals">
          <div><span>Subtotal</span><strong>{onlineMoney(order.subtotal, order.currency)}</strong></div>
          <div><span>Delivery fee</span><strong>{onlineMoney(order.delivery_fee, order.currency)}</strong></div>
          <div className="grand"><span>Total</span><strong>{onlineMoney(order.total_amount, order.currency)}</strong></div>
        </div>

        {(order.online_order_status_history || []).length > 0 && (
          <section className="online-status-history">
            <h3>Status history</h3>
            {(order.online_order_status_history || []).map((entry) => (
              <div key={entry.id}><span className={`status-dot ${entry.to_status}`} /><div><strong>{onlineStatusLabel(entry.to_status)}</strong><small>{onlineDateTime(entry.changed_at)}</small>{entry.note && <p>{entry.note}</p>}</div></div>
            ))}
          </section>
        )}

        {(canReceive || (canFulfill && order.sales_order_id) || canManage) && !closed && (
          <section className="online-order-actions">
            {canReceive && order.status === "pending" && (
              <button type="button" onClick={() => onConfirm(order.id)} disabled={busy}>
                <ReceiptText size={18} /> Receive order & reserve stock
              </button>
            )}

            {canManage && (
              <div className="online-status-editor">
                <select value={status} onChange={(event) => setStatus(event.target.value)}>
                  {nextStatuses.filter(([value]) => value !== order.status).map(([value, itemLabel]) => <option value={value} key={value}>{itemLabel}</option>)}
                </select>
                <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Status note or cancellation reason" />
                <button type="button" className="secondary" onClick={changeStatus} disabled={busy}>Update status</button>
              </div>
            )}
          </section>
        )}

        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
      </div>
      <MediaPreviewModal
        open={previewOpen}
        src={order.bank_slip_url}
        title={`${order.order_number} · Bank slip`}
        downloadName={`${order.order_number}-bank-slip`}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  );
}
