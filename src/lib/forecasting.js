import { savePurchaseOrder } from "./purchaseOrders";

export const FORECAST_RISKS = [
  ["", "All risks"],
  ["out_of_stock", "Out of stock"],
  ["critical", "Critical"],
  ["urgent", "Urgent"],
  ["watch", "Watch"],
  ["healthy", "Healthy"],
  ["insufficient_history", "Insufficient history"],
  ["slow_moving", "Slow moving"],
  ["overstock", "Overstock"]
];

export function forecastRiskLabel(value) {
  return Object.fromEntries(FORECAST_RISKS)[value] || value;
}

export function forecastRiskClass(value) {
  const classes = {
    out_of_stock: "danger",
    critical: "danger",
    urgent: "warning",
    watch: "incoming",
    healthy: "healthy",
    insufficient_history: "muted",
    slow_moving: "draft",
    overstock: "muted"
  };
  return classes[value] || "muted";
}

export async function loadDemandWorkspace(supabase, branchId) {
  const { data, error } = await supabase.rpc(
    "get_demand_planning_workspace",
    { p_branch_id: branchId || null }
  );
  if (error) throw error;
  return {
    settings: data?.settings || {},
    run: data?.run || {},
    items: Array.isArray(data?.items) ? data.items : [],
    history: Array.isArray(data?.history) ? data.history : []
  };
}

export async function runDemandForecast(supabase, branchId) {
  const { data, error } = await supabase.rpc(
    "run_demand_forecast",
    { p_branch_id: branchId || null }
  );
  if (error) throw error;
  return data;
}

export async function saveDemandSettings(supabase, branchId, values) {
  const { data, error } = await supabase.rpc(
    "save_demand_planning_settings",
    {
      p_branch_id: branchId || null,
      p_values: {
        history_days: Number(values.history_days || 90),
        forecast_horizon_days: Number(values.forecast_horizon_days || 30),
        safety_stock_days: Number(values.safety_stock_days || 0),
        recent_window_days: Number(values.recent_window_days || 30),
        recent_weight: Number(values.recent_weight || 0),
        seasonality_weight: Number(values.seasonality_weight || 0),
        minimum_history_days: Number(values.minimum_history_days || 14),
        slow_moving_days: Number(values.slow_moving_days || 60),
        overstock_cover_days: Number(values.overstock_cover_days || 90),
        auto_run_enabled: Boolean(values.auto_run_enabled),
        auto_run_hour: Number(values.auto_run_hour || 0)
      }
    }
  );
  if (error) throw error;
  return data;
}

function expectedDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + Math.max(0, Number(days || 0)));
  return date.toISOString().slice(0, 10);
}

export async function createForecastDraftPurchaseOrders(
  supabase,
  items,
  profile,
  run
) {
  const eligible = items.filter(
    (item) =>
      item.can_create_order &&
      item.preferred_supplier_id &&
      item.purchase_unit_id &&
      Number(item.suggested_purchase_quantity) > 0
  );

  if (!eligible.length) {
    throw new Error(
      "No selected forecast item is ready for a draft purchase order."
    );
  }

  const groups = new Map();

  for (const item of eligible) {
    const key = `${item.preferred_supplier_id}::${item.currency}`;
    if (!groups.has(key)) {
      groups.set(key, {
        supplier_id: item.preferred_supplier_id,
        supplier_name: item.preferred_supplier_name || "Supplier",
        currency: item.currency,
        lead_time_days: 0,
        items: []
      });
    }

    const group = groups.get(key);
    group.lead_time_days = Math.max(
      group.lead_time_days,
      Number(item.lead_time_days || 0)
    );
    group.items.push({
      product_id: item.product_id,
      product_unit_id: item.purchase_unit_id,
      quantity: Number(item.suggested_purchase_quantity),
      unit_cost: Number(item.estimated_purchase_unit_cost || 0)
    });
  }

  const created = [];

  for (const group of groups.values()) {
    const result = await savePurchaseOrder(supabase, {
      purchase_id: null,
      supplier_id: group.supplier_id,
      items: group.items,
      currency: group.currency,
      discount_amount: 0,
      tax_amount: 0,
      expected_date: expectedDate(group.lead_time_days),
      supplier_invoice_number: "",
      payment_terms: "",
      delivery_address: "",
      notes: [
        "Draft created by Tiny POS Demand Planning.",
        run?.id ? `Forecast run: ${run.id}.` : "",
        `Branch: ${profile?.branches?.name || "Selected branch"}.`
      ].filter(Boolean).join(" "),
      status: "draft"
    });

    created.push({
      ...result,
      supplier_name: group.supplier_name,
      item_count: group.items.length
    });
  }

  return created;
}

export function exportForecastCsv(items, run) {
  const headers = [
    "Risk",
    "Product",
    "SKU",
    "Barcode",
    "Category",
    "Daily Forecast",
    "Current Stock",
    "Reserved",
    "Incoming",
    "Days Cover",
    "Expected Stockout",
    "Recommended Order Date",
    "Suggested Quantity",
    "Purchase Unit",
    "Supplier",
    "Currency",
    "Estimated Order Total"
  ];

  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = items.map((item) => [
    forecastRiskLabel(item.risk_status),
    item.product_name,
    item.sku,
    item.barcode,
    item.category_name,
    item.forecast_daily_demand,
    item.current_stock,
    item.reserved_stock,
    item.incoming_stock,
    item.days_of_cover,
    item.expected_stockout_date,
    item.recommended_order_date,
    item.suggested_purchase_quantity,
    item.purchase_unit_name,
    item.preferred_supplier_name,
    item.currency,
    item.estimated_order_total
  ]);

  const csv = [headers, ...rows]
    .map((row) => row.map(quote).join(","))
    .join("\r\n");

  const blob = new Blob(["\uFEFF", csv], {
    type: "text/csv;charset=utf-8"
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `demand-forecast-${run?.as_of_date || new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}
