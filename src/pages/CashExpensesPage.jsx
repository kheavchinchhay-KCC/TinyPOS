import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleArrowDown,
  CircleArrowUp,
  Edit3,
  FolderCog,
  Landmark,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TrendingDown,
  WalletCards
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import CashEntryFormModal from "../components/CashEntryFormModal";
import CashCategoryModal from "../components/CashCategoryModal";
import VoidCashEntryModal from "../components/VoidCashEntryModal";
import ReportMetricCard from "../components/ReportMetricCard";
import ResponsiveDataList from "../components/ResponsiveDataList";
import DateRangePresetFields from "../components/DateRangePresetFields";
import { money } from "../lib/catalog";
import { formatReportDate } from "../lib/reports";
import {
  cashMethodLabel,
  defaultCashRange,
  loadCashExpenseWorkspace,
  saveCashCategory,
  saveCashEntry,
  voidCashEntry
} from "../lib/cashExpenses";

function number(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

export default function CashExpensesPage() {
  const { supabase, profile, shop, can, canAny } = useAuth();
  const canManage = canAny([
    "cash_expenses.manage",
    "cash_expenses.void"
  ]);
  const canAllBranches = can("branches.all");

  const [filters, setFilters] = useState(() => ({
    ...defaultCashRange(),
    branchId: profile?.branch_id || ""
  }));
  const [branches, setBranches] = useState([]);
  const [data, setData] = useState(null);
  const [search, setSearch] = useState("");
  const [directionFilter, setDirectionFilter] = useState("all");
  const [methodFilter, setMethodFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [entryModal, setEntryModal] = useState(null);
  const [categoryModal, setCategoryModal] = useState(false);
  const [voidEntry, setVoidEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  useEffect(() => {
    setFilters((current) => ({
      ...current,
      branchId: current.branchId || profile?.branch_id || ""
    }));
  }, [profile?.branch_id]);

  useEffect(() => {
    if (!supabase || !profile?.organization_id || !canAllBranches) {
      setBranches([]);
      return;
    }

    let active = true;
    (async () => {
      const { data: rows, error } = await supabase
        .from("branches")
        .select("id,name,code,is_active")
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name");

      if (active && !error) setBranches(rows || []);
    })();

    return () => { active = false; };
  }, [supabase, profile?.organization_id, canAllBranches]);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.branch_id) return;

    try {
      setLoading(true);
      setMessage("");
      const result = await loadCashExpenseWorkspace(supabase, {
        ...filters,
        branchId: filters.branchId || profile.branch_id
      });
      setData(result);
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.branch_id, filters]);

  useEffect(() => { refresh(); }, [refresh]);

  const currency = data?.base_currency || shop?.base_currency || "USD";
  const summary = data?.summary || {};

  const filteredEntries = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return (data?.entries || []).filter((entry) => {
      if (directionFilter !== "all" && entry.direction !== directionFilter) return false;
      if (methodFilter !== "all" && entry.method !== methodFilter) return false;
      if (categoryFilter !== "all" && entry.category_id !== categoryFilter) return false;

      if (!needle) return true;
      return [
        entry.entry_number,
        entry.category_name,
        entry.reference_number,
        entry.remark,
        entry.created_by_name,
        entry.branch_name,
        entry.method
      ].filter(Boolean).join(" ").toLowerCase().includes(needle);
    });
  }, [data?.entries, search, directionFilter, methodFilter, categoryFilter]);

  async function handleSaveEntry(values) {
    try {
      setBusy(true);
      const result = await saveCashEntry(supabase, values);
      setEntryModal(null);
      setMessageType("success");
      setMessage(`${result.entry_number} saved successfully.`);
      await refresh();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveCategory(values) {
    try {
      setBusy(true);
      await saveCashCategory(supabase, values);
      setMessageType("success");
      setMessage("Category saved successfully.");
      await refresh();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVoid(reason) {
    if (!voidEntry) return;
    try {
      setBusy(true);
      const result = await voidCashEntry(supabase, voidEntry.id, reason);
      setVoidEntry(null);
      setMessageType("success");
      setMessage(`${result.entry_number} was deleted from financial totals.`);
      await refresh();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <section className="panel empty-state">
        <WalletCards size={46} />
        <h2>Cash & Expenses access is restricted</h2>
        <p>Only an owner, admin, or manager can manage financial entries.</p>
      </section>
    );
  }

  return (
    <div className="page-stack cash-expenses-page">
      <div className="page-heading cash-heading">
        <div>
          <p className="eyebrow">CASH CONTROL</p>
          <h1>Cash & Expenses</h1>
          <p className="muted">Record cash in, operating expenses, transfers, and opening balances.</p>
        </div>
        <div className="heading-actions cash-heading-actions">
          <button type="button" className="secondary-button" onClick={() => setCategoryModal(true)}>
            <FolderCog size={18} /> Categories
          </button>
          <button type="button" className="secondary-button" onClick={() => setEntryModal({ direction: "income", entry: null })}>
            <CircleArrowUp size={18} /> Add cash in
          </button>
          <button type="button" className="primary-button" onClick={() => setEntryModal({ direction: "expense", entry: null })}>
            <Plus size={18} /> Add expense
          </button>
        </div>
      </div>

      {message && <div className={`notice ${messageType}`}>{message}</div>}

      <div className="report-metric-grid cash-metric-grid">
        <ReportMetricCard icon={Landmark} label="Current cash balance" value={money(summary.current_cash_balance, currency)} detail={`As of ${filters.to}`} tone={Number(summary.current_cash_balance || 0) < 0 ? "danger" : "success"} />
        <ReportMetricCard icon={WalletCards} label="Period cash flow" value={money(summary.period_cash_flow, currency)} detail={`Cash sales ${money(summary.cash_sales, currency)}`} tone={Number(summary.period_cash_flow || 0) < 0 ? "danger" : "success"} />
        <ReportMetricCard icon={CircleArrowUp} label="Other income" value={money(summary.other_income, currency)} detail={`${number(summary.income_count)} cash-in records`} />
        <ReportMetricCard icon={TrendingDown} label="Operating expenses" value={money(summary.operating_expenses, currency)} detail={`${number(summary.expense_count)} expense records`} tone="danger" />
        <ReportMetricCard icon={CircleArrowDown} label="Non-profit cash out" value={money(summary.non_profit_cash_out, currency)} detail="Transfers and owner withdrawals" />
        <ReportMetricCard icon={RefreshCw} label="Entries" value={number(summary.entry_count)} detail={`${money(summary.manual_income, currency)} in · ${money(summary.manual_expenses, currency)} out`} />
      </div>

      <section className="panel cash-filters">
        <div className="search-box">
          <Search size={18} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search code, category, user, reference or remark" />
        </div>
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
        {canAllBranches && (
          <label><span>Branch</span><select value={filters.allBranches ? "all" : filters.branchId} onChange={(event) => event.target.value === "all" ? setFilters((current) => ({ ...current, allBranches: true })) : setFilters((current) => ({ ...current, allBranches: false, branchId: event.target.value }))}><option value="all">All branches</option>{branches.map((branch) => <option value={branch.id} key={branch.id}>{branch.name}</option>)}</select></label>
        )}
        <label><span>Type</span><select value={directionFilter} onChange={(event) => setDirectionFilter(event.target.value)}><option value="all">All types</option><option value="income">Cash in</option><option value="expense">Expense</option></select></label>
        <label><span>Payment</span><select value={methodFilter} onChange={(event) => setMethodFilter(event.target.value)}><option value="all">All methods</option><option value="cash">Cash</option><option value="bank">Bank</option><option value="khqr">KHQR</option><option value="card">Card</option><option value="other">Other</option></select></label>
        <label><span>Category</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">All categories</option>{(data?.categories || []).map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}</select></label>
        <div className="cash-filter-actions">
          <button type="button" className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw size={18} className={loading ? "spin" : ""} /> Refresh</button>
        </div>
      </section>

      <ResponsiveDataList
        storageKey="cash-expense-list"
        title="Cash and expense list"
        subtitle={`${filters.from} to ${filters.to} · ${data?.scope?.branch_name || "Current branch"}`}
        rows={filteredEntries}
        filename={`tiny-pos-cash-expenses-${filters.from}-to-${filters.to}.xls`}
        summary={[
          { label: "Current cash balance", value: money(summary.current_cash_balance, currency) },
          { label: "Period cash flow", value: money(summary.period_cash_flow, currency) },
          { label: "Other income", value: money(summary.other_income, currency) },
          { label: "Operating expenses", value: money(summary.operating_expenses, currency) }
        ]}
        emptyTitle={loading && !data ? "Loading entries..." : "No entries found"}
        emptyText="Add an opening balance, cash in, or operating expense."
        columns={[
          { label: "Code / Date", width: 165, documentValue: (entry) => `${entry.entry_number} · ${formatReportDate(entry.entry_at, { time: true })}`, render: (entry) => <><strong>{entry.entry_number}</strong><small>{formatReportDate(entry.entry_at, { time: true })}</small></> },
          { label: "User / Branch", width: 170, documentValue: (entry) => `${entry.created_by_name || "—"} · ${entry.branch_name || "—"}`, render: (entry) => <><strong>{entry.created_by_name}</strong><small>{entry.branch_name}</small></> },
          { label: "Category", width: 150, documentValue: (entry) => entry.category_name, render: (entry) => <><strong>{entry.category_name}</strong><small>{entry.affects_profit ? "Profit & Loss" : "Cash only"}</small></> },
          { label: "Type", width: 90, documentValue: (entry) => entry.direction === "income" ? "Cash in" : "Expense", render: (entry) => <span className={`cash-direction-pill ${entry.direction}`}>{entry.direction === "income" ? "Cash in" : "Expense"}</span> },
          { label: "Payment", width: 95, documentValue: (entry) => cashMethodLabel(entry.method), render: (entry) => cashMethodLabel(entry.method) },
          { label: "Amount", width: 120, documentValue: (entry) => `${entry.direction === "income" ? "+" : "-"}${money(entry.amount, entry.currency)}`, render: (entry) => <><strong className={entry.direction === "income" ? "cash-positive" : "cash-negative"}>{entry.direction === "income" ? "+" : "-"}{money(entry.amount, entry.currency)}</strong>{entry.currency !== currency && <small>{money(entry.base_amount, currency)}</small>}</> },
          { label: "Reference / Remark", width: 250, documentValue: (entry) => `${entry.reference_number || ""} ${entry.remark || ""}`.trim(), render: (entry) => <><strong>{entry.reference_number || "—"}</strong><small>{entry.remark || "No remark"}</small></> },
          { label: "Actions", actionsOnly: true, excludeDocument: true, render: (entry) => <div className="cash-row-actions"><button type="button" className="icon-button" title="Edit" disabled={entry.branch_id !== profile.branch_id} onClick={() => setEntryModal({ direction: entry.direction, entry })}><Edit3 size={17} /></button><button type="button" className="icon-button danger-icon" title="Delete" disabled={entry.branch_id !== profile.branch_id} onClick={() => setVoidEntry(entry)}><Trash2 size={17} /></button></div> }
        ]}
        renderCard={(entry) => <article className="responsive-data-card cash-entry-card"><header><div><strong>{entry.entry_number}</strong><small>{formatReportDate(entry.entry_at, { time: true })}</small></div><span className={`cash-direction-pill ${entry.direction}`}>{entry.direction === "income" ? "Cash in" : "Expense"}</span></header><div><span>Category</span><strong>{entry.category_name}</strong><small>{entry.affects_profit ? "Profit & Loss" : "Cash only"}</small></div><div><span>User / Branch</span><strong>{entry.created_by_name}</strong><small>{entry.branch_name}</small></div><div><span>Payment</span><strong>{cashMethodLabel(entry.method)}</strong></div><div><span>Amount</span><strong className={entry.direction === "income" ? "cash-positive" : "cash-negative"}>{entry.direction === "income" ? "+" : "-"}{money(entry.amount, entry.currency)}</strong></div><div><span>Reference / Remark</span><strong>{entry.reference_number || "—"}</strong><small>{entry.remark || "No remark"}</small></div><footer><button type="button" className="secondary-button compact-button" disabled={entry.branch_id !== profile.branch_id} onClick={() => setEntryModal({ direction: entry.direction, entry })}><Edit3 size={17} />Edit</button><button type="button" className="danger-button compact-button" disabled={entry.branch_id !== profile.branch_id} onClick={() => setVoidEntry(entry)}><Trash2 size={17} />Delete</button></footer></article>}
      />

      {entryModal && <CashEntryFormModal entry={entryModal.entry} initialDirection={entryModal.direction} categories={data?.categories || []} baseCurrency={currency} busy={busy} onClose={() => setEntryModal(null)} onSave={handleSaveEntry} />}
      {categoryModal && <CashCategoryModal categories={data?.categories || []} busy={busy} onClose={() => setCategoryModal(false)} onSave={handleSaveCategory} />}
      <VoidCashEntryModal entry={voidEntry} busy={busy} onClose={() => setVoidEntry(null)} onConfirm={handleVoid} />
    </div>
  );
}
