export default function ReportMetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "default"
}) {
  return (
    <article className={`report-metric-card ${tone}`}>
      <div className="report-metric-icon">
        <Icon size={21} />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </div>
    </article>
  );
}
