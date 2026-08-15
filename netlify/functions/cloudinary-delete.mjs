import crypto from "node:crypto";
import { json, requireManager } from "./_auth.mjs";

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
    const { supabase } = await requireManager(request);
    const body = await request.json();
    const publicId = String(body.publicId || "").trim();

    if (!publicId.startsWith("tiny-pos-new/products/")) {
      return json({ ok: false, error: "Invalid product image ID." }, 400);
    }

    const { data: image, error: imageError } = await supabase
      .from("product_images")
      .select("id, cloudinary_public_id")
      .eq("cloudinary_public_id", publicId)
      .single();

    if (imageError || !image) {
      return json({ ok: false, error: "Product image not found." }, 404);
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return json({ ok: false, error: "Cloudinary environment variables are missing." }, 500);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const params = { invalidate: "true", public_id: publicId, timestamp };
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
      return json({ ok: false, error: result.error?.message || "Cloudinary delete failed." }, 502);
    }

    return json({ ok: true, result: result.result });
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
