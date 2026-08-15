import {
  AlertTriangle,
  ArrowRight,
  CircleAlert,
  CircleCheck,
  Info
} from "lucide-react";
import { Link } from "react-router-dom";
import { money } from "../lib/catalog";

function AlertIcon({ severity }) {
  if (severity === "danger") {
    return <CircleAlert size={21} />;
  }

  if (severity === "warning") {
    return <AlertTriangle size={21} />;
  }

  if (severity === "info") {
    return <Info size={21} />;
  }

  return <CircleCheck size={21} />;
}

export default function DashboardAlertCard({
  alert,
  currency = "USD"
}) {
  const target = alert.key === "out_of_stock"
    ? "/reorder?status=out_of_stock"
    : alert.key === "low_stock"
      ? "/reorder?status=attention"
      : alert.link || "/dashboard";

  return (
    <Link
      to={target}
      className={`dashboard-alert-card ${alert.severity || "neutral"}`}
    >
      <div className="dashboard-alert-icon">
        <AlertIcon severity={alert.severity} />
      </div>

      <div>
        <strong>{alert.title}</strong>
        <span>{alert.detail}</span>

        {alert.amount !== undefined
          && alert.amount !== null && (
            <b>
              {money(
                alert.amount,
                alert.currency || currency
              )}
            </b>
          )}
      </div>

      <ArrowRight size={18} />
    </Link>
  );
}
