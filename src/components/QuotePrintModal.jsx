import { printElementDocument } from "../lib/listDocuments";
import {
  ClipboardList,
  Download,
  Languages,
  Printer,
  ShoppingCart
} from "lucide-react";
import { useEffect, useState } from "react";
import Modal from "./Modal";
import { useLanguage } from "../context/LanguageContext";
import {
  money,
  stockNumber
} from "../lib/catalog";
import {
  effectiveQuoteStatus,
  quoteCanConvert,
  quoteDate,
  quoteDateTime,
  quoteStatusLabel
} from "../lib/quotes";

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename, rows) {
  const content = rows
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", content], {
    type: "text/csv;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const quotePrintStyles = `
.tiny-pos-print-frame-content{padding:0!important;font-family:"Noto Sans Khmer",Arial,sans-serif!important;color:#111!important;font-size:9.5px!important}
.quote-print-document{width:100%!important;max-width:none!important;margin:0!important;padding:0!important;border:0!important;border-radius:0!important;background:#fff!important;color:#111!important;box-shadow:none!important;overflow:visible!important}
.quote-print-header{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;align-items:start!important;gap:8mm!important;padding:0 0 4mm!important;border-bottom:2px solid #111!important;break-inside:avoid!important}
.quote-print-shop{display:grid!important;grid-template-columns:auto minmax(0,1fr)!important;align-items:start!important;gap:3mm!important;min-width:0!important}
.quote-print-shop img{display:block!important;width:16mm!important;height:16mm!important;max-width:16mm!important;max-height:16mm!important;object-fit:contain!important}
.quote-print-shop h2{margin:0!important;font-size:17px!important;line-height:1.15!important}.quote-print-shop p{margin:1mm 0 0!important;color:#444!important;line-height:1.25!important;overflow-wrap:anywhere!important}
.quote-print-title{text-align:right!important;display:grid!important;justify-items:end!important;gap:1mm!important;min-width:42mm!important}.quote-print-title>strong{font-size:18px!important;letter-spacing:.06em!important}.quote-print-title>span{font-weight:800!important;overflow-wrap:anywhere!important}.quote-status{display:inline-block!important;padding:1.2mm 2.2mm!important;border-radius:999px!important;font-size:8px!important;font-weight:800!important}
.quote-print-parties{display:grid!important;grid-template-columns:1fr 1fr!important;gap:8mm!important;padding:4mm 0!important;break-inside:avoid!important}.quote-print-parties>div{display:grid!important;align-content:start!important;gap:1mm!important;min-width:0!important}.quote-print-parties>div:last-child>div{display:grid!important;grid-template-columns:26mm minmax(0,1fr)!important;gap:2mm!important;padding:.7mm 0!important}.quote-print-parties span{color:#555!important;font-size:8.5px!important}.quote-print-parties p{margin:0!important;color:#333!important;overflow-wrap:anywhere!important}
.quote-print-table{width:100%!important;border-collapse:collapse!important;table-layout:fixed!important;font-size:8.8px!important}.quote-print-table thead{display:table-header-group!important}.quote-print-table tr{break-inside:avoid!important}.quote-print-table th,.quote-print-table td{display:table-cell!important;padding:1.8mm 1.5mm!important;border:1px solid #aeb4bd!important;text-align:left!important;vertical-align:top!important;overflow-wrap:anywhere!important;word-break:normal!important;line-height:1.25!important}.quote-print-table th{background:#f1f3f5!important;font-size:8.3px!important;font-weight:800!important}.quote-print-table th:nth-child(1),.quote-print-table td:nth-child(1){width:5%!important;text-align:center!important}.quote-print-table th:nth-child(2),.quote-print-table td:nth-child(2){width:31%!important}.quote-print-table th:nth-child(3),.quote-print-table td:nth-child(3){width:14%!important}.quote-print-table th:nth-child(4),.quote-print-table td:nth-child(4){width:14%!important}.quote-print-table th:nth-child(5),.quote-print-table td:nth-child(5){width:12%!important;text-align:right!important}.quote-print-table th:nth-child(6),.quote-print-table td:nth-child(6){width:12%!important;text-align:right!important}.quote-print-table th:nth-child(7),.quote-print-table td:nth-child(7){width:12%!important;text-align:right!important}.quote-print-table td>small{display:block!important;color:#64748b!important;margin-top:.8mm!important}
.quote-print-bottom{display:grid!important;grid-template-columns:minmax(0,1fr) 70mm!important;gap:6mm!important;padding-top:4mm!important;break-inside:avoid!important}.quote-print-notes{line-height:1.4!important;min-width:0!important}.quote-print-notes p{margin:0 0 2mm!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important}.quote-print-totals{display:grid!important}.quote-print-totals>div{display:flex!important;justify-content:space-between!important;gap:4mm!important;padding:1.5mm 0!important;border-bottom:1px solid #d5d7db!important}.quote-print-grand{font-size:11px!important;border-bottom:2px solid #111!important}
.quote-print-footer{margin-top:5mm!important;padding-top:3mm!important;border-top:1px solid #aaa!important;break-inside:avoid!important}.quote-print-footer>p{text-align:center!important;color:#555!important;margin:0!important}.quote-print-footer>div{display:grid!important;grid-template-columns:1fr 1fr!important;gap:15mm!important;margin-top:11mm!important}.quote-print-footer>div>span{padding-top:2mm!important;border-top:1px solid #222!important;text-align:center!important}
@media print{.quote-print-document,.quote-print-document *{visibility:visible!important}.quote-print-table{page-break-inside:auto!important}.quote-print-header,.quote-print-parties,.quote-print-bottom,.quote-print-footer{break-inside:avoid!important}}
`;

export default function QuotePrintModal({
  quote,
  shop,
  branch,
  onClose,
  onConvert,
  onCreateOrder,
  canCreateOrder = false,
  orderBusy = false
}) {
  const { language } = useLanguage();
  const [documentLanguage, setDocumentLanguage] = useState(
    language === "km" ? "km" : "en"
  );

  useEffect(() => {
    if (quote) setDocumentLanguage(language === "km" ? "km" : "en");
  }, [quote, language]);

  if (!quote) return null;

  const status = effectiveQuoteStatus(quote);
  const label = (english, khmer) =>
    documentLanguage === "km" ? khmer : english;
  const itemName = (item) =>
    documentLanguage === "km"
      ? item.products?.name_km || item.product_name
      : item.product_name;

  function exportQuote() {
    const rows = [
      [label("Quotation", "សម្រង់តម្លៃ"), quote.quote_number],
      [label("Customer", "អតិថិជន"), quote.customers?.name || label("Walk-in customer", "អតិថិជនទូទៅ")],
      [label("Branch", "សាខា"), branch?.name || ""],
      [label("Created", "កាលបរិច្ឆេទបង្កើត"), quoteDateTime(quote.created_at)],
      [label("Valid until", "មានសុពលភាពដល់"), quoteDate(quote.valid_until)],
      [],
      [
        "#",
        label("Product", "ផលិតផល"),
        label("Code", "កូដ"),
        label("Quantity", "បរិមាណ"),
        label("Unit price", "តម្លៃឯកតា"),
        label("Discount", "បញ្ចុះតម្លៃ"),
        label("Total", "សរុប")
      ],
      ...(quote.sales_quote_items || []).map((item, index) => [
        index + 1,
        itemName(item),
        item.sku || item.barcode || "",
        `${stockNumber(item.quantity)} ${item.sale_unit_name || ""}`,
        money(item.unit_price, quote.currency),
        money(item.discount_amount, quote.currency),
        money(item.line_total, quote.currency)
      ]),
      [],
      [label("Subtotal", "សរុបរង"), money(quote.subtotal, quote.currency)],
      [label("Discount", "បញ្ចុះតម្លៃ"), money(quote.discount_amount, quote.currency)],
      [label("Tax", "ពន្ធ"), money(quote.tax_amount, quote.currency)],
      [label("Quotation total", "សរុបសម្រង់តម្លៃ"), money(quote.total_amount, quote.currency)],
      [label("Notes", "កំណត់សម្គាល់"), quote.notes || ""],
      [label("Terms", "លក្ខខណ្ឌ"), quote.terms || ""]
    ];

    downloadCsv(`${quote.quote_number}-${documentLanguage}.csv`, rows);
  }

  return (
    <Modal
      title={quote.quote_number}
      onClose={onClose}
      wide
    >
      <div className="quote-print-wrapper">
        <div className="quote-language-toolbar" data-print-hide>
          <Languages size={18} />
          <button
            type="button"
            className={documentLanguage === "en" ? "active" : ""}
            onClick={() => setDocumentLanguage("en")}
          >
            English
          </button>
          <button
            type="button"
            className={documentLanguage === "km" ? "active" : ""}
            onClick={() => setDocumentLanguage("km")}
          >
            ខ្មែរ
          </button>
        </div>

        <article className="quote-print-document">
          <header className="quote-print-header">
            <div className="quote-print-shop">
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
                  <p>{label("Tax ID", "លេខអត្តសញ្ញាណពន្ធ")}: {shop.tax_id}</p>
                )}
              </div>
            </div>

            <div className="quote-print-title">
              <strong>{label("QUOTATION", "សម្រង់តម្លៃ")}</strong>
              <span>{quote.quote_number}</span>
              <b className={`quote-status ${status}`}>
                {quoteStatusLabel(status)}
              </b>
            </div>
          </header>

          <section className="quote-print-parties">
            <div>
              <span>{label("Quoted to", "សម្រង់ជូន")}</span>
              <strong>
                {quote.customers?.name
                  || label("Walk-in customer", "អតិថិជនទូទៅ")}
              </strong>

              {quote.customers?.customer_code && (
                <p>{quote.customers.customer_code}</p>
              )}

              {quote.customers?.company_name && (
                <p>{quote.customers.company_name}</p>
              )}

              {quote.customers?.phone && (
                <p>{quote.customers.phone}</p>
              )}

              {quote.customers?.email && (
                <p>{quote.customers.email}</p>
              )}

              {quote.customers?.address && (
                <p>{quote.customers.address}</p>
              )}
            </div>

            <div>
              <div>
                <span>{label("Branch", "សាខា")}</span>
                <strong>{branch?.name || label("Current branch", "សាខាបច្ចុប្បន្ន")}</strong>
              </div>

              <div>
                <span>{label("Created", "កាលបរិច្ឆេទបង្កើត")}</span>
                <strong>{quoteDateTime(quote.created_at)}</strong>
              </div>

              <div>
                <span>{label("Valid until", "មានសុពលភាពដល់")}</span>
                <strong>{quoteDate(quote.valid_until)}</strong>
              </div>

              <div>
                <span>{label("Currency", "រូបិយប័ណ្ណ")}</span>
                <strong>{quote.currency}</strong>
              </div>

              {quote.price_list_name && (
                <div>
                  <span>{label("Price list", "បញ្ជីតម្លៃ")}</span>
                  <strong>{quote.price_list_name}</strong>
                </div>
              )}
            </div>
          </section>

          <table className="quote-print-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{label("Product", "ផលិតផល")}</th>
                <th>{label("Code", "កូដ")}</th>
                <th>{label("Quantity", "បរិមាណ")}</th>
                <th>{label("Unit price", "តម្លៃឯកតា")}</th>
                <th>{label("Discount", "បញ្ចុះតម្លៃ")}</th>
                <th>{label("Total", "សរុប")}</th>
              </tr>
            </thead>

            <tbody>
              {(quote.sales_quote_items || []).map((item, index) => (
                <tr key={item.id}>
                  <td>{index + 1}</td>
                  <td>
                    <strong>{itemName(item)}</strong>
                    {documentLanguage === "km"
                      && item.products?.name_km
                      && item.products.name_km !== item.product_name && (
                      <small>{item.product_name}</small>
                    )}
                  </td>
                  <td>{item.sku || item.barcode || "—"}</td>
                  <td>{stockNumber(item.quantity)} {item.sale_unit_name}</td>
                  <td>{money(item.unit_price, quote.currency)}</td>
                  <td>{money(item.discount_amount, quote.currency)}</td>
                  <td>{money(item.line_total, quote.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <section className="quote-print-bottom">
            <div className="quote-print-notes">
              {quote.notes && (
                <p><strong>{label("Note", "កំណត់សម្គាល់")}:</strong> {quote.notes}</p>
              )}
              {quote.terms && (
                <p><strong>{label("Terms", "លក្ខខណ្ឌ")}:</strong> {quote.terms}</p>
              )}
              {quote.cancel_reason && (
                <p><strong>{label("Cancellation", "ការលុបចោល")}:</strong> {quote.cancel_reason}</p>
              )}
            </div>

            <div className="quote-print-totals">
              <div>
                <span>{label("Subtotal", "សរុបរង")}</span>
                <strong>{money(quote.subtotal, quote.currency)}</strong>
              </div>
              <div>
                <span>
                  {quote.coupon_code
                    ? `${label("Coupon", "គូប៉ុង")} ${quote.coupon_code}`
                    : label("Discount", "បញ្ចុះតម្លៃ")}
                </span>
                <strong>-{money(quote.discount_amount, quote.currency)}</strong>
              </div>
              <div>
                <span>{label("Tax", "ពន្ធ")}</span>
                <strong>{money(quote.tax_amount, quote.currency)}</strong>
              </div>
              <div className="quote-print-grand">
                <span>{label("Quotation total", "សរុបសម្រង់តម្លៃ")}</span>
                <strong>{money(quote.total_amount, quote.currency)}</strong>
              </div>
            </div>
          </section>

          <footer className="quote-print-footer">
            <p>
              {label(
                "This quotation does not reserve stock and is not a tax invoice or payment receipt.",
                "សម្រង់តម្លៃនេះមិនកក់ស្តុក និងមិនមែនជាវិក្កយបត្រពន្ធ ឬបង្កាន់ដៃទូទាត់ទេ។"
              )}
            </p>
            <div>
              <span>{label("Prepared by", "រៀបចំដោយ")}</span>
              <span>{label("Customer approval", "ការយល់ព្រមរបស់អតិថិជន")}</span>
            </div>
          </footer>
        </article>

        <div className="quote-print-actions" data-print-hide>
          <button type="button" className="secondary-button" onClick={onClose}>
            {label("Close", "បិទ")}
          </button>

          <button type="button" className="secondary-button" onClick={exportQuote}>
            <Download size={18} />
            {label("Export CSV", "នាំចេញ CSV")}
          </button>

          <button type="button" className="secondary-button" onClick={() => printElementDocument({
            title: "Quotation",
            selector: ".quote-print-document",
            styles: quotePrintStyles,
            page: "A4 portrait",
            includeAppStyles: true
          })}>
            <Printer size={18} />
            {label("Print quotation", "បោះពុម្ពសម្រង់តម្លៃ")}
          </button>

          {canCreateOrder && quoteCanConvert(quote) && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => onCreateOrder(quote)}
              disabled={orderBusy || !quote.customer_id}
              title={
                quote.customer_id
                  ? "Create a reservable sales order"
                  : "Choose a customer before creating a sales order"
              }
            >
              <ClipboardList size={18} />
              {orderBusy
                ? label("Creating order...", "កំពុងបង្កើតបញ្ជាទិញ...")
                : label("Create Sales Order", "បង្កើតបញ្ជាទិញលក់")}
            </button>
          )}

          {quoteCanConvert(quote) && (
            <button
              type="button"
              className="primary-button"
              onClick={() => onConvert(quote)}
            >
              <ShoppingCart size={18} />
              {label("Open in New Sale", "បើកក្នុងការលក់ថ្មី")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
