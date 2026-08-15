function normalizeUnit(unit) {
  return {
    ...unit,
    conversion_factor: Number(
      unit.conversion_factor || 1
    )
  };
}

function normalizeBatch(batch) {
  return {
    ...batch,
    initial_quantity: Number(batch.initial_quantity || 0),
    quantity: Number(batch.quantity || 0),
    unit_cost: Number(batch.unit_cost || 0)
  };
}

function normalizeItem(item) {
  return {
    ...item,
    expected_quantity: Number(
      item.expected_quantity || 0
    ),
    counted_quantity:
      item.counted_quantity === null
      || item.counted_quantity === undefined
        ? null
        : Number(item.counted_quantity),
    unit_cost_snapshot: Number(
      item.unit_cost_snapshot || 0
    ),
    products: item.products
      ? {
          ...item.products,
          product_units: [
            ...(item.products.product_units || [])
          ]
            .map(normalizeUnit)
            .filter(
              (unit) =>
                unit.is_active || unit.is_base
            )
            .sort(
              (a, b) =>
                Number(b.is_base)
                - Number(a.is_base)
                || Number(a.sort_order || 0)
                  - Number(b.sort_order || 0)
            ),
          inventory_batches: [
            ...(item.products.inventory_batches || [])
          ]
            .map(normalizeBatch)
            .sort((a, b) => {
              const aDate = a.expiry_date || "9999-12-31";
              const bDate = b.expiry_date || "9999-12-31";
              return String(aDate).localeCompare(String(bDate))
                || String(a.received_date || "").localeCompare(String(b.received_date || ""))
                || String(a.batch_number || "").localeCompare(String(b.batch_number || ""));
            })
        }
      : null
  };
}

function normalizeSession(session) {
  return {
    ...session,
    expected_items: Number(
      session.expected_items || 0
    ),
    counted_items: Number(
      session.counted_items || 0
    ),
    discrepancy_items: Number(
      session.discrepancy_items || 0
    ),
    shortage_items: Number(
      session.shortage_items || 0
    ),
    overage_items: Number(
      session.overage_items || 0
    ),
    value_variance_usd: Number(
      session.value_variance_usd || 0
    ),
    value_variance_khr: Number(
      session.value_variance_khr || 0
    )
  };
}

const itemSelect = `
  id,
  organization_id,
  session_id,
  product_id,
  expected_quantity,
  counted_quantity,
  selected_batch_id,
  unit_cost_snapshot,
  note,
  counted_by,
  counted_at,
  created_at,
  updated_at,
  products (
    id,
    name,
    name_km,
    sku,
    barcode,
    unit_name,
    currency,
    category_id,
    batch_tracking,
    expiry_tracking,
    picking_policy,
    categories (
      id,
      name
    ),
    product_units (
      id,
      name,
      short_name,
      conversion_factor,
      barcode,
      is_base,
      is_active,
      sort_order
    ),
    inventory_batches (
      id,
      batch_number,
      expiry_date,
      received_date,
      initial_quantity,
      quantity,
      unit_cost,
      status
    )
  )
`;

export async function loadStockCountItems(
  supabase,
  sessionId
) {
  const { data, error } = await supabase
    .from("stock_count_items")
    .select(itemSelect)
    .eq("session_id", sessionId);

  if (error) throw error;

  return (data || [])
    .map(normalizeItem)
    .sort((a, b) =>
      String(a.products?.name || "")
        .localeCompare(
          String(b.products?.name || "")
        )
    );
}

export async function loadStockCountWorkspace(
  supabase,
  profile
) {
  const [
    sessionResult,
    productResult,
    categoryResult
  ] = await Promise.all([
    supabase
      .from("stock_count_sessions")
      .select(`
        id,
        organization_id,
        branch_id,
        count_number,
        name,
        status,
        scope,
        category_id,
        blind_count,
        notes,
        expected_items,
        counted_items,
        discrepancy_items,
        shortage_items,
        overage_items,
        value_variance_usd,
        value_variance_khr,
        adjustment_id,
        started_by,
        started_at,
        completed_by,
        completed_at,
        cancelled_by,
        cancelled_at,
        cancellation_reason,
        created_at,
        updated_at,
        inventory_adjustments (
          adjustment_number
        )
      `)
      .eq(
        "organization_id",
        profile.organization_id
      )
      .eq("branch_id", profile.branch_id)
      .order("started_at", {
        ascending: false
      })
      .limit(60),

    supabase
      .from("products")
      .select(`
        id,
        name,
        name_km,
        sku,
        barcode,
        unit_name,
        currency,
        category_id,
        track_stock,
        is_active,
        categories (
          id,
          name
        ),
        product_units (
          id,
          name,
          short_name,
          conversion_factor,
          barcode,
          is_base,
          is_active,
          sort_order
        ),
        inventory_balances (
          branch_id,
          quantity,
          average_cost
        )
      `)
      .eq(
        "organization_id",
        profile.organization_id
      )
      .eq("is_active", true)
      .eq("track_stock", true)
      .order("name"),

    supabase
      .from("categories")
      .select("id,name,is_active")
      .eq(
        "organization_id",
        profile.organization_id
      )
      .eq("is_active", true)
      .order("name")
  ]);

  for (const result of [
    sessionResult,
    productResult,
    categoryResult
  ]) {
    if (result.error) throw result.error;
  }

  const sessions = (sessionResult.data || [])
    .map(normalizeSession);

  const activeSession =
    sessions.find(
      (session) =>
        session.status === "counting"
    ) || null;

  const activeItems = activeSession
    ? await loadStockCountItems(
        supabase,
        activeSession.id
      )
    : [];

  const products = (productResult.data || [])
    .map((product) => {
      const balance =
        (product.inventory_balances || [])
          .find(
            (row) =>
              row.branch_id === profile.branch_id
          );

      return {
        ...product,
        stock_quantity: Number(
          balance?.quantity || 0
        ),
        average_cost: Number(
          balance?.average_cost || 0
        ),
        product_units: [
          ...(product.product_units || [])
        ]
          .map(normalizeUnit)
          .filter(
            (unit) =>
              unit.is_active || unit.is_base
          )
          .sort(
            (a, b) =>
              Number(b.is_base)
              - Number(a.is_base)
              || Number(a.sort_order || 0)
                - Number(b.sort_order || 0)
          )
      };
    });

  return {
    sessions,
    activeSession,
    activeItems,
    products,
    categories:
      categoryResult.data || []
  };
}

function localDateBoundaryIso(dateKey, addDays = 0) {
  if (!dateKey) return null;
  const [year, month, day] = String(dateKey).split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day + addDays, 0, 0, 0, 0);
  return date.toISOString();
}

export async function loadStockCountHistorySessions(
  supabase,
  profile,
  { from, to } = {}
) {
  let query = supabase
    .from("stock_count_sessions")
    .select(`
      id,
      organization_id,
      branch_id,
      count_number,
      name,
      status,
      scope,
      category_id,
      blind_count,
      notes,
      expected_items,
      counted_items,
      discrepancy_items,
      shortage_items,
      overage_items,
      value_variance_usd,
      value_variance_khr,
      adjustment_id,
      started_by,
      started_at,
      completed_by,
      completed_at,
      cancelled_by,
      cancelled_at,
      cancellation_reason,
      created_at,
      updated_at,
      inventory_adjustments (
        adjustment_number
      )
    `)
    .eq("organization_id", profile.organization_id)
    .eq("branch_id", profile.branch_id)
    .neq("status", "counting")
    .order("started_at", { ascending: false });

  const startIso = localDateBoundaryIso(from);
  const endExclusiveIso = localDateBoundaryIso(to, 1);

  if (startIso) query = query.gte("started_at", startIso);
  if (endExclusiveIso) query = query.lt("started_at", endExclusiveIso);

  const { data, error } = await query.limit(1000);
  if (error) throw error;
  return (data || []).map(normalizeSession);
}

export function exactStockCountMatch(
  items,
  code
) {
  const needle = String(code || "")
    .trim()
    .toLowerCase();

  if (!needle) return null;

  for (const item of items) {
    const product = item.products;
    if (!product) continue;

    const unit =
      (product.product_units || [])
        .find(
          (row) =>
            row.is_active
            && String(row.barcode || "")
              .trim()
              .toLowerCase()
              === needle
        );

    if (unit) {
      return {
        item,
        product,
        unit
      };
    }

    if (
      String(product.sku || "")
        .trim()
        .toLowerCase()
        === needle
      || String(product.barcode || "")
        .trim()
        .toLowerCase()
        === needle
    ) {
      const baseUnit =
        (product.product_units || [])
          .find((row) => row.is_base)
        || (product.product_units || [])[0]
        || null;

      return {
        item,
        product,
        unit: baseUnit
      };
    }
  }

  return null;
}

export async function startStockCount(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "start_stock_count_v2",
    {
      p_name: values.name.trim(),
      p_scope: values.scope,
      p_category_id:
        values.scope === "category"
          ? values.category_id
          : null,
      p_product_ids:
        values.scope === "selected"
          ? values.product_ids
          : null,
      p_blind_count:
        Boolean(values.blind_count),
      p_notes:
        values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function saveStockCountItem(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_stock_count_item_v3",
    {
      p_session_id: values.session_id,
      p_product_id: values.product_id,
      p_counted_quantity:
        values.counted_quantity === null
          ? null
          : Number(
              values.counted_quantity
            ),
      p_note:
        values.note?.trim() || null,
      p_selected_batch_id:
        values.selected_batch_id || null
    }
  );

  if (error) throw error;
  return data;
}

export async function saveAllStockCountItems(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_stock_count_items_bulk_v3",
    {
      p_session_id: values.session_id,
      p_items: values.items.map((item) => ({
        product_id: item.product_id,
        counted_quantity:
          item.counted_quantity === null
            ? null
            : Number(item.counted_quantity),
        note: item.note?.trim() || null,
        selected_batch_id: item.selected_batch_id || null
      }))
    }
  );

  if (error) throw error;
  return data;
}

export async function scanStockCountItem(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "scan_stock_count_item_v2",
    {
      p_session_id: values.session_id,
      p_product_id: values.product_id,
      p_product_unit_id:
        values.product_unit_id || null,
      p_unit_quantity: Number(
        values.unit_quantity || 1
      )
    }
  );

  if (error) throw error;
  return data;
}

export async function completeStockCount(
  supabase,
  sessionId,
  note
) {
  const { data, error } = await supabase.rpc(
    "complete_stock_count_v3",
    {
      p_session_id: sessionId,
      p_completion_note:
        note?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function cancelStockCount(
  supabase,
  sessionId,
  reason
) {
  const { data, error } = await supabase.rpc(
    "cancel_stock_count_v2",
    {
      p_session_id: sessionId,
      p_reason: reason.trim()
    }
  );

  if (error) throw error;
  return data;
}
