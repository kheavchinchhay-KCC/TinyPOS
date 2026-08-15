import { useEffect, useState } from "react";
import {
  CalendarDays,
  Edit3,
  Gift,
  Mail,
  MapPin,
  Phone,
  ReceiptText,
  RotateCcw,
  UserCheck,
  UserX
} from "lucide-react";
import Modal from "./Modal";
import { money, stockNumber } from "../lib/catalog";

function dateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function dateOnly(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(new Date(`${value}T00:00:00`));
}

export default function CustomerDetailModal({
  customer,
  detail,
  loading,
  onClose,
  onEdit,
  onLoyalty,
  onToggleStatus
}) {
  const [tab, setTab] = useState("sales");

  useEffect(() => {
    if (customer) setTab("sales");
  }, [customer]);

  if (!customer) return null;

  const summaryCurrency = customer.summary_currency || "USD";

  return (
    <Modal title="Customer details" onClose={onClose} wide>
      <div className="customer-detail">
        <section className="customer-detail-header">
          <div className="customer-avatar-large">
            {customer.name.slice(0, 1).toUpperCase()}
          </div>

          <div className="customer-detail-identity">
            <div>
              <h2>{customer.name}</h2>
              <span className={`customer-type-badge ${customer.customer_type}`}>
                {customer.customer_type}
              </span>
              <span className={`status-pill ${customer.is_active ? "active" : "inactive"}`}>
                {customer.is_active ? "Active" : "Inactive"}
              </span>
            </div>
            <p>
              {customer.customer_code}
              {customer.company_name ? ` · ${customer.company_name}` : ""}
            </p>
          </div>

          <div className="customer-detail-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => onEdit(customer)}
            >
              <Edit3 size={17} />
              Edit
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onLoyalty(customer)}
            >
              <Gift size={17} />
              Loyalty
            </button>
            <button
              type="button"
              className={customer.is_active ? "danger-button" : "primary-button"}
              onClick={() => onToggleStatus(customer)}
            >
              {customer.is_active ? <UserX size={17} /> : <UserCheck size={17} />}
              {customer.is_active ? "Deactivate" : "Reactivate"}
            </button>
          </div>
        </section>

        <section className="customer-contact-grid">
          <div>
            <Phone size={17} />
            <span>Phone</span>
            <strong>{customer.phone || "—"}</strong>
          </div>
          <div>
            <Mail size={17} />
            <span>Email</span>
            <strong>{customer.email || "—"}</strong>
          </div>
          <div>
            <CalendarDays size={17} />
            <span>Birthday</span>
            <strong>{dateOnly(customer.date_of_birth)}</strong>
          </div>
          <div>
            <MapPin size={17} />
            <span>Address</span>
            <strong>{customer.address || "—"}</strong>
          </div>
        </section>

        <section className="customer-stat-grid">
          <article>
            <span>Net spent</span>
            <strong>{money(customer.net_spent, summaryCurrency)}</strong>
            <small>After refunds</small>
          </article>
          <article>
            <span>Purchases</span>
            <strong>{Number(customer.sale_count || 0).toLocaleString("en-US")}</strong>
            <small>Completed invoices</small>
          </article>
          <article>
            <span>Average sale</span>
            <strong>{money(customer.average_sale, summaryCurrency)}</strong>
            <small>Per invoice</small>
          </article>
          <article>
            <span>Refunded</span>
            <strong>{money(customer.refund_amount, summaryCurrency)}</strong>
            <small>{Number(customer.refund_count || 0)} refunds</small>
          </article>
          <article>
            <span>Loyalty points</span>
            <strong>{Number(customer.loyalty_points || 0).toLocaleString("en-US")}</strong>
            <small>Current balance</small>
          </article>
          <article>
            <span>Last purchase</span>
            <strong>{customer.last_purchase_at ? dateOnly(customer.last_purchase_at.slice(0, 10)) : "—"}</strong>
            <small>All branches</small>
          </article>
        </section>

        {(customer.notes
          || customer.allow_unlimited_credit
          || Number(customer.credit_limit || 0) > 0) && (
          <section className="customer-notes-card">
            <div>
              <span>Credit limit</span>
              <strong>
                {customer.allow_unlimited_credit
                  ? "Unlimited"
                  : money(customer.credit_limit, summaryCurrency)}
              </strong>
            </div>
            <div>
              <span>Notes</span>
              <p>{customer.notes || "—"}</p>
            </div>
          </section>
        )}

        <div className="customer-detail-tabs">
          <button
            type="button"
            className={tab === "sales" ? "active" : ""}
            onClick={() => setTab("sales")}
          >
            <ReceiptText size={17} />
            Purchases ({detail?.sales?.length || 0})
          </button>
          <button
            type="button"
            className={tab === "returns" ? "active" : ""}
            onClick={() => setTab("returns")}
          >
            <RotateCcw size={17} />
            Refunds ({detail?.returns?.length || 0})
          </button>
          <button
            type="button"
            className={tab === "loyalty" ? "active" : ""}
            onClick={() => setTab("loyalty")}
          >
            <Gift size={17} />
            Loyalty history ({detail?.loyalty?.length || 0})
          </button>
        </div>

        {loading ? (
          <div className="customer-detail-loading">Loading history...</div>
        ) : tab === "sales" ? (
          <div className="customer-history-list">
            {(detail?.sales || []).length === 0 ? (
              <div className="customer-history-empty">No purchase history.</div>
            ) : (
              detail.sales.map((sale) => (
                <article key={sale.id}>
                  <div className="customer-history-main">
                    <span>
                      <strong>{sale.invoice_number}</strong>
                      <small>
                        {dateTime(sale.completed_at || sale.created_at)}
                        {sale.branches?.name ? ` · ${sale.branches.name}` : ""}
                      </small>
                    </span>
                    <span>
                      <strong>{money(sale.total_amount, sale.currency)}</strong>
                      <small>{String(sale.status).replaceAll("_", " ")}</small>
                    </span>
                  </div>
                  <div className="customer-history-items">
                    {(sale.sale_items || []).map((item) => (
                      <span key={item.id}>
                        {item.product_name} · {stockNumber(item.quantity)} × {money(item.unit_price, sale.currency)}
                      </span>
                    ))}
                  </div>
                </article>
              ))
            )}
          </div>
        ) : tab === "returns" ? (
          <div className="customer-history-list">
            {(detail?.returns || []).length === 0 ? (
              <div className="customer-history-empty">No refund history.</div>
            ) : (
              detail.returns.map((refund) => (
                <article key={refund.id}>
                  <div className="customer-history-main">
                    <span>
                      <strong>{refund.return_number}</strong>
                      <small>
                        {dateTime(refund.processed_at)}
                        {refund.branches?.name ? ` · ${refund.branches.name}` : ""}
                      </small>
                    </span>
                    <span>
                      <strong>-{money(refund.refund_amount, refund.currency)}</strong>
                      <small>{String(refund.refund_method).toUpperCase()}</small>
                    </span>
                  </div>
                  <div className="customer-history-items">
                    <span>
                      Original invoice: {refund.sales?.invoice_number || "—"}
                    </span>
                    {(refund.return_items || []).map((item) => (
                      <span key={item.id}>
                        {item.sale_items?.product_name || "Returned item"} · {stockNumber(item.quantity)}
                        {item.restock ? " · Restocked" : " · Not restocked"}
                      </span>
                    ))}
                    <span>Reason: {refund.reason}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        ) : (
          <div className="customer-history-list loyalty-history-list">
            {(detail?.loyalty || []).length === 0 ? (
              <div className="customer-history-empty">No loyalty adjustments.</div>
            ) : (
              detail.loyalty.map((movement) => (
                <article key={movement.id}>
                  <div className="customer-history-main">
                    <span>
                      <strong>{movement.reason}</strong>
                      <small>{dateTime(movement.created_at)}</small>
                    </span>
                    <span>
                      <strong className={Number(movement.points_change) >= 0 ? "points-positive" : "points-negative"}>
                        {Number(movement.points_change) >= 0 ? "+" : ""}
                        {Number(movement.points_change).toLocaleString("en-US")}
                      </strong>
                      <small>
                        {Number(movement.points_before).toLocaleString("en-US")} → {Number(movement.points_after).toLocaleString("en-US")}
                      </small>
                    </span>
                  </div>
                </article>
              ))
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
