import {
  escapeHtml,
  sendTelegramMessage
} from "./_telegram-shared.mjs";
import { telegramLanguage } from "./_telegram-i18n.mjs";

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KHR" ? 0 : 2
  }).format(number(value));
}

function dateRange(payload) {
  if (!payload?.date_from) return "—";
  return payload.date_from === payload.date_to
    ? payload.date_from
    : `${payload.date_from} → ${payload.date_to}`;
}

function relevantRecipient(link, event) {
  const role = String(link.profiles?.role || "").toLowerCase();
  const isActor = link.user_id === event.actor_user_id;
  const isTarget = link.user_id === event.payload?.user_id;
  const isOrganizationManager = ["owner", "admin"].includes(role);
  const isBranchManager = role === "manager"
    && Boolean(event.branch_id)
    && link.profiles?.branch_id === event.branch_id;

  if (event.event_type === "online_order_requested") {
    const isBranchCashier = role === "cashier"
      && Boolean(event.branch_id)
      && link.profiles?.branch_id === event.branch_id;
    return isOrganizationManager || isBranchManager || isBranchCashier;
  }

  if (event.event_type === "sale_completed") {
    return isActor || isOrganizationManager || isBranchManager;
  }

  if (["cash_register_opened", "cash_register_closed"].includes(event.event_type)) {
    return isActor || isOrganizationManager || isBranchManager;
  }

  if (event.event_type.startsWith("leave_")) {
    return isTarget || isOrganizationManager || isBranchManager;
  }

  if (event.event_type === "approval_requested") {
    return !isTarget && (isOrganizationManager || isBranchManager);
  }

  if (["approval_approved", "approval_rejected"].includes(event.event_type)) {
    return isTarget || isOrganizationManager || isBranchManager;
  }

  return false;
}

function preferenceAllowed(preferences, eventType) {
  if (eventType === "online_order_requested") return preferences?.online_order_alerts !== false;
  if (eventType === "sale_completed") return preferences?.sale_alerts !== false;
  if (eventType.startsWith("cash_register_")) return preferences?.cash_register_alerts !== false;
  if (eventType.startsWith("leave_")) return preferences?.leave_alerts !== false;
  if (eventType.startsWith("approval_")) return true;
  return true;
}

function messageFor(event, context, language) {
  const km = language === "km";
  const branch = escapeHtml(context.branch?.name || "—");
  const actor = escapeHtml(context.actor?.full_name || "—");
  const staff = escapeHtml(context.target?.full_name || actor);
  const payload = event.payload || {};

  if (event.event_type === "online_order_requested") {
    return {
      path: "/online-store?tab=orders&status=pending",
      buttonText: km ? "មើលការបញ្ជាទិញ" : "Review online order",
      text: [
        km ? "🛍 <b>មានការបញ្ជាទិញអនឡាញថ្មី</b>" : "🛍 <b>New online order</b>",
        "",
        `${km ? "លេខបញ្ជាទិញ" : "Order"}: <code>${escapeHtml(payload.order_number || "—")}</code>`,
        `${km ? "អតិថិជន" : "Customer"}: <b>${escapeHtml(payload.customer_name || "—")}</b>`,
        payload.customer_phone
          ? `${km ? "ទូរស័ព្ទ" : "Phone"}: ${escapeHtml(payload.customer_phone)}`
          : null,
        `${km ? "ទឹកប្រាក់" : "Total"}: <b>${money(payload.total_amount, payload.currency || "USD")}</b>`,
        `${km ? "ការទូទាត់" : "Payment"}: ${escapeHtml(String(payload.payment_method || "—").replaceAll("_", " "))}`,
        payload.bank_slip_url
          ? (km ? "🧾 បានភ្ជាប់សន្លឹកបង់ប្រាក់" : "🧾 Bank slip attached")
          : null,
        `${km ? "ប្រគល់ទំនិញ" : "Fulfilment"}: ${escapeHtml(String(payload.fulfilment_type || "—").replaceAll("_", " "))}`,
        `${km ? "សាខា" : "Branch"}: ${branch}`
      ].filter(Boolean).join("\n")
    };
  }

  if (event.event_type === "sale_completed") {
    return {
      path: "/invoices",
      buttonText: km ? "មើលវិក្កយបត្រ" : "View invoice",
      text: [
        km ? "🧾 <b>ការលក់បានបញ្ចប់</b>" : "🧾 <b>Sale completed</b>",
        "",
        `${km ? "វិក្កយបត្រ" : "Invoice"}: <code>${escapeHtml(payload.invoice_number || "—")}</code>`,
        `${km ? "ទឹកប្រាក់" : "Total"}: <b>${money(payload.total_amount, payload.currency || "USD")}</b>`,
        `${km ? "អ្នកលក់" : "Cashier"}: ${actor}`,
        `${km ? "សាខា" : "Branch"}: ${branch}`
      ].join("\n")
    };
  }

  if (event.event_type === "cash_register_opened") {
    return {
      path: "/cash-register",
      buttonText: km ? "មើលកាសប្រាក់" : "View register",
      text: [
        km ? "🔓 <b>បានបើកកាសប្រាក់</b>" : "🔓 <b>Cash register opened</b>",
        "",
        `${km ? "កាស" : "Register"}: <b>${escapeHtml(payload.register_name || "—")}</b>`,
        `${km ? "សម័យ" : "Session"}: <code>${escapeHtml(payload.session_number || "—")}</code>`,
        `${km ? "អ្នកបើក" : "Opened by"}: ${actor}`,
        `${km ? "សាខា" : "Branch"}: ${branch}`
      ].join("\n")
    };
  }

  if (event.event_type === "cash_register_closed") {
    return {
      path: "/cash-register",
      buttonText: km ? "មើលរបាយការណ៍កាស" : "View register report",
      text: [
        km ? "🔒 <b>បានបិទកាសប្រាក់</b>" : "🔒 <b>Cash register closed</b>",
        "",
        `${km ? "កាស" : "Register"}: <b>${escapeHtml(payload.register_name || "—")}</b>`,
        `${km ? "អ្នកបិទ" : "Closed by"}: ${actor}`,
        `${km ? "លម្អៀង USD" : "USD variance"}: <b>${money(payload.variance_usd, "USD")}</b>`,
        `${km ? "លម្អៀង KHR" : "KHR variance"}: <b>${money(payload.variance_khr, "KHR")}</b>`,
        `${km ? "សាខា" : "Branch"}: ${branch}`
      ].join("\n")
    };
  }

  if (event.event_type.startsWith("approval_")) {
    const approved = event.event_type === "approval_approved";
    const rejected = event.event_type === "approval_rejected";
    return {
      path: "/access-control?tab=approvals",
      buttonText: km ? "មើលការអនុម័ត" : "Open approvals",
      text: [
        event.event_type === "approval_requested"
          ? (km ? "🛡️ <b>សំណើអនុម័តថ្មី</b>" : "🛡️ <b>New approval request</b>")
          : approved
            ? (km ? "✅ <b>សំណើបានអនុម័ត</b>" : "✅ <b>Approval granted</b>")
            : rejected
              ? (km ? "❌ <b>សំណើត្រូវបានបដិសេធ</b>" : "❌ <b>Approval rejected</b>")
              : "🛡️ <b>Approval update</b>",
        "",
        `${km ? "សកម្មភាព" : "Action"}: <b>${escapeHtml(payload.action_summary || "—")}</b>`,
        payload.amount !== null && payload.amount !== undefined && payload.currency
          ? `${km ? "ចំនួន" : "Amount"}: <b>${money(payload.amount, payload.currency)}</b>`
          : null,
        `${km ? "អ្នកស្នើ" : "Requested by"}: ${staff}`,
        payload.review_note
          ? `${km ? "ចំណាំ" : "Review note"}: ${escapeHtml(payload.review_note)}`
          : null,
        `${km ? "សាខា" : "Branch"}: ${branch}`
      ].filter(Boolean).join("\n")
    };
  }

  const statusLabels = {
    leave_requested: km ? "សំណើច្បាប់ថ្មី" : "New leave request",
    leave_approved: km ? "សំណើច្បាប់បានអនុម័ត" : "Leave request approved",
    leave_rejected: km ? "សំណើច្បាប់ត្រូវបានបដិសេធ" : "Leave request rejected",
    leave_cancelled: km ? "សំណើច្បាប់ត្រូវបានលុប" : "Leave request cancelled"
  };
  const icons = {
    leave_requested: "🏖",
    leave_approved: "✅",
    leave_rejected: "❌",
    leave_cancelled: "🚫"
  };

  return {
    path: "/staff-operations?tab=leave",
    buttonText: km ? "មើលសំណើច្បាប់" : "View leave request",
    text: [
      `${icons[event.event_type] || "🏖"} <b>${statusLabels[event.event_type] || "Leave request"}</b>`,
      "",
      `${km ? "បុគ្គលិក" : "Staff"}: <b>${staff}</b>`,
      `${km ? "កាលបរិច្ឆេទ" : "Dates"}: <b>${escapeHtml(dateRange(payload))}</b>`,
      `${km ? "ប្រភេទ" : "Type"}: ${escapeHtml(payload.leave_type || "—")}`,
      `${km ? "មូលហេតុ" : "Reason"}: ${escapeHtml(payload.reason || "—")}`,
      payload.review_note
        ? `${km ? "ចំណាំពិនិត្យ" : "Review note"}: ${escapeHtml(payload.review_note)}`
        : null,
      `${km ? "សាខា" : "Branch"}: ${branch}`
    ].filter(Boolean).join("\n")
  };
}

async function loadContext(service, event) {
  const userIds = [...new Set([
    event.actor_user_id,
    event.payload?.user_id
  ].filter(Boolean))];

  const [branchResult, profileResult] = await Promise.all([
    event.branch_id
      ? service.from("branches").select("id,name,code").eq("id", event.branch_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    userIds.length
      ? service.from("profiles").select("id,full_name,role,branch_id").in("id", userIds)
      : Promise.resolve({ data: [], error: null })
  ]);

  if (branchResult.error) throw branchResult.error;
  if (profileResult.error) throw profileResult.error;

  const profiles = new Map((profileResult.data || []).map((row) => [row.id, row]));
  return {
    branch: branchResult.data,
    actor: profiles.get(event.actor_user_id),
    target: profiles.get(event.payload?.user_id)
  };
}

async function deliverToLink(service, event, link, preferences, language, context) {
  const message = messageFor(event, context, language);
  const deliveryPayload = {
    organization_id: link.organization_id,
    user_id: link.user_id,
    telegram_link_id: link.id,
    event_type: event.event_type,
    event_key: event.event_key,
    chat_id: link.chat_id,
    message_text: message.text,
    status: "pending",
    error_message: null,
    payload: event.payload || {}
  };

  const { data: existing, error: existingError } = await service
    .from("telegram_notification_deliveries")
    .select("id,status")
    .eq("user_id", link.user_id)
    .eq("event_key", event.event_key)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.status === "sent") return { sent: 0, skipped: 1 };

  let delivery;
  if (existing?.id) {
    const { data, error } = await service
      .from("telegram_notification_deliveries")
      .update(deliveryPayload)
      .eq("id", existing.id)
      .select("id,status")
      .single();
    if (error) throw error;
    delivery = data;
  } else {
    const { data, error } = await service
      .from("telegram_notification_deliveries")
      .insert(deliveryPayload)
      .select("id,status")
      .single();
    if (error) throw error;
    delivery = data;
  }

  try {
    const sent = await sendTelegramMessage({
      chatId: link.chat_id,
      text: message.text,
      path: message.path,
      buttonText: message.buttonText
    });

    await service
      .from("telegram_notification_deliveries")
      .update({
        status: "sent",
        telegram_message_id: sent.message_id,
        sent_at: new Date().toISOString(),
        error_message: null
      })
      .eq("id", delivery.id);

    return { sent: 1, skipped: 0 };
  } catch (error) {
    await service
      .from("telegram_notification_deliveries")
      .update({ status: "failed", error_message: error.message })
      .eq("id", delivery.id);
    throw error;
  }
}

export async function dispatchOperationalEvent(service, eventId) {
  let query = service
    .from("telegram_operational_events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();
  const { data: event, error: eventError } = await query;
  if (eventError) throw eventError;
  if (!event) return { sent: 0, skipped: 0, missing: true };

  await service
    .from("telegram_operational_events")
    .update({ status: "processing", attempts: number(event.attempts) + 1, last_error: null })
    .eq("id", event.id);

  try {
    const { data: links, error: linksError } = await service
      .from("telegram_user_links")
      .select(`
        id,user_id,organization_id,chat_id,language_code,is_active,
        profiles!inner(id,full_name,role,branch_id,is_active)
      `)
      .eq("organization_id", event.organization_id)
      .eq("is_active", true)
      .eq("profiles.is_active", true);
    if (linksError) throw linksError;

    const relevant = (links || []).filter((link) => relevantRecipient(link, event));
    const userIds = relevant.map((row) => row.user_id);
    const [preferenceResult, languageResult, context] = await Promise.all([
      userIds.length
        ? service.from("telegram_notification_preferences").select("*").in("user_id", userIds)
        : Promise.resolve({ data: [], error: null }),
      userIds.length
        ? service.from("user_preferences").select("user_id,language").in("user_id", userIds)
        : Promise.resolve({ data: [], error: null }),
      loadContext(service, event)
    ]);
    if (preferenceResult.error) throw preferenceResult.error;
    if (languageResult.error) throw languageResult.error;

    const preferenceMap = new Map((preferenceResult.data || []).map((row) => [row.user_id, row]));
    const languageMap = new Map((languageResult.data || []).map((row) => [row.user_id, row.language]));
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const link of relevant) {
      const preferences = preferenceMap.get(link.user_id) || {};
      if (!preferenceAllowed(preferences, event.event_type)) {
        skipped += 1;
        continue;
      }

      try {
        const result = await deliverToLink(
          service,
          event,
          link,
          preferences,
          telegramLanguage(languageMap.get(link.user_id) || link.language_code || "en"),
          context
        );
        sent += result.sent;
        skipped += result.skipped;
      } catch (error) {
        failed += 1;
        console.error("Telegram operational delivery failed", event.id, link.user_id, error);
      }
    }

    await service
      .from("telegram_operational_events")
      .update({
        status: failed ? "failed" : "sent",
        processed_at: failed ? null : new Date().toISOString(),
        last_error: failed ? `${failed} recipient delivery failed` : null
      })
      .eq("id", event.id);

    return { sent, skipped, failed };
  } catch (error) {
    await service
      .from("telegram_operational_events")
      .update({ status: "failed", last_error: error.message })
      .eq("id", event.id);
    throw error;
  }
}

export async function dispatchPendingOperationalEvents(service, limit = 20) {
  const { data: events, error } = await service
    .from("telegram_operational_events")
    .select("id")
    .in("status", ["pending", "failed"])
    .lt("attempts", 8)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const totals = { considered: 0, sent: 0, skipped: 0, failed: 0 };
  for (const row of events || []) {
    totals.considered += 1;
    try {
      const result = await dispatchOperationalEvent(service, row.id);
      totals.sent += result.sent || 0;
      totals.skipped += result.skipped || 0;
      totals.failed += result.failed || 0;
    } catch {
      totals.failed += 1;
    }
  }
  return totals;
}
