import {
  AlertTriangle,
  BadgeDollarSign,
  Eye,
  HandCoins,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldAlert,
  UsersRound
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { useAuth } from "../context/AuthContext";
import CreditAccountModal from "../components/CreditAccountModal";
import CreditPaymentModal from "../components/CreditPaymentModal";
import CreditStatementModal from "../components/CreditStatementModal";
import ListViewControls, { defaultListView } from "../components/ListViewControls";
import { exportListExcel, printListDocument } from "../lib/listDocuments";
import { getOpenCashRegisterSummary } from "../lib/cashRegister";
import { money } from "../lib/catalog";
import {
  creditAccountStatusClass,
  creditAccountStatusLabel,
  creditDate,
  creditDateTime,
  loadCreditStatement,
  loadCreditWorkspace,
  receiveCreditPayment,
  saveCreditAccount
} from "../lib/creditAccounts";

export default function CreditAccountsPage() {
  const { supabase, profile, can, canAny } = useAuth();

  const canAccess = canAny([
    "credit_accounts.manage",
    "credit_accounts.collect"
  ]);

  const canManage = can(
    "credit_accounts.manage"
  );

  const [accounts, setAccounts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [canReceivePayment, setCanReceivePayment] =
    useState(false);
  const [cashRegisterOpen, setCashRegisterOpen] =
    useState(false);

  const [search, setSearch] = useState("");
  const [currencyFilter, setCurrencyFilter] =
    useState("");
  const [statusFilter, setStatusFilter] =
    useState("");

  const [accountModalOpen, setAccountModalOpen] =
    useState(false);
  const [editingAccount, setEditingAccount] =
    useState(null);
  const [paymentAccount, setPaymentAccount] =
    useState(null);
  const [statementAccount, setStatementAccount] =
    useState(null);
  const [statement, setStatement] = useState(null);
  const [statementLoading, setStatementLoading] =
    useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] =
    useState("success");
  const [viewMode, setViewMode] = useState(defaultListView);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !canAccess) {
      return;
    }

    try {
      setLoading(true);

      const [workspace, register] = await Promise.all([
        loadCreditWorkspace(supabase),
        getOpenCashRegisterSummary(supabase)
      ]);

      setAccounts(workspace.accounts);
      setCustomers(workspace.customers);
      setMetrics(workspace.metrics);
      setCanReceivePayment(
        workspace.canReceivePayment
      );
      setCashRegisterOpen(Boolean(register?.session));
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, canAccess]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visibleAccounts = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return accounts.filter((account) => {
      if (
        currencyFilter
        && account.currency !== currencyFilter
      ) {
        return false;
      }

      if (
        statusFilter
        && account.account_status !== statusFilter
      ) {
        return false;
      }

      if (!needle) return true;

      return [
        account.customer?.customer_code,
        account.customer?.name,
        account.customer?.company_name,
        account.customer?.phone,
        account.customer?.email,
        account.currency,
        account.notes
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [
    accounts,
    search,
    currencyFilter,
    statusFilter
  ]);

  useEffect(() => { setPage(1); }, [search, currencyFilter, statusFilter, pageSize]);
  const totalPages = Math.max(1, Math.ceil(visibleAccounts.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedAccounts = visibleAccounts.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const creditReportColumns = [
    { label: "Customer", value: (row) => row.customer?.name || "—" },
    { label: "Code", value: (row) => row.customer?.customer_code || "—" },
    { label: "Phone", value: (row) => row.customer?.phone || "—" },
    { label: "Status", value: (row) => creditAccountStatusLabel(row.account_status) },
    { label: "Currency", value: (row) => row.currency },
    { label: "Balance due", value: (row) => money(row.balance_due, row.currency) },
    { label: "Overdue", value: (row) => money(row.overdue_amount, row.currency) },
    { label: "Credit limit", value: (row) => row.allow_unlimited_credit ? "Unlimited" : money(row.credit_limit, row.currency) },
    { label: "Available", value: (row) => row.allow_unlimited_credit ? "Unlimited" : money(row.available_credit, row.currency) },
    { label: "Open invoices", value: (row) => Number(row.open_invoice_count || 0) },
    { label: "Oldest due", value: (row) => creditDate(row.oldest_due_date) },
    { label: "Last activity", value: (row) => creditDateTime(row.last_activity_at || row.updated_at) }
  ];

  function printCreditAccounts() {
    printListDocument({
      title: "Customer Credit Accounts",
      subtitle: `${visibleAccounts.length} account(s)`,
      summary: [
        { label: "Currency", value: currencyFilter || "All currencies" },
        { label: "Status", value: statusFilter || "All statuses" },
        { label: "Search", value: search || "All customers" }
      ],
      columns: creditReportColumns,
      rows: visibleAccounts
    });
  }

  function exportCreditAccounts() {
    exportListExcel({
      filename: `credit-accounts-${new Date().toISOString().slice(0, 10)}.xls`,
      title: "Customer Credit Accounts",
      subtitle: `${visibleAccounts.length} account(s)`,
      summary: [{ label: "Currency", value: currencyFilter || "All currencies" }],
      columns: creditReportColumns,
      rows: visibleAccounts
    });
  }

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function openNewAccount() {
    setEditingAccount(null);
    setAccountModalOpen(true);
  }

  function openAccountSettings(account) {
    setEditingAccount(account);
    setAccountModalOpen(true);
  }

  async function handleAccountSave(values) {
    try {
      setBusy("account");

      await saveCreditAccount(
        supabase,
        values
      );

      setAccountModalOpen(false);
      setEditingAccount(null);
      announce(
        "success",
        "Customer credit account saved."
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handlePayment(values) {
    try {
      setBusy("payment");

      const result = await receiveCreditPayment(
        supabase,
        values
      );

      setPaymentAccount(null);
      announce(
        "success",
        `${result.payment_number} received for ${money(
          result.amount,
          result.currency
        )}. Remaining balance: ${money(
          result.balance_after,
          result.currency
        )}.`
      );
      await refresh();

      if (statementAccount) {
        await openStatement(statementAccount);
      }
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function openStatement(account) {
    try {
      setStatementAccount(account);
      setStatement(null);
      setStatementLoading(true);

      const result = await loadCreditStatement(
        supabase,
        account.id
      );

      setStatement(result);
    } catch (error) {
      announce("error", error.message);
      setStatementAccount(null);
    } finally {
      setStatementLoading(false);
    }
  }

  if (!canAccess) {
    return (
      <section className="panel empty-state">
        <BadgeDollarSign size={46} />
        <h2>Credit account access is restricted</h2>
        <p>
          This module is available to active sales and
          management staff.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack credit-accounts-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            ACCOUNTS RECEIVABLE
          </p>
          <h1>Credit Accounts</h1>
          <p className="muted">
            Manage customer limits, overdue invoices,
            statements and collections.
          </p>
        </div>

        <div className="page-heading-actions">
          {canManage && (
            <button
              type="button"
              className="primary-button"
              onClick={openNewAccount}
            >
              <Plus size={18} />
              Add credit account
            </button>
          )}

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
      </div>

      {message && (
        <div
          className={`notice ${messageType}`}
          onClick={() => setMessage("")}
        >
          {message}
        </div>
      )}

      <div className="credit-account-metrics">
        <article>
          <BadgeDollarSign size={22} />
          <span>Total receivables</span>
          <strong>
            {money(
              metrics.receivable_usd || 0,
              "USD"
            )}
          </strong>
          <small>
            {money(
              metrics.receivable_khr || 0,
              "KHR"
            )}
          </small>
        </article>

        <article>
          <AlertTriangle size={22} />
          <span>Overdue balance</span>
          <strong>
            {money(
              metrics.overdue_usd || 0,
              "USD"
            )}
          </strong>
          <small>
            {money(
              metrics.overdue_khr || 0,
              "KHR"
            )}
            {" · "}
            {Number(metrics.overdue_accounts || 0)}
            {" overdue account(s)"}
          </small>
        </article>

        <article>
          <UsersRound size={22} />
          <span>Customers owing</span>
          <strong>
            {Number(
              metrics.customers_with_balance || 0
            ).toLocaleString("en-US")}
          </strong>
          <small>
            {Number(
              metrics.account_count || 0
            ).toLocaleString("en-US")}
            {" total account(s)"}
          </small>
        </article>

        <article>
          <ShieldAlert size={22} />
          <span>Accounts on hold</span>
          <strong>
            {Number(
              metrics.accounts_on_hold || 0
            ).toLocaleString("en-US")}
          </strong>
          <small>
            New credit invoices are blocked.
          </small>
        </article>
      </div>

      <section className="panel credit-account-filters">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            placeholder="Search customer, code, phone, email or company"
          />
        </div>

        <label>
          <span>Currency</span>
          <select
            value={currencyFilter}
            onChange={(event) =>
              setCurrencyFilter(event.target.value)
            }
          >
            <option value="">All currencies</option>
            <option value="USD">USD</option>
            <option value="KHR">KHR</option>
          </select>
        </label>

        <label>
          <span>Status</span>
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value)
            }
          >
            <option value="">All statuses</option>
            <option value="overdue">Overdue</option>
            <option value="open">Balance open</option>
            <option value="limit_reached">
              Limit reached
            </option>
            <option value="hold">On hold</option>
            <option value="clear">Clear</option>
          </select>
        </label>
      </section>

      <ListViewControls
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        totalRows={visibleAccounts.length}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setPage}
        onExport={exportCreditAccounts}
        onPrint={printCreditAccounts}
      />

      <section className="panel credit-account-table-panel">
        {loading ? (
          <div className="empty-state">
            <RefreshCw className="spin" size={34} />
            <p>Loading customer credit accounts...</p>
          </div>
        ) : visibleAccounts.length === 0 ? (
          <div className="empty-state">
            <BadgeDollarSign size={46} />
            <h2>No matching credit accounts</h2>
            <p>
              Add an account or change the filters.
            </p>
          </div>
        ) : (
          viewMode === "cards" ? (
            <div className="list-card-grid credit-card-grid">
              {pagedAccounts.map((account) => (
                <article className="list-record-card" key={account.id}>
                  <header><div><strong>{account.customer?.name}</strong><small>{[account.customer?.customer_code, account.customer?.company_name, account.customer?.phone].filter(Boolean).join(" · ")}</small></div><span className={`credit-account-status ${creditAccountStatusClass(account.account_status)}`}>{creditAccountStatusLabel(account.account_status)}</span></header>
                  <div className="list-card-fields">
                    <div><span>Balance due</span><strong>{money(account.balance_due, account.currency)}</strong>{Number(account.overdue_amount || 0) > 0 && <small>{money(account.overdue_amount, account.currency)} overdue</small>}</div>
                    <div><span>Credit limit</span><strong>{account.allow_unlimited_credit ? "Unlimited" : money(account.credit_limit, account.currency)}</strong></div>
                    <div><span>Available</span><strong>{account.allow_unlimited_credit ? "Unlimited" : money(account.available_credit, account.currency)}</strong></div>
                    <div><span>Invoices</span><strong>{Number(account.open_invoice_count || 0)}</strong><small>{Number(account.overdue_invoice_count || 0)} overdue</small></div>
                    <div><span>Oldest due</span><strong>{creditDate(account.oldest_due_date)}</strong></div>
                    <div><span>Last activity</span><strong>{creditDateTime(account.last_activity_at || account.updated_at)}</strong></div>
                  </div>
                  <div className="list-card-actions credit-account-actions">
                    <button type="button" className="icon-button" onClick={() => openStatement(account)} title="View statement"><Eye size={18} /></button>
                    {canReceivePayment && Number(account.balance_due || 0) > 0 && <button type="button" className="icon-button" onClick={() => setPaymentAccount(account)} title="Receive payment"><HandCoins size={18} /></button>}
                    {canManage && <button type="button" className="icon-button" onClick={() => openAccountSettings(account)} title="Credit settings"><Settings2 size={18} /></button>}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="credit-account-table-wrap wide-list-scroll">
              <table className="credit-account-table">
                <thead><tr><th>Customer</th><th>Status</th><th>Currency</th><th>Balance due</th><th>Credit limit</th><th>Available</th><th>Invoices</th><th>Oldest due</th><th>Last activity</th><th /></tr></thead>
                <tbody>{pagedAccounts.map((account) => (
                  <tr key={account.id}>
                    <td data-label="Customer"><strong>{account.customer?.name}</strong><small>{[account.customer?.customer_code, account.customer?.company_name, account.customer?.phone].filter(Boolean).join(" · ")}</small></td>
                    <td data-label="Status"><span className={`credit-account-status ${creditAccountStatusClass(account.account_status)}`}>{creditAccountStatusLabel(account.account_status)}</span></td>
                    <td data-label="Currency"><strong>{account.currency}</strong></td>
                    <td data-label="Balance due"><strong>{money(account.balance_due, account.currency)}</strong>{Number(account.overdue_amount || 0) > 0 && <small className="credit-overdue-text">{money(account.overdue_amount, account.currency)} overdue</small>}</td>
                    <td data-label="Credit limit">{account.allow_unlimited_credit ? "Unlimited" : money(account.credit_limit, account.currency)}</td>
                    <td data-label="Available"><strong>{account.allow_unlimited_credit ? "Unlimited" : money(account.available_credit, account.currency)}</strong></td>
                    <td data-label="Invoices"><strong>{Number(account.open_invoice_count || 0)}</strong><small>{Number(account.overdue_invoice_count || 0)} overdue</small></td>
                    <td data-label="Oldest due">{creditDate(account.oldest_due_date)}</td>
                    <td data-label="Last activity">{creditDateTime(account.last_activity_at || account.updated_at)}</td>
                    <td data-label="Actions"><div className="credit-account-actions"><button type="button" className="icon-button" onClick={() => openStatement(account)} title="View statement"><Eye size={18} /></button>{canReceivePayment && Number(account.balance_due || 0) > 0 && <button type="button" className="icon-button" onClick={() => setPaymentAccount(account)} title="Receive payment"><HandCoins size={18} /></button>}{canManage && <button type="button" className="icon-button" onClick={() => openAccountSettings(account)} title="Credit settings"><Settings2 size={18} /></button>}</div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )
        )}
      </section>

      <CreditAccountModal
        open={accountModalOpen}
        account={editingAccount}
        customers={customers}
        busy={busy === "account"}
        onClose={() => {
          setAccountModalOpen(false);
          setEditingAccount(null);
        }}
        onSubmit={handleAccountSave}
      />

      <CreditPaymentModal
        account={paymentAccount}
        cashRegisterOpen={cashRegisterOpen}
        busy={busy === "payment"}
        onClose={() => setPaymentAccount(null)}
        onSubmit={handlePayment}
      />

      <CreditStatementModal
        statement={statement}
        loading={statementLoading}
        canReceivePayment={canReceivePayment}
        onReceivePayment={(account) => {
          setStatementAccount(null);
          setStatement(null);
          setPaymentAccount({
            ...account,
            customer: account.customer
          });
        }}
        onClose={() => {
          setStatementAccount(null);
          setStatement(null);
        }}
      />
    </div>
  );
}
