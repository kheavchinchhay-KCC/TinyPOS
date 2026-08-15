export default function ImportPreviewTable({ headers, rows }) {
  if (!rows.length) return null;

  return (
    <div className="import-preview-wrap">
      <table className="import-preview-table">
        <thead>
          <tr>
            <th>CSV row</th>
            {headers.map((header) => (
              <th key={header}>{header.replaceAll("_", " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((row) => (
            <tr key={row.rowNumber}>
              <td>{row.rowNumber}</td>
              {headers.map((header) => (
                <td key={header} title={row.values[header] || ""}>
                  {row.values[header] || <span className="muted">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 && (
        <p className="import-preview-more">
          Showing 20 of {rows.length.toLocaleString("en-US")} data rows.
        </p>
      )}
    </div>
  );
}
