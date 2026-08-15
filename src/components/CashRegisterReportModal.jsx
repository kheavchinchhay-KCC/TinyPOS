import { printElementDocument } from "../lib/listDocuments";
import { Printer } from "lucide-react";
import Modal from "./Modal";
import { money } from "../lib/catalog";

function dateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

const rows = [
  ["Opening cash", "opening", 1],
  ["Cash sales", "cash_sales", 1],
  ["Cash refunds", "cash_refunds", -1],
  ["Other cash in", "cash_income", 1],
  ["Cash expenses", "cash_expenses", -1],
  ["Supplier payments", "supplier_payments", -1]
];

const registerPrintStyles = `
.tiny-pos-print-frame-content{padding:0!important;font-family:"Noto Sans Khmer",Arial,sans-serif!important;color:#111!important;font-size:10px!important}
.register-report-document{width:100%!important;max-width:none!important;margin:0!important;padding:0!important;border:0!important;background:#fff!important;color:#111!important;box-shadow:none!important}
.register-report-document>header{display:grid!important;grid-template-columns:auto minmax(0,1fr) auto!important;align-items:center!important;gap:10px!important;padding:0 0 5mm!important;border-bottom:2px solid #111!important;text-align:left!important;break-inside:avoid!important}
.register-report-document>header img{display:block!important;width:48px!important;height:48px!important;max-width:48px!important;max-height:48px!important;object-fit:contain!important}
.register-report-document>header h2{margin:0!important;font-size:20px!important;line-height:1.15!important}
.register-report-document>header>strong{font-size:11px!important;letter-spacing:.06em!important;text-align:right!important;white-space:normal!important}
.register-report-meta{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:2.5mm!important;padding:4mm 0!important;break-inside:avoid!important}
.register-report-meta>div{display:grid!important;gap:1mm!important;padding:2.2mm!important;border:1px solid #cbd5e1!important;min-width:0!important}
.register-report-meta span{font-size:8.5px!important;color:#64748b!important;text-transform:uppercase!important;letter-spacing:.03em!important}
.register-report-meta strong{font-size:10px!important;line-height:1.25!important;overflow-wrap:anywhere!important}
.register-report-grid{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;gap:5mm!important;align-items:start!important;break-inside:avoid!important}
.register-report-currency{padding:0!important;border:1px solid #9ca3af!important;background:#fff!important;min-width:0!important;break-inside:avoid!important}
.register-report-currency h3{margin:0!important;padding:2.5mm 3mm!important;background:#f3f4f6!important;border-bottom:1px solid #9ca3af!important;font-size:13px!important}
.register-report-table{width:100%!important;border-collapse:collapse!important;table-layout:fixed!important;font-size:10px!important}
.register-report-table th,.register-report-table td{padding:2.2mm 3mm!important;border-bottom:1px solid #d7dce2!important;vertical-align:top!important;overflow-wrap:anywhere!important;word-break:normal!important}
.register-report-table th{width:62%!important;text-align:left!important;font-weight:600!important;color:#374151!important}
.register-report-table td{width:38%!important;text-align:right!important;font-weight:800!important;white-space:nowrap!important}
.register-report-table tr:last-child th,.register-report-table tr:last-child td{border-bottom:0!important}
.register-report-table tr.register-report-total th,.register-report-table tr.register-report-total td{border-top:2px solid #111!important;font-size:11px!important;color:#111!important}
.register-report-table tr.register-report-variance th,.register-report-table tr.register-report-variance td{font-size:11px!important;font-weight:900!important}
.register-report-notes{display:grid!important;grid-template-columns:1fr 1fr!important;gap:4mm!important;padding-top:5mm!important;break-inside:avoid!important}
.register-report-notes>div{padding:3mm!important;border:1px solid #cbd5e1!important}
.register-report-notes p{margin:1.5mm 0 0!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important}
.register-report-document>footer{text-align:center!important;margin-top:5mm!important;padding-top:3mm!important;border-top:1px solid #cbd5e1!important;font-size:8.5px!important;color:#64748b!important}
@media print{.register-report-document,.register-report-document *{visibility:visible!important}.register-report-grid{grid-template-columns:1fr 1fr!important}.register-report-currency{break-inside:avoid!important}.register-report-table{page-break-inside:avoid!important}}
`;

function signedMoney(value, currency, sign) {
  const numeric = Math.abs(Number(value || 0));
  return `${sign < 0 ? "−" : ""}${money(numeric, currency)}`;
}

function CurrencyReport({ currency, totals, closed }) {
  const values = totals?.[currency] || {};

  return (
    <section className="register-report-currency">
      <h3>{currency} drawer</h3>

      <table className="register-report-table">
        <tbody>
          {rows.map(([label, field, sign]) => (
            <tr key={field}>
              <th scope="row">{label}</th>
              <td>{signedMoney(values[field], currency, sign)}</td>
            </tr>
          ))}

          <tr className="register-report-total">
            <th scope="row">Expected cash</th>
            <td>{money(values.expected || 0, currency)}</td>
          </tr>

          {closed && (
            <>
              <tr>
                <th scope="row">Counted cash</th>
                <td>{money(values.counted || 0, currency)}</td>
              </tr>
              <tr className="register-report-variance">
                <th scope="row">Variance</th>
                <td>{money(values.variance || 0, currency)}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </section>
  );
}

export default function CashRegisterReportModal({
  report,
  shop,
  onClose
}) {
  if (!report) return null;

  const session = report.session;
  const closed = session.status === "closed";

  return (
    <Modal
      title={closed ? "Cash register closing report" : "Cash register report"}
      onClose={onClose}
      wide
    >
      <div className="register-report-wrapper">
        <article className="register-report-document">
          <header>
            {shop?.shop_logo_url ? (
              <img src={shop.shop_logo_url} alt="" />
            ) : (
              <span aria-hidden="true" />
            )}
            <h2>{shop?.shop_name || "Tiny POS"}</h2>
            <strong>
              {closed
                ? "CASH REGISTER CLOSING REPORT"
                : "OPEN CASH REGISTER REPORT"}
            </strong>
          </header>

          <div className="register-report-meta">
            <div>
              <span>Session</span>
              <strong>{session.session_number}</strong>
            </div>
            <div>
              <span>Register</span>
              <strong>{session.register_name}</strong>
            </div>
            <div>
              <span>Opened</span>
              <strong>{dateTime(session.opened_at)}</strong>
            </div>
            <div>
              <span>Closed</span>
              <strong>{dateTime(session.closed_at)}</strong>
            </div>
            <div>
              <span>Status</span>
              <strong>{session.status.toUpperCase()}</strong>
            </div>
          </div>

          <div className="register-report-grid">
            <CurrencyReport
              currency="USD"
              totals={report.totals}
              closed={closed}
            />
            <CurrencyReport
              currency="KHR"
              totals={report.totals}
              closed={closed}
            />
          </div>

          {(session.opening_note || session.closing_note) && (
            <div className="register-report-notes">
              {session.opening_note && (
                <div>
                  <strong>Opening note</strong>
                  <p>{session.opening_note}</p>
                </div>
              )}
              {session.closing_note && (
                <div>
                  <strong>Closing note</strong>
                  <p>{session.closing_note}</p>
                </div>
              )}
            </div>
          )}

          <footer>
            Generated by Tiny POS
          </footer>
        </article>

        <div className="receipt-actions">
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
              title: "Cash Register Report",
              selector: ".register-report-document",
              styles: registerPrintStyles,
              page: "A4 landscape",
              includeAppStyles: true
            })}
          >
            <Printer size={18} />
            Print report
          </button>
        </div>
      </div>
    </Modal>
  );
}
