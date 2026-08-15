import { printElementDocument } from "../lib/listDocuments";
import {
  Printer,
  ReceiptText,
  Truck
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";
import {
  money,
  stockNumber
} from "../lib/catalog";
import {
  salesOrderDate,
  salesOrderDateTime,
  salesOrderStatusLabel
} from "../lib/salesOrders";

export default function SalesOrderDocumentModal({
  order,
  shop,
  branch,
  onClose
}) {
  const completedDeliveries = useMemo(
    () =>
      (order?.sales_order_deliveries || [])
        .filter(
          (delivery) =>
            delivery.status === "completed"
        ),
    [order]
  );

  const [documentKey, setDocumentKey] =
    useState("order");

  useEffect(() => {
    setDocumentKey("order");
  }, [order?.id]);

  if (!order) return null;

  const delivery = completedDeliveries.find(
    (row) => row.id === documentKey
  );

  const isDelivery = Boolean(delivery);
  const rows = isDelivery
    ? delivery.sales_order_delivery_items || []
    : order.sales_order_items || [];

  const number = isDelivery
    ? delivery.delivery_number
    : order.order_number;

  const title = isDelivery
    ? "DELIVERY NOTE"
    : "SALES ORDER";

  return (
    <Modal
      title={`${order.order_number} documents`}
      onClose={onClose}
      wide
      className="sales-order-document-modal"
      bodyClassName="sales-order-document-modal-body"
    >
      <div className="sales-order-document-wrapper">
        <div className="sales-order-document-tabs">
          <button
            type="button"
            className={
              documentKey === "order"
                ? "active"
                : ""
            }
            onClick={() =>
              setDocumentKey("order")
            }
          >
            <ReceiptText size={17} />
            Sales Order
          </button>

          {completedDeliveries.map((row) => (
            <button
              type="button"
              className={
                documentKey === row.id
                  ? "active"
                  : ""
              }
              onClick={() =>
                setDocumentKey(row.id)
              }
              key={row.id}
            >
              <Truck size={17} />
              {row.delivery_number}
            </button>
          ))}
        </div>

        <article className="sales-order-print-document">
          <header className="sales-order-print-header">
            <div className="sales-order-print-shop">
              {shop?.shop_logo_url && (
                <img
                  src={shop.shop_logo_url}
                  alt=""
                />
              )}

              <div>
                <h2>
                  {shop?.shop_name || "Tiny POS"}
                </h2>
                {shop?.shop_address && (
                  <p>{shop.shop_address}</p>
                )}
                {shop?.shop_phone && (
                  <p>{shop.shop_phone}</p>
                )}
                {shop?.shop_email && (
                  <p>{shop.shop_email}</p>
                )}
                {shop?.tax_id && (
                  <p>Tax ID: {shop.tax_id}</p>
                )}
              </div>
            </div>

            <div className="sales-order-print-title">
              <strong>{title}</strong>
              <span>{number}</span>
              {!isDelivery && (
                <b className={`sales-order-status ${order.status}`}>
                  {salesOrderStatusLabel(
                    order.status
                  )}
                </b>
              )}
            </div>
          </header>

          <section className="sales-order-print-parties">
            <div>
              <span>Customer</span>
              <strong>
                {order.customers?.name}
              </strong>
              {order.customers?.customer_code && (
                <p>
                  {order.customers.customer_code}
                </p>
              )}
              {order.customers?.company_name && (
                <p>
                  {order.customers.company_name}
                </p>
              )}
              {order.customers?.phone && (
                <p>{order.customers.phone}</p>
              )}
              {order.customers?.email && (
                <p>{order.customers.email}</p>
              )}
            </div>

            <div>
              <div>
                <span>Branch</span>
                <strong>
                  {branch?.name
                    || "Current branch"}
                </strong>
              </div>

              <div>
                <span>
                  {isDelivery
                    ? "Delivery date"
                    : "Created"}
                </span>
                <strong>
                  {isDelivery
                    ? salesOrderDate(
                        delivery.delivery_date
                      )
                    : salesOrderDateTime(
                        order.created_at
                      )}
                </strong>
              </div>

              {!isDelivery && (
                <div>
                  <span>Requested delivery</span>
                  <strong>
                    {salesOrderDate(
                      order.requested_delivery_date
                    )}
                  </strong>
                </div>
              )}

              {isDelivery && (
                <div>
                  <span>Invoice</span>
                  <strong>
                    {delivery.invoice_number
                      || "—"}
                  </strong>
                </div>
              )}

              <div>
                <span>Currency</span>
                <strong>{order.currency}</strong>
              </div>
            </div>
          </section>

          <section className="sales-order-delivery-address">
            <span>Delivery address</span>
            <strong>
              {isDelivery
                ? delivery.delivery_address
                  || order.delivery_address
                  || "—"
                : order.delivery_address || "—"}
            </strong>
          </section>

          <table className="sales-order-print-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Product</th>
                <th>Code</th>
                <th>Quantity</th>
                {!isDelivery && (
                  <th>Delivered</th>
                )}
                <th>Unit price</th>
                <th>Total</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((item, index) => (
                <tr key={item.id}>
                  <td>{index + 1}</td>
                  <td>{item.product_name}</td>
                  <td>
                    {item.sku
                      || item.barcode
                      || "—"}
                  </td>
                  <td>
                    {stockNumber(item.quantity)}
                    {" "}
                    {item.sale_unit_name}
                  </td>

                  {!isDelivery && (
                    <td>
                      {stockNumber(
                        item.delivered_quantity
                      )}
                    </td>
                  )}

                  <td>
                    {money(
                      isDelivery
                        ? item.invoice_unit_price
                        : item.net_unit_price,
                      order.currency
                    )}
                  </td>

                  <td>
                    {money(
                      item.line_total,
                      order.currency
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="sales-order-print-bottom">
            <div>
              {(isDelivery
                ? delivery.notes
                : order.notes) && (
                <p>
                  <strong>Note:</strong>
                  {" "}
                  {isDelivery
                    ? delivery.notes
                    : order.notes}
                </p>
              )}

              {!isDelivery && order.terms && (
                <p>
                  <strong>Terms:</strong>
                  {" "}
                  {order.terms}
                </p>
              )}
            </div>

            <div className="sales-order-print-totals">
              <div>
                <span>Subtotal</span>
                <strong>
                  {money(
                    isDelivery
                      ? delivery.subtotal
                      : order.subtotal,
                    order.currency
                  )}
                </strong>
              </div>

              {!isDelivery && (
                <div>
                  <span>Discount</span>
                  <strong>
                    -{money(
                      order.discount_amount,
                      order.currency
                    )}
                  </strong>
                </div>
              )}

              <div>
                <span>Tax</span>
                <strong>
                  {money(
                    isDelivery
                      ? delivery.tax_amount
                      : order.tax_amount,
                    order.currency
                  )}
                </strong>
              </div>

              <div className="sales-order-print-grand">
                <span>
                  {isDelivery
                    ? "Invoice total"
                    : "Order total"}
                </span>
                <strong>
                  {money(
                    isDelivery
                      ? delivery.total_amount
                      : order.total_amount,
                    order.currency
                  )}
                </strong>
              </div>
            </div>
          </section>

          <footer className="sales-order-print-footer">
            <p>
              {isDelivery
                ? "Goods received in good condition unless noted above."
                : "Confirmed quantities are reserved until delivered or cancelled."}
            </p>

            <div>
              <span>Prepared by</span>
              <span>
                {isDelivery
                  ? "Customer received by"
                  : "Customer approval"}
              </span>
            </div>
          </footer>
        </article>

        <div className="sales-order-document-actions">
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
            onClick={() => printElementDocument({ title: "Sales Order", selector: ".sales-order-print-document", page: "A4 portrait" })}
          >
            <Printer size={18} />
            {isDelivery
              ? "Print delivery note"
              : "Print sales order"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
