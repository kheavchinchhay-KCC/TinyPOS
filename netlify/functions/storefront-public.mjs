import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { dispatchOperationalEvent } from "./_telegram-events.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

function serviceClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error("Supabase server environment is incomplete.");
  }

  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function cleanSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,59}$/.test(slug)) {
    throw Object.assign(new Error("Storefront address is invalid."), { status: 400 });
  }
  return slug;
}

function clientFingerprint(request) {
  const forwarded = request.headers.get("x-nf-client-connection-ip")
    || request.headers.get("x-forwarded-for")
    || "";
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || SERVICE_ROLE_KEY || "tiny-pos";
  return crypto
    .createHmac("sha256", secret)
    .update(String(forwarded).split(",")[0].trim())
    .digest("hex");
}

function publicError(error) {
  const message = String(error?.message || error || "")
    .replace(/^.*?:\s*/, "")
    .slice(0, 300) || "The request could not be completed.";
  return json({ ok: false, error: message }, Number(error?.status || 400));
}

function cloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw Object.assign(new Error("Bank-slip upload is not configured."), { status: 503 });
  }
  return { cloudName, apiKey, apiSecret };
}

function signCloudinary(params, secret) {
  const source = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(source + secret).digest("hex");
}

async function catalog(service, slug) {
  const { data, error } = await service.rpc("get_public_storefront", { p_slug: slug });
  if (error) throw error;
  return json({ ok: true, ...data }, 200, {
    "cache-control": "public, max-age=20, stale-while-revalidate=90"
  });
}

async function uploadSignature(service, request, slug) {
  const body = await request.json().catch(() => ({}));
  const fileType = String(body.file_type || "").toLowerCase();
  const fileSize = Number(body.file_size || 0);

  if (!fileType.startsWith("image/") || fileSize <= 0 || fileSize > 5 * 1024 * 1024) {
    throw Object.assign(new Error("Choose a bank-slip image up to 5 MB."), { status: 400 });
  }

  const { data: store, error } = await service
    .from("online_store_settings")
    .select("organization_id,branch_id,allow_bank_transfer,is_published")
    .eq("slug", slug)
    .eq("is_published", true)
    .maybeSingle();
  if (error) throw error;
  if (!store?.allow_bank_transfer) {
    throw Object.assign(new Error("Bank transfer is unavailable for this store."), { status: 400 });
  }

  const { cloudName, apiKey, apiSecret } = cloudinaryConfig();
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `tiny-pos-new/online-orders/${store.organization_id}/${store.branch_id}`;
  const publicId = `slip-${timestamp}-${crypto.randomBytes(6).toString("hex")}`;
  const params = {
    folder,
    invalidate: "true",
    overwrite: "false",
    public_id: publicId,
    timestamp
  };

  return json({
    ok: true,
    cloudName,
    apiKey,
    timestamp,
    folder,
    publicId,
    overwrite: params.overwrite,
    invalidate: params.invalidate,
    signature: signCloudinary(params, apiSecret)
  });
}

function validCloudinaryImage(url) {
  return /^https:\/\/res\.cloudinary\.com\//i.test(String(url || ""));
}

async function submitOrder(service, request, slug) {
  const body = await request.json();

  if (String(body?.website || "").trim()) {
    return json({ ok: true, order_number: "RECEIVED" });
  }

  const slipUrl = String(body?.bank_slip_url || "").trim();
  const slipPublicId = String(body?.bank_slip_public_id || "").trim();
  const bankReference = String(body?.bank_reference || "").trim().slice(0, 160);
  if (body?.payment_method === "bank_transfer") {
    if (!validCloudinaryImage(slipUrl) || !slipPublicId) {
      throw Object.assign(new Error("Upload a valid bank-slip image before submitting the order."), { status: 400 });
    }
  }

  const { data, error } = await service.rpc("submit_online_order", {
    p_slug: slug,
    p_payload: body,
    p_source_ip_hash: clientFingerprint(request),
    p_user_agent: request.headers.get("user-agent") || null
  });
  if (error) throw error;

  if (body?.payment_method === "bank_transfer" && slipUrl) {
    const { error: updateError } = await service
      .from("online_orders")
      .update({
        bank_slip_url: slipUrl,
        bank_slip_public_id: slipPublicId,
        bank_slip_uploaded_at: new Date().toISOString(),
        bank_reference: bankReference || null
      })
      .eq("id", data.order_id);
    if (updateError) throw updateError;

    await service
      .from("telegram_operational_events")
      .update({
        payload: {
          order_number: data.order_number,
          customer_name: String(body.customer_name || "").trim(),
          customer_phone: String(body.customer_phone || "").trim(),
          currency: data.currency,
          total_amount: data.total_amount,
          payment_method: "bank_transfer",
          payment_status: "pending_confirmation",
          fulfilment_type: String(body.fulfilment_type || "pickup"),
          bank_slip_url: slipUrl,
          created_at: new Date().toISOString()
        }
      })
      .eq("event_key", `online_order_requested:${data.order_id}`);
  }

  try {
    const { data: event } = await service
      .from("telegram_operational_events")
      .select("id")
      .eq("event_key", `online_order_requested:${data.order_id}`)
      .maybeSingle();
    if (event?.id) await dispatchOperationalEvent(service, event.id);
  } catch (notificationError) {
    console.error("Immediate online-order Telegram alert failed", notificationError);
  }

  return json({
    ...data,
    bank_slip_url: slipUrl || null,
    bank_reference: bankReference || null
  }, 201);
}

async function trackOrder(service, slug, url) {
  const orderNumber = String(url.searchParams.get("order") || "").trim();
  const trackingToken = String(url.searchParams.get("token") || "").trim();
  if (!orderNumber || trackingToken.length < 20) {
    throw Object.assign(new Error("Order number and tracking token are required."), { status: 400 });
  }

  const { data, error } = await service.rpc("track_online_order", {
    p_slug: slug,
    p_order_number: orderNumber,
    p_tracking_token: trackingToken
  });
  if (error) throw error;
  return json({ ok: true, order: data });
}

async function phoneOrders(service, request, slug, url) {
  const phone = String(url.searchParams.get("phone") || "").trim();
  if (phone.replace(/\D/g, "").length < 7) {
    throw Object.assign(new Error("Enter a valid phone number."), { status: 400 });
  }

  const { data, error } = await service.rpc("find_public_orders_by_phone", {
    p_slug: slug,
    p_phone: phone,
    p_source_ip_hash: clientFingerprint(request)
  });
  if (error) {
    if (/too many recent lookup attempts/i.test(error.message || "")) {
      throw Object.assign(new Error(error.message), { status: 429 });
    }
    throw error;
  }
  return json({ ok: true, orders: Array.isArray(data) ? data : [] });
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const slug = cleanSlug(url.searchParams.get("slug"));
    const service = serviceClient();
    const action = url.searchParams.get("action") || (request.method === "GET" ? "catalog" : "submit");

    if (request.method === "GET") {
      if (action === "track") return await trackOrder(service, slug, url);
      if (action === "phone-orders") return await phoneOrders(service, request, slug, url);
      return await catalog(service, slug);
    }

    if (request.method === "POST") {
      if (action === "upload-signature") return await uploadSignature(service, request, slug);
      return await submitOrder(service, request, slug);
    }

    return json({ ok: false, error: "Method not allowed." }, 405, { allow: "GET, POST" });
  } catch (error) {
    return publicError(error);
  }
};
