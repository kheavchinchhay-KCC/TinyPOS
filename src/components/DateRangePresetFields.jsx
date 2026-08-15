import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../context/LanguageContext";
import {
  DATE_RANGE_PRESETS,
  dateRangeForPreset,
  matchingDateRangePreset
} from "../lib/dateRangePresets";

/**
 * Shared Tiny POS date-range controls.
 *
 * It deliberately owns the From/To inputs as well as the preset selector so
 * manually editing either date always changes the selector to "Custom Date".
 * Selecting a preset updates both dates in one parent state change.
 */
export default function DateRangePresetFields({
  from,
  to,
  onChange,
  disabled = false,
  presetLabel = "Date range",
  fromLabel = "From",
  toLabel = "To"
}) {
  const { t } = useLanguage();
  const [preset, setPreset] = useState(() =>
    matchingDateRangePreset(from, to)
  );
  const previousRange = useRef({ from, to });
  const appliedPreset = useRef(null);

  useEffect(() => {
    const previous = previousRange.current;
    if (previous.from === from && previous.to === to) return;

    previousRange.current = { from, to };

    if (
      appliedPreset.current
      && appliedPreset.current.from === from
      && appliedPreset.current.to === to
    ) {
      setPreset(appliedPreset.current.preset);
      appliedPreset.current = null;
      return;
    }

    // Any date update not initiated by this preset dropdown is a custom range.
    setPreset("custom");
  }, [from, to]);

  function commitRange(nextRange, nextPreset = "custom") {
    if (!nextRange?.from || !nextRange?.to) return;

    setPreset(nextPreset);
    appliedPreset.current = nextPreset === "custom"
      ? null
      : { ...nextRange, preset: nextPreset };
    onChange(nextRange, nextPreset);
  }

  function choosePreset(event) {
    const nextPreset = event.target.value;

    if (nextPreset === "custom") {
      setPreset("custom");
      appliedPreset.current = null;
      return;
    }

    const nextRange = dateRangeForPreset(nextPreset);
    if (nextRange) commitRange(nextRange, nextPreset);
  }

  function changeFrom(event) {
    const nextFrom = event.target.value;
    const nextTo = to && nextFrom && to < nextFrom ? nextFrom : to;
    commitRange({ from: nextFrom, to: nextTo || nextFrom }, "custom");
  }

  function changeTo(event) {
    const nextTo = event.target.value;
    const nextFrom = from && nextTo && nextTo < from ? nextTo : from;
    commitRange({ from: nextFrom || nextTo, to: nextTo }, "custom");
  }

  return (
    <>
      <label className="date-range-preset-field">
        <span>{t(presetLabel)}</span>
        <select
          value={preset}
          onChange={choosePreset}
          disabled={disabled}
          aria-label={t(presetLabel)}
        >
          {DATE_RANGE_PRESETS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </label>

      <label className="date-range-from-field">
        <span>{t(fromLabel)}</span>
        <input
          type="date"
          value={from || ""}
          onChange={changeFrom}
          disabled={disabled}
          aria-label={t(fromLabel)}
        />
      </label>

      <label className="date-range-to-field">
        <span>{t(toLabel)}</span>
        <input
          type="date"
          min={from || undefined}
          value={to || ""}
          onChange={changeTo}
          disabled={disabled}
          aria-label={t(toLabel)}
        />
      </label>
    </>
  );
}
