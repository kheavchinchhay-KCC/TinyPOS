export function creditDate(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(new Date(`${String(value).slice(0, 10)}T00:00:00`));
}

export function creditDateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function creditAccountStatusLabel(status) {
  const labels = {
    hold: "On hold",
    overdue: "Overdue",
    limit_reached: "Limit reached",
    open: "Balance open",
    clear: "Clear"
  };

  return labels[status] || String(status || "Unknown");
}

export function creditAccountStatusClass(status) {
  const classes = {
    hold: "hold",
    overdue: "overdue",
    limit_reached: "limit",
    open: "open",
    clear: "clear"
  };

  return classes[status] || "clear";
}

export async function loadCreditWorkspace(supabase) {
  const { data, error } = await supabase.rpc(
    "get_customer_credit_workspace"
  );

  if (error) throw error;

  return {
    accounts: Array.isArray(data?.accounts)
      ? data.accounts
      : [],
    customers: Array.isArray(data?.customers)
      ? data.customers
      : [],
    metrics: data?.metrics || {},
    canManage: Boolean(data?.can_manage),
    canReceivePayment: Boolean(
      data?.can_receive_payment
    )
  };
}

export async function loadCreditStatement(
  supabase,
  accountId
) {
  const { data, error } = await supabase.rpc(
    "get_customer_credit_statement",
    {
      p_account_id: accountId
    }
  );

  if (error) throw error;
  return data;
}

export async function saveCreditAccount(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "save_customer_credit_account_v3",
    {
      p_customer_id: values.customer_id,
      p_currency: values.currency,
      p_credit_limit: Number(
        values.credit_limit || 0
      ),
      p_allow_unlimited_credit: Boolean(
        values.allow_unlimited_credit
      ),
      p_payment_terms_days: Number(
        values.payment_terms_days || 0
      ),
      p_is_on_hold: Boolean(values.is_on_hold),
      p_notes: values.notes?.trim() || null
    }
  );

  if (error) throw error;
  return data;
}

export async function receiveCreditPayment(
  supabase,
  values
) {
  const { data, error } = await supabase.rpc(
    "record_customer_credit_payment_v2",
    {
      p_account_id: values.account_id,
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
