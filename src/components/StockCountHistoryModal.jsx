import { Download, Printer } from "lucide-react";
import Modal from "./Modal";
import {
  money,
  stockNumber
} from "../lib/catalog";
import { exportListExcel, printListDocument } from "../lib/listDocuments";

function dateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export default function StockCountHistoryModal({
  session,
  items,
  loading,
  onClose
}) {
  if (!session) return null;

  const documentColumns = [
    { label: "Product", width: 170, value: (item) => item.products?.name || "" },
    { label: "Khmer name", width: 145, value: (item) => item.products?.name_km || "" },
    { label: "Code", width: 95, value: (item) => item.products?.sku || item.products?.barcode || "" },
    { label: "Unit", width: 70, value: (item) => item.products?.unit_name || "pcs" },
    { label: "Expected", width: 82, value: (item) => stockNumber(item.expected_quantity) },
    { label: "Counted", width: 82, value: (item) => item.counted_quantity === null ? "Not counted" : stockNumber(item.counted_quantity) },
    { label: "Variance", width: 82, value: (item) => {
      if (item.counted_quantity === null) return "—";
      const variance = Number(item.counted_quantity) - Number(item.expected_quantity);
      return `${variance > 0 ? "+" : ""}${stockNumber(variance)}`;
    } },
    { label: "Value", width: 95, value: (item) => {
      if (item.counted_quantity === null) return "—";
      const variance = Number(item.counted_quantity) - Number(item.expected_quantity);
      return money(variance * Number(item.unit_cost_snapshot || 0), item.products?.currency || "USD");
    } },
    { label: "Note", width: 150, value: (item) => item.note || "" }
  ];

  const documentSummary = [
    { label: "Status", value: session.status || "—" },
    { label: "Started", value: dateTime(session.started_at) },
    { label: session.status === "cancelled" ? "Cancelled" : "Completed", value: dateTime(session.completed_at || session.cancelled_at) },
    { label: "Products", value: session.expected_items || 0 },
    { label: "Discrepancies", value: session.discrepancy_items || 0 },
    { label: "Adjustment", value: session.inventory_adjustments?.adjustment_number || "No adjustment" },
    { label: "USD variance", value: money(session.value_variance_usd, "USD") },
    { label: "KHR variance", value: money(session.value_variance_khr, "KHR") },
    ...(session.cancellation_reason ? [{ label: "Cancellation reason", value: session.cancellation_reason }] : []),
    ...(session.notes ? [{ label: "Notes", value: session.notes }] : [])
  ];

  function exportCount() {
    exportListExcel({
      filename: `${session.count_number}.xls`,
      title: `${session.count_number} · ${session.name}`,
      subtitle: `Stock count · ${dateTime(session.started_at)}`,
      summary: documentSummary,
      columns: documentColumns,
      rows: items || []
    });
  }

  function printCount() {
    printListDocument({
      title: `${session.count_number} · ${session.name}`,
      subtitle: `Stock count · ${dateTime(session.started_at)}`,
      summary: documentSummary,
      columns: documentColumns,
      rows: items || [],
      orientation: "landscape"
    });
  }

  return (
    <Modal
      title={`${session.count_number} · ${session.name}`}
      onClose={onClose}
      wide
    >
      <div className="stock-count-history-detail">
        <div className="stock-count-history-document-actions" data-print-hide>
          <button
            type="button"
            className="secondary-button"
            onClick={exportCount}
            disabled={loading}
          >
            <Download size={18} />
            Export
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={printCount}
            disabled={loading}
          >
            <Printer size={18} />
            Print
          </button>
        </div>

        <section className="stock-count-history-summary">
          <div>
            <span>Status</span>
            <strong>
              {session.status}
            </strong>
          </div>
          <div>
            <span>Started</span>
            <strong>
              {dateTime(session.started_at)}
            </strong>
          </div>
          <div>
            <span>Completed</span>
            <strong>
              {dateTime(
                session.completed_at
                || session.cancelled_at
              )}
            </strong>
          </div>
          <div>
            <span>Products</span>
            <strong>
              {session.expected_items}
            </strong>
          </div>
          <div>
            <span>Discrepancies</span>
            <strong>
              {session.discrepancy_items}
            </strong>
          </div>
          <div>
            <span>Adjustment</span>
            <strong>
              {session.inventory_adjustments
                ?.adjustment_number
                || "No adjustment"}
            </strong>
          </div>
          <div>
            <span>USD variance</span>
            <strong>
              {money(
                session.value_variance_usd,
                "USD"
              )}
            </strong>
          </div>
          <div>
            <span>KHR variance</span>
            <strong>
              {money(
                session.value_variance_khr,
                "KHR"
              )}
            </strong>
          </div>
        </section>

        {session.cancellation_reason && (
          <div className="notice warning">
            Cancelled:{" "}
            {session.cancellation_reason}
          </div>
        )}

        {session.notes && (
          <div className="stock-count-history-notes">
            <strong>Notes</strong>
            <p>{session.notes}</p>
          </div>
        )}

        {loading ? (
          <div className="empty-state">
            <p>Loading count details...</p>
          </div>
        ) : (
          <div className="stock-count-history-table-wrap">
            <table className="stock-count-history-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Expected</th>
                  <th>Counted</th>
                  <th>Variance</th>
                  <th>Value</th>
                  <th>Note</th>
                </tr>
              </thead>

              <tbody>
                {items.map((item) => {
                  const variance =
                    item.counted_quantity === null
                      ? null
                      : item.counted_quantity
                        - item.expected_quantity;

                  return (
                    <tr key={item.id}>
                      <td data-label="Product">
                        <strong>
                          {item.products?.name}
                        </strong>
                        <small>
                          {item.products?.unit_name}
                        </small>
                      </td>

                      <td data-label="Expected">
                        {stockNumber(
                          item.expected_quantity
                        )}
                      </td>

                      <td data-label="Counted">
                        {item.counted_quantity === null
                          ? "Not counted"
                          : stockNumber(
                              item.counted_quantity
                            )}
                      </td>

                      <td data-label="Variance">
                        {variance === null
                          ? "—"
                          : `${variance > 0 ? "+" : ""}${stockNumber(
                              variance
                            )}`}
                      </td>

                      <td data-label="Value">
                        {variance === null
                          ? "—"
                          : money(
                              variance
                                * item.unit_cost_snapshot,
                              item.products
                                ?.currency
                                || "USD"
                            )}
                      </td>

                      <td data-label="Note">
                        {item.note || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="primary-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
