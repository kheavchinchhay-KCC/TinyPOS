import {
  escapeHtml,
  hashLinkCode,
  json,
  sendTelegramMessage,
  serviceClient,
  setTelegramCommandsForChat,
  clearTelegramCommandsForChat
} from "./_telegram-shared.mjs";
import {
  tg,
  telegramLanguage
} from "./_telegram-i18n.mjs";

function commandParts(text) {
  const trimmed = String(text || "").trim();
  const [first = "", ...rest] = trimmed.split(/\s+/);
  const command = first.split("@")[0].toLowerCase();
  return {
    command,
    argument: rest.join(" ").trim()
  };
}

async function userLanguage(
  service,
  userId,
  fallback = "en"
) {
  if (!userId) return telegramLanguage(fallback);

  const { data } = await service
    .from("user_preferences")
    .select("language")
    .eq("user_id", userId)
    .maybeSingle();

  return telegramLanguage(
    data?.language || fallback
  );
}

async function linkedCustomer(
  service,
  telegramUserId,
  fallbackLanguage = "en"
) {
  const { data, error } = await service
    .from("customer_telegram_links")
    .select(`
      *,
      customers!inner(
        id,
        organization_id,
        customer_code,
        name,
        loyalty_points,
        preferred_language,
        marketing_opt_in,
        crm_status,
        is_active
      )
    `)
    .eq("telegram_user_id", telegramUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    ...data,
    language: telegramLanguage(
      data.customers?.preferred_language
      || data.language_code
      || fallbackLanguage
    )
  };
}

async function linkedProfile(
  service,
  telegramUserId,
  fallbackLanguage = "en"
) {
  const { data, error } = await service
    .from("telegram_user_links")
    .select(`
      *,
      profiles!inner(
        id,
        full_name,
        role,
        is_active,
        branch_id,
        branches(id,name,code)
      )
    `)
    .eq("telegram_user_id", telegramUserId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    ...data,
    language: await userLanguage(
      service,
      data.user_id,
      data.language_code || fallbackLanguage
    )
  };
}

async function claimCode(
  service,
  code,
  message,
  fallbackLanguage
) {
  const language = telegramLanguage(
    fallbackLanguage
  );

  const normalized = String(code || "")
    .trim()
    .replace(/^link_/i, "")
    .toUpperCase();

  if (!/^[A-F0-9]{8}$/.test(normalized)) {
    throw new Error(
      tg(language, "invalid_code_format")
    );
  }

  const { data: linkCode, error: codeError } =
    await service
      .from("telegram_link_codes")
      .select("*")
      .eq(
        "code_hash",
        hashLinkCode(normalized)
      )
      .is("used_at", null)
      .gt(
        "expires_at",
        new Date().toISOString()
      )
      .maybeSingle();

  if (codeError) throw codeError;

  if (!linkCode) {
    throw new Error(
      tg(language, "invalid_code")
    );
  }

  const { data: profile, error: profileError } =
    await service
      .from("profiles")
      .select("*,branches(id,name,code)")
      .eq("id", linkCode.user_id)
      .eq("is_active", true)
      .single();

  if (profileError || !profile) {
    throw new Error(
      tg(language, "inactive_user")
    );
  }

  const preferredLanguage = await userLanguage(
    service,
    profile.id,
    fallbackLanguage
  );

  const { data: collision, error: collisionError } =
    await service
      .from("telegram_user_links")
      .select("id,user_id")
      .eq(
        "organization_id",
        profile.organization_id
      )
      .eq(
        "telegram_user_id",
        message.from.id
      )
      .neq("user_id", profile.id)
      .maybeSingle();

  if (collisionError) throw collisionError;

  if (collision) {
    throw new Error(
      preferredLanguage === "km"
        ? "គណនី Telegram នេះបានភ្ជាប់ជាមួយអ្នកប្រើ POS ផ្សេងរួចហើយ។"
        : "This Telegram account is already connected to another POS user."
    );
  }

  const { data: link, error: linkError } =
    await service
      .from("telegram_user_links")
      .upsert({
        organization_id:
          profile.organization_id,
        user_id: profile.id,
        telegram_user_id: message.from.id,
        chat_id: message.chat.id,
        username:
          message.from.username || null,
        first_name:
          message.from.first_name || null,
        last_name:
          message.from.last_name || null,
        language_code:
          message.from.language_code || null,
        is_active: true,
        linked_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString()
      }, {
        onConflict: "user_id"
      })
      .select()
      .single();

  if (linkError) throw linkError;

  await service
    .from("telegram_link_codes")
    .update({
      used_at: new Date().toISOString()
    })
    .eq("id", linkCode.id);

  await setTelegramCommandsForChat(message.chat.id, profile.role);

  await service
    .from("audit_logs")
    .insert({
      organization_id:
        profile.organization_id,
      branch_id: profile.branch_id,
      user_id: profile.id,
      action: "link_telegram_code",
      entity_type: "telegram_user_link",
      entity_id: link.id,
      new_data: {
        telegram_user_id: message.from.id,
        username:
          message.from.username || null
      }
    });

  return {
    profile,
    link,
    language: preferredLanguage
  };
}

async function claimCustomerCode(
  service,
  code,
  message,
  fallbackLanguage
) {
  const language = telegramLanguage(fallbackLanguage);
  const normalized = String(code || "")
    .trim()
    .replace(/^customer_/i, "")
    .toUpperCase();

  if (!/^[A-F0-9]{8}$/.test(normalized)) {
    throw new Error(language === "km" ? "ទម្រង់កូដអតិថិជនមិនត្រឹមត្រូវ។" : "Invalid customer link code format.");
  }

  const { data: staffCollision } = await service
    .from("telegram_user_links")
    .select("id")
    .eq("telegram_user_id", message.from.id)
    .eq("is_active", true)
    .maybeSingle();

  if (staffCollision) {
    throw new Error(language === "km" ? "គណនី Telegram នេះបានភ្ជាប់ជាបុគ្គលិក POS រួចហើយ។" : "This Telegram account is already linked as POS staff.");
  }

  const { data: linkCode, error: codeError } = await service
    .from("customer_telegram_link_codes")
    .select("*")
    .eq("code_hash", hashLinkCode(normalized))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (codeError) throw codeError;
  if (!linkCode) throw new Error(language === "km" ? "កូដនេះមិនត្រឹមត្រូវ ឬផុតកំណត់។" : "This customer code is invalid or expired.");

  const { data: customer, error: customerError } = await service
    .from("customers")
    .select("id,organization_id,customer_code,name,loyalty_points,preferred_language,marketing_opt_in,is_active")
    .eq("id", linkCode.customer_id)
    .eq("is_active", true)
    .single();

  if (customerError || !customer) throw new Error(language === "km" ? "រកមិនឃើញអតិថិជនសកម្ម។" : "Active customer not found.");

  const { data: collision, error: collisionError } = await service
    .from("customer_telegram_links")
    .select("id,customer_id")
    .eq("organization_id", customer.organization_id)
    .eq("telegram_user_id", message.from.id)
    .neq("customer_id", customer.id)
    .maybeSingle();

  if (collisionError) throw collisionError;
  if (collision) throw new Error(language === "km" ? "Telegram នេះបានភ្ជាប់ជាមួយអតិថិជនផ្សេងរួចហើយ។" : "This Telegram account is already linked to another customer.");

  const { data: link, error: linkError } = await service
    .from("customer_telegram_links")
    .upsert({
      organization_id: customer.organization_id,
      customer_id: customer.id,
      telegram_user_id: message.from.id,
      chat_id: message.chat.id,
      username: message.from.username || null,
      first_name: message.from.first_name || null,
      last_name: message.from.last_name || null,
      language_code: message.from.language_code || null,
      marketing_opt_in: true,
      is_active: true,
      linked_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { onConflict: "customer_id" })
    .select()
    .single();

  if (linkError) throw linkError;

  const customerUpdate = {
    preferred_language: telegramLanguage(customer.preferred_language || fallbackLanguage),
    marketing_opt_in: true,
    marketing_opt_in_at: new Date().toISOString(),
    marketing_opt_out_at: null,
    updated_at: new Date().toISOString()
  };
  if (customer.crm_status === "do_not_contact") customerUpdate.crm_status = "active";
  await service.from("customers").update(customerUpdate).eq("id", customer.id);

  await service.from("customer_telegram_link_codes").update({ used_at: new Date().toISOString() }).eq("id", linkCode.id);

  return { customer, link, language: telegramLanguage(customer.preferred_language || fallbackLanguage) };
}

async function customerWelcome(chatId, linked, fallbackLanguage) {
  const language = telegramLanguage(linked?.language || fallbackLanguage);
  const customer = linked?.customers;
  if (!customer) return;
  const points = Number(customer.loyalty_points || 0).toLocaleString("en-US");
  await sendTelegramMessage({
    chatId,
    withoutButton: true,
    text: language === "km"
      ? [
          `👋 <b>សួស្តី ${escapeHtml(customer.name)}</b>`,
          "",
          `លេខអតិថិជន៖ <code>${escapeHtml(customer.customer_code)}</code>`,
          `ពិន្ទុបច្ចុប្បន្ន៖ <b>${points}</b>`,
          "",
          "/points — មើលពិន្ទុ",
          "/offers — មើលការផ្តល់ជូន",
          "/stop — ឈប់ទទួលសារផ្សព្វផ្សាយ"
        ].join("\n")
      : [
          `👋 <b>Hello ${escapeHtml(customer.name)}</b>`,
          "",
          `Customer code: <code>${escapeHtml(customer.customer_code)}</code>`,
          `Current points: <b>${points}</b>`,
          "",
          "/points — View points",
          "/offers — View offers",
          "/stop — Stop marketing messages"
        ].join("\n")
  });
}

function linkedAccountText(
  language,
  titleKey,
  profile,
  includeHelp = false
) {
  return [
    `✅ <b>${tg(language, titleKey)}</b>`,
    "",
    tg(language, "user", {
      value: escapeHtml(profile.full_name)
    }),
    tg(language, "role", {
      value: escapeHtml(profile.role)
    }),
    tg(language, "branch", {
      value: escapeHtml(
        profile.branches?.name
        || tg(language, "assigned_branch")
      )
    }),
    includeHelp ? "" : null,
    includeHelp
      ? tg(language, "alert_settings_help")
      : null
  ]
    .filter((value) => value !== null)
    .join("\n");
}

async function welcome(
  chatId,
  linked,
  fallbackLanguage
) {
  const language = telegramLanguage(
    linked?.language || fallbackLanguage
  );

  if (linked) {
    const profile = linked.profiles;

    await sendTelegramMessage({
      chatId,
      text: [
        language === "km"
          ? "👋 <b>សូមស្វាគមន៍មកកាន់ Tiny POS</b>"
          : "👋 <b>Welcome to Tiny POS</b>",
        "",
        language === "km"
          ? `អ្នកប្រើដែលបានភ្ជាប់៖ ${escapeHtml(profile.full_name)}`
          : `Connected user: ${escapeHtml(profile.full_name)}`,
        tg(language, "role", {
          value: escapeHtml(profile.role)
        }),
        tg(language, "branch", {
          value: escapeHtml(
            profile.branches?.name
            || tg(language, "assigned_branch")
          )
        }),
        "",
        language === "km"
          ? "ប្រើប៊ូតុងខាងក្រោម ដើម្បីបើក POS Mini App។"
          : "Use the button below to open the POS Mini App."
      ].join("\n"),
      path: "/dashboard",
      buttonText: tg(language, "open_pos")
    });

    return;
  }

  await sendTelegramMessage({
    chatId,
    text: language === "km"
      ? [
          "👋 <b>សូមស្វាគមន៍មកកាន់ Tiny POS</b>",
          "",
          "បើក Mini App ហើយចូលដោយគណនី POS របស់អ្នក។",
          "បន្ទាប់មកបើកការកំណត់ Telegram ក្នុង Tiny POS ហើយភ្ជាប់គណនី Telegram នេះ។",
          "",
          "អ្នកក៏អាចបង្កើតកូដប្រើម្ដងក្នុង Tiny POS ហើយផ្ញើ៖",
          "<code>/link YOUR_CODE</code>"
        ].join("\n")
      : [
          "👋 <b>Welcome to Tiny POS</b>",
          "",
          "Open the Mini App and sign in with your POS account.",
          "Then open Telegram Settings inside Tiny POS and connect this Telegram account.",
          "",
          "You may also create a one-time code in Tiny POS and send:",
          "<code>/link YOUR_CODE</code>"
        ].join("\n"),
    path: "/login",
    buttonText: tg(language, "open_pos")
  });
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({
      ok: false,
      error: "Method not allowed."
    }, 405);
  }

  const expectedSecret =
    process.env.TELEGRAM_WEBHOOK_SECRET || "";

  const receivedSecret = request.headers.get(
    "x-telegram-bot-api-secret-token"
  ) || "";

  if (
    !expectedSecret
    || receivedSecret !== expectedSecret
  ) {
    return json({
      ok: false,
      error: "Invalid webhook secret."
    }, 401);
  }

  try {
    const update = await request.json();
    const message = update.message;

    if (
      !message?.from?.id
      || !message?.chat?.id
    ) {
      return json({ ok: true, ignored: true });
    }

    if (message.chat.type !== "private") {
      return json({ ok: true, ignored: true });
    }

    const fallbackLanguage = telegramLanguage(
      message.from.language_code
    );

    const service = serviceClient();
    const text = String(message.text || "");
    const { command, argument } =
      commandParts(text);

    let linked = await linkedProfile(
      service,
      message.from.id,
      fallbackLanguage
    );
    let customerLinked = await linkedCustomer(
      service,
      message.from.id,
      fallbackLanguage
    );

    if (linked) {
      await service
        .from("telegram_user_links")
        .update({
          chat_id: message.chat.id,
          username:
            message.from.username || null,
          first_name:
            message.from.first_name || null,
          last_name:
            message.from.last_name || null,
          language_code:
            message.from.language_code || null,
          last_seen_at:
            new Date().toISOString()
        })
        .eq("id", linked.id);
    }

    if (customerLinked) {
      await service
        .from("customer_telegram_links")
        .update({
          chat_id: message.chat.id,
          username: message.from.username || null,
          first_name: message.from.first_name || null,
          last_name: message.from.last_name || null,
          language_code: message.from.language_code || null,
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", customerLinked.id);
    }

    const language = telegramLanguage(
      linked?.language || customerLinked?.language || fallbackLanguage
    );

    if (linked && ["/start", "/status", "/help", "/menu", "/pos"].includes(command)) {
      try {
        await setTelegramCommandsForChat(message.chat.id, linked.profiles?.role);
      } catch (commandError) {
        console.warn("Could not update role Telegram commands", commandError.message);
      }
    }

    if (command === "/start") {
      const customerPayload = argument.match(/^customer_(.+)$/i)?.[1] || "";
      if (customerPayload) {
        try {
          const result = await claimCustomerCode(service, customerPayload, message, language);
          customerLinked = await linkedCustomer(service, message.from.id, result.language);
          await customerWelcome(message.chat.id, customerLinked, result.language);
        } catch (error) {
          await sendTelegramMessage({ chatId: message.chat.id, text: `❌ ${escapeHtml(error.message)}`, withoutButton: true });
        }
        return json({ ok: true });
      }

      const payload = argument.replace(
        /^link_/i,
        ""
      );

      if (payload) {
        try {
          const result = await claimCode(
            service,
            payload,
            message,
            language
          );

          linked = await linkedProfile(
            service,
            message.from.id,
            result.language
          );

          await sendTelegramMessage({
            chatId: message.chat.id,
            text: linkedAccountText(
              result.language,
              "connected_title",
              result.profile,
              true
            ),
            path: "/telegram",
            buttonText: tg(
              result.language,
              "notification_settings"
            )
          });
        } catch (error) {
          await sendTelegramMessage({
            chatId: message.chat.id,
            text: `❌ ${escapeHtml(error.message)}`,
            path: "/telegram",
            buttonText: tg(
              language,
              "create_link_code"
            )
          });
        }

        return json({ ok: true });
      }

      if (customerLinked && !linked) {
        await customerWelcome(message.chat.id, customerLinked, language);
      } else {
        await welcome(
          message.chat.id,
          linked,
          language
        );
      }

      return json({ ok: true });
    }

    if (command === "/join") {
      try {
        const result = await claimCustomerCode(service, argument, message, language);
        customerLinked = await linkedCustomer(service, message.from.id, result.language);
        await customerWelcome(message.chat.id, customerLinked, result.language);
      } catch (error) {
        await sendTelegramMessage({ chatId: message.chat.id, text: `❌ ${escapeHtml(error.message)}`, withoutButton: true });
      }
      return json({ ok: true });
    }

    if (["/points", "/offers", "/stop"].includes(command)) {
      if (!customerLinked) {
        await sendTelegramMessage({ chatId: message.chat.id, text: language === "km" ? "សូមភ្ជាប់ជាមួយកូដអតិថិជនជាមុន៖ <code>/join CODE</code>" : "Connect with a customer code first: <code>/join CODE</code>", withoutButton: true });
        return json({ ok: true });
      }
      const customer = customerLinked.customers;
      if (command === "/stop") {
        await Promise.all([
          service.from("customer_telegram_links").update({ marketing_opt_in: false, updated_at: new Date().toISOString() }).eq("id", customerLinked.id),
          service.from("customers").update({ marketing_opt_in: false, marketing_opt_out_at: new Date().toISOString(), crm_status: "do_not_contact", updated_at: new Date().toISOString() }).eq("id", customer.id)
        ]);
        await sendTelegramMessage({ chatId: message.chat.id, text: language === "km" ? "✅ អ្នកនឹងមិនទទួលសារផ្សព្វផ្សាយទៀតទេ។ អ្នកនៅតែអាចប្រើ /points បាន។" : "✅ Marketing messages are now stopped. You can still use /points.", withoutButton: true });
        return json({ ok: true });
      }
      if (command === "/points") {
        const { data: fresh } = await service.from("customers").select("loyalty_points,name,customer_code").eq("id", customer.id).single();
        await sendTelegramMessage({ chatId: message.chat.id, text: language === "km" ? `🎁 <b>ពិន្ទុរបស់អ្នក</b>\n\n${escapeHtml(fresh.name)} · <code>${escapeHtml(fresh.customer_code)}</code>\nពិន្ទុ៖ <b>${Number(fresh.loyalty_points || 0).toLocaleString("en-US")}</b>` : `🎁 <b>Your loyalty points</b>\n\n${escapeHtml(fresh.name)} · <code>${escapeHtml(fresh.customer_code)}</code>\nPoints: <b>${Number(fresh.loyalty_points || 0).toLocaleString("en-US")}</b>`, withoutButton: true });
        return json({ ok: true });
      }
      const { data: offers, error: offersError } = await service
        .from("customer_campaign_recipients")
        .select("sent_at,customer_campaigns(name,title_en,title_km,message_en,message_km,bonus_points,coupons(code,end_at))")
        .eq("customer_id", customer.id)
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(5);
      if (offersError) throw offersError;
      const lines = [language === "km" ? "🎟 <b>ការផ្តល់ជូនថ្មីៗ</b>" : "🎟 <b>Recent offers</b>"];
      for (const row of offers || []) {
        const campaign = row.customer_campaigns;
        if (!campaign) continue;
        lines.push("", `• <b>${escapeHtml(language === "km" ? (campaign.title_km || campaign.title_en) : campaign.title_en)}</b>`);
        if (campaign.coupons?.code) lines.push(`<code>${escapeHtml(campaign.coupons.code)}</code>`);
        if (Number(campaign.bonus_points || 0)>0) lines.push(language === "km" ? `ពិន្ទុបន្ថែម៖ ${Number(campaign.bonus_points).toLocaleString("en-US")}` : `Bonus points: ${Number(campaign.bonus_points).toLocaleString("en-US")}`);
      }
      if (lines.length === 1) lines.push("", language === "km" ? "មិនមានការផ្តល់ជូនថ្មីទេ។" : "No recent offers.");
      await sendTelegramMessage({ chatId: message.chat.id, text: lines.join("\n"), withoutButton: true });
      return json({ ok: true });
    }

    if (command === "/link") {
      try {
        const result = await claimCode(
          service,
          argument,
          message,
          language
        );

        await sendTelegramMessage({
          chatId: message.chat.id,
          text: linkedAccountText(
            result.language,
            "connected_pos_title",
            result.profile
          ),
          path: "/telegram",
          buttonText: tg(
            result.language,
            "notification_settings"
          )
        });
      } catch (error) {
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: `❌ ${escapeHtml(error.message)}`,
          path: "/telegram",
          buttonText: tg(
            language,
            "open_pos"
          )
        });
      }

      return json({ ok: true });
    }

    if (command === "/unlink") {
      if (!linked) {
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: tg(
            language,
            "not_connected"
          ),
          path: "/login",
          buttonText: tg(
            language,
            "open_pos"
          )
        });

        return json({ ok: true });
      }

      await service
        .from("telegram_user_links")
        .update({ is_active: false })
        .eq("id", linked.id);

      await clearTelegramCommandsForChat(message.chat.id).catch(() => null);

      await sendTelegramMessage({
        chatId: message.chat.id,
        text: `✅ ${tg(
          language,
          "disconnected"
        )}`,
        path: "/login",
        buttonText: tg(
          language,
          "open_pos"
        )
      });

      return json({ ok: true });
    }

    if (command === "/status") {
      if (!linked) {
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: tg(language, "connect_help"),
          path: "/login",
          buttonText: tg(
            language,
            "open_pos"
          )
        });

        return json({ ok: true });
      }

      await sendTelegramMessage({
        chatId: message.chat.id,
        text: linkedAccountText(
          language,
          "connected_account",
          linked.profiles
        ),
        path: "/telegram",
        buttonText: tg(
          language,
          "notification_settings"
        )
      });

      return json({ ok: true });
    }


    if (command === "/takeleave") {
      if (!linked) {
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: tg(language, "connect_help"),
          path: "/login",
          buttonText: tg(language, "open_pos")
        });
        return json({ ok: true });
      }

      await sendTelegramMessage({
        chatId: message.chat.id,
        text: language === "km"
          ? [
              "🏖 <b>ស្នើសុំច្បាប់</b>",
              "",
              "ចុចប៊ូតុងខាងក្រោម ដើម្បីជ្រើសថ្ងៃចាប់ផ្តើម ថ្ងៃបញ្ចប់ ប្រភេទច្បាប់ មូលហេតុ និងរូបភាពភ្ជាប់ (ជាជម្រើស)។",
              "សំណើរបស់អ្នកនឹងមានស្ថានភាព Pending រហូតដល់អ្នកគ្រប់គ្រងអនុម័ត ឬបដិសេធ។"
            ].join("\n")
          : [
              "🏖 <b>Request leave</b>",
              "",
              "Open the form below to choose the start date, end date, leave type, reason and an optional picture.",
              "Your request stays Pending until a manager approves or rejects it."
            ].join("\n"),
        path: "/staff-operations?tab=leave&new=1",
        buttonText: language === "km" ? "បំពេញសំណើច្បាប់" : "Open leave form"
      });
      return json({ ok: true });
    }

    if (command === "/leaverequests") {
      if (!linked) {
        await sendTelegramMessage({ chatId: message.chat.id, text: tg(language, "connect_help"), path: "/login", buttonText: tg(language, "open_pos") });
        return json({ ok: true });
      }

      if (!["owner", "admin", "manager"].includes(String(linked.profiles?.role || "").toLowerCase())) {
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: language === "km" ? "❌ ពាក្យបញ្ជានេះសម្រាប់អ្នកគ្រប់គ្រងប៉ុណ្ណោះ។" : "❌ This command is for managers only.",
          withoutButton: true
        });
        return json({ ok: true });
      }

      let query = service
        .from("staff_leave_requests")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", linked.organization_id)
        .eq("status", "pending");
      if (linked.profiles.role === "manager" && linked.profiles.branch_id) {
        query = query.eq("branch_id", linked.profiles.branch_id);
      }
      const { count, error } = await query;
      if (error) throw error;

      await sendTelegramMessage({
        chatId: message.chat.id,
        text: language === "km"
          ? `🏖 <b>សំណើច្បាប់កំពុងរង់ចាំ៖ ${Number(count || 0)}</b>\n\nបើក Tiny POS ដើម្បីពិនិត្យ អនុម័ត ឬបដិសេធ។`
          : `🏖 <b>Pending leave requests: ${Number(count || 0)}</b>\n\nOpen Tiny POS to review, approve or reject them.`,
        path: "/staff-operations?tab=leave",
        buttonText: language === "km" ? "ពិនិត្យសំណើច្បាប់" : "Review leave requests"
      });
      return json({ ok: true });
    }

    if (command === "/today") {
      if (!linked || !["owner", "admin", "manager"].includes(String(linked.profiles?.role || "").toLowerCase())) {
        await sendTelegramMessage({ chatId: message.chat.id, text: linked ? "❌ Manager permission required." : tg(language, "connect_help"), withoutButton: Boolean(linked), path: linked ? "/dashboard" : "/login", buttonText: tg(language, "open_pos") });
        return json({ ok: true });
      }
      const now = new Date();
      const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Phnom_Penh" }));
      const startLocal = new Date(local.getFullYear(), local.getMonth(), local.getDate());
      const offset = local.getTime() - now.getTime();
      const startUtc = new Date(startLocal.getTime() - offset).toISOString();
      let salesQuery = service
        .from("sales")
        .select("currency,total_amount")
        .eq("organization_id", linked.organization_id)
        .eq("status", "completed")
        .gte("completed_at", startUtc);
      if (linked.profiles.role === "manager" && linked.profiles.branch_id) salesQuery = salesQuery.eq("branch_id", linked.profiles.branch_id);
      const { data: rows, error } = await salesQuery;
      if (error) throw error;
      const totals = (rows || []).reduce((value, row) => {
        value.count += 1;
        value[row.currency] = Number(value[row.currency] || 0) + Number(row.total_amount || 0);
        return value;
      }, { count: 0, USD: 0, KHR: 0 });
      const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(totals.USD);
      const khr = new Intl.NumberFormat("en-US", { style: "currency", currency: "KHR", maximumFractionDigits: 0 }).format(totals.KHR);
      await sendTelegramMessage({
        chatId: message.chat.id,
        text: `📊 <b>${language === "km" ? "ការលក់ថ្ងៃនេះ" : "Today's sales"}</b>\n\n${language === "km" ? "វិក្កយបត្រ" : "Receipts"}: <b>${totals.count}</b>\nUSD: <b>${usd}</b>\nKHR: <b>${khr}</b>`,
        path: "/dashboard",
        buttonText: tg(language, "open_pos")
      });
      return json({ ok: true });
    }

    if (command === "/register") {
      if (!linked || !["owner", "admin", "manager"].includes(String(linked.profiles?.role || "").toLowerCase())) {
        await sendTelegramMessage({ chatId: message.chat.id, text: linked ? "❌ Manager permission required." : tg(language, "connect_help"), withoutButton: Boolean(linked), path: linked ? "/cash-register" : "/login", buttonText: tg(language, "open_pos") });
        return json({ ok: true });
      }
      let registerQuery = service
        .from("cash_register_sessions")
        .select("id,session_number,register_name,opened_at,opened_by")
        .eq("organization_id", linked.organization_id)
        .eq("status", "open")
        .order("opened_at", { ascending: true });
      if (linked.profiles.role === "manager" && linked.profiles.branch_id) registerQuery = registerQuery.eq("branch_id", linked.profiles.branch_id);
      const { data: registers, error } = await registerQuery;
      if (error) throw error;
      const openerIds = [...new Set((registers || []).map((row) => row.opened_by).filter(Boolean))];
      const { data: openerRows, error: openerError } = openerIds.length
        ? await service.from("profiles").select("id,full_name").in("id", openerIds)
        : { data: [], error: null };
      if (openerError) throw openerError;
      const openerMap = new Map((openerRows || []).map((row) => [row.id, row.full_name]));
      const lines = [`💵 <b>${language === "km" ? "កាសប្រាក់កំពុងបើក" : "Open cash registers"}: ${(registers || []).length}</b>`];
      for (const row of registers || []) lines.push(`\n• ${escapeHtml(row.register_name)} · ${escapeHtml(openerMap.get(row.opened_by) || "—")}\n<code>${escapeHtml(row.session_number)}</code>`);
      await sendTelegramMessage({ chatId: message.chat.id, text: lines.join("\n"), path: "/cash-register", buttonText: tg(language, "open_pos") });
      return json({ ok: true });
    }


    if (["/checkin", "/checkout", "/attendance", "/commission"].includes(command)) {
      if (!linked) {
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: tg(language, "connect_help"),
          path: "/login",
          buttonText: tg(language, "open_pos")
        });
        return json({ ok: true });
      }

      try {
        if (command === "/checkin" || command === "/checkout") {
          const action = command === "/checkin" ? "check_in" : "check_out";
          const { data, error } = await service.rpc(
            "telegram_attendance_action",
            { p_user_id: linked.user_id, p_action: action }
          );
          if (error) throw error;
          const sessionRow = data?.session || {};
          const duration = Math.max(0, Number(sessionRow.total_minutes || 0));
          const durationText = `${Math.floor(duration / 60)}h ${Math.round(duration % 60)}m`;
          const formatted = new Intl.DateTimeFormat(
            language === "km" ? "km-KH" : "en-US",
            { dateStyle: "medium", timeStyle: "short" }
          ).format(new Date(action === "check_in" ? sessionRow.check_in_at : sessionRow.check_out_at));
          await sendTelegramMessage({
            chatId: message.chat.id,
            text: `✅ ${tg(language, action === "check_in" ? "attendance_checked_in" : "attendance_checked_out", action === "check_in" ? { time: formatted } : { duration: durationText })}`,
            path: "/staff-operations",
            buttonText: tg(language, "open_staff_operations")
          });
          return json({ ok: true });
        }

        if (command === "/attendance") {
          const { data, error } = await service.rpc(
            "telegram_attendance_status",
            { p_user_id: linked.user_id }
          );
          if (error) throw error;
          let textValue = tg(language, "attendance_not_checked_in");
          if (data?.checked_in) {
            const formatted = new Intl.DateTimeFormat(
              language === "km" ? "km-KH" : "en-US",
              { dateStyle: "medium", timeStyle: "short" }
            ).format(new Date(data.session.check_in_at));
            const minutes = Math.max(0, Number(data.elapsed_minutes || 0));
            textValue = tg(language, "attendance_current", {
              time: formatted,
              duration: `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
            });
          }
          await sendTelegramMessage({
            chatId: message.chat.id,
            text: `🕒 <b>${escapeHtml(textValue)}</b>`,
            path: "/staff-operations",
            buttonText: tg(language, "open_staff_operations")
          });
          return json({ ok: true });
        }

        const { data, error } = await service.rpc(
          "telegram_my_commission_summary",
          { p_user_id: linked.user_id }
        );
        if (error) throw error;
        const money = (value, currency) => new Intl.NumberFormat("en-US", {
          style: "currency", currency,
          maximumFractionDigits: currency === "KHR" ? 0 : 2
        }).format(Number(value || 0));
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: [
            `💰 <b>${tg(language, "commission_title")}</b>`,
            "",
            tg(language, "commission_earned_usd", { amount: money(data.earned_usd, "USD") }),
            tg(language, "commission_earned_khr", { amount: money(data.earned_khr, "KHR") }),
            tg(language, "commission_outstanding_usd", { amount: money(data.outstanding_usd, "USD") }),
            tg(language, "commission_outstanding_khr", { amount: money(data.outstanding_khr, "KHR") })
          ].join("\n"),
          path: "/staff-operations",
          buttonText: tg(language, "open_staff_operations")
        });
      } catch (error) {
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: `❌ ${escapeHtml(error.message)}`,
          path: "/staff-operations",
          buttonText: tg(language, "open_staff_operations")
        });
      }
      return json({ ok: true });
    }


    if (command === "/payslip" || command === "/payroll") {
      if (!linked) {
        await sendTelegramMessage({ chatId: message.chat.id, text: tg(language, "connect_help"), path: "/login", buttonText: tg(language, "open_pos") });
        return json({ ok: true });
      }
      try {
        const { data, error } = await service.rpc("telegram_my_payroll_summary", { p_user_id: linked.user_id });
        if (error) throw error;
        const row = data?.latest;
        if (!row || row === "null") {
          await sendTelegramMessage({ chatId: message.chat.id, text: tg(language, "payroll_none"), path: "/payroll", buttonText: tg(language, "open_payroll") });
          return json({ ok: true });
        }
        const money = (value, currency) => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: currency === "KHR" ? 0 : 2 }).format(Number(value || 0));
        await sendTelegramMessage({
          chatId: message.chat.id,
          text: [
            `💵 <b>${tg(language, "payroll_title")}</b>`,
            "",
            `<b>${escapeHtml(row.run_number)}</b>`,
            tg(language, "payroll_period", { from: row.period_start, to: row.period_end }),
            tg(language, "payroll_net", { amount: money(row.net_pay, row.currency) }),
            tg(language, "payroll_paid", { amount: money(row.paid_amount, row.currency) }),
            tg(language, "payroll_outstanding", { amount: money(row.outstanding, row.currency) }),
            tg(language, "payroll_status", { status: row.status })
          ].join("\n"),
          path: "/payroll",
          buttonText: tg(language, "open_payroll")
        });
      } catch (error) {
        await sendTelegramMessage({ chatId: message.chat.id, text: `❌ ${escapeHtml(error.message)}`, path: "/payroll", buttonText: tg(language, "open_payroll") });
      }
      return json({ ok: true });
    }

    if (
      ["/pos", "/menu", "/help"]
        .includes(command)
    ) {
      if (customerLinked && !linked) {
        await customerWelcome(message.chat.id, customerLinked, language);
      } else {
        await welcome(
          message.chat.id,
          linked,
          language
        );
      }

      return json({ ok: true });
    }

    if (customerLinked && !linked) {
      await customerWelcome(message.chat.id, customerLinked, language);
    } else {
      await sendTelegramMessage({
        chatId: message.chat.id,
        text: linked
          ? tg(language, "linked_help")
          : tg(language, "unlinked_help"),
        path: linked ? "/dashboard" : "/login",
        buttonText: tg(language, "open_pos")
      });
    }

    return json({ ok: true });
  } catch (error) {
    console.error(
      "Telegram webhook error",
      error
    );

    return json({
      ok: true,
      handled_error: error.message
    });
  }
};
