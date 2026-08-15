import { Languages, Printer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import ProductBarcode from "./ProductBarcode";
import SaleInvoiceDocument from "./SaleInvoiceDocument";
import { useAuth } from "../context/AuthContext";
import { money, stockNumber } from "../lib/catalog";
import { printElementDocument } from "../lib/listDocuments";

function dateTime(value, locale = "en-US") {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function dateOnly(value, locale = "en-US") {
  if (!value) return "—";

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium"
  }).format(
    new Date(`${String(value).slice(0, 10)}T00:00:00`)
  );
}

export default function ReceiptModal({ receipt, onClose }) {
  const { shop } = useAuth();
  const defaultReceiptLanguage = shop?.receipt_default_language === "km" ? "km" : "en";
  const [receiptLanguage, setReceiptLanguage] = useState(defaultReceiptLanguage);
  const receiptPrintRef = useRef(null);

  useEffect(() => {
    if (receipt) setReceiptLanguage(defaultReceiptLanguage);
  }, [receipt, defaultReceiptLanguage]);

  const label = (english, khmer) => receiptLanguage === "km" ? khmer : english;
  const locale = receiptLanguage === "km" ? "km-KH" : "en-US";

  if (!receipt) return null;

  const receiptWidth = Number(shop?.receipt_width_mm || 80);
  const saleDocumentType = shop?.sale_document_type === "invoice" ? "invoice" : "receipt";
  const invoicePaperSize = shop?.invoice_paper_size === "A4" ? "A4" : "A5";
  const showLogo = shop?.receipt_show_logo !== false;
  const showAddress = shop?.receipt_show_address !== false;
  const showPhone = shop?.receipt_show_phone !== false;
  const showCustomer = shop?.receipt_show_customer !== false;
  const showCashier = shop?.receipt_show_cashier !== false;
  const showBarcode = shop?.receipt_show_barcode !== false;
  const exchangeRate = Math.max(0.0001, Number(
    receipt.exchangeRate
    || shop?.usd_to_khr_rate
    || 4100
  ));
  const alternateCurrency = receipt.currency === "USD" ? "KHR" : "USD";
  const alternateTotal = receipt.currency === "USD"
    ? Number(receipt.totalAmount || 0) * exchangeRate
    : Number(receipt.totalAmount || 0) / exchangeRate;
  const paymentRows = Array.isArray(receipt.payments)
    ? receipt.payments
    : [];
  const paymentMethod = String(
    receipt.paymentMethod
    || (paymentRows.length > 1 ? "split" : paymentRows[0]?.method)
    || "other"
  );

  const isKhmer = receiptLanguage === "km";
  const receiptShopName = isKhmer
    ? shop?.shop_name_km || shop?.shop_name || receipt.shopName || "Tiny POS"
    : shop?.shop_name || receipt.shopName || "Tiny POS";
  const receiptHeader = isKhmer
    ? shop?.receipt_header_km || ""
    : shop?.receipt_header || "";
  const receiptAddress = isKhmer
    ? shop?.shop_address_km || shop?.shop_address || receipt.shopAddress || ""
    : shop?.shop_address || receipt.shopAddress || "";
  const receiptFooter = isKhmer
    ? shop?.receipt_footer_km || "សូមអរគុណសម្រាប់ការទិញ។"
    : shop?.receipt_footer || receipt.footer || "Thank you for your purchase.";
  const logoPosition = shop?.receipt_logo_position === "above" ? "above" : "inline";

  const statusText = (value) => {
    const normalized = String(value || "").toLowerCase();
    if (!isKhmer) return normalized.replaceAll("_", " ").toUpperCase();
    return ({
      completed: "បានបញ្ចប់",
      partially_refunded: "សងប្រាក់មួយផ្នែក",
      refunded: "បានសងប្រាក់",
      voided: "បានលុបចោល",
      pending: "កំពុងរង់ចាំ"
    })[normalized] || normalized.replaceAll("_", " ");
  };

  const paymentText = (value) => {
    const normalized = String(value || "other").toLowerCase();
    if (!isKhmer) return normalized.toUpperCase();
    return ({
      cash: "សាច់ប្រាក់",
      bank: "ធនាគារ",
      khqr: "KHQR",
      card: "កាត",
      credit: "ឥណទាន",
      split: "ចម្រុះ",
      other: "ផ្សេងៗ"
    })[normalized] || normalized;
  };

  function printReceipt() {
    const printable = receiptPrintRef.current;
    if (!printable) return;

    const documentLabel = saleDocumentType === "invoice"
      ? label("Invoice", "វិក្កយបត្រ")
      : label("Receipt", "បង្កាន់ដៃ");
    const title = `${receiptShopName} ${documentLabel}`;
    const page = saleDocumentType === "invoice"
      ? `${invoicePaperSize} portrait`
      : "auto";

    printElementDocument({
      title,
      element: printable,
      page,
      includeAppStyles: true,
      styles: saleDocumentType === "invoice" ? `
        .tiny-pos-print-frame-content{width:100%!important;max-width:100%!important;margin:0 auto!important;padding:0!important}
        .sale-invoice-document{width:100%!important;max-width:100%!important;margin:0 auto!important;padding:0!important;box-shadow:none!important;border:0!important;background:#fff!important;color:#111!important}
        .sale-invoice-table{width:100%!important;table-layout:fixed!important}
        .sale-invoice-table th,.sale-invoice-table td{white-space:normal!important;overflow-wrap:anywhere!important}
        .receipt-language-toolbar,.receipt-actions,[data-print-hide]{display:none!important}
        @page{size:${invoicePaperSize} portrait;margin:${invoicePaperSize === "A4" ? "8mm" : "7mm"}}
      ` : `
        .tiny-pos-print-frame-content{width:min(100%,${receiptWidth}mm)!important;margin:0 auto!important;padding:0!important}
        .receipt-document{width:100%!important;max-width:${receiptWidth}mm!important;margin:0 auto!important;padding:0!important;box-shadow:none!important;background:#fff!important;color:#111!important}
        .receipt-wrapper{padding:0!important}.receipt-language-toolbar,.receipt-actions,[data-print-hide]{display:none!important}
        .receipt-shop,.receipt-meta,.receipt-lines,.receipt-totals,.receipt-footer,.receipt-invoice-barcode{break-inside:avoid}
        .receipt-logo{max-width:86px!important;max-height:62px!important;object-fit:contain!important}
        @page{margin:4mm}
      `
    });
  }

  return (
    <Modal
      title={receipt.offlinePending ? label("Offline receipt saved", "បានរក្សាទុកបង្កាន់ដៃក្រៅបណ្តាញ") : label("Sale completed", "ការលក់បានបញ្ចប់")}
      onClose={onClose}
      wide={saleDocumentType === "invoice"}
      className={`receipt-modal no-translate ${saleDocumentType === "invoice" ? "sale-invoice-modal" : ""}`}
    >
      <div className="receipt-wrapper">
        {receipt.offlinePending && (
          <div className="notice warning offline-receipt-notice">
            Pending synchronization. This local receipt becomes a final invoice only after the server accepts it.
          </div>
        )}
        <div className="receipt-language-toolbar" data-print-hide>
          <Languages size={18} />
          <button type="button" className={receiptLanguage === "en" ? "active" : ""} onClick={() => setReceiptLanguage("en")}>English</button>
          <button type="button" className={receiptLanguage === "km" ? "active" : ""} onClick={() => setReceiptLanguage("km")}>ខ្មែរ</button>
        </div>
        <div ref={receiptPrintRef}>
          {saleDocumentType === "invoice" ? (
            <SaleInvoiceDocument receipt={receipt} shop={shop} language={receiptLanguage} />
          ) : (
            <article
              className="receipt-document"
              style={{ "--receipt-width": `${receiptWidth}mm` }}
            >
              <div className={`receipt-shop receipt-logo-${logoPosition}`}>
                <div className="receipt-brand-line">
                  {showLogo && shop?.shop_logo_url && (
                    <img className="receipt-logo" src={shop.shop_logo_url} alt="" />
                  )}
                  <h2>{receiptShopName}</h2>
                </div>
                {receiptHeader && <p>{receiptHeader}</p>}
                {showAddress && receiptAddress && (
                  <p>{receiptAddress}</p>
                )}
                {showPhone && (shop?.shop_phone || receipt.shopPhone) && (
                  <p>{shop?.shop_phone || receipt.shopPhone}</p>
                )}
                {showPhone && shop?.shop_email && <p>{shop.shop_email}</p>}
                {shop?.tax_id && <p>{label("Tax ID", "លេខអត្តសញ្ញាណពន្ធ")}: {shop.tax_id}</p>}
              </div>

              <div className="receipt-meta">
                <div><span>{label("Invoice", "វិក្កយបត្រ")}</span><strong>{receipt.invoiceNumber}</strong></div>
                {receipt.sourceQuoteNumber && (
                  <div>
                    <span>{label("Quotation", "សម្រង់តម្លៃ")}</span>
                    <strong>{receipt.sourceQuoteNumber}</strong>
                  </div>
                )}
                {receipt.sourceSalesOrderNumber && (
                  <div>
                    <span>{label("Sales Order", "បញ្ជាទិញលក់")}</span>
                    <strong>{receipt.sourceSalesOrderNumber}</strong>
                  </div>
                )}
                {receipt.sourceDeliveryNumber && (
                  <div>
                    <span>{label("Delivery Note", "ប័ណ្ណប្រគល់ទំនិញ")}</span>
                    <strong>{receipt.sourceDeliveryNumber}</strong>
                  </div>
                )}
                <div><span>{label("Date", "កាលបរិច្ឆេទ")}</span><strong>{dateTime(receipt.completedAt, locale)}</strong></div>
                {receipt.saleStatus && receipt.saleStatus !== "completed" && (
                  <div>
                    <span>{label("Status", "ស្ថានភាព")}</span>
                    <strong>
                      {statusText(receipt.saleStatus)}
                    </strong>
                  </div>
                )}
                {showCashier && (
                  <div><span>{label("Cashier", "អ្នកគិតលុយ")}</span><strong>{receipt.cashierName}</strong></div>
                )}
                {showCustomer && (
                  <div>
                    <span>{label("Customer", "អតិថិជន")}</span>
                    <strong>{receipt.customerName || label("Walk-in", "អតិថិជនទូទៅ")}</strong>
                  </div>
                )}
                {showCustomer && receipt.customerName && (
                  <div>
                    <span>{label("Customer profile", "ប្រភេទអតិថិជន")}</span>
                    <strong>
                      {[receipt.customerCode, receipt.customerType]
                        .filter(Boolean)
                        .join(" · ")}
                    </strong>
                  </div>
                )}
                {receipt.priceListName && (
                  <div>
                    <span>{label("Price list", "បញ្ជីតម្លៃ")}</span>
                    <strong>{receipt.priceListName}</strong>
                  </div>
                )}
              </div>

              {showBarcode && (
                <div className="receipt-invoice-barcode">
                  <ProductBarcode
                    value={receipt.invoiceNumber}
                    format="CODE128"
                    height={28}
                    width={1.15}
                  />
                  <small>{receipt.invoiceNumber}</small>
                </div>
              )}

              <div className="receipt-lines">
                {receipt.cart.map((item) => (
                  <div key={item.id}>
                    <span>
                      <strong>
                        {receiptLanguage === "km"
                          ? item.name_km || item.name
                          : item.name}
                      </strong>
                      {receiptLanguage === "km"
                        && item.name_km
                        && item.name_km !== item.name && (
                          <small>{item.name}</small>
                        )}
                      <small>
                        {stockNumber(item.quantity)}{" "}
                        {item.selected_unit_name || item.sale_unit_name || item.unit_name}
                        {" × "}
                        {money(item.selected_unit_price ?? item.selling_price, item.currency)}
                      </small>
                    </span>
                    <strong>
                      {money(
                        Number(item.quantity) * Number(item.selected_unit_price ?? item.selling_price),
                        item.currency
                      )}
                    </strong>
                  </div>
                ))}
              </div>

              <div className="receipt-totals">
                <div><span>{label("Subtotal", "សរុបរង")}</span><strong>{money(receipt.subtotal, receipt.currency)}</strong></div>
                {Number(receipt.priceAdjustmentAmount || 0) !== 0 && (
                  <div>
                    <span>
                      {Number(receipt.priceAdjustmentAmount) > 0
                        ? label("Price-list savings", "សន្សំពីបញ្ជីតម្លៃ")
                        : label("Price-list markup", "តម្លៃបន្ថែមពីបញ្ជីតម្លៃ")}
                    </span>
                    <strong>
                      {Number(receipt.priceAdjustmentAmount) > 0 ? "-" : "+"}
                      {money(
                        Math.abs(Number(receipt.priceAdjustmentAmount)),
                        receipt.currency
                      )}
                    </strong>
                  </div>
                )}
                <div><span>{label("Discount", "បញ្ចុះតម្លៃ")}</span><strong>-{money(receipt.discountAmount, receipt.currency)}</strong></div>
                {Number(receipt.taxAmount) > 0 && (
                  <div><span>{label("Tax", "ពន្ធ")}</span><strong>{money(receipt.taxAmount, receipt.currency)}</strong></div>
                )}
                <div className="receipt-grand-total">
                  <span>{label("Total", "សរុប")}</span>
                  <strong>{money(receipt.totalAmount, receipt.currency)}</strong>
                  <small>≈ {money(alternateTotal, alternateCurrency)}</small>
                </div>
                {Number(receipt.refundedAmount || 0) > 0 && (
                  <>
                    <div>
                      <span>{label("Refunded", "បានសងប្រាក់")}</span>
                      <strong>
                        -{money(receipt.refundedAmount, receipt.currency)}
                      </strong>
                    </div>
                    <div>
                      <span>{label("Net after refunds", "សរុបក្រោយសងប្រាក់")}</span>
                      <strong>
                        {money(
                          receipt.netTotal
                          ?? Number(receipt.totalAmount || 0)
                          - Number(receipt.refundedAmount || 0),
                          receipt.currency
                        )}
                      </strong>
                    </div>
                  </>
                )}
                <div><span>{label("Payment", "ការទូទាត់")}</span><strong>{paymentText(paymentMethod)}</strong></div>
                {(paymentMethod === "credit" || Number(receipt.creditAmount || 0) > 0) && (
                  <div>
                    <span>{label("Credit Amount", "ប្រាក់ជំពាក់")}</span>
                    <strong>{money(receipt.creditAmount || receipt.totalAmount, receipt.currency)}</strong>
                  </div>
                )}
                {paymentMethod === "credit" ? (
                  <>
                    <div>
                      <span>{label("Paid now", "បានបង់ឥឡូវ")}</span>
                      <strong>{money(0, receipt.currency)}</strong>
                    </div>
                    {receipt.creditDueDate && (
                      <div>
                        <span>{label("Credit due date", "ថ្ងៃផុតកំណត់ឥណទាន")}</span>
                        <strong>{dateOnly(receipt.creditDueDate, locale)}</strong>
                      </div>
                    )}
                    {receipt.creditOutstanding !== null
                      && receipt.creditOutstanding !== undefined && (
                        <div>
                          <span>{label("Invoice outstanding", "ប្រាក់នៅសល់លើវិក្កយបត្រ")}</span>
                          <strong>{money(receipt.creditOutstanding, receipt.currency)}</strong>
                        </div>
                      )}
                    <div>
                      <span>
                        {receipt.creditBalanceAfter !== null
                          && receipt.creditBalanceAfter !== undefined
                          ? label("Customer account balance", "សមតុល្យគណនីអតិថិជន")
                          : label("Invoice credit amount", "ចំនួនឥណទានវិក្កយបត្រ")}
                      </span>
                      <strong>
                        {money(
                          receipt.creditBalanceAfter
                          ?? receipt.creditAmount
                          ?? receipt.totalAmount,
                          receipt.currency
                        )}
                      </strong>
                    </div>
                  </>
                ) : paymentRows.length ? (
                  <div className="receipt-payment-parts">
                    {paymentRows.map((payment, index) => {
                      const tenderCurrency = payment.tender_currency
                        || payment.currency
                        || receipt.currency;
                      const tenderAmount = Number(
                        payment.tender_amount
                        ?? payment.amount_received
                        ?? payment.settlement_amount
                        ?? 0
                      );
                      const change = Number(
                        payment.change_amount
                        ?? payment.tender_change_amount
                        ?? 0
                      );
                      return (
                        <div className="receipt-payment-part" key={`${payment.method || "payment"}-${index}`}>
                          <span>
                            <strong>{paymentText(payment.method || "other")}</strong>
                            {payment.reference_number && <small>{payment.reference_number}</small>}
                          </span>
                          <span>
                            <strong>{money(tenderAmount, tenderCurrency)}</strong>
                            {payment.settlement_amount !== undefined
                              && tenderCurrency !== receipt.currency && (
                                <small>={money(payment.settlement_amount, receipt.currency)}</small>
                              )}
                            {change > 0 && (
                              <small>{label("Change", "ប្រាក់អាប់")}: {money(change, tenderCurrency)}</small>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <>
                    <div><span>{label("Received", "ទទួល")}</span><strong>{money(receipt.amountReceived, receipt.currency)}</strong></div>
                    <div><span>{label("Change", "ប្រាក់អាប់")}</span><strong>{money(receipt.changeAmount, receipt.currency)}</strong></div>
                  </>
                )}
              </div>

              <div className="receipt-footer">
                {receiptFooter}
              </div>
            </article>
          )}
        </div>

        <div className="receipt-actions">
          <button type="button" className="secondary-button" onClick={onClose}>{label("Close", "បិទ")}</button>
          <button type="button" className="primary-button" onClick={printReceipt}>
            <Printer size={18} /> {label("Print receipt", "បោះពុម្ពបង្កាន់ដៃ")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
