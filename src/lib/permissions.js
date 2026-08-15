export const ROLE_PERMISSION_FALLBACKS = {
  owner: ["*"],

  admin: [
    "dashboard.view",
    "sales.create",
    "offline_checkout.use",
    "offline_checkout.manage",
    "sales.discount.apply",
    "sales.discount.unlimited",
    "quotations.manage",
    "sales_orders.manage",
    "sales_orders.deliver",
    "online_store.manage",
    "online_orders.manage",
    "online_orders.fulfill",
    "invoices.view",
    "returns.process",
    "returns.refund.unlimited",
    "customers.manage",
    "crm.view",
    "crm.manage",
    "crm.campaigns.send",
    "credit_accounts.manage",
    "credit_accounts.collect",
    "credit_accounts.sell",
    "coupons.manage",
    "price_lists.manage",
    "products.manage",
    "labels.print",
    "inventory.view",
    "inventory.adjust",
    "stock_counts.manage",
    "transfers.create",
    "transfers.receive",
    "transfers.cancel",
    "transfers.edit",
    "transfers.count",
    "transfers.approve",
    "purchases.manage",
    "purchases.receive",
    "purchases.cancel",
    "purchases.supplier_return",
    "supplier_payables.view",
    "supplier_payables.pay",
    "reorder.manage",
    "demand_planning.view",
    "demand_planning.manage",
    "demand_planning.create_purchase_orders",
    "cash_expenses.manage",
    "cash_expenses.void",
    "cash_register.use",
    "cash_register.close",
    "reports.view",
    "profit.view",
    "accounting.view",
    "accounting.export",
    "accounting.manage",
    "payroll.view_self",
    "payroll.manage",
    "payroll.approve",
    "payroll.pay",
    "branches.all",
    "branches.switch",
    "staff.manage",
    "staff_operations.self",
    "attendance.manage",
    "commissions.view_self",
    "commissions.manage",
    "commissions.pay",
    "access.manage",
    "approvals.review",
    "audit_backup.manage",
    "system_health.manage",
    "import.manage",
    "telegram.use",
    "telegram.admin",
    "integrations.view",
    "integrations.manage",
    "integrations.keys.manage",
    "integrations.webhooks.manage",
    "settings.view",
    "settings.manage"
  ],

  manager: [
    "dashboard.view",
    "sales.create",
    "offline_checkout.use",
    "offline_checkout.manage",
    "sales.discount.apply",
    "quotations.manage",
    "sales_orders.manage",
    "sales_orders.deliver",
    "online_store.manage",
    "online_orders.manage",
    "online_orders.fulfill",
    "invoices.view",
    "returns.process",
    "customers.manage",
    "crm.view",
    "crm.manage",
    "crm.campaigns.send",
    "credit_accounts.manage",
    "credit_accounts.collect",
    "credit_accounts.sell",
    "coupons.manage",
    "price_lists.manage",
    "products.manage",
    "labels.print",
    "inventory.view",
    "inventory.adjust",
    "stock_counts.manage",
    "transfers.create",
    "transfers.receive",
    "transfers.cancel",
    "transfers.edit",
    "transfers.count",
    "transfers.approve",
    "purchases.manage",
    "purchases.receive",
    "purchases.cancel",
    "purchases.supplier_return",
    "supplier_payables.view",
    "supplier_payables.pay",
    "reorder.manage",
    "demand_planning.view",
    "demand_planning.manage",
    "demand_planning.create_purchase_orders",
    "cash_expenses.manage",
    "cash_expenses.void",
    "cash_register.use",
    "cash_register.close",
    "reports.view",
    "profit.view",
    "accounting.view",
    "accounting.export",
    "payroll.view_self",
    "staff_operations.self",
    "attendance.manage",
    "commissions.view_self",
    "approvals.review",
    "telegram.use",
    "settings.view"
  ],

  cashier: [
    "dashboard.view",
    "sales.create",
    "offline_checkout.use",
    "sales.discount.apply",
    "quotations.manage",
    "sales_orders.deliver",
    "online_orders.fulfill",
    "invoices.view",
    "returns.process",
    "credit_accounts.collect",
    "credit_accounts.sell",
    "cash_register.use",
    "cash_register.close",
    "payroll.view_self",
    "staff_operations.self",
    "commissions.view_self",
    "telegram.use",
    "settings.view"
  ],

  viewer: [
    "dashboard.view",
    "invoices.view",
    "reports.view",
    "payroll.view_self",
    "staff_operations.self",
    "profit.view",
    "telegram.use",
    "settings.view"
  ]
};

export const ROLE_LIMIT_FALLBACKS = {
  owner: {
    max_discount_percent: null,
    max_discount_amount_usd: null,
    max_discount_amount_khr: null,
    max_refund_amount_usd: null,
    max_refund_amount_khr: null
  },

  admin: {
    max_discount_percent: null,
    max_discount_amount_usd: null,
    max_discount_amount_khr: null,
    max_refund_amount_usd: null,
    max_refund_amount_khr: null
  },

  manager: {
    max_discount_percent: 15,
    max_discount_amount_usd: 50,
    max_discount_amount_khr: 200000,
    max_refund_amount_usd: 100,
    max_refund_amount_khr: 400000
  },

  cashier: {
    max_discount_percent: 5,
    max_discount_amount_usd: 10,
    max_discount_amount_khr: 40000,
    max_refund_amount_usd: 0,
    max_refund_amount_khr: 0
  },

  viewer: {
    max_discount_percent: 0,
    max_discount_amount_usd: 0,
    max_discount_amount_khr: 0,
    max_refund_amount_usd: 0,
    max_refund_amount_khr: 0
  }
};

export function fallbackAccessForRole(role) {
  const list =
    ROLE_PERMISSION_FALLBACKS[role] || [];

  const permissions = {};

  if (list.includes("*")) {
    permissions["*"] = true;
  } else {
    for (const key of list) {
      permissions[key] = true;
    }
  }

  return {
    role,
    permissions,
    limits: {
      ...(ROLE_LIMIT_FALLBACKS[role]
        || ROLE_LIMIT_FALLBACKS.viewer)
    },
    fallback: true
  };
}

export function accessAllows(access, permissionKey) {
  if (!permissionKey) return true;

  if (
    access?.permissions?.["*"]
    || access?.role === "owner"
  ) {
    return true;
  }

  return Boolean(
    access?.permissions?.[permissionKey]
  );
}

export function accessAllowsAny(
  access,
  permissionKeys = []
) {
  return permissionKeys.some((key) =>
    accessAllows(access, key)
  );
}

export async function loadMyAccess(
  supabase,
  role
) {
  try {
    const { data, error } = await supabase.rpc(
      "get_my_access"
    );

    if (error) throw error;

    return {
      ...fallbackAccessForRole(role),
      ...(data || {}),
      permissions: {
        ...(data?.permissions || {})
      },
      limits: {
        ...ROLE_LIMIT_FALLBACKS[role],
        ...(data?.limits || {})
      },
      fallback: false
    };
  } catch {
    return fallbackAccessForRole(role);
  }
}

export async function loadAccessWorkspace(
  supabase
) {
  const { data, error } = await supabase.rpc(
    "get_access_control_workspace"
  );

  if (error) throw error;

  return {
    can_manage: Boolean(data?.can_manage),
    can_review: Boolean(data?.can_review),
    definitions: data?.definitions || [],
    staff: data?.staff || [],
    requests: data?.requests || []
  };
}

export async function loadRefundPermissionWorkspace(
  supabase
) {
  const { data, error } = await supabase.rpc(
    "get_refund_permission_workspace"
  );

  if (error) throw error;

  return {
    staff: data?.staff || [],
    windows: data?.windows || []
  };
}

export async function saveRefundPermissionWindow(
  supabase,
  userId,
  refundWindow
) {
  const { data, error } = await supabase.rpc(
    "save_user_refund_window",
    {
      p_user_id: userId,
      p_refund_window: refundWindow
    }
  );

  if (error) throw error;
  return data;
}

export async function saveUserAccess(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_user_access",
    {
      p_user_id: values.user_id,
      p_overrides: values.overrides,
      p_limits: values.limits
    }
  );

  if (error) throw error;
  return data;
}

export function moneyLimit(
  limits,
  prefix,
  currency
) {
  const key = `${prefix}_${
    currency === "KHR" ? "khr" : "usd"
  }`;

  const value = limits?.[key];

  return value === null
    || value === undefined
      ? null
      : Number(value);
}

export function saleApprovalPayload(values) {
  return {
    items: values.cart.map((item) => ({
      product_id: item.id,
      product_unit_id:
        item.selected_unit_id || null,
      quantity: Number(item.quantity)
    })),
    payment_method:
      String(values.payment_method || "")
        .trim()
        .toLowerCase(),
    amount_received:
      Number(values.amount_received || 0),
    customer_id:
      values.customer_id || null,
    manual_discount_type:
      values.discount_type,
    manual_discount_value:
      Number(values.discount_value || 0),
    coupon_code:
      values.coupon_code
        ? String(values.coupon_code)
            .trim()
            .toUpperCase()
        : null,
    currency: values.currency,
    source_quote_id:
      values.source_quote_id || null
  };
}

export function returnApprovalPayload(values) {
  return {
    sale_id: values.sale_id,
    items: values.items.map((item) => ({
      sale_item_id:
        item.sale_item_id,
      quantity:
        Number(item.quantity),
      restock:
        Boolean(item.restock)
    })),
    refund_method:
      String(values.refund_method || "")
        .trim()
        .toLowerCase(),
    reason:
      String(values.reason || "").trim(),
    refund_reference:
      values.refund_reference?.trim()
      || null
  };
}

export function saleDiscountApprovalRequirement(
  access,
  values
) {
  if (
    values.applied_coupon
    || values.discount_type === "none"
    || Number(values.discount_value || 0) <= 0
    || accessAllows(
      access,
      "sales.discount.unlimited"
    )
  ) {
    return {
      required: false,
      discountAmount:
        Number(values.discount_amount || 0)
    };
  }

  const discountAmount =
    Number(values.discount_amount || 0);

  const amountLimit = moneyLimit(
    access?.limits,
    "max_discount_amount",
    values.currency
  );

  const percentLimit =
    access?.limits?.max_discount_percent;

  const percentExceeded =
    values.discount_type === "percent"
    && percentLimit !== null
    && percentLimit !== undefined
    && Number(values.discount_value)
      > Number(percentLimit);

  const amountExceeded =
    amountLimit !== null
    && discountAmount > amountLimit;

  return {
    required:
      percentExceeded || amountExceeded,
    discountAmount,
    percentExceeded,
    amountExceeded,
    percentLimit:
      percentLimit === null
        || percentLimit === undefined
          ? null
          : Number(percentLimit),
    amountLimit
  };
}

export function estimateReturnAmount(
  sale,
  selectedItems
) {
  const totalSaleLines = (
    sale?.sale_items || []
  ).reduce(
    (sum, item) =>
      sum + Number(item.line_total || 0),
    0
  );

  let remainingTax = Math.max(
    0,
    Number(sale?.tax_amount || 0)
      - Number(
          sale?.previous_tax_refunded || 0
        )
  );

  let total = 0;

  const sorted = [...selectedItems].sort(
    (a, b) =>
      String(a.sale_item_id)
        .localeCompare(
          String(b.sale_item_id)
        )
  );

  for (const selected of sorted) {
    const saleItem = (
      sale?.sale_items || []
    ).find(
      (item) =>
        item.id === selected.sale_item_id
    );

    if (!saleItem) continue;

    const quantity =
      Number(selected.quantity || 0);

    const sold =
      Number(saleItem.quantity || 0);

    if (quantity <= 0 || sold <= 0) {
      continue;
    }

    const netRefund =
      Math.round(
        (
          Number(saleItem.line_total || 0)
          * quantity / sold
          + Number.EPSILON
        )
        * 100
      )
      / 100;

    let taxRefund = 0;

    if (
      totalSaleLines > 0
      && remainingTax > 0
    ) {
      taxRefund = Math.min(
        remainingTax,
        Math.round(
          (
            Number(sale.tax_amount || 0)
            * (
              Number(saleItem.line_total || 0)
              / totalSaleLines
            )
            * (quantity / sold)
            + Number.EPSILON
          )
          * 100
        )
        / 100
      );
    }

    remainingTax = Math.max(
      0,
      remainingTax - taxRefund
    );

    total += netRefund + taxRefund;
  }

  return Math.round(
    (total + Number.EPSILON) * 100
  ) / 100;
}

export function refundApprovalRequirement(
  access,
  amount,
  currency
) {
  if (
    accessAllows(
      access,
      "returns.refund.unlimited"
    )
  ) {
    return {
      required: false,
      limit: null,
      amount
    };
  }

  const limit = moneyLimit(
    access?.limits,
    "max_refund_amount",
    currency
  );

  return {
    required:
      limit !== null
      && Number(amount) > limit,
    limit,
    amount: Number(amount)
  };
}

export async function createApprovalRequest(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "create_approval_request",
    {
      p_permission_key:
        values.permission_key,
      p_action_type:
        values.action_type,
      p_action_payload:
        values.payload,
      p_action_summary:
        values.summary,
      p_amount:
        values.amount ?? null,
      p_currency:
        values.currency || null
    }
  );

  if (error) throw error;
  return data;
}

export async function loadApprovalRequest(
  supabase,
  requestId
) {
  const { data, error } = await supabase.rpc(
    "get_approval_request_status",
    {
      p_request_id: requestId
    }
  );

  if (error) throw error;
  return data;
}

export async function reviewApprovalRequest(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "review_approval_request",
    {
      p_request_id: values.request_id,
      p_decision: values.decision,
      p_note:
        values.note?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export function approvalStatusLabel(status) {
  const labels = {
    pending: "Waiting for approval",
    approved: "Approved",
    rejected: "Rejected",
    expired: "Expired",
    consumed: "Used",
    cancelled: "Cancelled"
  };

  return labels[status] || status;
}
