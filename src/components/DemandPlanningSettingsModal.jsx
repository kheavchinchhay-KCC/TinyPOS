import { useEffect, useState } from "react";
import { X } from "lucide-react";

const defaults = {
  history_days: 90,
  forecast_horizon_days: 30,
  safety_stock_days: 7,
  recent_window_days: 30,
  recent_weight: 0.55,
  seasonality_weight: 0.2,
  minimum_history_days: 14,
  slow_moving_days: 60,
  overstock_cover_days: 90,
  auto_run_enabled: true,
  auto_run_hour: 6
};

export default function DemandPlanningSettingsModal({
  open,
  settings,
  busy,
  onClose,
  onSave
}) {
  const [values, setValues] = useState(defaults);

  useEffect(() => {
    if (!open) return;
    setValues({ ...defaults, ...(settings || {}) });
  }, [open, settings]);

  if (!open) return null;

  function update(name, value) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  return (
    <div className="modal-backdrop">
      <div className="modal demand-settings-modal">
        <div className="modal-header">
          <div>
            <p className="eyebrow">DEMAND MODEL</p>
            <h2>Forecast Settings</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="forecast-settings-grid">
          <label>
            Sales history days
            <input type="number" min="30" max="730" value={values.history_days}
              onChange={(event) => update("history_days", event.target.value)} />
            <small>Longer history is steadier; shorter history reacts faster.</small>
          </label>

          <label>
            Forecast horizon days
            <input type="number" min="7" max="180" value={values.forecast_horizon_days}
              onChange={(event) => update("forecast_horizon_days", event.target.value)} />
          </label>

          <label>
            Safety-stock days
            <input type="number" min="0" max="90" value={values.safety_stock_days}
              onChange={(event) => update("safety_stock_days", event.target.value)} />
          </label>

          <label>
            Recent-sales window
            <input type="number" min="7" max="90" value={values.recent_window_days}
              onChange={(event) => update("recent_window_days", event.target.value)} />
          </label>

          <label>
            Recent-sales weight
            <input type="number" min="0" max="1" step="0.05" value={values.recent_weight}
              onChange={(event) => update("recent_weight", event.target.value)} />
            <small>0 uses long history; 1 uses only the recent window.</small>
          </label>

          <label>
            Short-seasonality weight
            <input type="number" min="0" max="1" step="0.05" value={values.seasonality_weight}
              onChange={(event) => update("seasonality_weight", event.target.value)} />
          </label>

          <label>
            Minimum selling days
            <input type="number" min="1" max="365" value={values.minimum_history_days}
              onChange={(event) => update("minimum_history_days", event.target.value)} />
          </label>

          <label>
            Slow-moving after days
            <input type="number" min="7" max="730" value={values.slow_moving_days}
              onChange={(event) => update("slow_moving_days", event.target.value)} />
          </label>

          <label>
            Overstock cover days
            <input type="number" min="14" max="730" value={values.overstock_cover_days}
              onChange={(event) => update("overstock_cover_days", event.target.value)} />
          </label>

          <label>
            Daily automatic-run hour
            <input type="number" min="0" max="23" value={values.auto_run_hour}
              onChange={(event) => update("auto_run_hour", event.target.value)} />
            <small>Uses the shop timezone and a 24-hour clock.</small>
          </label>
        </div>

        <label className="form-check form-switch forecast-auto-switch">
          <input className="form-check-input" type="checkbox" checked={Boolean(values.auto_run_enabled)}
            onChange={(event) => update("auto_run_enabled", event.target.checked)} />
          <span className="form-check-label">Generate one forecast automatically every day</span>
        </label>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="button" disabled={busy} onClick={() => onSave(values)}>
            {busy ? "Saving…" : "Save forecast settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
