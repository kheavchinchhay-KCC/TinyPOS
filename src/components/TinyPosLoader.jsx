import React from "react";

export default function TinyPosLoader({
  label = "Loading…",
  overlay = false,
  compact = false
}) {
  return (
    <div
      className={[
        "tiny-pos-loader",
        overlay ? "overlay" : "",
        compact ? "compact" : ""
      ].filter(Boolean).join(" ")}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="tiny-pos-loader-card">
        <img src="/icons/tiny-pos-brand.png" alt="" aria-hidden="true" />
        <strong>{label}</strong>
        <div className="tiny-pos-loader-track" aria-hidden="true">
          {Array.from({ length: 12 }, (_, index) => (
            <span key={index} style={{ "--loader-index": index }} />
          ))}
        </div>
      </div>
    </div>
  );
}
