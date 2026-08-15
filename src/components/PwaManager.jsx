import {
  Download,
  RefreshCw,
  WifiOff,
  X
} from "lucide-react";
import {
  applyPwaUpdate,
  dismissPwaInstall,
  getPwaState,
  promptPwaInstall,
  subscribePwaState
} from "../lib/pwa";
import { useEffect, useState } from "react";

export default function PwaManager() {
  const [pwa, setPwa] = useState(
    getPwaState
  );
  const [installing, setInstalling] =
    useState(false);

  useEffect(
    () => subscribePwaState(setPwa),
    []
  );

  async function install() {
    try {
      setInstalling(true);
      await promptPwaInstall();
    } finally {
      setInstalling(false);
    }
  }

  if (
    pwa.online &&
    !pwa.updateAvailable &&
    !pwa.installAvailable
  ) {
    return null;
  }

  return (
    <div className="pwa-status-stack">
      {!pwa.online && (
        <div className="pwa-banner offline">
          <WifiOff size={20} />
          <div>
            <strong>Tiny POS is offline</strong>
            <span>
              Browse the loaded screen and keep editing
              the local sale draft. Payments and database
              changes are disabled until reconnection.
            </span>
          </div>
        </div>
      )}

      {pwa.updateAvailable && (
        <div className="pwa-banner update">
          <RefreshCw size={20} />
          <div>
            <strong>A Tiny POS update is ready</strong>
            <span>
              Reload once to use the newest deployed files.
            </span>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={applyPwaUpdate}
          >
            Update now
          </button>
        </div>
      )}

      {pwa.installAvailable && (
        <div className="pwa-banner install">
          <Download size={20} />
          <div>
            <strong>Install Tiny POS</strong>
            <span>
              Add it as a standalone app for faster access
              on this device.
            </span>
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={install}
            disabled={installing}
          >
            {installing ? "Opening…" : "Install"}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={dismissPwaInstall}
            aria-label="Dismiss install prompt"
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
