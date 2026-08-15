function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function valueFor(column, row) {
  return typeof column.value === "function"
    ? column.value(row)
    : row[column.value];
}

function widthFor(column, rows) {
  if (Number(column.width) > 0) return Number(column.width);
  let length = String(column.label || "").length;
  for (const row of rows.slice(0, 500)) {
    length = Math.max(length, String(valueFor(column, row) ?? "").length);
  }
  return Math.min(260, Math.max(72, length * 7.2 + 20));
}

function isMobileOrTelegram() {
  try {
    return window.matchMedia("(max-width: 900px)").matches
      || Boolean(window.Telegram?.WebApp?.initData)
      || /iPhone|iPad|iPod|Android/i.test(window.navigator.userAgent || "");
  } catch {
    return false;
  }
}

function currentStyleMarkup() {
  return [...document.querySelectorAll('link[rel="stylesheet"], style')]
    .map((node) => node.outerHTML)
    .join("\n");
}

function finalPrintGuardStyles(page) {
  const normalizedPage = String(page || "auto").trim();
  const isA4 = /^A4(?:\s|$)/i.test(normalizedPage);

  if (!isA4) {
    return `
.tiny-pos-print-frame-content,.tiny-pos-print-frame-content *{box-sizing:border-box!important}
.tiny-pos-print-frame-content img,.tiny-pos-print-frame-content svg{max-width:100%!important}
`;
  }

  return `
@page{size:${normalizedPage};margin:8mm}
html,body{width:auto!important;max-width:none!important;margin:0!important;padding:0!important;overflow:visible!important}
.tiny-pos-print-frame-content{width:100%!important;max-width:100%!important;margin:0 auto!important;padding:0!important;overflow:visible!important;box-sizing:border-box!important}
.tiny-pos-print-frame-content,.tiny-pos-print-frame-content *{box-sizing:border-box!important}
.tiny-pos-print-frame-content>*,
.tiny-pos-print-frame-content article,
.tiny-pos-print-frame-content section,
.tiny-pos-print-frame-content header,
.tiny-pos-print-frame-content footer,
.tiny-pos-print-frame-content div{max-width:100%!important;min-width:0!important}
.tiny-pos-print-frame-content table{width:100%!important;max-width:100%!important;min-width:0!important;table-layout:fixed!important;border-collapse:collapse!important}
.tiny-pos-print-frame-content thead{display:table-header-group!important}
.tiny-pos-print-frame-content tr{break-inside:avoid!important}
.tiny-pos-print-frame-content th,
.tiny-pos-print-frame-content td{min-width:0!important;max-width:none!important;white-space:normal!important;overflow-wrap:anywhere!important;word-break:normal!important}
.tiny-pos-print-frame-content img,
.tiny-pos-print-frame-content svg,
.tiny-pos-print-frame-content canvas{max-width:100%!important;height:auto!important}
.tiny-pos-print-frame-content pre,
.tiny-pos-print-frame-content code{white-space:pre-wrap!important;overflow-wrap:anywhere!important}
.po-print-document,.grn-print-document,.quote-print-document,.sales-order-print-document,.credit-statement-document,.supplier-statement-document,.register-report-document,.payslip-sheet,.tiny-pos-staff-print-document,.stock-count-print-document{width:100%!important;max-width:100%!important;min-width:0!important;margin-left:auto!important;margin-right:auto!important;overflow:visible!important}
.print-table-scroll,.responsive-wide-table-wrap,.stock-count-table-wrap,.stock-count-history-table-wrap{width:100%!important;max-width:100%!important;overflow:visible!important}
`;
}

function waitForPrintableAssets(doc) {
  const stylesheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((link) => {
    if (link.sheet) return Promise.resolve();

    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };

      link.addEventListener("load", finish, { once: true });
      link.addEventListener("error", finish, { once: true });
      window.setTimeout(finish, 4000);
    });
  });

  const images = [...doc.images].map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => resolve();
      image.addEventListener("load", finish, { once: true });
      image.addEventListener("error", finish, { once: true });
      window.setTimeout(finish, 3000);
    });
  });

  const fonts = doc.fonts?.ready
    ? Promise.race([
        doc.fonts.ready.catch(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 2500))
      ])
    : Promise.resolve();

  return Promise.all([fonts, ...stylesheets, ...images]);
}

/**
 * Print without navigating away from Tiny POS.
 * A temporary about:blank iframe is used so mobile Safari/Telegram does not
 * open a blank tab and the printed footer does not inherit the app route URL.
 */
function printInPlace({ title, html, styles = "", page = "auto", includeAppStyles = false }) {
  const previous = document.getElementById("tiny-pos-print-frame");
  previous?.remove();

  const frame = document.createElement("iframe");
  frame.id = "tiny-pos-print-frame";
  frame.title = `${title} print document`;
  frame.setAttribute("aria-hidden", "true");
  Object.assign(frame.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "1px",
    height: "1px",
    border: "0",
    opacity: "0.001",
    pointerEvents: "none",
    zIndex: "-1"
  });
  document.body.appendChild(frame);

  const doc = frame.contentDocument || frame.contentWindow?.document;
  if (!doc) {
    frame.remove();
    return false;
  }

  const appStyles = includeAppStyles ? currentStyleMarkup() : "";
  const finalGuards = finalPrintGuardStyles(page);
  const baseHref = escapeHtml(document.baseURI || window.location.origin || "/");
  const documentStyles = `
*{box-sizing:border-box}
html,body{margin:0!important;padding:0!important;width:100%!important;min-height:0!important;overflow:visible!important;background:#fff!important;color:#111!important;font-family:"Noto Sans Khmer",Arial,sans-serif!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{padding:0!important}
[data-print-hide],.no-print,.modal-actions,.receipt-actions,.po-print-actions,.grn-print-actions,.quote-print-actions,.sales-order-document-actions,.print-toolbar{display:none!important}
a{color:inherit;text-decoration:none}
@page{size:${page};margin:6mm}
@media print{html,body{width:100%!important;height:auto!important;overflow:visible!important}.tiny-pos-print-frame-content{display:block!important;visibility:visible!important;position:static!important;width:100%!important;max-width:none!important;margin:0!important;padding:0!important;overflow:visible!important}.tiny-pos-print-frame-content,.tiny-pos-print-frame-content *{visibility:visible!important}}
${styles}`;

  doc.open();
  doc.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" />
<base href="${baseHref}" />
<title>${escapeHtml(title)}</title>
${appStyles}
<style>${documentStyles}</style>
</head>
<body><main class="tiny-pos-print-frame-content">${html}</main><style id="tiny-pos-final-print-guard">${finalGuards}</style></body>
</html>`);
  doc.close();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.setTimeout(() => frame.remove(), 250);
  };

  frame.contentWindow?.addEventListener("afterprint", cleanup, { once: true });
  window.setTimeout(cleanup, 300000);

  const run = async () => {
    await waitForPrintableAssets(doc);
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  // The request still originates from the user's Print button. The short RAF
  // lets the iframe finish layout without opening another page or popup.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      void run();
    });
  });

  return true;
}

async function deliverFile(blob, filename, mimeType) {
  const safeName = filename || "tiny-pos-export.xls";

  if (isMobileOrTelegram() && typeof File !== "undefined" && navigator.share) {
    try {
      const file = new File([blob], safeName, { type: mimeType });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ title: safeName, files: [file] });
        return;
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function reportDocumentHtml({
  title,
  subtitle = "",
  summary = [],
  columns,
  rows,
  orientation = "landscape"
}) {
  const summaryHtml = summary.length
    ? `<section class="print-summary">${summary.map((item) => `<div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join("")}</section>`
    : "";
  const head = columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = rows.length
    ? rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(valueFor(column, row))}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${columns.length}">No records found.</td></tr>`;
  const content = `
    <header class="print-report-header">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
    </header>
    ${summaryHtml}
    <div class="print-table-scroll">
      <table class="print-report-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
  const styles = `
.tiny-pos-print-frame-content{padding:4mm;font-size:10px}
.print-report-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding-bottom:8px;border-bottom:2px solid #111}
.print-report-header h1{margin:0 0 3px;font-size:20px}.print-report-header p{margin:0;color:#555;text-align:right}
.print-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin:9px 0}
.print-summary div{border:1px solid #cfd6df;padding:6px;display:grid;gap:2px;break-inside:avoid}.print-summary span{color:#555;font-size:9px}.print-summary strong{font-size:11px}
.print-table-scroll{overflow:visible}.print-report-table{width:100%;border-collapse:collapse;table-layout:auto}
.print-report-table th,.print-report-table td{border:1px solid #cfd6df;padding:4px 5px;vertical-align:top;overflow-wrap:anywhere;word-break:normal}
.print-report-table th{background:#2563eb!important;color:#fff!important;text-align:left;white-space:normal}.print-report-table thead{display:table-header-group}.print-report-table tr{display:table-row!important;break-inside:avoid}.print-report-table th,.print-report-table td{display:table-cell!important}`;
  return { content, styles, page: `A4 ${orientation}` };
}

export function printListDocument(options) {
  const { title } = options;
  const { content, styles, page } = reportDocumentHtml(options);
  printInPlace({ title, html: content, styles, page });
}

export function exportListExcel({
  filename,
  title,
  subtitle = "",
  summary = [],
  columns,
  rows
}) {
  const columnXml = columns
    .map((column) => `<Column ss:AutoFitWidth="0" ss:Width="${widthFor(column, rows).toFixed(0)}"/>`)
    .join("");
  const summaryRows = summary.map((item) => `
    <Row>
      <Cell ss:StyleID="SummaryLabel"><Data ss:Type="String">${escapeXml(item.label)}</Data></Cell>
      <Cell ss:StyleID="SummaryValue"><Data ss:Type="String">${escapeXml(item.value)}</Data></Cell>
    </Row>`).join("");
  const header = columns.map((column) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(column.label)}</Data></Cell>`).join("");
  const body = rows.map((row) => `<Row ss:AutoFitHeight="1">${columns.map((column) => `<Cell ss:StyleID="Body"><Data ss:Type="String">${escapeXml(valueFor(column, row))}</Data></Cell>`).join("")}</Row>`).join("");
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
  <Style ss:ID="Title"><Font ss:Bold="1" ss:Size="16"/><Alignment ss:WrapText="1"/></Style>
  <Style ss:ID="Subtitle"><Font ss:Italic="1" ss:Color="#667085"/><Alignment ss:WrapText="1"/></Style>
  <Style ss:ID="SummaryLabel"><Font ss:Bold="1"/><Interior ss:Color="#F2F4F7" ss:Pattern="Solid"/><Alignment ss:WrapText="1"/></Style>
  <Style ss:ID="SummaryValue"><Alignment ss:WrapText="1"/></Style>
  <Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2563EB" ss:Pattern="Solid"/><Alignment ss:WrapText="1" ss:Horizontal="Center" ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  <Style ss:ID="Body"><Alignment ss:WrapText="1" ss:Vertical="Top"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D0D5DD"/></Borders></Style>
 </Styles>
 <Worksheet ss:Name="Report">
  <Table>
   ${columnXml}
   <Row><Cell ss:MergeAcross="${Math.max(0, columns.length - 1)}" ss:StyleID="Title"><Data ss:Type="String">${escapeXml(title)}</Data></Cell></Row>
   <Row><Cell ss:MergeAcross="${Math.max(0, columns.length - 1)}" ss:StyleID="Subtitle"><Data ss:Type="String">${escapeXml(subtitle)}</Data></Cell></Row>
   ${summaryRows}
   <Row>${header}</Row>
   ${body}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions>
 </Worksheet>
</Workbook>`;
  const safeName = filename.endsWith(".xls") ? filename : `${filename}.xls`;
  const blob = new Blob(["\uFEFF", xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  void deliverFile(blob, safeName, "application/vnd.ms-excel");
}

export function printHtmlDocument({
  title = "Tiny POS",
  html = "",
  styles = "",
  page = "auto",
  includeAppStyles = false
}) {
  return printInPlace({ title, html, styles, page, includeAppStyles });
}

export function printElementDocument({
  title = "Tiny POS",
  element,
  selector,
  styles = "",
  page = "auto",
  includeAppStyles = true
}) {
  const target = element || (selector ? document.querySelector(selector) : null);
  if (!target) return false;
  const html = target.outerHTML || target.innerHTML || "";
  return printInPlace({ title, html, styles, page, includeAppStyles });
}
