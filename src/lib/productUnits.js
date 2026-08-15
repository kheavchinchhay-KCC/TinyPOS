export function sortedProductUnits(product) {
  return [...(product?.product_units || product?.units || [])]
    .filter((unit) => unit.is_active || unit.is_base)
    .sort(
      (a, b) =>
        Number(b.is_base) - Number(a.is_base)
        || Number(a.sort_order || 0) - Number(b.sort_order || 0)
        || String(a.name).localeCompare(String(b.name))
    );
}

export function baseProductUnit(product) {
  return (
    sortedProductUnits(product).find((unit) => unit.is_base)
    || sortedProductUnits(product)[0]
    || null
  );
}

export function findProductUnit(product, unitId) {
  const units = sortedProductUnits(product);

  return (
    units.find((unit) => unit.id === unitId)
    || units.find((unit) => unit.is_base)
    || units[0]
    || null
  );
}

export async function saveProductUnit(
  supabase,
  profile,
  product,
  values
) {
  const payload = {
    organization_id: profile.organization_id,
    product_id: product.id,
    name: values.name.trim(),
    short_name: values.short_name.trim() || null,
    conversion_factor: Number(values.conversion_factor),
    selling_price: Number(values.selling_price),
    barcode: values.barcode.trim() || null,
    is_base: Boolean(values.is_base),
    is_active: Boolean(values.is_active),
    sort_order: Number(values.sort_order || 0),
    created_by: profile.id
  };

  if (values.id) {
    const { data, error } = await supabase
      .from("product_units")
      .update({
        name: payload.name,
        short_name: payload.short_name,
        conversion_factor: payload.conversion_factor,
        selling_price: payload.selling_price,
        barcode: payload.barcode,
        is_active: payload.is_active,
        sort_order: payload.sort_order
      })
      .eq("id", values.id)
      .eq("organization_id", profile.organization_id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("product_units")
    .insert(payload)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setProductUnitStatus(
  supabase,
  profile,
  unit,
  isActive
) {
  if (unit.is_base && !isActive) {
    throw new Error("The base unit cannot be deactivated.");
  }

  const { data, error } = await supabase
    .from("product_units")
    .update({ is_active: Boolean(isActive) })
    .eq("id", unit.id)
    .eq("organization_id", profile.organization_id)
    .select()
    .single();

  if (error) throw error;
  return data;
}
