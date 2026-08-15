import ListViewControls from "./ListViewControls";
import { exportListExcel, printListDocument } from "../lib/listDocuments";
import { useListViewState } from "../lib/listViewState";

function valueFor(column, row) {
  if (typeof column.documentValue === "function") return column.documentValue(row);
  if (typeof column.value === "function") return column.value(row);
  if (typeof column.value === "string") return row[column.value];
  return "";
}

function CardValue({ column, row }) {
  return (
    <div className="responsive-card-value">
      {column.render
        ? column.render(row)
        : String(valueFor(column, row) ?? "—")}
    </div>
  );
}

function GenericCard({ row, columns }) {
  const visible = columns.filter((column) => !column.actionsOnly);
  const [primary, ...details] = visible;

  return (
    <article className="responsive-data-card responsive-generic-card">
      {primary && (
        <header className="responsive-generic-card-header">
          <div>
            <span className="responsive-card-label">{primary.label}</span>
            <CardValue column={primary} row={row} />
          </div>
        </header>
      )}

      <div className="responsive-card-field-list">
        {details.map((column) => (
          <div className="responsive-card-field" key={column.label}>
            <span className="responsive-card-label">{column.label}</span>
            <CardValue column={column} row={row} />
          </div>
        ))}
      </div>
    </article>
  );
}

export default function ResponsiveDataList({
  storageKey,
  title,
  subtitle = "",
  rows = [],
  columns = [],
  summary = [],
  filename = "tiny-pos-report.xls",
  printTitle,
  emptyTitle = "No records found",
  emptyText = "Change the filters and try again.",
  renderCard,
  rowKey = (row, index) => row.id || index,
  className = "",
  tableClassName = "",
  orientation = "landscape",
  initialPageSize = 30,
  headingExtra = null,
  exporting = false
}) {
  const state = useListViewState(rows, storageKey, initialPageSize);
  const documentColumns = columns
    .filter((column) => !column.excludeDocument && !column.actionsOnly)
    .map((column) => ({
      label: column.label,
      width: column.width,
      value: (row) => valueFor(column, row)
    }));

  function handleExport() {
    exportListExcel({
      filename,
      title: printTitle || title,
      subtitle,
      summary,
      columns: documentColumns,
      rows
    });
  }

  function handlePrint() {
    printListDocument({
      title: printTitle || title,
      subtitle,
      summary,
      columns: documentColumns,
      rows,
      orientation
    });
  }

  return (
    <section className={`panel responsive-data-list ${className}`.trim()}>
      <div className="responsive-data-list-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="responsive-data-list-heading-right">
          <span>{rows.length} rows</span>
          {headingExtra}
        </div>
      </div>

      <ListViewControls
        viewMode={state.viewMode}
        onViewModeChange={state.setViewMode}
        pageSize={state.pageSize}
        onPageSizeChange={state.setPageSize}
        totalRows={state.totalRows}
        currentPage={state.currentPage}
        totalPages={state.totalPages}
        onPageChange={state.setCurrentPage}
        onExport={handleExport}
        onPrint={handlePrint}
        exporting={exporting}
      />

      {rows.length === 0 ? (
        <div className="empty-state compact-empty-state">
          <h3>{emptyTitle}</h3>
          <p>{emptyText}</p>
        </div>
      ) : state.viewMode === "table" ? (
        <div className="responsive-wide-table-wrap">
          <table className={`responsive-wide-table ${tableClassName}`.trim()}>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.label} style={column.width ? { width: column.width } : undefined}>{column.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.pageRows.map((row, index) => (
                <tr key={rowKey(row, index)}>
                  {columns.map((column) => (
                    <td key={column.label} data-label={column.label} className={column.className || ""}>
                      {column.render ? column.render(row) : String(valueFor(column, row) ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="responsive-data-card-grid">
          {state.pageRows.map((row, index) => (
            renderCard
              ? <div className="responsive-card-grid-item" key={rowKey(row, index)}>{renderCard(row, index)}</div>
              : <GenericCard key={rowKey(row, index)} row={row} columns={columns} />
          ))}
        </div>
      )}
    </section>
  );
}
