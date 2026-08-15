export default function ReportBarChart({
  data,
  labelKey,
  valueKey,
  valueFormatter = (value) => value,
  emptyLabel = "No data for this period"
}) {
  const rows = (data || []).filter((row) => Number(row[valueKey] || 0) !== 0);
  const max = Math.max(...rows.map((row) => Math.abs(Number(row[valueKey] || 0))), 0);

  if (rows.length === 0 || max <= 0) {
    return <div className="report-chart-empty">{emptyLabel}</div>;
  }

  return (
    <div className="report-bar-chart">
      {rows.map((row, index) => {
        const value = Number(row[valueKey] || 0);
        const width = Math.max(2, Math.abs(value) / max * 100);

        return (
          <div className="report-bar-row" key={`${row[labelKey]}-${index}`}>
            <div className="report-bar-label" title={row[labelKey]}>
              {row[labelKey]}
            </div>
            <div className="report-bar-track">
              <div
                className={`report-bar-fill ${value < 0 ? "negative" : ""}`}
                style={{ width: `${width}%` }}
              />
            </div>
            <strong>{valueFormatter(value)}</strong>
          </div>
        );
      })}
    </div>
  );
}
