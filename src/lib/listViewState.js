import { useEffect, useMemo, useState } from "react";
import { defaultListView } from "../components/ListViewControls";

function readStored(key, fallback) {
  if (!key) return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function useListViewState(rows, storageKey, initialPageSize = 30) {
  const [viewMode, setViewModeState] = useState(() =>
    readStored(`${storageKey}:view`, defaultListView())
  );
  const [pageSize, setPageSizeState] = useState(() => {
    const value = Number(readStored(`${storageKey}:rows`, initialPageSize));
    return [30, 60, 90, 120].includes(value) ? value : initialPageSize;
  });
  const [currentPage, setCurrentPage] = useState(1);

  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  const pageRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, currentPage, pageSize]);

  function setViewMode(value) {
    setViewModeState(value);
    try { window.localStorage.setItem(`${storageKey}:view`, value); } catch { /* optional */ }
  }

  function setPageSize(value) {
    const normalized = [30, 60, 90, 120].includes(Number(value)) ? Number(value) : 30;
    setPageSizeState(normalized);
    setCurrentPage(1);
    try { window.localStorage.setItem(`${storageKey}:rows`, String(normalized)); } catch { /* optional */ }
  }

  return {
    viewMode,
    setViewMode,
    pageSize,
    setPageSize,
    currentPage,
    setCurrentPage,
    totalPages,
    totalRows,
    pageRows
  };
}
