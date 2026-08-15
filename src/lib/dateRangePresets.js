export const DATE_RANGE_PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom Date" }
];

function cloneDate(value = new Date()) {
  const source = value instanceof Date ? value : new Date(value);
  return new Date(
    source.getFullYear(),
    source.getMonth(),
    source.getDate(),
    12,
    0,
    0,
    0
  );
}

export function localDateKey(value = new Date()) {
  const date = cloneDate(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value, amount) {
  const date = cloneDate(value);
  date.setDate(date.getDate() + amount);
  return date;
}

export function dateRangeForPreset(preset, referenceDate = new Date()) {
  const today = cloneDate(referenceDate);

  if (preset === "today") {
    const key = localDateKey(today);
    return { from: key, to: key };
  }

  if (preset === "yesterday") {
    const key = localDateKey(addDays(today, -1));
    return { from: key, to: key };
  }

  if (preset === "this_week" || preset === "last_week") {
    // JavaScript Sunday is 0. Convert to a Monday-first week where Monday=0.
    const mondayOffset = (today.getDay() + 6) % 7;
    let monday = addDays(today, -mondayOffset);

    if (preset === "last_week") {
      monday = addDays(monday, -7);
    }

    return {
      from: localDateKey(monday),
      to: localDateKey(addDays(monday, 6))
    };
  }

  if (preset === "this_month") {
    const first = new Date(today.getFullYear(), today.getMonth(), 1, 12);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0, 12);
    return {
      from: localDateKey(first),
      to: localDateKey(last)
    };
  }

  if (preset === "last_month") {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1, 12);
    const last = new Date(today.getFullYear(), today.getMonth(), 0, 12);
    return {
      from: localDateKey(first),
      to: localDateKey(last)
    };
  }

  return null;
}

export function matchingDateRangePreset(from, to, referenceDate = new Date()) {
  for (const preset of DATE_RANGE_PRESETS) {
    if (preset.value === "custom") continue;
    const range = dateRangeForPreset(preset.value, referenceDate);
    if (range?.from === from && range?.to === to) {
      return preset.value;
    }
  }

  return "custom";
}
