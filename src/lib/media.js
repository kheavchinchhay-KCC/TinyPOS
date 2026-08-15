export const PRODUCT_IMAGE_PLACEHOLDER = "/assets/tiny-pos-product-placeholder.png";
export const MEDIA_SOURCE_LIMIT = 30 * 1024 * 1024;

function extractUrl(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return extractUrl(
      value.secure_url
      || value.image_url
      || value.url
      || value.src
      || ""
    );
  }

  let text = String(value).trim();
  if (!text) return "";

  if ((text.startsWith("{") || text.startsWith("[")) && text.length < 20000) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return extractUrl(parsed[0]);
      return extractUrl(parsed);
    } catch {
      // Continue with the original text. Some legacy records contain plain URLs.
    }
  }

  text = text.replace(/^['"]+|['"]+$/g, "").trim();
  if (text.startsWith("//")) text = `https:${text}`;
  if (/^res\.cloudinary\.com\//i.test(text)) text = `https://${text}`;
  if (/^http:\/\/res\.cloudinary\.com\//i.test(text)) {
    text = text.replace(/^http:/i, "https:");
  }
  if (/^javascript:/i.test(text)) return "";

  return text;
}

export function normalizeMediaUrl(value) {
  const url = extractUrl(value);
  if (!url) return "";
  if (/^(https?:|blob:|data:image\/|\/)/i.test(url)) return url;
  return "";
}

export function isCloudinaryImageUrl(value) {
  const url = normalizeMediaUrl(value);
  return /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\//i.test(url);
}

function transformationString({
  width,
  height,
  crop = "fill",
  gravity = "auto",
  quality = "auto:eco",
  format = "auto"
} = {}) {
  const parts = [];
  if (format) parts.push(`f_${format}`);
  if (quality) parts.push(`q_${quality}`);
  if (crop) parts.push(`c_${crop}`);
  if (gravity && crop === "fill") parts.push(`g_${gravity}`);
  if (Number(width) > 0) parts.push(`w_${Math.round(Number(width))}`);
  if (Number(height) > 0) parts.push(`h_${Math.round(Number(height))}`);
  return parts.join(",");
}

function stripSavedCloudinaryTransforms(path) {
  const versionMatch = path.match(/(?:^|\/)(v\d+\/.*)$/);
  if (versionMatch?.[1]) return versionMatch[1];

  let clean = path;
  while (/^(?:[a-z]{1,4}_[^/]+(?:,[^/]+)*)\//i.test(clean)) {
    clean = clean.replace(/^[^/]+\//, "");
  }
  return clean;
}

export function cloudinaryImageUrl(value, options = {}) {
  const url = normalizeMediaUrl(value);
  if (!url || !isCloudinaryImageUrl(url)) return url;
  const transformation = transformationString(options);
  if (!transformation) return url;

  const [deliveryBase, savedPath = ""] = url.split("/image/upload/");
  const assetPath = stripSavedCloudinaryTransforms(savedPath);
  return `${deliveryBase}/image/upload/${transformation}/${assetPath}`;
}

export function productCardImageUrl(value, width = 320, height = 220) {
  return cloudinaryImageUrl(value, {
    width,
    height,
    crop: "fill",
    gravity: "auto",
    quality: "auto:eco"
  });
}

export function productDetailImageUrl(value, width = 1200, height = 1200) {
  return cloudinaryImageUrl(value, {
    width,
    height,
    crop: "limit",
    gravity: null,
    quality: "auto:good"
  });
}

export function attachmentPreviewUrl(value, width = 1600, height = 1600) {
  return cloudinaryImageUrl(value, {
    width,
    height,
    crop: "limit",
    gravity: null,
    quality: "auto:good"
  });
}

export function cloudinaryDownloadUrl(value) {
  const url = normalizeMediaUrl(value);
  if (!url || !isCloudinaryImageUrl(url)) return url;
  return url.replace("/image/upload/", "/image/upload/fl_attachment/");
}

export function cloudinaryPublicIdFromUrl(value) {
  const url = normalizeMediaUrl(value);
  if (!isCloudinaryImageUrl(url)) return "";
  try {
    const parsed = new URL(url);
    let path = parsed.pathname.split("/image/upload/")[1] || "";
    const versionMatch = path.match(/(?:^|\/)v\d+\/(.+)$/);
    if (versionMatch?.[1]) {
      path = versionMatch[1];
    } else {
      // Older saved delivery links may already include one or more transform
      // segments but no explicit Cloudinary version segment.
      while (/^(?:[a-z]{1,4}_[^/]+(?:,[^/]+)*)\//i.test(path)) {
        path = path.replace(/^[^/]+\//, "");
      }
    }
    path = path.replace(/\.[a-z0-9]+$/i, "");
    return decodeURIComponent(path);
  } catch {
    return "";
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall through to HTMLImageElement for older mobile browsers.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("This image format cannot be read on this device."));
      element.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function optimizeImageFile(file, {
  maxWidth = 1200,
  maxHeight = 1200,
  quality = 0.82,
  baseName = "tiny-pos-image"
} = {}) {
  if (!file) return null;
  if (!String(file.type || "").startsWith("image/")) {
    throw new Error("Choose a valid image file.");
  }
  if (Number(file.size || 0) > MEDIA_SOURCE_LIMIT) {
    throw new Error("The source image must be 30 MB or smaller.");
  }

  const bitmap = await loadBitmap(file);
  const sourceWidth = Number(bitmap.naturalWidth || bitmap.width || 0);
  const sourceHeight = Number(bitmap.naturalHeight || bitmap.height || 0);
  if (!sourceWidth || !sourceHeight) {
    bitmap.close?.();
    throw new Error("The selected image has no readable dimensions.");
  }

  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) {
    bitmap.close?.();
    throw new Error("This browser cannot prepare the image for upload.");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  let blob = await canvasBlob(canvas, "image/webp", quality);
  let type = "image/webp";
  let extension = "webp";
  if (!blob) {
    blob = await canvasBlob(canvas, "image/jpeg", Math.min(0.9, quality + 0.04));
    type = "image/jpeg";
    extension = "jpg";
  }
  if (!blob) throw new Error("The image could not be compressed.");

  const stem = String(file.name || baseName)
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || baseName;

  return new File([blob], `${stem}.${extension}`, {
    type,
    lastModified: Date.now()
  });
}

export async function downloadMediaFile(value, filename = "tiny-pos-image") {
  const url = cloudinaryDownloadUrl(value) || normalizeMediaUrl(value);
  if (!url) throw new Error("No image is available to download.");

  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error("The image could not be downloaded.");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    const extension = blob.type.includes("png")
      ? "png"
      : blob.type.includes("webp")
        ? "webp"
        : "jpg";
    link.href = objectUrl;
    link.download = `${String(filename || "tiny-pos-image").replace(/[^a-z0-9-_]+/gi, "-")}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
