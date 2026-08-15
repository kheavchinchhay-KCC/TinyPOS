import {
  json,
  serviceClient,
  validateTelegramInitData
} from "./_telegram-shared.mjs";

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const verified = validateTelegramInitData(body.init_data, 3600);
    const service = serviceClient();

    const { data: link, error: linkError } = await service
      .from("telegram_user_links")
      .select(`
        id,
        user_id,
        is_active,
        profiles!inner(id,is_active)
      `)
      .eq("telegram_user_id", verified.user.id)
      .eq("is_active", true)
      .eq("profiles.is_active", true)
      .maybeSingle();

    if (linkError) throw linkError;

    if (!link) {
      return json({ ok: true, linked: false }, 404);
    }

    await service
      .from("telegram_user_links")
      .update({
        username: verified.user.username || null,
        first_name: verified.user.first_name || null,
        last_name: verified.user.last_name || null,
        language_code: verified.user.language_code || null,
        last_seen_at: new Date().toISOString()
      })
      .eq("id", link.id);

    if (body.current_user_id === link.user_id) {
      return json({ ok: true, linked: true, user_id: link.user_id });
    }

    const { data: authUserResult, error: authUserError } =
      await service.auth.admin.getUserById(link.user_id);

    if (authUserError || !authUserResult?.user?.email) {
      throw new Error(authUserError?.message || "Linked POS authentication user was not found.");
    }

    const { data: generated, error: generateError } =
      await service.auth.admin.generateLink({
        type: "magiclink",
        email: authUserResult.user.email
      });

    if (generateError) throw generateError;

    let tokenHash = generated?.properties?.hashed_token || null;
    if (!tokenHash && generated?.properties?.action_link) {
      try {
        tokenHash = new URL(generated.properties.action_link).searchParams.get("token");
      } catch {
        tokenHash = null;
      }
    }
    if (!tokenHash) {
      throw new Error("Supabase did not return a Telegram session token hash.");
    }

    return json({
      ok: true,
      linked: true,
      user_id: link.user_id,
      token_hash: tokenHash
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
