import { authenticatedProfile, json, serviceClient } from "./_telegram-shared.mjs";

const RELEASE = "tiny-pos-v1.0.0-rc1-step37";

function check(key, label, passed, detail, severity = "critical") {
  return {
    key,
    label,
    status: passed ? "pass" : "fail",
    severity,
    detail
  };
}

export default async (request) => {
  try {
    if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);

    const { profile } = await authenticatedProfile(request);
    if (!["owner", "admin"].includes(profile.role)) {
      return json({ ok: false, error: "Owner or administrator access required." }, 403);
    }

    const checks = [];
    const supabaseUrl = process.env.SUPABASE_URL || "";
    const publishable = process.env.SUPABASE_PUBLISHABLE_KEY || "";
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

    checks.push(check("supabase_url", "Supabase URL", /^https:\/\/.+\.supabase\.co/i.test(supabaseUrl),
      supabaseUrl ? "Supabase project URL is configured." : "SUPABASE_URL is missing."));
    checks.push(check("supabase_publishable", "Supabase publishable key", Boolean(publishable),
      publishable ? "Frontend authentication key is configured." : "SUPABASE_PUBLISHABLE_KEY is missing."));
    checks.push(check("supabase_service", "Supabase service role", Boolean(serviceRole),
      serviceRole ? "Server-only administrative key is configured." : "SUPABASE_SERVICE_ROLE_KEY is missing."));

    try {
      const service = serviceClient();
      const { error } = await service.from("organizations").select("id", { head: true, count: "exact" }).limit(1);
      checks.push(check("supabase_connection", "Supabase server connection", !error,
        error ? error.message : "Netlify can securely reach Supabase."));
    } catch (error) {
      checks.push(check("supabase_connection", "Supabase server connection", false, error.message));
    }

    const cloudinary = [
      process.env.CLOUDINARY_CLOUD_NAME,
      process.env.CLOUDINARY_API_KEY,
      process.env.CLOUDINARY_API_SECRET
    ];
    checks.push(check("cloudinary", "Cloudinary configuration", cloudinary.every(Boolean),
      cloudinary.every(Boolean)
        ? "Image upload and deletion credentials are configured."
        : "One or more Cloudinary variables are missing.", "warning"));

    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
    const telegramSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
    const miniUrl = process.env.TELEGRAM_MINI_APP_URL || process.env.URL || "";
    checks.push(check("telegram_secret", "Telegram webhook secret", Boolean(telegramSecret),
      telegramSecret ? "Webhook verification secret is configured." : "TELEGRAM_WEBHOOK_SECRET is missing.", "warning"));
    checks.push(check("mini_app_url", "Telegram Mini App URL", /^https:\/\//i.test(miniUrl),
      /^https:\/\//i.test(miniUrl) ? "Mini App uses HTTPS." : "TELEGRAM_MINI_APP_URL must be HTTPS.", "warning"));

    if (telegramToken) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${telegramToken}/getMe`);
        const result = await response.json().catch(() => null);
        checks.push(check("telegram_bot", "Telegram bot connection", Boolean(response.ok && result?.ok),
          response.ok && result?.ok
            ? `Connected as @${result.result.username || "bot"}.`
            : result?.description || `Telegram returned HTTP ${response.status}.`, "warning"));
      } catch (error) {
        checks.push(check("telegram_bot", "Telegram bot connection", false, error.message, "warning"));
      }
    } else {
      checks.push(check("telegram_bot", "Telegram bot connection", false,
        "TELEGRAM_BOT_TOKEN is missing.", "warning"));
    }

    checks.push(check("node_runtime", "Node runtime", /^v22\./.test(process.version),
      `Netlify Functions are running ${process.version}. Expected Node 22.`, "warning"));
    checks.push(check("site_url", "Production site URL", /^https:\/\//i.test(process.env.URL || miniUrl),
      /^https:\/\//i.test(process.env.URL || miniUrl)
        ? "Production URL uses HTTPS."
        : "Netlify URL is missing or is not HTTPS."));

    const critical = checks.filter((row) => row.status === "fail" && row.severity === "critical").length;
    const warnings = checks.filter((row) => row.status === "fail" && row.severity !== "critical").length;

    return json({
      ok: true,
      release: RELEASE,
      node: process.version,
      checked_at: new Date().toISOString(),
      status: critical > 0 ? "critical" : warnings > 0 ? "warning" : "healthy",
      checks
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
