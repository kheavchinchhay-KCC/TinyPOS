import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  ExternalLink
} from "lucide-react";
import { Link } from "react-router-dom";

export default function SystemHealthCheckCard({ check }) {
  const failed = check.status === "fail";
  const critical = failed && check.severity === "critical";
  const Icon = !failed
    ? CheckCircle2
    : critical
      ? CircleAlert
      : AlertTriangle;

  return (
    <article
      className={`system-check-card ${
        !failed ? "pass" : critical ? "critical" : "warning"
      }`}
    >
      <Icon size={22} />
      <div>
        <strong>{check.label}</strong>
        <span>{check.detail}</span>
      </div>
      <b>{Number(check.count || 0)}</b>
      {failed && check.path && (
        <Link to={check.path} title="Open related page">
          <ExternalLink size={17} />
        </Link>
      )}
    </article>
  );
}
