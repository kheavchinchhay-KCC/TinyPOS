import {
  Banknote,
  CalendarDays,
  CircleDollarSign,
  Eye,
  LockKeyhole,
  RefreshCw,
  Scale,
  UnlockKeyhole,
  WalletCards
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import CashRegisterCloseModal from "../components/CashRegisterCloseModal";
import CashRegisterReportModal from "../components/CashRegisterReportModal";
import ResponsiveDataList from "../components/ResponsiveDataList";
import DateRangePresetFields from "../components/DateRangePresetFields";
import { money } from "../lib/catalog";
import {
  closeCashRegister,
  defaultRegisterDates,
  getCashRegisterSessionSummary,
  loadCashRegisterWorkspace,
  openCashRegister
} from "../lib/cashRegister";
import { notifyTelegramEvent } from "../lib/telegram";

function dateTime(value) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function value(summary, currency, field) {
  return Number(summary?.totals?.[currency]?.[field] || 0);
}

function DrawerBreakdown({ summary, currency }) {
  const rows = [
    ["Opening cash", "opening", "plus"],
    ["Cash sales", "cash_sales", "plus"],
    ["Cash refunds", "cash_refunds", "minus"],
    ["Other cash in", "cash_income", "plus"],
    ["Cash expenses", "cash_expenses", "minus"],
    ["Supplier payments", "supplier_payments", "minus"]
  ];

  return (
    <section className="register-drawer-panel panel">
      <div className="panel-title-row">
        <div>
          <p className="eyebrow">{currency} DRAWER</p>
          <h2>{money(value(summary, currency, "expected"), currency)}</h2>
          <span className="muted">Expected cash now</span>
        </div>
        <Banknote size={24} />
      </div>

      <div className="register-breakdown">
        {rows.map(([label, field, type]) => (
          <div key={field}>
            <span>{label}</span>
            <strong className={type}>
              {type === "minus" ? "−" : "+"}
              {money(Math.abs(value(summary, currency, field)), currency)}
            </strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function CashRegisterPage() {
  const { supabase, session, profile, shop, canAny, can } = useAuth();
  const canOverride = can("cash_register.override");
  const canOperate = canAny([
    "cash_register.use",
    "cash_register.close"
  ]);

  const [filters, setFilters] = useState(defaultRegisterDates);
  const [openSummary, setOpenSummary] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [opening, setOpening] = useState({
    register_name: "Main Register",
    opening_cash_usd: "0",
    opening_cash_khr: "0",
    opening_note: ""
  });
  const [closeOpen, setCloseOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !profile?.branch_id) {
      return;
    }

    try {
      setLoading(true);
      const workspace = await loadCashRegisterWorkspace(
        supabase,
        profile,
        filters
      );

      setOpenSummary(workspace.openSummary);
      setSessions(workspace.sessions);
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeSession = openSummary?.session || null;

  const historyTotals = useMemo(() => {
    const closed = sessions.filter(
      (session) => session.status === "closed"
    );

    return {
      sessions: closed.length,
      varianceUsd: closed.reduce(
        (sum, session) =>
          sum + Number(session.variance_usd || 0),
        0
      ),
      varianceKhr: closed.reduce(
        (sum, session) =>
          sum + Number(session.variance_khr || 0),
        0
      )
    };
  }, [sessions]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function handleOpen(event) {
    event.preventDefault();

    if (!opening.register_name.trim()) {
      announce("error", "Register name is required.");
      return;
    }

    try {
      setBusy("open");
      const result = await openCashRegister(
        supabase,
        opening
      );

      setOpenSummary(result);
      void notifyTelegramEvent(session, "cash_register_opened", result.session.id);
      setOpening({
        register_name: "Main Register",
        opening_cash_usd: "0",
        opening_cash_khr: "0",
        opening_note: ""
      });
      announce(
        "success",
        `${result.session.session_number} opened. Cash payments are now available.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleClose(values) {
    try {
      setBusy("close");
      const result = await closeCashRegister(
        supabase,
        values
      );

      setCloseOpen(false);
      void notifyTelegramEvent(session, "cash_register_closed", result.session.id);
      setReport(result);
      setOpenSummary(null);
      announce(
        "success",
        `${result.session.session_number} closed successfully.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function viewSession(sessionId) {
    try {
      setBusy(`view-${sessionId}`);
      const result = await getCashRegisterSessionSummary(
        supabase,
        sessionId
      );
      setReport(result);
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function openOverrideClose(sessionId) {
    if (!canOverride) {
      announce("error", "Cash-register override permission is required.");
      return;
    }

    try {
      setBusy(`prepare-close-${sessionId}`);
      const result = await getCashRegisterSessionSummary(
        supabase,
        sessionId
      );
      if (!result?.session || result.session.status !== "open") {
        announce("error", "That register session is no longer open.");
        await refresh();
        return;
      }
      setOpenSummary(result);
      setCloseOpen(true);
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  if (!canOperate) {
    return (
      <section className="panel empty-state">
        <WalletCards size={46} />
        <h2>Cash register access is restricted</h2>
        <p>
          Only an owner, admin, manager or cashier can operate a
          register.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack cash-register-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CASH CONTROL</p>
          <h1>Cash Register</h1>
          <p className="muted">
            Open the drawer, track expected cash and close the shift
            with a counted balance.
          </p>
        </div>

        <button
          type="button"
          className="secondary-button"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw
            size={18}
            className={loading ? "spin" : ""}
          />
          Refresh
        </button>
      </div>

      {message && (
        <div className={`notice ${messageType}`}>
          {message}
        </div>
      )}

      {activeSession ? (
        <>
          <section className="panel open-register-banner">
            <div className="open-register-icon">
              <UnlockKeyhole size={26} />
            </div>
            <div>
              <p className="eyebrow">REGISTER OPEN</p>
              <h2>{activeSession.session_number}</h2>
              <span>
                {activeSession.register_name}
                {" · Opened "}
                {dateTime(activeSession.opened_at)}
              </span>
            </div>

            <div className="open-register-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setReport(openSummary)}
              >
                <Eye size={18} />
                View report
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => setCloseOpen(true)}
              >
                <LockKeyhole size={18} />
                Close register
              </button>
            </div>
          </section>

          <div className="register-metrics">
            <article>
              <CircleDollarSign size={22} />
              <span>Cash sales</span>
              <strong>
                {money(value(openSummary, "USD", "cash_sales"), "USD")}
              </strong>
              <small>
                {money(value(openSummary, "KHR", "cash_sales"), "KHR")}
              </small>
            </article>
            <article>
              <Scale size={22} />
              <span>Cash refunds</span>
              <strong>
                {money(value(openSummary, "USD", "cash_refunds"), "USD")}
              </strong>
              <small>
                {money(value(openSummary, "KHR", "cash_refunds"), "KHR")}
              </small>
            </article>
            <article>
              <WalletCards size={22} />
              <span>Cash expenses</span>
              <strong>
                {money(value(openSummary, "USD", "cash_expenses"), "USD")}
              </strong>
              <small>
                {money(value(openSummary, "KHR", "cash_expenses"), "KHR")}
              </small>
            </article>
            <article>
              <Banknote size={22} />
              <span>Expected drawers</span>
              <strong>
                {money(value(openSummary, "USD", "expected"), "USD")}
              </strong>
              <small>
                {money(value(openSummary, "KHR", "expected"), "KHR")}
              </small>
            </article>
          </div>

          <div className="register-drawer-grid">
            <DrawerBreakdown
              summary={openSummary}
              currency="USD"
            />
            <DrawerBreakdown
              summary={openSummary}
              currency="KHR"
            />
          </div>
        </>
      ) : (
        <section className="panel register-open-panel">
          <div className="register-open-heading">
            <div className="open-register-icon closed">
              <LockKeyhole size={26} />
            </div>
            <div>
              <p className="eyebrow">REGISTER CLOSED</p>
              <h2>Open a cash register</h2>
              <p className="muted">
                Cash payments are disabled until a register is open.
                Bank, KHQR, card and other payment methods still work.
              </p>
            </div>
          </div>

          <form className="register-open-form" onSubmit={handleOpen}>
            <label>
              <span>Register name</span>
              <input
                value={opening.register_name}
                onChange={(event) =>
                  setOpening((current) => ({
                    ...current,
                    register_name: event.target.value
                  }))
                }
                placeholder="Main Register"
              />
            </label>

            <label>
              <span>Opening USD cash</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={opening.opening_cash_usd}
                onChange={(event) =>
                  setOpening((current) => ({
                    ...current,
                    opening_cash_usd: event.target.value
                  }))
                }
              />
            </label>

            <label>
              <span>Opening KHR cash</span>
              <input
                type="number"
                min="0"
                step="1"
                value={opening.opening_cash_khr}
                onChange={(event) =>
                  setOpening((current) => ({
                    ...current,
                    opening_cash_khr: event.target.value
                  }))
                }
              />
            </label>

            <label className="register-opening-note">
              <span>Opening note</span>
              <textarea
                rows="3"
                value={opening.opening_note}
                onChange={(event) =>
                  setOpening((current) => ({
                    ...current,
                    opening_note: event.target.value
                  }))
                }
                placeholder="Optional handover or drawer note"
              />
            </label>

            <button
              type="submit"
              className="primary-button"
              disabled={busy === "open"}
            >
              <UnlockKeyhole size={18} />
              {busy === "open"
                ? "Opening register..."
                : "Open register"}
            </button>
          </form>
        </section>
      )}

      <section className="panel register-history-filters-panel">
        <div className="register-history-summary">
          <div><span>Closed sessions</span><strong>{historyTotals.sessions}</strong></div>
          <div><span>Total USD variance</span><strong>{money(historyTotals.varianceUsd, "USD")}</strong></div>
          <div><span>Total KHR variance</span><strong>{money(historyTotals.varianceKhr, "KHR")}</strong></div>
        </div>
        <div className="register-history-filters">
          <DateRangePresetFields
            from={filters.from}
            to={filters.to}
            onChange={(range) =>
              setFilters((current) => ({
                ...current,
                from: range.from,
                to: range.to
              }))
            }
          />
        </div>
      </section>

      <ResponsiveDataList
        storageKey="cash-register-sessions"
        title="Cash register sessions"
        subtitle={`${filters.from} to ${filters.to} · ${profile?.branches?.name || "Current branch"}`}
        rows={sessions}
        filename={`tiny-pos-cash-register-${filters.from}-to-${filters.to}.xls`}
        summary={[
          { label: "Closed sessions", value: historyTotals.sessions },
          { label: "Total USD variance", value: money(historyTotals.varianceUsd, "USD") },
          { label: "Total KHR variance", value: money(historyTotals.varianceKhr, "KHR") }
        ]}
        emptyTitle={loading ? "Loading register history..." : "No register sessions"}
        emptyText="Open the first cash register to begin shift tracking."
        columns={[
          { label: "Session", width: 170, documentValue: (row) => row.session_number, render: (row) => <><strong>{row.session_number}</strong><small>{row.register_name}</small></> },
          { label: "Opened", width: 150, documentValue: (row) => dateTime(row.opened_at), render: (row) => dateTime(row.opened_at) },
          { label: "Closed", width: 150, documentValue: (row) => dateTime(row.closed_at), render: (row) => dateTime(row.closed_at) },
          { label: "Opened by", width: 150, value: (row) => row.opened_by_profile?.full_name || "POS Staff" },
          { label: "Status", width: 90, documentValue: (row) => row.status, render: (row) => <span className={`status-pill ${row.status === "open" ? "active" : "inactive"}`}>{row.status}</span> },
          { label: "Expected USD", width: 110, documentValue: (row) => money(row.expected_cash_usd || 0, "USD"), render: (row) => money(row.expected_cash_usd || 0, "USD") },
          { label: "Expected KHR", width: 120, documentValue: (row) => money(row.expected_cash_khr || 0, "KHR"), render: (row) => money(row.expected_cash_khr || 0, "KHR") },
          { label: "Variance USD", width: 110, documentValue: (row) => row.status === "closed" ? money(row.variance_usd || 0, "USD") : "—", render: (row) => <strong className={Number(row.variance_usd || 0) === 0 ? "variance-balanced" : Number(row.variance_usd || 0) > 0 ? "variance-over" : "variance-short"}>{row.status === "closed" ? money(row.variance_usd || 0, "USD") : "—"}</strong> },
          { label: "Variance KHR", width: 120, documentValue: (row) => row.status === "closed" ? money(row.variance_khr || 0, "KHR") : "—", render: (row) => <strong className={Number(row.variance_khr || 0) === 0 ? "variance-balanced" : Number(row.variance_khr || 0) > 0 ? "variance-over" : "variance-short"}>{row.status === "closed" ? money(row.variance_khr || 0, "KHR") : "—"}</strong> },
          { label: "Report", actionsOnly: true, excludeDocument: true, render: (row) => (
            <div className="register-session-row-actions">
              <button type="button" className="icon-button" onClick={() => viewSession(row.id)} disabled={busy === `view-${row.id}`} title="View report"><Eye size={18} /></button>
              {canOverride && row.status === "open" && (
                <button type="button" className="icon-button danger-text" onClick={() => openOverrideClose(row.id)} disabled={busy === `prepare-close-${row.id}`} title="Override close register"><LockKeyhole size={18} /></button>
              )}
            </div>
          ) }
        ]}
        renderCard={(row) => <article className="responsive-data-card register-session-card"><header><div><strong>{row.session_number}</strong><small>{row.register_name}</small></div><span className={`status-pill ${row.status === "open" ? "active" : "inactive"}`}>{row.status}</span></header><div><span>Opened</span><strong>{dateTime(row.opened_at)}</strong></div><div><span>Closed</span><strong>{dateTime(row.closed_at)}</strong></div><div><span>Opened by</span><strong>{row.opened_by_profile?.full_name || "POS Staff"}</strong></div><div><span>Expected</span><strong>{money(row.expected_cash_usd || 0, "USD")}</strong><small>{money(row.expected_cash_khr || 0, "KHR")}</small></div><div><span>Variance</span><strong>{row.status === "closed" ? money(row.variance_usd || 0, "USD") : "—"}</strong><small>{row.status === "closed" ? money(row.variance_khr || 0, "KHR") : "—"}</small></div><footer><button type="button" className="secondary-button compact-button" onClick={() => viewSession(row.id)} disabled={busy === `view-${row.id}`}><Eye size={18} />View report</button>{canOverride && row.status === "open" && <button type="button" className="danger-button compact-button" onClick={() => openOverrideClose(row.id)} disabled={busy === `prepare-close-${row.id}`}><LockKeyhole size={17} />Override close</button>}</footer></article>}
      />

      <CashRegisterCloseModal
        summary={closeOpen ? openSummary : null}
        busy={busy === "close"}
        onClose={() => setCloseOpen(false)}
        onSubmit={handleClose}
      />

      <CashRegisterReportModal
        report={report}
        shop={shop}
        onClose={() => setReport(null)}
      />
    </div>
  );
}
