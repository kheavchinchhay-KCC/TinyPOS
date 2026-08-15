export async function loadProductStockWorkspace(supabase, productId) {
  const { data, error } = await supabase.rpc("get_product_stock_workspace", {
    p_product_id: productId
  });

  if (error) throw error;

  return {
    product: data?.product || null,
    currentBranchId: data?.current_branch_id || null,
    totalStock: Number(data?.total_stock || 0),
    history: Array.isArray(data?.history) ? data.history : [],
    stockSummary: Array.isArray(data?.stock_summary) ? data.stock_summary : []
  };
}
