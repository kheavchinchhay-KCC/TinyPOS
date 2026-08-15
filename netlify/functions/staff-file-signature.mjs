import crypto from "node:crypto";
import {
  authenticatedProfile,
  json
} from "./_telegram-shared.mjs";

function sign(params, secret) {
  const source = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(source + secret).digest("hex");
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  try {
    const { profile } = await authenticatedProfile(request);
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error("Cloudinary environment variables are missing.");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `${profile.id}-${crypto.randomUUID()}`;
    const params = {
      folder: `tiny-pos-new/leave-requests/${profile.organization_id}`,
      public_id: publicId,
      timestamp
    };

    return json({
      ok: true,
      cloudName,
      apiKey,
      timestamp,
      folder: params.folder,
      publicId,
      signature: sign(params, apiSecret)
    });
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
