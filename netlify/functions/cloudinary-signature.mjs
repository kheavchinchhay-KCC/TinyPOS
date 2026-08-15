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
    const productId = String(body.productId || "").trim();

    if (!/^[0-9a-f-]{36}$/i.test(productId)) {
      return json({ ok: false, error: "Valid product ID required." }, 400);
    }

    const { data: product, error: productError } = await supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .single();

    if (productError || !product) {
      return json({ ok: false, error: "Product not found." }, 404);
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return json({ ok: false, error: "Cloudinary environment variables are missing." }, 500);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
      folder: "tiny-pos-new/products",
      invalidate: "true",
      overwrite: "true",
      public_id: productId,
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
  } catch (error) {
    return json({ ok: false, error: error.message }, error.status || 500);
  }
};
