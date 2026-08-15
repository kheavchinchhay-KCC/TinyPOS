export function defaultReportRange() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return {
    from: today,
    to: today,
    allBranches: false,
    branchId: ""
  };
}

export async function loadReports(supabase, filters) {
  const parameters = {
    p_from: filters.from,
    p_to: filters.to,
    p_branch_id: filters.allBranches ? null : filters.branchId || null,
    p_all_branches: Boolean(filters.allBranches)
  };

  const [reportResult, cashResult] = await Promise.all([
    supabase.rpc("get_reports_data", parameters),
    supabase.rpc("get_cash_expense_workspace", parameters)
  ]);

  if (reportResult.error) throw reportResult.error;
  if (cashResult.error) throw cashResult.error;

  return {
    ...reportResult.data,
    cash_report: cashResult.data
  };
}

export function formatReportDate(value, options = {}) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: options.short ? "short" : "2-digit",
    day: "2-digit",
    ...(options.time
      ? { hour: "2-digit", minute: "2-digit" }
      : {})
  }).format(new Date(value));
}

export function formatPercent(value) {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(Number(value || 0))}%`;
}

export function exportCsv(filename, columns, rows) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return `"${text.replaceAll('"', '""')}"`;
  };

  const csv = [
    columns.map((column) => escape(column.label)).join(","),
    ...rows.map((row) =>
      columns
        .map((column) => escape(
          typeof column.value === "function"
            ? column.value(row)
            : row[column.value]
        ))
        .join(",")
    )
  ].join("\r\n");

  const blob = new Blob(["\ufeff", csv], {
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
