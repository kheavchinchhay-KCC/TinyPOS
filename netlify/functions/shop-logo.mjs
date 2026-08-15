import crypto from "node:crypto";
import { json, requireManager } from "./_auth.mjs";

function sign(params, secret) {
  const source = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  return crypto
    .createHash("sha1")
    .update(source + secret)
    .digest("hex");
}

function cloudinaryConfiguration() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    const error = new Error("Cloudinary environment variables are missing.");
    error.status = 500;
    throw error;
  }

  return { cloudName, apiKey, apiSecret };
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  try {
    const { profile } = await requireManager(request, "settings.manage");

    if (!["owner", "admin"].includes(profile.role)) {
      return json(
        { ok: false, error: "Only an owner or admin can change the shop logo." },
        403
      );
    }

    const body = await request.json();
    const action = String(body.action || "sign").trim();
    const expectedPublicId = `tiny-pos-new/shop/${profile.organization_id}/logo`;
    const { cloudName, apiKey, apiSecret } = cloudinaryConfiguration();
    const timestamp = Math.floor(Date.now() / 1000);

    if (action === "sign") {
      const params = {
        folder: `tiny-pos-new/shop/${profile.organization_id}`,
        invalidate: "true",
        overwrite: "true",
        public_id: "logo",
        timestamp
      };

      return json({
        ok: true,
        cloudName,
        apiKey,
        timestamp,
        folder: params.folder,
        publicId: params.public_id,
        overwrite: params.overwrite,
        invalidate: params.invalidate,
        signature: sign(params, apiSecret)
      });
    }

    if (action === "delete") {
      const publicId = String(body.publicId || "").trim();

      if (publicId !== expectedPublicId) {
        return json({ ok: false, error: "Invalid shop logo ID." }, 400);
      }

      const params = {
        invalidate: "true",
        public_id: publicId,
        timestamp
      };

      const form = new URLSearchParams({
        ...params,
        api_key: apiKey,
        signature: sign(params, apiSecret)
      });

      const response = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`,
        { method: "POST", body: form }
      );
      const result = await response.json();

      if (!response.ok || !["ok", "not found"].includes(result.result)) {
        return json(
          { ok: false, error: result.error?.message || "Shop logo delete failed." },
          502
        );
      }

      return json({ ok: true, result: result.result });
    }

    return json({ ok: false, error: "Unsupported shop logo action." }, 400);
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
