import {
  escapeHtml,
  miniAppUrl,
  sendTelegramMessage,
  serviceClient
} from "./_telegram-shared.mjs";
import {
  tg,
  telegramLanguage
} from "./_telegram-i18n.mjs";
import { dispatchPendingOperationalEvents } from "./_telegram-events.mjs";

export const config = {
  schedule: "*/15 * * * *"
};

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value, currency) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KHR" ? 0 : 2
  }).format(number(value));
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function zonedDateTimeToUtc({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0
}, timeZone) {
  const desired = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second
  );

  let guess = desired;

  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(new Date(guess), timeZone);
    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    guess += desired - represented;
  }

  return new Date(guess);
}

function localContext(now, timeZone) {
  const parts = zonedParts(now, timeZone);
  const start = zonedDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0
  }, timeZone);

  const tomorrowLocal = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + 1
  ));

  const tomorrowParts = {
    year: tomorrowLocal.getUTCFullYear(),
    month: tomorrowLocal.getUTCMonth() + 1,
    day: tomorrowLocal.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0
  };

  const end = zonedDateTimeToUtc(tomorrowParts, timeZone);

  return {
    date: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    hour: parts.hour,
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function isQuiet(preferences, hour) {
  const start = preferences.quiet_start_hour;
  const end = preferences.quiet_end_hour;

  if (start === null || start === undefined || end === null || end === undefined) {
    return false;
  }

  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function canReceive(role, eventType) {
  const roles = {
    stock: ["owner", "admin", "manager"],
    forecast: ["owner", "admin", "manager"],
    summary: ["owner", "admin", "manager", "cashier", "viewer"],
    credit: ["owner", "admin", "manager"],
    supplier: ["owner", "admin", "manager"],
    purchase: ["owner", "admin", "manager"],
    transfer: ["owner", "admin", "manager"],
    quotation: ["owner", "admin", "manager", "cashier"],
    sales_order: ["owner", "admin", "manager", "cashier"],
    online_order: ["owner", "admin", "manager", "cashier"],
    register: ["owner", "admin", "manager", "cashier"],
    approval: ["owner", "admin", "manager"],
    attendance: ["owner", "admin", "manager", "cashier", "viewer"],
    payroll: ["owner", "admin"],
    integration: ["owner", "admin"]
  };

  return (roles[eventType] || []).includes(role);
}

function permissionAllowed(
  role,
  override,
  defaultRoles
) {
  if (role === "owner") return true;

  if (override !== undefined) {
    return Boolean(override);
  }

  return defaultRoles.includes(role);
}

async function reserveDelivery(service, link, event) {
  const { data, error } = await service
    .from("telegram_notification_deliveries")
    .insert({
      organization_id: link.organization_id,
      user_id: link.user_id,
      telegram_link_id: link.id,
      event_type: event.type,
      event_key: event.key,
      chat_id: link.chat_id,
      message_text: event.text,
      status: "pending",
      payload: event.payload || {}
    })
    .select("id")
    .single();

  if (error?.code === "23505") return null;
  if (error) throw error;
  return data.id;
}

async function deliver(service, link, event) {
  const deliveryId = await reserveDelivery(service, link, event);
  if (!deliveryId) return false;

  try {
    const message = await sendTelegramMessage({
      chatId: link.chat_id,
      text: event.text,
      path: event.path,
      buttonText: event.buttonText || tg(event.language, "open_pos")
    });

    await service
      .from("telegram_notification_deliveries")
      .update({
        status: "sent",
        telegram_message_id: message.message_id,
        sent_at: new Date().toISOString()
      })
      .eq("id", deliveryId);

    return true;
  } catch (error) {
    await service
      .from("telegram_notification_deliveries")
      .update({
        status: "failed",
        error_message: String(error.message || error).slice(0, 1000)
      })
      .eq("id", deliveryId);

    if (/blocked by the user|chat not found|user is deactivated/i.test(error.message)) {
      await service
        .from("telegram_user_links")
        .update({ is_active: false })
        .eq("id", link.id);
    }

    return false;
  }
}

async function activeBranchIds(service, link, profile, preferences) {
  if (
    preferences.all_branches
    && ["owner", "admin"].includes(profile.role)
  ) {
    const { data, error } = await service
      .from("branches")
      .select("id,name,code")
      .eq("organization_id", link.organization_id)
      .eq("is_active", true)
      .order("name");

    if (error) throw error;
    return data || [];
  }

  return profile.branches
    ? [profile.branches]
    : profile.branch_id
      ? [{ id: profile.branch_id, name: "Assigned branch" }]
      : [];
}

async function buildSummary(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);

  const [salesResult, returnsResult] = await Promise.all([
    service
      .from("sales")
      .select("id,currency,total_amount")
      .eq("organization_id", link.organization_id)
      .in("branch_id", ids)
      .in("status", ["completed", "partially_refunded", "refunded"])
      .gte("completed_at", context.start)
      .lt("completed_at", context.end),
    service
      .from("returns")
      .select("id,currency,refund_amount")
      .eq("organization_id", link.organization_id)
      .in("branch_id", ids)
      .eq("status", "completed")
      .gte("processed_at", context.start)
      .lt("processed_at", context.end)
  ]);

  if (salesResult.error) throw salesResult.error;
  if (returnsResult.error) throw returnsResult.error;

  const totals = { USD: 0, KHR: 0 };
  const refunds = { USD: 0, KHR: 0 };

  for (const sale of salesResult.data || []) {
    totals[sale.currency] += number(sale.total_amount);
  }

  for (const row of returnsResult.data || []) {
    refunds[row.currency] += number(row.refund_amount);
  }

  return {
    type: "summary",
    key: `summary:${context.date}:${scopeName}`,
    path: "/dashboard",
    language,
    buttonText: tg(language, "open_dashboard"),
    text: [
      `📊 <b>${tg(language, "summary_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "transactions", {
        count: (salesResult.data || []).length
      }),
      tg(language, "net_usd", {
        amount: money(totals.USD - refunds.USD, "USD")
      }),
      tg(language, "net_khr", {
        amount: money(totals.KHR - refunds.KHR, "KHR")
      }),
      tg(language, "refunds", {
        count: (returnsResult.data || []).length
      }),
      "",
      tg(language, "business_date", {
        date: context.date
      })
    ].join("\n"),
    payload: { totals, refunds }
  };
}

async function buildStock(service, link, branchIds, context, scopeName, settings, language) {
  const ids = branchIds.map((branch) => branch.id);
  const { data, error } = await service
    .from("inventory_balances")
    .select(`
      quantity,
      branch_id,
      products!inner(
        id,
        name,
        is_active,
        track_stock,
        low_stock_threshold
      )
    `)
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .eq("products.is_active", true)
    .eq("products.track_stock", true);

  if (error) throw error;

  let out = 0;
  let low = 0;

  for (const row of data || []) {
    const quantity = number(row.quantity);
    const threshold = number(
      row.products?.low_stock_threshold
      ?? settings.low_stock_threshold
      ?? 0
    );

    if (quantity <= 0) out += 1;
    else if (quantity <= threshold) low += 1;
  }

  if (!out && !low) return null;

  return {
    type: "stock",
    key: `stock:${context.date}:${scopeName}`,
    path: "/reorder",
    language,
    buttonText: tg(language, "open_reorder"),
    text: [
      `⚠️ <b>${tg(language, "stock_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "out_stock", { count: out }),
      tg(language, "low_stock", { count: low }),
      "",
      tg(language, "stock_help")
    ].join("\n"),
    payload: { out_of_stock: out, low_stock: low }
  };
}

async function buildExpiry(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const limit = new Date(`${context.date}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + 30);
  const limitDate = limit.toISOString().slice(0, 10);
  const { data, error } = await service
    .from("inventory_batches")
    .select("id,expiry_date,quantity,status")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .gt("quantity", 0)
    .not("expiry_date", "is", null)
    .lte("expiry_date", limitDate);
  if (error) throw error;
  let expired = 0;
  let expiring = 0;
  for (const row of data || []) {
    if (row.status === "depleted") continue;
    if (row.expiry_date < context.date) expired += 1;
    else expiring += 1;
  }
  if (!expired && !expiring) return null;
  return {
    type: "stock",
    key: `expiry:${context.date}:${scopeName}`,
    path: "/batches",
    language,
    buttonText: tg(language, "open_batches"),
    text: [
      `⏳ <b>${tg(language, "expiry_title", { scope: escapeHtml(scopeName) })}</b>`,
      "",
      tg(language, "expired_batches", { count: expired }),
      tg(language, "expiring_batches", { count: expiring }),
      "",
      tg(language, "expiry_help")
    ].join("\n"),
    payload: { expired, expiring }
  };
}

async function buildForecast(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const { data: runRows, error: runError } = await service
    .from("demand_forecast_runs")
    .select("id,branch_id,generated_at,as_of_date,status")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .eq("status", "completed")
    .order("generated_at", { ascending: false })
    .limit(100);

  if (runError) {
    if (runError.code === "42P01" || String(runError.message || "").includes("demand_forecast_runs")) {
      return null;
    }
    throw runError;
  }

  const latestByBranch = new Map();
  for (const row of runRows || []) {
    if (!latestByBranch.has(row.branch_id)) latestByBranch.set(row.branch_id, row);
  }
  const runs = [...latestByBranch.values()];
  if (!runs.length) return null;

  const { data, error } = await service
    .from("demand_forecast_items")
    .select("id,run_id,risk_status,currency,estimated_order_total")
    .in("run_id", runs.map((row) => row.id))
    .in("risk_status", ["out_of_stock", "critical", "urgent"]);

  if (error) throw error;
  if (!(data || []).length) return null;

  const critical = (data || []).filter(
    (row) => row.risk_status === "out_of_stock" || row.risk_status === "critical"
  ).length;
  const urgent = (data || []).filter((row) => row.risk_status === "urgent").length;
  const usd = (data || []).filter((row) => row.currency === "USD")
    .reduce((sum, row) => sum + number(row.estimated_order_total), 0);
  const khr = (data || []).filter((row) => row.currency === "KHR")
    .reduce((sum, row) => sum + number(row.estimated_order_total), 0);

  return {
    type: "forecast",
    key: `forecast:${context.date}:${scopeName}:${runs.map((row) => row.id).sort().join("-")}`,
    path: "/demand-planning",
    language,
    buttonText: tg(language, "open_demand_planning"),
    text: [
      `📈 <b>${tg(language, "forecast_title", { scope: escapeHtml(scopeName) })}</b>`,
      "",
      tg(language, "forecast_critical", { count: critical }),
      tg(language, "forecast_urgent", { count: urgent }),
      tg(language, "forecast_value_usd", { amount: money(usd, "USD") }),
      tg(language, "forecast_value_khr", { amount: money(khr, "KHR") }),
      "",
      tg(language, "forecast_help")
    ].join("\n"),
    payload: { critical, urgent, usd, khr, run_ids: runs.map((row) => row.id) }
  };
}

async function buildCredit(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const { data, error } = await service
    .from("sales")
    .select("id,currency,credit_amount,paid_amount,credit_due_date")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .not("credit_account_id", "is", null)
    .lt("credit_due_date", context.date)
    .in("payment_status", ["unpaid", "partial"]);

  if (error) throw error;
  if (!(data || []).length) return null;

  const due = { USD: 0, KHR: 0 };
  for (const sale of data || []) {
    due[sale.currency] += Math.max(
      0,
      number(sale.credit_amount) - number(sale.paid_amount)
    );
  }

  return {
    type: "credit",
    key: `credit:${context.date}:${scopeName}`,
    path: "/credit-accounts",
    language,
    buttonText: tg(language, "open_credit"),
    text: [
      `⏰ <b>${tg(language, "credit_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "overdue_invoices", { count: data.length }),
      tg(language, "outstanding_usd", {
        amount: money(due.USD, "USD")
      }),
      tg(language, "outstanding_khr", {
        amount: money(due.KHR, "KHR")
      })
    ].join("\n"),
    payload: { count: data.length, due }
  };
}

async function buildSupplier(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const { data, error } = await service
    .from("purchases")
    .select("id,currency,total_amount,amount_paid,payment_due_date")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .eq("status", "received")
    .lte("payment_due_date", context.date);

  if (error) throw error;

  const rows = (data || []).filter(
    (row) => number(row.total_amount) > number(row.amount_paid)
  );

  if (!rows.length) return null;

  return {
    type: "supplier",
    key: `supplier:${context.date}:${scopeName}`,
    path: "/supplier-payables",
    language,
    buttonText: tg(language, "open_payables"),
    text: [
      `🧾 <b>${tg(language, "supplier_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "due_purchase_orders", { count: rows.length }),
      tg(language, "supplier_help")
    ].join("\n"),
    payload: { count: rows.length }
  };
}

async function buildPurchase(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const { data, error } = await service
    .from("purchases")
    .select("id,status,expected_date")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .in("status", ["ordered", "partially_received"])
    .lt("expected_date", context.date);

  if (error) throw error;
  if (!(data || []).length) return null;

  return {
    type: "purchase",
    key: `purchase:${context.date}:${scopeName}`,
    path: "/purchase-orders",
    language,
    buttonText: tg(language, "open_purchases"),
    text: [
      `📦 <b>${tg(language, "purchase_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "orders_past_date", { count: data.length }),
      tg(language, "purchase_help")
    ].join("\n"),
    payload: { count: data.length }
  };
}

async function buildTransfer(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const { data, error } = await service
    .from("stock_transfers")
    .select("id,source_branch_id,destination_branch_id")
    .eq("organization_id", link.organization_id)
    .eq("status", "pending")
    .or(
      `source_branch_id.in.(${ids.join(",")}),destination_branch_id.in.(${ids.join(",")})`
    );

  if (error) throw error;
  if (!(data || []).length) return null;

  const inbound = (data || []).filter(
    (row) => ids.includes(row.destination_branch_id)
  ).length;
  const outbound = (data || []).filter(
    (row) => ids.includes(row.source_branch_id)
  ).length;

  return {
    type: "transfer",
    key: `transfer:${context.date}:${scopeName}`,
    path: "/transfers",
    language,
    buttonText: tg(language, "open_transfers"),
    text: [
      `🚚 <b>${tg(language, "transfer_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "inbound_waiting", { count: inbound }),
      tg(language, "outbound_transit", { count: outbound })
    ].join("\n"),
    payload: { inbound, outbound }
  };
}

async function buildQuotation(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const soon = new Date(`${context.date}T00:00:00.000Z`);
  soon.setUTCDate(soon.getUTCDate() + 2);
  const soonDate = soon.toISOString().slice(0, 10);

  const { data, error } = await service
    .from("sales_quotes")
    .select("id,currency,total_amount,valid_until")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .in("status", ["draft", "sent", "accepted"])
    .gte("valid_until", context.date)
    .lte("valid_until", soonDate);

  if (error) throw error;
  if (!(data || []).length) return null;

  return {
    type: "quotation",
    key: `quotation:${context.date}:${scopeName}`,
    path: "/quotes",
    language,
    buttonText: tg(language, "open_quotes"),
    text: [
      `📄 <b>${tg(language, "quote_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "quote_expiring", { count: data.length }),
      tg(language, "quote_help")
    ].join("\n"),
    payload: { count: data.length }
  };
}

async function buildSalesOrders(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);

  const { data, error } = await service
    .from("sales_orders")
    .select("id,status,requested_delivery_date")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .in("status", ["confirmed", "partially_delivered"])
    .not("requested_delivery_date", "is", null)
    .lte("requested_delivery_date", context.date);

  if (error) throw error;
  if (!(data || []).length) return null;

  const partial = (data || []).filter(
    (row) => row.status === "partially_delivered"
  ).length;

  return {
    type: "sales_order",
    key: `sales-order:${context.date}:${scopeName}`,
    path: "/sales-orders",
    language,
    buttonText: tg(language, "open_sales_orders"),
    text: [
      `🚚 <b>${tg(language, "sales_order_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "sales_order_due", { count: data.length }),
      tg(language, "sales_order_partial", { count: partial }),
      tg(language, "sales_order_help")
    ].join("\n"),
    payload: {
      due: data.length,
      partially_delivered: partial
    }
  };
}

async function buildOnlineOrders(
  service,
  link,
  branchIds,
  context,
  scopeName,
  language
) {
  const ids = branchIds.map(
    (branch) => branch.id
  );

  const { data, error } = await service
    .from("online_orders")
    .select("id,currency,total_amount,created_at")
    .eq(
      "organization_id",
      link.organization_id
    )
    .in("branch_id", ids)
    .eq("status", "pending")
    .order("created_at", {
      ascending: false
    })
    .limit(100);

  if (error) {
    // Step 41 may not be installed yet.
    if (
      error.code === "42P01"
      || String(error.message || "")
        .includes("online_orders")
    ) {
      return null;
    }
    throw error;
  }

  if (!(data || []).length) return null;

  const usd = (data || [])
    .filter((row) => row.currency === "USD")
    .reduce(
      (sum, row) =>
        sum + number(row.total_amount),
      0
    );

  const khr = (data || [])
    .filter((row) => row.currency === "KHR")
    .reduce(
      (sum, row) =>
        sum + number(row.total_amount),
      0
    );

  const newest = data[0];

  return {
    type: "online_order",
    key: [
      "online-order",
      link.user_id,
      newest.id,
      data.length
    ].join(":"),
    path: "/online-store",
    language,
    buttonText: tg(
      language,
      "open_online_store"
    ),
    text: [
      `🛍️ <b>${tg(
        language,
        "online_order_title",
        {
          scope: escapeHtml(scopeName)
        }
      )}</b>`,
      "",
      tg(language, "online_order_pending", {
        count: data.length
      }),
      tg(
        language,
        "online_order_value_usd",
        {
          amount: money(usd, "USD")
        }
      ),
      tg(
        language,
        "online_order_value_khr",
        {
          amount: money(khr, "KHR")
        }
      ),
      tg(language, "online_order_help")
    ].join("\n"),
    payload: {
      pending: data.length,
      usd,
      khr,
      newest_order_id: newest.id
    }
  };
}

async function buildRegister(service, link, branchIds, context, scopeName, language) {
  const ids = branchIds.map((branch) => branch.id);
  const { data, error } = await service
    .from("cash_register_sessions")
    .select("id,status,opened_at,closed_at,variance_usd,variance_khr")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .or(`and(status.eq.closed,closed_at.gte.${context.start},closed_at.lt.${context.end}),status.eq.open`);

  if (error) throw error;

  const now = Date.now();
  const longOpen = (data || []).filter(
    (row) => row.status === "open"
      && now - new Date(row.opened_at).getTime() > 14 * 60 * 60 * 1000
  );
  const variances = (data || []).filter(
    (row) => row.status === "closed"
      && (Math.abs(number(row.variance_usd)) >= 0.01
        || Math.abs(number(row.variance_khr)) >= 1)
  );

  if (!longOpen.length && !variances.length) return null;

  return {
    type: "register",
    key: `register:${context.date}:${scopeName}`,
    path: "/cash-register",
    language,
    buttonText: tg(language, "open_register"),
    text: [
      `💵 <b>${tg(language, "register_title", {
        scope: escapeHtml(scopeName)
      })}</b>`,
      "",
      tg(language, "register_long", { count: longOpen.length }),
      tg(language, "register_variance", { count: variances.length })
    ].join("\n"),
    payload: {
      long_open: longOpen.length,
      variance_sessions: variances.length
    }
  };
}

async function buildAttendance(service, link, branchIds, context, scopeName, profile, language) {
  const ids = branchIds.map((branch) => branch.id);
  let query = service
    .from("attendance_sessions")
    .select("id,user_id,branch_id,check_in_at,status")
    .eq("organization_id", link.organization_id)
    .in("branch_id", ids)
    .eq("status", "open")
    .lt("check_in_at", new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString());
  if (!["owner", "admin", "manager"].includes(profile.role)) {
    query = query.eq("user_id", link.user_id);
  }
  const { data, error } = await query;
  if (error) throw error;
  if (!(data || []).length) return null;
  return {
    type: "attendance",
    key: `attendance:${context.date}:${link.user_id}:${scopeName}`,
    path: "/staff-operations",
    language,
    buttonText: tg(language, "open_staff_operations"),
    text: [
      `🕒 <b>${tg(language, "attendance_reminder_title", { scope: escapeHtml(scopeName) })}</b>`,
      "",
      tg(language, "attendance_long_open", { count: data.length }),
      tg(language, "attendance_reminder_help")
    ].join("\n"),
    payload: { long_open: data.length }
  };
}

async function buildApprovals(
  service,
  link,
  branchIds,
  language
) {
  const ids = branchIds.map(
    (branch) => branch.id
  );

  const { data, error } = await service
    .from("approval_requests")
    .select(`
      id,
      branch_id,
      requested_by,
      permission_key,
      action_type,
      action_summary,
      amount,
      currency,
      requested_at,
      expires_at,
      profiles!approval_requests_requested_by_fkey(
        full_name,
        role
      )
    `)
    .eq(
      "organization_id",
      link.organization_id
    )
    .in("branch_id", ids)
    .eq("status", "pending")
    .neq("requested_by", link.user_id)
    .gt(
      "expires_at",
      new Date().toISOString()
    )
    .order("requested_at", {
      ascending: true
    })
    .limit(10);

  if (error) throw error;

  return (data || []).map((request) => ({
    type: "approval",
    key: `approval:${request.id}`,
    path: "/access-control?tab=approvals",
    language,
    buttonText: tg(language, "review_approval"),
    text: [
      `🛡️ <b>${tg(language, "approval_title")}</b>`,
      "",
      escapeHtml(request.action_summary),
      request.amount !== null
        && request.currency
        ? tg(language, "amount", {
            amount: money(
              request.amount,
              request.currency
            )
          })
        : null,
      tg(language, "requested_by", {
        name: escapeHtml(
          request.profiles?.full_name
          || "POS user"
        )
      }),
      tg(language, "expires", {
        date: new Intl.DateTimeFormat(
          language === "km" ? "km-KH" : "en-US",
          {
            dateStyle: "medium",
            timeStyle: "short"
          }
        ).format(
          new Date(request.expires_at)
        )
      })
    ]
      .filter(Boolean)
      .join("\n"),
    payload: {
      approval_request_id: request.id,
      permission_key:
        request.permission_key,
      requested_by:
        request.requested_by
    }
  }));
}


async function buildPayrollEvent(service, link, branches, context, scopeName, language) {
  const branchIds = branches.map((branch) => branch.id);
  const { data: runs, error: runError } = await service
    .from("payroll_runs")
    .select("id,status,pay_date,branch_id")
    .eq("organization_id", link.organization_id)
    .in("status", ["draft", "approved", "partially_paid"])
    .lte("pay_date", context.date)
    .limit(100);
  if (runError) throw runError;
  const scopedRuns = (runs || []).filter((row) => row.branch_id === null || branchIds.includes(row.branch_id));
  if (!scopedRuns.length) return null;
  const runIds = scopedRuns.map((row) => row.id);
  const { data: lines, error: lineError } = await service
    .from("payroll_run_lines")
    .select("id,payroll_run_id,net_pay,paid_amount")
    .in("payroll_run_id", runIds)
    .limit(1000);
  if (lineError) throw lineError;
  const unpaid = (lines || []).filter((row) => Number(row.net_pay || 0) - Number(row.paid_amount || 0) > 0.005).length;
  return {
    type: "payroll",
    key: `payroll:${context.date}:${link.user_id}:${scopeName}:${scopedRuns.length}:${unpaid}`,
    path: "/payroll",
    buttonText: tg(language, "open_payroll"),
    text: [
      `💵 <b>${tg(language, "payroll_alert_title", { scope: escapeHtml(scopeName) })}</b>`,
      "",
      tg(language, "payroll_due_runs", { count: scopedRuns.length }),
      tg(language, "payroll_unpaid_staff", { count: unpaid }),
      tg(language, "payroll_alert_help")
    ].join("\n")
  };
}


async function buildIntegrationAlerts(service, link, branches, context, scopeName, language) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const branchIds = branches.map((branch) => branch.id);
  const [deadResult, apiResult] = await Promise.all([
    service.from("integration_webhook_deliveries")
      .select("id,integration_events(branch_id)")
      .eq("organization_id", link.organization_id)
      .eq("status", "dead")
      .gte("created_at", since)
      .limit(200),
    service.from("integration_api_request_logs")
      .select("id,branch_id")
      .eq("organization_id", link.organization_id)
      .gte("status_code", 500)
      .gte("created_at", since)
      .limit(200)
  ]);
  for (const result of [deadResult, apiResult]) {
    if (result.error) {
      if (result.error.code === "42P01") return null;
      throw result.error;
    }
  }
  const dead = (deadResult.data || []).filter((row) => {
    const id = row.integration_events?.branch_id;
    return !id || branchIds.includes(id);
  }).length;
  const failures = (apiResult.data || []).filter((row) => !row.branch_id || branchIds.includes(row.branch_id)).length;
  if (!dead && !failures) return null;
  return {
    type: "integration",
    key: `integration:${context.date}:${link.user_id}:${scopeName}:${dead}:${failures}`,
    path: "/integrations?tab=activity",
    language,
    buttonText: tg(language, "open_integrations"),
    text: [
      `🔌 <b>${tg(language, "integration_alert_title", { scope: escapeHtml(scopeName) })}</b>`,
      "",
      tg(language, "integration_dead_webhooks", { count: dead }),
      tg(language, "integration_api_failures", { count: failures }),
      tg(language, "integration_alert_help")
    ].join("\n")
  };
}

export default async () => {
  const service = serviceClient();
  let sent = 0;
  let failed = 0;
  let considered = 0;

  try {
    // Immediate sale/register/leave alerts use a durable outbox. Drain it here
    // as a retry fallback in case the browser closed before the instant
    // dispatch request completed.
    const operational = await dispatchPendingOperationalEvents(service, 25);
    sent += operational.sent || 0;
    failed += operational.failed || 0;
    considered += operational.considered || 0;

    const { data: links, error: linksError } = await service
      .from("telegram_user_links")
      .select(`
        *,
        profiles!inner(
          id,
          organization_id,
          branch_id,
          full_name,
          role,
          is_active,
          branches(id,name,code)
        )
      `)
      .eq("is_active", true)
      .eq("profiles.is_active", true);

    if (linksError) throw linksError;

    const userIds = (links || []).map((link) => link.user_id);
    const { data: preferenceRows, error: preferenceError } = userIds.length
      ? await service
          .from("telegram_notification_preferences")
          .select("*")
          .in("user_id", userIds)
      : { data: [], error: null };

    if (preferenceError) throw preferenceError;

    const preferenceMap = new Map(
      (preferenceRows || []).map((row) => [row.user_id, row])
    );

    const {
      data: userPreferenceRows,
      error: userPreferenceError
    } = userIds.length
      ? await service
          .from("user_preferences")
          .select("user_id,language")
          .in("user_id", userIds)
      : { data: [], error: null };

    if (userPreferenceError) {
      throw userPreferenceError;
    }

    const userLanguageMap = new Map(
      (userPreferenceRows || []).map(
        (row) => [
          row.user_id,
          telegramLanguage(row.language)
        ]
      )
    );

    const {
      data: approvalOverrideRows,
      error: approvalOverrideError
    } = userIds.length
      ? await service
          .from("user_permission_overrides")
          .select("user_id,allowed")
          .eq(
            "permission_key",
            "approvals.review"
          )
          .in("user_id", userIds)
      : { data: [], error: null };

    if (approvalOverrideError) {
      throw approvalOverrideError;
    }

    const approvalOverrideMap = new Map(
      (approvalOverrideRows || []).map(
        (row) => [
          row.user_id,
          Boolean(row.allowed)
        ]
      )
    );

    const settingsCache = new Map();

    for (const link of links || []) {
      considered += 1;

      const profile = link.profiles;
      const preferences = preferenceMap.get(link.user_id);

      if (!profile || !preferences) continue;

      let language = telegramLanguage(
        userLanguageMap.get(link.user_id)
        || link.language_code
        || "en"
      );

      let settings = settingsCache.get(link.organization_id);
      if (!settings) {
        const { data, error } = await service
          .from("app_settings")
          .select("timezone,low_stock_threshold,default_language")
          .eq("organization_id", link.organization_id)
          .single();

        if (error) throw error;
        settings = data;
        settingsCache.set(link.organization_id, settings);
      }

      if (
        !userLanguageMap.has(link.user_id)
        && !link.language_code
      ) {
        language = telegramLanguage(
          settings.default_language
        );
      }

      const timeZone = settings.timezone || "Asia/Phnom_Penh";
      const context = localContext(new Date(), timeZone);

      if (isQuiet(preferences, context.hour)) continue;

      const branches = await activeBranchIds(
        service,
        link,
        profile,
        preferences
      );

      if (!branches.length) continue;

      const scopeName = branches.length > 1
        ? tg(language, "all_branches")
        : branches[0].name
          || tg(language, "current_branch");

      const builders = [];

      if (
        preferences.sales_summary
        && canReceive(profile.role, "summary")
        && context.hour === Number(preferences.daily_summary_hour)
      ) {
        builders.push(() => buildSummary(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.stock_alerts && canReceive(profile.role, "stock")) {
        builders.push(() => buildStock(
          service, link, branches, context, scopeName, settings, language
        ));
        builders.push(() => buildExpiry(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.forecast_alerts && canReceive(profile.role, "forecast")) {
        builders.push(() => buildForecast(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.credit_alerts && canReceive(profile.role, "credit")) {
        builders.push(() => buildCredit(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.supplier_alerts && canReceive(profile.role, "supplier")) {
        builders.push(() => buildSupplier(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.purchase_alerts && canReceive(profile.role, "purchase")) {
        builders.push(() => buildPurchase(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.transfer_alerts && canReceive(profile.role, "transfer")) {
        builders.push(() => buildTransfer(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.quotation_alerts && canReceive(profile.role, "quotation")) {
        builders.push(() => buildQuotation(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.sales_order_alerts && canReceive(profile.role, "sales_order")) {
        builders.push(() => buildSalesOrders(
          service, link, branches, context, scopeName, language
        ));
      }

      if (
        preferences.online_order_alerts
        && canReceive(
          profile.role,
          "online_order"
        )
      ) {
        builders.push(() =>
          buildOnlineOrders(
            service,
            link,
            branches,
            context,
            scopeName,
            language
          )
        );
      }

      if (preferences.cash_register_alerts && canReceive(profile.role, "register")) {
        builders.push(() => buildRegister(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.attendance_alerts && canReceive(profile.role, "attendance")) {
        builders.push(() => buildAttendance(
          service, link, branches, context, scopeName, profile, language
        ));
      }

      if (preferences.payroll_alerts && canReceive(profile.role, "payroll")) {
        builders.push(() => buildPayrollEvent(
          service, link, branches, context, scopeName, language
        ));
      }

      if (preferences.integration_alerts && canReceive(profile.role, "integration")) {
        builders.push(() => buildIntegrationAlerts(
          service, link, branches, context, scopeName, language
        ));
      }

      if (
        preferences.system_alerts
        && canReceive(
          profile.role,
          "approval"
        )
        && permissionAllowed(
          profile.role,
          approvalOverrideMap.get(
            profile.id
          ),
          ["owner", "admin", "manager"]
        )
      ) {
        builders.push(() =>
          buildApprovals(
            service,
            link,
            branches,
            language
          )
        );
      }

      for (const build of builders) {
        try {
          const events = asArray(
            await build()
          );

          for (const event of events) {
            if (!event) continue;

            const delivered =
              await deliver(
                service,
                link,
                event
              );

            if (delivered) sent += 1;
          }
        } catch (error) {
          failed += 1;
          console.error(
            "Telegram notification event failed",
            profile.id,
            error
          );
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      considered,
      sent,
      failed
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("Telegram notification schedule failed", error);

    return new Response(JSON.stringify({
      ok: false,
      error: error.message,
      considered,
      sent,
      failed: failed + 1
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
