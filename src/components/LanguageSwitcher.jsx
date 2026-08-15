import { Languages } from "lucide-react";
import { useLanguage } from "../context/LanguageContext";

export default function LanguageSwitcher({
  compact = false,
  className = ""
}) {
  const {
    displayLanguage,
    isSwitching,
    setLanguage,
    t
  } = useLanguage();

  return (
    <div
      className={`language-switcher ${compact ? "compact" : ""} ${isSwitching ? "switching" : ""} ${className}`.trim()}
      data-i18n-skip
      role="group"
      aria-label={t("Language")}
      aria-busy={isSwitching}
    >
      {!compact && (
        <span className="language-switcher-label">
          <Languages size={18} aria-hidden="true" />
          {t("Language")}
        </span>
      )}

      <div className="language-toggle" aria-label={t("Choose language") }>
        <button
          type="button"
          className={displayLanguage === "en" ? "active" : ""}
          onClick={() => setLanguage("en")}
          aria-pressed={displayLanguage === "en"}
        >
          EN
        </button>
        <button
          type="button"
          className={displayLanguage === "km" ? "active" : ""}
          onClick={() => setLanguage("km")}
          aria-pressed={displayLanguage === "km"}
        >
          KH
        </button>
      </div>
    </div>
  );
}
