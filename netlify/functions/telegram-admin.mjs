import { hasEffectivePermission } from "./_permission.mjs";
import {
  authenticatedProfile,
  botToken,
  json,
  miniAppUrl,
  sendTelegramMessage,
  serviceClient,
  setTelegramCommandsForChat,
  telegramApi,
  validateTelegramInitData
} from "./_telegram-shared.mjs";
import {
  tg,
  telegramLanguage
} from "./_telegram-i18n.mjs";

function errorResponse(error) {
  return json(
    { ok: false, error: error.message },
    error.status || 500
  );
}

async function preferredLanguage(
  service,
  userId,
  fallback = "en"
) {
  const { data } = await service
    .from("user_preferences")
    .select("language")
    .eq("user_id", userId)
    .maybeSingle();

  return telegramLanguage(
    data?.language || fallback
  );
}

async function botStatus(service, userId) {
  const expectedWebhookUrl = miniAppUrl("/api/telegram-webhook");
  const [me, webhookInfo, linkResult, preferenceResult] = await Promise.all([
    telegramApi("getMe"),
    telegramApi("getWebhookInfo"),
    service
      .from("telegram_user_links")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
    service
      .from("telegram_notification_preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle()
  ]);

  if (linkResult.error) throw linkResult.error;
  if (preferenceResult.error) throw preferenceResult.error;

  return {
    bot: {
      id: me.id,
      username: me.username,
      first_name: me.first_name,
      can_join_groups: me.can_join_groups
    },
    mini_app_url: miniAppUrl("/"),
    webhook: {
      configured: webhookInfo.url === expectedWebhookUrl,
      healthy: webhookInfo.url === expectedWebhookUrl && !webhookInfo.last_error_message,
      expected_url: expectedWebhookUrl,
      url: webhookInfo.url || null,
      pending_update_count: webhookInfo.pending_update_count || 0,
      last_error_date: webhookInfo.last_error_date || null,
      last_error_message: webhookInfo.last_error_message || null
    },
    link: linkResult.data || null,
    preferences: preferenceResult.data || null
  };
}

async function linkMiniApp({ service, profile }, initData) {
  const verified = validateTelegramInitData(initData);
  const telegramUser = verified.user;

  const { data: collision, error: collisionError } = await service
    .from("telegram_user_links")
    .select("id,user_id")
    .eq("organization_id", profile.organization_id)
    .eq("telegram_user_id", telegramUser.id)
    .neq("user_id", profile.id)
    .maybeSingle();

  if (collisionError) throw collisionError;
  if (collision) {
    throw Object.assign(
      new Error(
        "This Telegram account is already connected to another POS user in this organization."
      ),
      { status: 409 }
    );
  }

  const payload = {
    organization_id: profile.organization_id,
    user_id: profile.id,
    telegram_user_id: telegramUser.id,
    chat_id: telegramUser.id,
    username: telegramUser.username || null,
    first_name: telegramUser.first_name || null,
    last_name: telegramUser.last_name || null,
    language_code: telegramUser.language_code || null,
    is_active: true,
    linked_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  };

  const { data: link, error: linkError } = await service
    .from("telegram_user_links")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();

  if (linkError) throw linkError;


  await service.from("audit_logs").insert({
    organization_id: profile.organization_id,
    branch_id: profile.branch_id,
    user_id: profile.id,
    action: "link_telegram_mini_app",
    entity_type: "telegram_user_link",
    entity_id: link.id,
    new_data: {
      telegram_user_id: telegramUser.id,
      username: telegramUser.username || null
    }
  });

  const language = await preferredLanguage(
    service,
    profile.id,
    telegramUser.language_code
  );

  await setTelegramCommandsForChat(telegramUser.id, profile.role);

  await sendTelegramMessage({
    chatId: telegramUser.id,
    text: [
      `✅ <b>${tg(language, "connected_pos_title")}</b>`,
      "",
      tg(language, "user", {
        value: profile.full_name
      }),
      tg(language, "role", {
        value: profile.role
      }),
      tg(language, "branch", {
        value: profile.branches?.name
          || tg(language, "assigned_branch")
      }),
      "",
      language === "km"
        ? "ការជូនដំណឹង Telegram ដែលពាក់ព័ន្ធ នឹងអនុវត្តតាមការកំណត់ផ្ទាល់ខ្លួនរបស់អ្នក។"
        : "Relevant Telegram alerts will follow your personal notification settings."
    ].join("\n"),
    path: "/dashboard",
    buttonText: tg(language, "open_pos")
  });

  return link;
}

async function setupBot(service, profile) {
  if (!await hasEffectivePermission(
    service,
    profile,
    "telegram.admin",
    ["owner", "admin"]
  )) {
    throw Object.assign(
      new Error("Permission required: telegram.admin"),
      { status: 403 }
    );
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret || !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must contain 16-256 letters, numbers, underscores or hyphens."
    );
  }

  const webhookUrl = miniAppUrl("/api/telegram-webhook");
  const appUrl = miniAppUrl("/");

  const webhook = await telegramApi("setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: false
  });

  const verifiedWebhook = await telegramApi("getWebhookInfo");
  if (verifiedWebhook.url !== webhookUrl) {
    throw new Error("Telegram did not save the Tiny POS webhook URL. Run setup again after confirming TELEGRAM_MINI_APP_URL.");
  }

  const menu = await telegramApi("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "Open Tiny POS · បើក Tiny POS",
      web_app: { url: appUrl }
    }
  });

  const commands = await telegramApi("setMyCommands", {
    commands: [
      { command: "start", description: "Open Tiny POS / បើក Tiny POS" },
      { command: "pos", description: "Open Mini App / បើក Mini App" },
      { command: "status", description: "Linked account / គណនីបានភ្ជាប់" },
      { command: "checkin", description: "Check in / ចុះវត្តមានចូល" },
      { command: "checkout", description: "Check out / ចុះវត្តមានចេញ" },
      { command: "attendance", description: "Attendance status / ស្ថានភាពវត្តមាន" },
      { command: "takeleave", description: "Request leave / ស្នើសុំច្បាប់" },
      { command: "commission", description: "My commission / កម្រៃជើងសារ" },
      { command: "payslip", description: "My payslip / បង្កាន់ដៃប្រាក់ខែ" },
      { command: "join", description: "Customer link / ភ្ជាប់អតិថិជន" },
      { command: "points", description: "Customer points / ពិន្ទុអតិថិជន" },
      { command: "offers", description: "Customer offers / ការផ្តល់ជូន" },
      { command: "stop", description: "Stop marketing / បញ្ឈប់ផ្សព្វផ្សាយ" },
      { command: "link", description: "Link code / កូដភ្ជាប់" },
      { command: "unlink", description: "Disconnect / ផ្តាច់" },
      { command: "help", description: "Help / ជំនួយ" }
    ]
  });

  const { data: activeLinks, error: activeLinksError } = await service
    .from("telegram_user_links")
    .select("chat_id,profiles!inner(role,is_active)")
    .eq("organization_id", profile.organization_id)
    .eq("is_active", true)
    .eq("profiles.is_active", true);

  if (activeLinksError) throw activeLinksError;
  let roleCommandMenus = 0;
  for (const link of activeLinks || []) {
    try {
      await setTelegramCommandsForChat(link.chat_id, link.profiles?.role);
      roleCommandMenus += 1;
    } catch (error) {
      console.warn("Could not refresh Telegram role commands", link.chat_id, error.message);
    }
  }

  return {
    webhook,
    menu,
    commands,
    role_command_menus: roleCommandMenus,
    webhook_url: webhookUrl,
    mini_app_url: appUrl
  };
}

export default async (request) => {
  try {
    if (!["GET", "POST"].includes(request.method)) {
      return json({ ok: false, error: "Method not allowed." }, 405);
    }

    botToken();
    const context = await authenticatedProfile(request);

    if (request.method === "GET") {
      const status = await botStatus(
        context.service,
        context.profile.id
      );
      return json({ ok: true, ...status });
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action || "status";

    if (action === "status") {
      const status = await botStatus(
        context.service,
        context.profile.id
      );
      return json({ ok: true, ...status });
    }

    if (action === "link-mini-app") {
      const link = await linkMiniApp(context, body.init_data);
      return json({ ok: true, link });
    }

    if (action === "setup") {
      const result = await setupBot(context.service, context.profile);
      return json({ ok: true, ...result });
    }

    if (action === "test") {
      const { data: link, error } = await context.service
        .from("telegram_user_links")
        .select("*")
        .eq("user_id", context.profile.id)
        .eq("is_active", true)
        .maybeSingle();

      if (error) throw error;
      if (!link) {
        throw Object.assign(
          new Error("Connect Telegram before sending a test message."),
          { status: 409 }
        );
      }

      const language = await preferredLanguage(
        context.service,
        context.profile.id,
        link.language_code
      );

      const sent = await sendTelegramMessage({
        chatId: link.chat_id,
        text: language === "km"
          ? [
              "🧪 <b>សារសាកល្បង Tiny POS</b>",
              "",
              `សួស្តី ${context.profile.full_name}។`,
              "ការភ្ជាប់ Telegram របស់អ្នកដំណើរការល្អ។"
            ].join("\n")
          : [
              "🧪 <b>Tiny POS test message</b>",
              "",
              `Hello ${context.profile.full_name}.`,
              "Your Telegram connection is working."
            ].join("\n"),
        path: "/telegram",
        buttonText: tg(
          language,
          "notification_settings"
        )
      });

      return json({ ok: true, message_id: sent.message_id });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (error) {
    return errorResponse(error);
  }
};
