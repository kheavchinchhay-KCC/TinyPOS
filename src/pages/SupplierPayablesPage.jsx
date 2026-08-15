import {
  CalendarClock,
  Eye,
  HandCoins,
  Landmark,
  RefreshCw,
  Search,
  Settings2
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import SupplierPaymentModal from "../components/SupplierPaymentModal";
import SupplierStatementModal from "../components/SupplierStatementModal";
import SupplierTermsModal from "../components/SupplierTermsModal";
import ResponsiveDataList from "../components/ResponsiveDataList";
import DateRangePresetFields from "../components/DateRangePresetFields";
import { money } from "../lib/catalog";
import {
  agingClass,
  agingLabel,
  loadSupplierPayables,
  loadSupplierStatement,
  payableDate,
  payableDateTime,
  payableMethodLabel,
  recordSupplierPayment,
  saveSupplierTerms
} from "../lib/payables";

function todayString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function statementStartString() {
  const date = new Date();
  date.setDate(date.getDate() - 89);
  return date.toISOString().slice(0, 10);
}

export default function SupplierPayablesPage() {
  const {
    supabase,
    profile,
    shop,
    can
  } = useAuth();

  const canManage = can(
    "supplier_payables.view"
  ) || can("supplier_payables.pay");

  const canAllBranches = can(
    "branches.all"
  );

  const [allBranches, setAllBranches] =
    useState(false);
  const [asOf, setAsOf] =
    useState(todayString());

  const [workspace, setWorkspace] =
    useState({
      meta: {},
      summary: {
        usd: {},
        khr: {}
      },
      suppliers: [],
      invoices: [],
      recent_payments: []
    });

  const [search, setSearch] =
    useState("");
  const [currency, setCurrency] =
    useState("");
  const [aging, setAging] =
    useState("");

  const [paymentSupplier, setPaymentSupplier] =
    useState(null);
  const [termsSupplier, setTermsSupplier] =
    useState(null);

  const [statement, setStatement] =
    useState(null);
  const [statementLoading, setStatementLoading] =
    useState(false);
  const [statementFrom, setStatementFrom] =
    useState(todayString());
  const [statementTo, setStatementTo] =
    useState(todayString());

  const [loading, setLoading] =
    useState(true);
  const [busy, setBusy] =
    useState("");
  const [message, setMessage] =
    useState("");
  const [messageType, setMessageType] =
    useState("success");

  const refresh = useCallback(async () => {
    if (
      !supabase
      || !profile?.organization_id
      || !profile?.branch_id
      || !canManage
    ) {
      return;
    }

    try {
      setLoading(true);
      setMessage("");

      const result =
        await loadSupplierPayables(
          supabase,
          allBranches,
          asOf
        );

      setWorkspace(result);
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [
    supabase,
    profile,
    allBranches,
    asOf,
    canManage
  ]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!canAllBranches && allBranches) {
      setAllBranches(false);
    }
  }, [canAllBranches, allBranches]);

  const visibleSuppliers = useMemo(() => {
    const needle = search
      .trim()
      .toLowerCase();

    return workspace.suppliers.filter(
      (supplier) => {
        if (
          currency === "USD"
          && Number(
            supplier.usd_balance || 0
          ) <= 0
        ) {
          return false;
        }

        if (
          currency === "KHR"
          && Number(
            supplier.khr_balance || 0
          ) <= 0
        ) {
          return false;
        }

        if (
          aging === "overdue"
          && Number(
            supplier.overdue_invoice_count
            || 0
          ) <= 0
        ) {
          return false;
        }

        if (
          aging === "current"
          && (
            Number(
              supplier.usd_current || 0
            ) <= 0
            && Number(
              supplier.khr_current || 0
            ) <= 0
          )
        ) {
          return false;
        }

        if (!needle) return true;

        return [
          supplier.name,
          supplier.supplier_code,
          supplier.contact_name,
          supplier.phone,
          supplier.email,
          supplier.tax_id
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle);
      }
    );
  }, [
    workspace.suppliers,
    search,
    currency,
    aging
  ]);

  const visibleInvoices = useMemo(() => {
    const supplierIds = new Set(
      visibleSuppliers.map(
        (supplier) =>
          supplier.supplier_id
      )
    );

    return workspace.invoices.filter(
      (invoice) => {
        if (
          !supplierIds.has(
            invoice.supplier_id
          )
        ) {
          return false;
        }

        if (
          currency
          && invoice.currency !== currency
        ) {
          return false;
        }

        if (
          aging === "overdue"
          && Number(
            invoice.days_overdue || 0
          ) <= 0
        ) {
          return false;
        }

        if (
          aging === "current"
          && invoice.aging_bucket
            !== "current"
        ) {
          return false;
        }

        return true;
      }
    );
  }, [
    workspace.invoices,
    visibleSuppliers,
    currency,
    aging
  ]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function currentBranchBalance(
    supplier,
    selectedCurrency
  ) {
    return workspace.invoices
      .filter(
        (invoice) =>
          invoice.supplier_id
            === supplier.supplier_id
          && invoice.branch_id
            === profile.branch_id
          && (
            !selectedCurrency
            || invoice.currency
              === selectedCurrency
          )
      )
      .reduce(
        (sum, invoice) =>
          sum
          + Number(
            invoice.balance_due || 0
          ),
        0
      );
  }

  async function handlePayment(values) {
    try {
      setBusy("payment");

      const result =
        await recordSupplierPayment(
          supabase,
          values
        );

      setPaymentSupplier(null);

      announce(
        "success",
        `${result.payment_number} recorded for ${money(
          result.amount,
          result.currency
        )} and allocated to ${result.allocation_count} purchase${
          result.allocation_count === 1
            ? ""
            : "s"
        }.`
      );

      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleTerms(values) {
    try {
      setBusy("terms");

      const result =
        await saveSupplierTerms(
          supabase,
          values
        );

      setTermsSupplier(null);

      announce(
        "success",
        `Supplier terms saved. ${result.updated_open_purchases} open purchase${
          result.updated_open_purchases === 1
            ? ""
            : "s"
        } recalculated.`
      );

      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function openStatement(supplier) {
    if (statementTo < statementFrom) {
      announce(
        "error",
        "Statement end date must be on or after the start date."
      );
      return;
    }

    try {
      setStatementLoading(true);
      setStatement({
        supplier: {
          name: supplier.name
        }
      });

      const result =
        await loadSupplierStatement(
          supabase,
          {
            supplier_id:
              supplier.supplier_id,
            from: statementFrom,
            to: statementTo,
            all_branches:
              allBranches
          }
        );

      setStatement(result);
    } catch (error) {
      setStatement(null);
      announce("error", error.message);
    } finally {
      setStatementLoading(false);
    }
  }

  if (!canManage) {
    return (
      <section className="panel empty-state">
        <Landmark size={46} />
        <h2>
          Management access required
        </h2>
        <p>
          Only an owner, admin or manager can
          use Supplier Payables.
        </p>
      </section>
    );
  }

  const summary = workspace.summary || {};
  const usd = summary.usd || {};
  const khr = summary.khr || {};

  return (
    <div className="page-stack supplier-payables-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            ACCOUNTS PAYABLE
          </p>
          <h1>Supplier Payables</h1>
          <p className="muted">
            Track due purchases, supplier credits,
            aging, payments and printable
            statements.
          </p>
        </div>

        <div className="page-heading-actions">
          <Link
            to="/purchase-orders"
            className="secondary-button"
          >
            <Landmark size={18} />
            Purchase orders
          </Link>

          <button
            type="button"
            className="secondary-button"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw
              size={18}
              className={
                loading ? "spin" : ""
              }
            />
            Refresh
          </button>
        </div>
      </div>

      {message && (
        <div
          className={`notice ${messageType}`}
          onClick={() =>
            setMessage("")
          }
        >
          {message}
        </div>
      )}

      <div className="supplier-payable-metrics">
        <article>
          <span>USD outstanding</span>
          <strong>
            {money(
              usd.total || 0,
              "USD"
            )}
          </strong>
          <small>
            {money(
              usd.current || 0,
              "USD"
            )}
            {" current"}
          </small>
        </article>

        <article className="overdue">
          <span>USD overdue</span>
          <strong>
            {money(
              usd.overdue || 0,
              "USD"
            )}
          </strong>
          <small>
            {money(
              usd.over_90 || 0,
              "USD"
            )}
            {" over 90 days"}
          </small>
        </article>

        <article>
          <span>KHR outstanding</span>
          <strong>
            {money(
              khr.total || 0,
              "KHR"
            )}
          </strong>
          <small>
            {money(
              khr.current || 0,
              "KHR"
            )}
            {" current"}
          </small>
        </article>

        <article className="overdue">
          <span>KHR overdue</span>
          <strong>
            {money(
              khr.overdue || 0,
              "KHR"
            )}
          </strong>
          <small>
            {money(
              khr.over_90 || 0,
              "KHR"
            )}
            {" over 90 days"}
          </small>
        </article>

        <article>
          <span>Open purchases</span>
          <strong>
            {Number(
              summary.open_invoice_count
              || 0
            ).toLocaleString("en-US")}
          </strong>
        </article>

        <article className="overdue">
          <span>Overdue purchases</span>
          <strong>
            {Number(
              summary.overdue_invoice_count
              || 0
            ).toLocaleString("en-US")}
          </strong>
        </article>
      </div>

      <section className="panel supplier-payable-filter-panel">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) =>
              setSearch(
                event.target.value
              )
            }
            placeholder="Search supplier, code, phone, email or tax ID"
          />
        </div>

        <label>
          <span>Currency</span>
          <select
            value={currency}
            onChange={(event) =>
              setCurrency(
                event.target.value
              )
            }
          >
            <option value="">
              USD and KHR
            </option>
            <option value="USD">
              USD
            </option>
            <option value="KHR">
              KHR
            </option>
          </select>
        </label>

        <label>
          <span>Aging status</span>
          <select
            value={aging}
            onChange={(event) =>
              setAging(
                event.target.value
              )
            }
          >
            <option value="">
              All open balances
            </option>
            <option value="current">
              Current
            </option>
            <option value="overdue">
              Overdue
            </option>
          </select>
        </label>

        <label>
          <span>As of</span>
          <input
            type="date"
            value={asOf}
            onChange={(event) =>
              setAsOf(
                event.target.value
              )
            }
          />
        </label>

        {canAllBranches && (
          <label>
            <span>Scope</span>
            <select
              value={
                allBranches
                  ? "all"
                  : "current"
              }
              onChange={(event) =>
                setAllBranches(
                  event.target.value
                    === "all"
                )
              }
            >
              <option value="current">
                Current branch
              </option>
              <option value="all">
                All branches
              </option>
            </select>
          </label>
        )}
      </section>

      <section className="panel supplier-statement-range">
        <div>
          <CalendarClock size={21} />
          <div>
            <strong>
              Statement date range
            </strong>
            <span>
              Used when opening a supplier
              statement.
            </span>
          </div>
        </div>

        <DateRangePresetFields
          from={statementFrom}
          to={statementTo}
          onChange={(range) => {
            setStatementFrom(range.from);
            setStatementTo(range.to);
          }}
        />
      </section>

      <ResponsiveDataList
        storageKey="supplier-payable-balances"
        title="Outstanding supplier balances"
        subtitle={`${allBranches ? "All branches" : profile?.branches?.name || "Current branch"} · As of ${asOf}`}
        rows={visibleSuppliers}
        filename={`supplier-balances-${asOf}.xls`}
        summary={[
          { label: "USD outstanding", value: money(usd.total || 0, "USD") },
          { label: "USD overdue", value: money(usd.overdue || 0, "USD") },
          { label: "KHR outstanding", value: money(khr.total || 0, "KHR") },
          { label: "KHR overdue", value: money(khr.overdue || 0, "KHR") }
        ]}
        emptyTitle={loading ? "Loading supplier balances..." : "No matching supplier balance"}
        emptyText="Change the search or filters."
        columns={[
          { label: "Supplier", width: 210, documentValue: (supplier) => supplier.name, render: (supplier) => <><strong>{supplier.name}</strong><small>{[supplier.supplier_code, supplier.phone, supplier.contact_name].filter(Boolean).join(" · ")}</small></> },
          { label: "Terms", width: 85, documentValue: (supplier) => `${supplier.default_payment_terms_days} days`, render: (supplier) => <strong>{supplier.default_payment_terms_days} days</strong> },
          { label: "Open", width: 65, value: (supplier) => Number(supplier.open_invoice_count || 0) },
          { label: "Oldest due", width: 105, documentValue: (supplier) => payableDate(supplier.oldest_due_date), render: (supplier) => payableDate(supplier.oldest_due_date) },
          { label: "USD balance", width: 135, documentValue: (supplier) => money(supplier.usd_balance, "USD"), render: (supplier) => <><strong>{money(supplier.usd_balance, "USD")}</strong><small>{money(supplier.usd_overdue, "USD")} overdue</small></> },
          { label: "KHR balance", width: 135, documentValue: (supplier) => money(supplier.khr_balance, "KHR"), render: (supplier) => <><strong>{money(supplier.khr_balance, "KHR")}</strong><small>{money(supplier.khr_overdue, "KHR")} overdue</small></> },
          { label: "Overdue invoices", width: 95, value: (supplier) => Number(supplier.overdue_invoice_count || 0), render: (supplier) => <span className={`payable-overdue-count ${Number(supplier.overdue_invoice_count || 0) > 0 ? "active" : ""}`}>{Number(supplier.overdue_invoice_count || 0)}</span> },
          { label: "Actions", actionsOnly: true, excludeDocument: true, render: (supplier) => { const currentBalance = currentBranchBalance(supplier); return <div className="supplier-payable-actions"><button type="button" className="icon-button" onClick={() => setPaymentSupplier(supplier)} disabled={currentBalance <= 0} title={currentBalance > 0 ? "Record payment for the current branch" : "No unpaid balance in your current branch"}><HandCoins size={18} /></button><button type="button" className="icon-button" onClick={() => openStatement(supplier)} title="View supplier statement"><Eye size={18} /></button><button type="button" className="icon-button" onClick={() => setTermsSupplier(supplier)} title="Edit payment terms"><Settings2 size={18} /></button></div>; } }
        ]}
        renderCard={(supplier) => {
          const currentBalance = currentBranchBalance(supplier);
          return <article className="responsive-data-card supplier-payable-card"><header><div><strong>{supplier.name}</strong><small>{[supplier.supplier_code, supplier.phone, supplier.contact_name].filter(Boolean).join(" · ")}</small></div><span className={`payable-overdue-count ${Number(supplier.overdue_invoice_count || 0) > 0 ? "active" : ""}`}>{Number(supplier.overdue_invoice_count || 0)} overdue</span></header><div><span>Terms</span><strong>{supplier.default_payment_terms_days} days</strong></div><div><span>Oldest due</span><strong>{payableDate(supplier.oldest_due_date)}</strong></div><div><span>USD balance</span><strong>{money(supplier.usd_balance, "USD")}</strong><small>{money(supplier.usd_overdue, "USD")} overdue</small></div><div><span>KHR balance</span><strong>{money(supplier.khr_balance, "KHR")}</strong><small>{money(supplier.khr_overdue, "KHR")} overdue</small></div><footer><button type="button" className="secondary-button compact-button" onClick={() => setPaymentSupplier(supplier)} disabled={currentBalance <= 0}><HandCoins size={17} />Pay</button><button type="button" className="secondary-button compact-button" onClick={() => openStatement(supplier)}><Eye size={17} />Statement</button><button type="button" className="secondary-button compact-button" onClick={() => setTermsSupplier(supplier)}><Settings2 size={17} />Terms</button></footer></article>;
        }}
      />

      <ResponsiveDataList
        storageKey="supplier-open-invoices"
        title="Open purchases"
        subtitle={`${allBranches ? "All branches" : profile?.branches?.name || "Current branch"} · Aging as of ${asOf}`}
        rows={visibleInvoices}
        filename={`supplier-open-purchases-${asOf}.xls`}
        emptyTitle="No open purchases"
        emptyText="No open purchases match the current filters."
        columns={[
          { label: "Purchase", width: 160, documentValue: (invoice) => invoice.purchase_number, render: (invoice) => <><strong>{invoice.purchase_number}</strong><small>{invoice.supplier_invoice_number || "No supplier invoice"}</small></> },
          { label: "Supplier", width: 170, value: (invoice) => invoice.supplier_name },
          ...(allBranches ? [{ label: "Branch", width: 120, value: (invoice) => invoice.branch_name }] : []),
          { label: "Due date", width: 105, documentValue: (invoice) => payableDate(invoice.due_date), render: (invoice) => payableDate(invoice.due_date) },
          { label: "Aging", width: 115, documentValue: (invoice) => agingLabel(invoice.aging_bucket), render: (invoice) => <><span className={`payable-aging ${agingClass(invoice.aging_bucket)}`}>{agingLabel(invoice.aging_bucket)}</span>{Number(invoice.days_overdue || 0) > 0 && <small>{invoice.days_overdue} days overdue</small>}</> },
          { label: "Total", width: 105, documentValue: (invoice) => money(invoice.total_amount, invoice.currency), render: (invoice) => money(invoice.total_amount, invoice.currency) },
          { label: "Paid", width: 105, documentValue: (invoice) => money(invoice.amount_paid, invoice.currency), render: (invoice) => money(invoice.amount_paid, invoice.currency) },
          { label: "Return credit", width: 110, documentValue: (invoice) => money(invoice.return_credit, invoice.currency), render: (invoice) => money(invoice.return_credit, invoice.currency) },
          { label: "Balance", width: 110, documentValue: (invoice) => money(invoice.balance_due, invoice.currency), render: (invoice) => <strong>{money(invoice.balance_due, invoice.currency)}</strong> }
        ]}
        renderCard={(invoice) => <article className="responsive-data-card supplier-invoice-card"><header><div><strong>{invoice.purchase_number}</strong><small>{invoice.supplier_invoice_number || "No supplier invoice"}</small></div><span className={`payable-aging ${agingClass(invoice.aging_bucket)}`}>{agingLabel(invoice.aging_bucket)}</span></header><div><span>Supplier</span><strong>{invoice.supplier_name}</strong></div>{allBranches && <div><span>Branch</span><strong>{invoice.branch_name}</strong></div>}<div><span>Due date</span><strong>{payableDate(invoice.due_date)}</strong><small>{Number(invoice.days_overdue || 0) > 0 ? `${invoice.days_overdue} days overdue` : "Current"}</small></div><div><span>Total</span><strong>{money(invoice.total_amount, invoice.currency)}</strong></div><div><span>Paid / credit</span><strong>{money(invoice.amount_paid, invoice.currency)} / {money(invoice.return_credit, invoice.currency)}</strong></div><div><span>Balance</span><strong>{money(invoice.balance_due, invoice.currency)}</strong></div></article>}
      />

      <section className="panel supplier-recent-payments-panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">
              PAYMENT HISTORY
            </p>
            <h2>Recent allocations</h2>
          </div>
          <HandCoins size={22} />
        </div>

        {(workspace.recent_payments || [])
          .length === 0 ? (
          <p className="muted">
            No supplier payments yet.
          </p>
        ) : (
          <div className="supplier-payment-history-list">
            {workspace.recent_payments
              .slice(0, 30)
              .map((payment) => (
                <article key={payment.id}>
                  <div>
                    <strong>
                      {payment.payment_number
                        || payment.purchase_number}
                    </strong>
                    <span>
                      {payment.supplier_name}
                      {" · "}
                      {payment.purchase_number}
                    </span>
                  </div>

                  <div>
                    <strong>
                      {money(
                        payment.amount,
                        payment.currency
                      )}
                    </strong>
                    <span>
                      {payableMethodLabel(
                        payment.method
                      )}
                      {payment.reference_number
                        ? ` · ${payment.reference_number}`
                        : ""}
                    </span>
                  </div>

                  <div>
                    <strong>
                      {payment.branch_name}
                    </strong>
                    <span>
                      {payableDateTime(
                        payment.paid_at
                      )}
                    </span>
                  </div>
                </article>
              ))}
          </div>
        )}
      </section>

      <SupplierPaymentModal
        supplier={paymentSupplier}
        invoices={workspace.invoices}
        currentBranchId={
          profile?.branch_id
        }
        currentBranchName={
          profile?.branches?.name
        }
        busy={busy === "payment"}
        onClose={() =>
          setPaymentSupplier(null)
        }
        onSubmit={handlePayment}
      />

      <SupplierTermsModal
        supplier={termsSupplier}
        canAllBranches={canAllBranches}
        busy={busy === "terms"}
        onClose={() =>
          setTermsSupplier(null)
        }
        onSave={handleTerms}
      />

      <SupplierStatementModal
        statement={statement}
        loading={statementLoading}
        shop={shop}
        onClose={() => {
          setStatement(null);
          setStatementLoading(false);
        }}
      />
    </div>
  );
}
