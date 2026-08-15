function activeNow(row) {
  const now = Date.now();

  if (!row?.is_active) return false;

  if (
    row.starts_at
    && new Date(row.starts_at).getTime() > now
  ) {
    return false;
  }

  if (
    row.ends_at
    && new Date(row.ends_at).getTime() <= now
  ) {
    return false;
  }

  return true;
}

export function priceListScopeLabel(list) {
  if (!list) return "Standard pricing";

  const customer = {
    all: "All customers",
    regular: "Regular",
    vip: "VIP",
    wholesale: "Wholesale"
  }[list.customer_type] || list.customer_type;

  return `${customer} · ${list.currency}`;
}

export async function loadPriceListWorkspace(
  supabase,
  profile
) {
  const [listResult, productResult, customerResult, branchResult] =
    await Promise.all([
      supabase
        .from("price_lists")
        .select(`
          id,
          organization_id,
          branch_id,
          code,
          name,
          currency,
          customer_type,
          priority,
          starts_at,
          ends_at,
          is_active,
          notes,
          created_at,
          updated_at,
          branches (
            id,
            code,
            name
          ),
          price_list_items (
            id,
            product_id,
            product_unit_id,
            selling_price
          )
        `)
        .eq("organization_id", profile.organization_id)
        .order("priority", { ascending: false })
        .order("name"),

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
            selling_price,
            barcode,
            is_base,
            is_active,
            sort_order
          )
        `)
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name"),

      supabase
        .from("customers")
        .select(`
          id,
          customer_code,
          customer_type,
          name,
          company_name,
          phone,
          email,
          price_list_id,
          is_active
        `)
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name"),

      supabase
        .from("branches")
        .select("id,code,name,is_active")
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name")
    ]);

  for (const result of [
    listResult,
    productResult,
    customerResult,
    branchResult
  ]) {
    if (result.error) throw result.error;
  }

  const products = (productResult.data || []).map((product) => ({
    ...product,
    product_units: [...(product.product_units || [])]
      .filter((unit) => unit.is_active || unit.is_base)
      .sort(
        (a, b) =>
          Number(b.is_base) - Number(a.is_base)
          || Number(a.sort_order || 0) - Number(b.sort_order || 0)
          || String(a.name).localeCompare(String(b.name))
      )
  }));

  const lists = (listResult.data || []).map((list) => ({
    ...list,
    priority: Number(list.priority || 0),
    price_list_items: (list.price_list_items || []).map((item) => ({
      ...item,
      selling_price: Number(item.selling_price || 0)
    })),
    assigned_customer_count: (customerResult.data || []).filter(
      (customer) => customer.price_list_id === list.id
    ).length
  }));

  return {
    lists,
    products,
    customers: customerResult.data || [],
    branches: branchResult.data || []
  };
}

export async function savePriceList(supabase, values) {
  const { data, error } = await supabase.rpc(
    "save_price_list_v2",
    {
      p_price_list_id: values.price_list_id || null,
      p_code: values.code.trim(),
      p_name: values.name.trim(),
      p_currency: values.currency,
      p_customer_type: values.customer_type,
      p_branch_id: values.branch_id || null,
      p_priority: Number(values.priority || 0),
      p_starts_at: values.starts_at || null,
      p_ends_at: values.ends_at || null,
      p_is_active: Boolean(values.is_active),
      p_notes: values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function savePriceListItems(
  supabase,
  priceListId,
  rows
) {
  const { data, error } = await supabase.rpc(
    "save_price_list_items_v2",
    {
      p_price_list_id: priceListId,
      p_items: rows.map((row) => ({
        product_unit_id: row.product_unit_id,
        selling_price: Number(row.selling_price)
      }))
    }
  );

  if (error) throw error;
  return data;
}

export async function assignCustomerPriceList(
  supabase,
  customerId,
  priceListId
) {
  const { data, error } = await supabase.rpc(
    "assign_customer_price_list_v2",
    {
      p_customer_id: customerId,
      p_price_list_id: priceListId || null
    }
  );

  if (error) throw error;
  return data;
}

export async function loadCustomerPriceCatalog(
  supabase,
  customerId,
  currency
) {
  const { data, error } = await supabase.rpc(
    "get_customer_price_catalog",
    {
      p_customer_id: customerId || null,
      p_currency: currency
    }
  );

  if (error) throw error;

  return {
    price_list_id: data?.price_list_id || null,
    price_list_code: data?.price_list_code || null,
    price_list_name: data?.price_list_name || null,
    customer_type: data?.customer_type || null,
    currency,
    items: Array.isArray(data?.items) ? data.items : []
  };
}

export function applyPriceCatalog(products, catalog) {
  const priceMap = new Map(
    (catalog?.items || []).map((item) => [
      item.product_unit_id,
      Number(item.selling_price || 0)
    ])
  );

  return products.map((product) => {
    const units = (product.product_units || product.units || []).map((unit) => {
      const standardPrice = Number(
        unit.standard_selling_price
        ?? unit.selling_price
        ?? 0
      );

      const override = priceMap.get(unit.id);
      const effectivePrice = override === undefined
        ? standardPrice
        : override;

      return {
        ...unit,
        standard_selling_price: standardPrice,
        selling_price: effectivePrice,
        price_list_id: catalog?.price_list_id || null,
        price_list_name: catalog?.price_list_name || null,
        price_adjustment: standardPrice - effectivePrice
      };
    });

    const baseUnit = units.find((unit) => unit.is_base) || units[0];

    return {
      ...product,
      product_units: units,
      units,
      selling_price: Number(baseUnit?.selling_price || product.selling_price || 0),
      price_list_id: catalog?.price_list_id || null,
      price_list_name: catalog?.price_list_name || null
    };
  });
}

export function chooseAutomaticPriceList(
  lists,
  customer,
  branchId,
  currency
) {
  const active = lists.filter(
    (list) =>
      list.currency === currency
      && activeNow(list)
      && (!list.branch_id || list.branch_id === branchId)
  );

  const assigned = customer?.price_list_id
    ? active.find((list) => list.id === customer.price_list_id)
    : null;

  if (assigned) return assigned;

  return active
    .filter((list) =>
      list.customer_type === "all"
      || (
        customer
        && list.customer_type === customer.customer_type
      )
    )
    .sort(
      (a, b) =>
        Number(
          customer
          && b.customer_type === customer.customer_type
        )
        - Number(
          customer
          && a.customer_type === customer.customer_type
        )
        || Number(b.branch_id === branchId) - Number(a.branch_id === branchId)
        || Number(b.priority || 0) - Number(a.priority || 0)
    )[0] || null;
}
