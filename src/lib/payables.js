export function payableDate(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(
    new Date(`${String(value).slice(0, 10)}T00:00:00`)
  );
}

export function payableDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function payableMethodLabel(method) {
  const labels = {
    cash: "Cash",
    bank: "Bank",
    khqr: "KHQR",
    card: "Card",
    other: "Other"
  };

  return labels[method] || String(method || "Other");
}

export function agingLabel(bucket) {
  const labels = {
    current: "Current",
    "1_30": "1–30 days",
    "31_60": "31–60 days",
    "61_90": "61–90 days",
    over_90: "Over 90 days"
  };

  return labels[bucket] || bucket;
}

export function agingClass(bucket) {
  if (bucket === "current") return "current";
  if (bucket === "1_30") return "warning";
  if (bucket === "31_60") return "late";
  return "danger";
}

export async function loadSupplierPayables(
  supabase,
  allBranches = false,
  asOf = null
) {
  const { data, error } = await supabase.rpc(
    "get_supplier_payables_center",
    {
      p_all_branches: Boolean(allBranches),
      p_as_of: asOf || null
    }
  );

  if (error) throw error;

  return {
    meta: data?.meta || {},
    summary: data?.summary || {
      usd: {},
      khr: {}
    },
    suppliers: data?.suppliers || [],
    invoices: data?.invoices || [],
    recent_payments:
      data?.recent_payments || []
  };
}

export async function saveSupplierTerms(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_supplier_payable_terms",
    {
      p_supplier_id: values.supplier_id,
      p_default_payment_terms_days:
        Number(values.default_payment_terms_days),
      p_apply_to_open_purchases:
        Boolean(values.apply_to_open_purchases),
      p_apply_all_branches:
        Boolean(values.apply_all_branches)
    }
  );

  if (error) throw error;
  return data;
}

export async function recordSupplierPayment(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "record_supplier_payment_batch_v2",
    {
      p_supplier_id: values.supplier_id,
      p_currency: values.currency,
      p_amount: Number(values.amount),
      p_method: values.method,
      p_reference_number:
        values.reference_number?.trim() || null,
      p_notes: values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function loadSupplierStatement(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "get_supplier_payable_statement",
    {
      p_supplier_id: values.supplier_id,
      p_from: values.from,
      p_to: values.to,
      p_all_branches:
        Boolean(values.all_branches)
    }
  );

  if (error) throw error;
  return data;
}

function csvCell(value) {
  const text = String(value ?? "");

  if (
    text.includes(",")
    || text.includes('"')
    || text.includes("\n")
  ) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

export function downloadSupplierPayablesCsv(
  invoices,
  filename = "supplier-payables.csv"
) {
  const headers = [
    "Supplier Code",
    "Supplier",
    "Purchase",
    "Branch",
    "Currency",
    "Total",
    "Paid",
    "Return Credit",
    "Balance Due",
    "Due Date",
    "Days Overdue",
    "Aging"
  ];

  const rows = invoices.map((invoice) => [
    invoice.supplier_code,
    invoice.supplier_name,
    invoice.purchase_number,
    invoice.branch_name,
    invoice.currency,
    invoice.total_amount,
    invoice.amount_paid,
    invoice.return_credit,
    invoice.balance_due,
    invoice.due_date,
    invoice.days_overdue,
    agingLabel(invoice.aging_bucket)
  ]);

  const csv = [
    headers,
    ...rows
  ]
    .map((row) =>
      row.map(csvCell).join(",")
    )
    .join("\n");

  const blob = new Blob(
    [`\uFEFF${csv}`],
    {
      type: "text/csv;charset=utf-8"
    }
  );

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
