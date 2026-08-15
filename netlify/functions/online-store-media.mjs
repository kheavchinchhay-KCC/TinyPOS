import crypto from "node:crypto";
import { json, requireManager } from "./_auth.mjs";

function sign(params, secret) {
  const source = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(source + secret).digest("hex");
}

function cloudinaryConfig() {
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
    const { profile } = await requireManager(request, "online_store.manage");
    const body = await request.json().catch(() => ({}));
    const kind = String(body.kind || "banner").trim().toLowerCase();
    const fileType = String(body.file_type || "").toLowerCase();
    const fileSize = Number(body.file_size || 0);

    if (!["banner", "bank_qr"].includes(kind)) {
      return json({ ok: false, error: "Unsupported online-store media type." }, 400);
    }
    if (!fileType.startsWith("image/") || fileSize <= 0 || fileSize > 8 * 1024 * 1024) {
      return json({ ok: false, error: "Choose an image up to 8 MB." }, 400);
    }

    const { cloudName, apiKey, apiSecret } = cloudinaryConfig();
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `tiny-pos-new/online-store/${profile.organization_id}/${profile.branch_id}/${kind}`;
    const publicId = `${kind}-${timestamp}-${crypto.randomBytes(5).toString("hex")}`;
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
      signature: sign(params, apiSecret)
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
