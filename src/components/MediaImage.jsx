import { useEffect, useMemo, useState } from "react";
import {
  PRODUCT_IMAGE_PLACEHOLDER,
  cloudinaryImageUrl,
  normalizeMediaUrl
} from "../lib/media";

export default function MediaImage({
  src,
  alt = "",
  width,
  height,
  crop = "fill",
  gravity = "auto",
  quality = "auto:eco",
  className = "",
  imgClassName = "",
  placeholder = PRODUCT_IMAGE_PLACEHOLDER,
  eager = false,
  onClick,
  title
}) {
  const normalized = useMemo(() => normalizeMediaUrl(src), [src]);
  const displayUrl = useMemo(
    () => cloudinaryImageUrl(normalized, { width, height, crop, gravity, quality }),
    [normalized, width, height, crop, gravity, quality]
  );
  const [status, setStatus] = useState(displayUrl ? "loading" : "fallback");

  useEffect(() => {
    setStatus(displayUrl ? "loading" : "fallback");
  }, [displayUrl]);

  const shownUrl = status === "error" || status === "fallback"
    ? placeholder
    : displayUrl;

  return (
    <span
      className={`media-image-frame ${status === "loading" ? "is-loading" : ""} ${status === "error" || status === "fallback" ? "is-fallback" : ""} ${className}`.trim()}
      onClick={onClick}
      title={title}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (event) => {
        if (event.key === "Enter" || event.key === " ") onClick(event);
      } : undefined}
    >
      {status === "loading" && <span className="media-image-loader" aria-hidden="true" />}
      <img
        src={shownUrl}
        alt={alt}
        className={imgClassName}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onLoad={() => setStatus((current) => current === "loading" ? "ready" : current)}
        onError={() => setStatus((current) => current === "error" ? "fallback" : "error")}
      />
    </span>
  );
}
