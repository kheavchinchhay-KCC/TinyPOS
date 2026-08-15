import { useEffect } from "react";
import { telegramWebApp } from "../lib/telegram";

export default function TelegramMiniAppBridge() {
  useEffect(() => {
    const app = telegramWebApp();
    if (!app) return;

    try {
      app.ready();
      app.expand();
      app.enableClosingConfirmation?.();
      app.disableVerticalSwipes?.();

      document.documentElement.dataset.telegramMiniApp = "true";
      document.documentElement.style.setProperty(
        "--telegram-viewport-height",
        `${app.viewportStableHeight || app.viewportHeight || window.innerHeight}px`
      );

      const applyTheme = () => {
        document.documentElement.dataset.telegramColorScheme =
          app.colorScheme || "light";
      };

      applyTheme();
      app.onEvent?.("themeChanged", applyTheme);

      return () => {
        app.offEvent?.("themeChanged", applyTheme);
      };
    } catch {
      // Telegram integration must never block the normal browser POS.
    }
  }, []);

  return null;
}
