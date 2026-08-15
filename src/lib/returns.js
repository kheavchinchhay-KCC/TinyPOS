function beginningOfDay(dateString) {
  return new Date(`${dateString}T00:00:00`).toISOString();
}

function endOfDay(dateString) {
  return new Date(`${dateString}T23:59:59.999`).toISOString();
}

export function defaultReturnDateRange() {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return {
    from: today,
    to: today
  };
}

export function estimateRefund(sale, selections) {
  const saleItems = sale?.sale_items || [];
  const saleLineTotal = saleItems.reduce(
    (sum, item) => sum + Number(item.line_total || 0),
    0
  );

  let netRefund = 0;
  let taxRefund = 0;
  let costAmount = 0;

  for (const selection of selections) {
    const item = saleItems.find((row) => row.id === selection.sale_item_id);
    const quantity = Number(selection.quantity || 0);

    if (!item || quantity <= 0) continue;

    const soldQuantity = Number(item.quantity || 0);
    if (soldQuantity <= 0) continue;

    const itemNet = Number(item.line_total || 0) * quantity / soldQuantity;
    const itemTax =
      saleLineTotal > 0
        ? Number(sale.tax_amount || 0)
          * (Number(item.line_total || 0) / saleLineTotal)
          * (quantity / soldQuantity)
        : 0;

    netRefund += itemNet;
    taxRefund += itemTax;
    costAmount += Number(item.unit_cost || 0) * quantity;
  }

  const roundMoney = (value) =>
    Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

  return {
    netRefund: roundMoney(netRefund),
    taxRefund: roundMoney(taxRefund),
    totalRefund: roundMoney(netRefund + taxRefund),
    costAmount: Math.round((costAmount + Number.EPSILON) * 10000) / 10000,
    profitReversal:
      Math.round((netRefund - costAmount + Number.EPSILON) * 10000) / 10000
  };
}

export async function loadReturnsWorkspace(
  supabase,
  profile,
  filters
) {
  const { data, error } = await supabase.rpc(
    "get_returns_workspace_v2",
    {
      p_from: filters.from,
      p_to: filters.to
    }
  );

  if (error) throw error;

  return {
    sales: data?.sales || [],
    returns: data?.returns || [],
    refundPolicy: data?.refund_policy || {
      window: "current_date",
      label: "Current date",
      from: filters.from,
      to: filters.to
    }
  };
}

export async function processSaleReturn(supabase, values) {
  const { data, error } = await supabase.rpc("process_sale_return_v4", {
    p_sale_id: values.sale_id,
    p_items: values.items.map((item) => ({
      sale_item_id: item.sale_item_id,
      quantity: Number(item.quantity),
      restock: Boolean(item.restock)
    })),
    p_refund_method: values.refund_method,
    p_reason: values.reason.trim(),
    p_refund_reference: values.refund_reference.trim() || null,
    p_approval_request_id:
      values.approval_request_id || null
  });

  if (error) throw error;
  return data;
}
