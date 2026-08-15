export function dateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function normalizeUnits(units = []) {
  return [...units]
    .map((unit) => ({
      ...unit,
      conversion_factor: Number(unit.conversion_factor || 1),
      selling_price: Number(unit.selling_price || 0)
    }))
    .filter((unit) => unit.is_active || unit.is_base)
    .sort(
      (a, b) =>
        Number(b.is_base) - Number(a.is_base)
        || Number(a.sort_order || 0) - Number(b.sort_order || 0)
        || String(a.name || "").localeCompare(String(b.name || ""))
    );
}

function normalizeTransferItem(item) {
  const product = item.products
    ? {
        ...item.products,
        product_units: normalizeUnits(item.products.product_units || [])
      }
    : null;
  const requestedFactor = Number(item.requested_unit_factor || 1);
  const countedFactor = Number(item.counted_unit_factor || 1);
  const baseQuantity = Number(item.quantity || 0);
  const countedBase = item.counted_quantity === null || item.counted_quantity === undefined
    ? null
    : Number(item.counted_quantity);

  const batchAllocations = (item.stock_transfer_item_batches || []).map((row) => ({
    ...row,
    base_quantity: Number(row.base_quantity || 0),
    base_unit_cost: Number(row.base_unit_cost || 0)
  }));

  return {
    ...item,
    quantity: baseQuantity,
    unit_cost: Number(item.unit_cost || 0),
    requested_unit_factor: requestedFactor,
    requested_unit_quantity: item.requested_unit_quantity === null || item.requested_unit_quantity === undefined
      ? baseQuantity / Math.max(requestedFactor, 0.001)
      : Number(item.requested_unit_quantity),
    requested_unit_name: item.requested_unit_name || product?.unit_name || "pcs",
    counted_quantity: countedBase,
    counted_unit_factor: countedFactor,
    counted_unit_quantity: item.counted_unit_quantity === null || item.counted_unit_quantity === undefined
      ? countedBase === null
        ? null
        : countedBase / Math.max(countedFactor, 0.001)
      : Number(item.counted_unit_quantity),
    counted_unit_name: item.counted_unit_name || product?.unit_name || "pcs",
    stock_transfer_item_batches: batchAllocations,
    products: product
  };
}

export async function loadTransferWorkspace(supabase, profile, options = {}) {
  const orgId = profile.organization_id;
  const branchId = profile.branch_id;

  let transferQuery = supabase
    .from("stock_transfers")
    .select(`
      id,transfer_number,source_branch_id,destination_branch_id,status,notes,created_by,created_at,
      received_by,received_at,receive_notes,cancelled_at,cancel_reason,
      workflow_version,count_status,count_notes,counted_by,counted_at,submitted_by,submitted_at,
      approved_by,approved_at,approval_note,requested_by_branch_id,
      source_branch:branches!stock_transfers_source_branch_id_fkey(id,name,code),
      destination_branch:branches!stock_transfers_destination_branch_id_fkey(id,name,code),
      stock_transfer_items(
        id,product_id,quantity,unit_cost,counted_quantity,count_note,
        requested_product_unit_id,requested_unit_name,requested_unit_factor,requested_unit_quantity,
        counted_product_unit_id,counted_unit_name,counted_unit_factor,counted_unit_quantity,
        stock_transfer_item_batches(
          id,source_batch_id,destination_batch_id,batch_number,expiry_date,received_date,base_quantity,base_unit_cost,notes,created_at
        ),
        products(
          id,name,name_km,sku,barcode,unit_name,currency,batch_tracking,expiry_tracking,picking_policy,
          product_units(id,name,short_name,conversion_factor,selling_price,barcode,is_base,is_active,sort_order)
        )
      )
    `)
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (!options.allBranches) {
    transferQuery = transferQuery.or(`source_branch_id.eq.${branchId},destination_branch_id.eq.${branchId}`);
  }

  const [branchResult, productResult, transferResult, purchaseResult, returnResult, metricsResult] = await Promise.all([
    supabase.from("branches").select("id,name,code,is_active").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("products").select(`
      id,name,name_km,sku,barcode,unit_name,currency,is_active,track_stock,batch_tracking,expiry_tracking,picking_policy,category_id,
      categories(id,name),
      inventory_balances(branch_id,quantity,average_cost),
      product_units(id,name,short_name,conversion_factor,selling_price,barcode,is_base,is_active,sort_order)
    `).eq("organization_id", orgId).eq("is_active", true).eq("track_stock", true).order("name"),
    transferQuery,
    supabase.from("purchases").select(`
      id,purchase_number,branch_id,supplier_id,status,currency,total_amount,received_at,first_received_at,last_received_at,created_at,
      suppliers(id,name),
      purchase_items(
        id,product_id,product_unit_id,purchase_unit_name,unit_factor,quantity,base_quantity,
        received_quantity,base_received_quantity,unit_cost,base_unit_cost,line_total,
        products(id,name,sku,barcode,unit_name,currency)
      )
    `).eq("organization_id", orgId).eq("branch_id", branchId).in("status", ["ordered", "received"]).order("last_received_at", { ascending: false, nullsFirst: false }).limit(100),
    supabase.from("purchase_returns").select(`
      id,return_number,purchase_id,supplier_id,status,currency,total_amount,reason,supplier_reference,created_at,
      suppliers(id,name),purchases(id,purchase_number),
      purchase_return_items(
        id,purchase_item_id,product_id,quantity,base_quantity,return_unit_name,unit_factor,unit_cost,base_unit_cost,line_total,
        products(id,name,sku,barcode,unit_name,currency)
      )
    `).eq("organization_id", orgId).eq("branch_id", branchId).eq("status", "completed").order("created_at", { ascending: false }).limit(200),
    supabase.rpc("get_stock_transfer_metrics_v5")
  ]);

  for (const result of [branchResult, productResult, transferResult, purchaseResult, returnResult, metricsResult]) {
    if (result.error) throw result.error;
  }

  const products = (productResult.data || []).map((product) => {
    const balances = (product.inventory_balances || []).map((row) => ({
      ...row,
      quantity: Number(row.quantity || 0),
      average_cost: Number(row.average_cost || 0)
    }));
    const balance = balances.find((row) => row.branch_id === branchId);
    return {
      ...product,
      inventory_balances: balances,
      product_units: normalizeUnits(product.product_units || []),
      stock_by_branch: Object.fromEntries(balances.map((row) => [row.branch_id, row])),
      stock_quantity: Number(balance?.quantity || 0),
      average_cost: Number(balance?.average_cost || 0)
    };
  });

  const transfers = (transferResult.data || []).map((transfer) => ({
    ...transfer,
    workflow_version: Number(transfer.workflow_version || 1),
    count_status: transfer.count_status || (transfer.status === "received" ? "approved" : "pending"),
    display_status: transfer.status === "received"
      ? "Approved"
      : transfer.status === "cancelled"
        ? "Cancelled"
        : transfer.count_status === "awaiting_approval"
          ? "Awaiting approval"
          : transfer.count_status === "counting"
            ? "Counting"
            : "Pending",
    stock_transfer_items: (transfer.stock_transfer_items || []).map(normalizeTransferItem)
  }));

  const returnedByPurchaseItem = new Map();
  for (const supplierReturn of returnResult.data || []) {
    for (const item of supplierReturn.purchase_return_items || []) {
      returnedByPurchaseItem.set(item.purchase_item_id, Number(returnedByPurchaseItem.get(item.purchase_item_id) || 0) + Number(item.quantity || 0));
    }
  }

  const purchases = (purchaseResult.data || []).map((purchase) => ({
    ...purchase,
    purchase_items: (purchase.purchase_items || []).map((item) => {
      const returnedQuantity = Number(returnedByPurchaseItem.get(item.id) || 0);
      const unitFactor = Number(item.unit_factor || 1);
      return {
        ...item,
        unit_factor: unitFactor,
        quantity: Number(item.quantity || 0),
        base_quantity: Number(item.base_quantity ?? Number(item.quantity || 0) * unitFactor),
        received_quantity: Number(item.received_quantity || 0),
        base_received_quantity: Number(item.base_received_quantity || 0),
        unit_cost: Number(item.unit_cost || 0),
        base_unit_cost: Number(item.base_unit_cost ?? Number(item.unit_cost || 0) / Math.max(unitFactor, 0.001)),
        returned_quantity: returnedQuantity,
        returnable_quantity: Math.max(0, Number(item.received_quantity || 0) - returnedQuantity)
      };
    })
  })).filter((purchase) => (purchase.purchase_items || []).some((item) => Number(item.received_quantity || 0) > 0));

  return {
    branches: branchResult.data || [],
    products,
    transfers,
    purchases,
    supplierReturns: returnResult.data || [],
    transferMetrics: metricsResult.data || {}
  };
}

export async function loadStockTransferBatchOptions(supabase, transferId) {
  const { data, error } = await supabase.rpc("get_stock_transfer_batch_options_v6", {
    p_transfer_id: transferId
  });
  if (error) throw error;
  return (data || []).map((row) => ({
    ...row,
    available_quantity: Number(row.available_quantity || 0),
    unit_cost: Number(row.unit_cost || 0),
    recommended_order: Number(row.recommended_order || 0)
  }));
}

export async function createStockTransfer(supabase, values) {
  const { data, error } = await supabase.rpc("create_stock_transfer_v5", {
    p_source_branch_id: values.source_branch_id,
    p_destination_branch_id: values.destination_branch_id,
    p_items: values.items.map((item) => ({
      product_id: item.product_id,
      product_unit_id: item.product_unit_id || null,
      quantity: Number(item.quantity)
    })),
    p_notes: values.notes?.trim() || null
  });
  if (error) throw error;
  return data;
}

export async function updateStockTransfer(supabase, values) {
  const { data, error } = await supabase.rpc("update_stock_transfer_v5", {
    p_transfer_id: values.transfer_id,
    p_source_branch_id: values.source_branch_id,
    p_destination_branch_id: values.destination_branch_id,
    p_items: values.items.map((item) => ({
      product_id: item.product_id,
      product_unit_id: item.product_unit_id || null,
      quantity: Number(item.quantity)
    })),
    p_notes: values.notes?.trim() || null
  });
  if (error) throw error;
  return data;
}

export async function saveStockTransferCount(supabase, values) {
  const { data, error } = await supabase.rpc("save_stock_transfer_count_v6", {
    p_transfer_id: values.transfer_id,
    p_items: values.items.map((item) => ({
      product_id: item.product_id,
      product_unit_id: item.product_unit_id || null,
      counted_unit_quantity: item.counted_unit_quantity === null || item.counted_unit_quantity === undefined || item.counted_unit_quantity === ""
        ? null
        : Number(item.counted_unit_quantity),
      batch_allocations: (item.batch_allocations || []).map((row) => ({
        source_batch_id: row.source_batch_id,
        base_quantity: Number(row.base_quantity)
      })),
      note: item.note || ""
    })),
    p_notes: values.notes?.trim() || null,
    p_submit: Boolean(values.submit)
  });
  if (error) throw error;
  return data;
}

export async function approveStockTransfer(supabase, transferId, note) {
  const { data, error } = await supabase.rpc("approve_stock_transfer_v6", {
    p_transfer_id: transferId,
    p_note: note?.trim() || null
  });
  if (error) throw error;
  return data;
}

export async function reopenStockTransferCount(supabase, transferId, note) {
  const { data, error } = await supabase.rpc("reopen_stock_transfer_count_v4", {
    p_transfer_id: transferId,
    p_note: note?.trim() || null
  });
  if (error) throw error;
  return data;
}

export async function receiveStockTransfer(supabase, transferId, notes) {
  const { data, error } = await supabase.rpc("receive_stock_transfer_v3", {
    p_transfer_id: transferId,
    p_notes: notes?.trim() || null
  });
  if (error) throw error;
  return data;
}

export async function cancelStockTransfer(supabase, transfer, reason) {
  const rpc = Number(transfer.workflow_version || 1) >= 2 ? "cancel_stock_transfer_v6" : "cancel_stock_transfer_v3";
  const { data, error } = await supabase.rpc(rpc, {
    p_transfer_id: transfer.id,
    p_reason: reason.trim()
  });
  if (error) throw error;
  return data;
}

export async function processSupplierReturn(supabase, values) {
  const { data, error } = await supabase.rpc("process_supplier_return_v5", {
    p_purchase_id: values.purchase_id,
    p_items: values.items.map((item) => ({ purchase_item_id: item.purchase_item_id, quantity: Number(item.quantity) })),
    p_reason: values.reason.trim(),
    p_supplier_reference: values.supplier_reference?.trim() || null
  });
  if (error) throw error;
  return data;
}
