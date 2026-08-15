import {
  ArrowLeftRight,
  Banknote,
  BarChart3,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  Clock3,
  PackageSearch,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Store,
  TrendingUp,
  UsersRound,
  WalletCards
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import DashboardAlertCard from "../components/DashboardAlertCard";
import DashboardTrendChart from "../components/DashboardTrendChart";
import { money, stockNumber } from "../lib/catalog";
import {
  dashboardDateTime,
  dashboardPercent,
  loadDashboardActionCenter,
  paymentMethodLabel
} from "../lib/dashboard";

const emptyDashboard = {
  meta: {},
  today: {},
  periods: {},
  trend: [],
  payment_methods: [],
  top_products: [],
  recent_sales: [],
  branch_performance: [],
  quick_counts: {},
  register: {},
  alerts: []
};

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = ""
}) {
  return (
    <article className={`dashboard-metric-card ${tone}`}>
      <div className="dashboard-metric-icon">
        <Icon size={22} />
      </div>

      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function RegisterBanner({ register }) {
  if (register?.is_open) {
    const hours = Math.floor(
      Number(register.open_minutes || 0) / 60
    );
    const minutes =
      Number(register.open_minutes || 0) % 60;

    return (
      <Link
        to="/cash-register"
        className="dashboard-register-banner open"
      >
        <div>
          <Banknote size={23} />
          <span>Cash register open</span>
        </div>

        <strong>
          {register.session_number}
        </strong>

        <span>
          {register.register_name}
          {" · "}
          {hours > 0 ? `${hours}h ` : ""}
          {minutes}m
          {" · "}
          {register.opened_by || "POS Staff"}
        </span>
      </Link>
    );
  }

  return (
    <Link
      to="/cash-register"
      className="dashboard-register-banner closed"
    >
      <div>
        <Clock3 size={23} />
        <span>Cash register closed</span>
      </div>

      <strong>Cash payments unavailable</strong>

      <span>
        Open the register before accepting cash.
      </span>
    </Link>
  );
}

export default function DashboardPage() {
  const {
    supabase,
    profile,
    shop,
    can,
    canAny
  } = useAuth();

  const [allBranches, setAllBranches] =
    useState(false);
  const [dashboard, setDashboard] =
    useState(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id) {
      return;
    }

    try {
      setLoading(true);
      setMessage("");

      const data =
        await loadDashboardActionCenter(
          supabase,
          allBranches,
          {
            profile,
            canReviewApprovals: can("approvals.review"),
            canManageAttendance: can("attendance.manage"),
            canReceiveOnlineOrders: canAny([
              "online_orders.manage",
              "online_orders.fulfill"
            ])
          }
        );

      setDashboard({
        ...emptyDashboard,
        ...(data || {})
      });
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [
    supabase,
    profile?.organization_id,
    profile?.branch_id,
    allBranches,
    profile,
    can,
    canAny
  ]);

  useEffect(() => {
    refresh();

    const interval = window.setInterval(
      refresh,
      60000
    );

    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  const currency =
    dashboard.meta?.base_currency
    || shop?.base_currency
    || "USD";

  const canViewProfit =
    Boolean(dashboard.meta?.can_view_profit)
    && can("profit.view");

  const canAllBranches =
    Boolean(dashboard.meta?.can_all_branches)
    && can("branches.all");

  useEffect(() => {
    if (!canAllBranches && allBranches) {
      setAllBranches(false);
    }
  }, [canAllBranches, allBranches]);

  const today = dashboard.today || {};
  const periods = dashboard.periods || {};

  const quickActions = useMemo(() => {
    const actions = [];

    if (can("sales.create")) {
      actions.push({
        to: "/sales",
        label: "New Sale",
        icon: ShoppingCart
      });
    }

    if (
      canAny([
        "cash_register.use",
        "cash_register.close"
      ])
    ) {
      actions.push({
        to: "/cash-register",
        label: "Cash Register",
        icon: Banknote
      });
    }

    if (can("returns.process")) {
      actions.push({
        to: "/returns",
        label: "Return / Refund",
        icon: RotateCcw
      });
    }

    if (
      canAny([
        "purchases.manage",
        "purchases.receive"
      ])
    ) {
      actions.push({
        to: "/purchase-orders",
        label: "Purchase Order",
        icon: ClipboardList
      });
    }

    if (can("reorder.manage")) {
      actions.push({
        to: "/reorder",
        label: "Reorder Planner",
        icon: PackageSearch
      });
    }

    if (
      canAny([
        "cash_expenses.manage",
        "cash_expenses.void"
      ])
    ) {
      actions.push({
        to: "/cash-expenses",
        label: "Cash & Expense",
        icon: WalletCards
      });
    }

    if (can("reports.view")) {
      actions.push({
        to: "/reports",
        label: "Reports",
        icon: BarChart3
      });
    }

    return actions;
  }, [can, canAny]);

  const paymentMaximum = Math.max(
    1,
    ...(dashboard.payment_methods || []).map(
      (row) => Number(row.amount || 0)
    )
  );

  const branchMaximum = Math.max(
    1,
    ...(dashboard.branch_performance || []).map(
      (row) => Number(row.net_sales || 0)
    )
  );

  const monthChange = dashboardPercent(
    periods.month_change_percent
  );

  return (
    <div className="page-stack dashboard-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            BUSINESS OVERVIEW
          </p>
          <h1>Dashboard</h1>
          <p className="muted">
            Welcome back,{" "}
            {profile?.full_name || "POS User"}.
            {" · "}
            {dashboard.meta?.branch_name
              || profile?.branches?.name
              || "Current branch"}
          </p>
        </div>

        <div className="page-heading-actions">
          {canAllBranches && (
            <label className="dashboard-scope-switch">
              <Store size={18} />
              <select
                value={
                  allBranches
                    ? "all"
                    : "current"
                }
                onChange={(event) =>
                  setAllBranches(
                    event.target.value === "all"
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
        <div className="notice error">
          {message}
        </div>
      )}

      <div className="dashboard-updated-row">
        <span>
          Business date:{" "}
          {dashboard.meta?.business_date || "—"}
        </span>
        <span>
          Updated:{" "}
          {dashboardDateTime(
            dashboard.meta?.generated_at
          )}
        </span>
      </div>

      <div className="dashboard-metric-grid">
        <MetricCard
          icon={CircleDollarSign}
          label="Today's net sales"
          value={money(
            today.net_sales || 0,
            currency
          )}
          detail={[
            `${Number(today.sale_count || 0)} sales`,
            `${Number(today.refund_count || 0)} refunds`
          ].join(" · ")}
          tone="sales"
        />

        <MetricCard
          icon={ReceiptText}
          label="Average sale"
          value={money(
            today.average_sale || 0,
            currency
          )}
          detail={`${money(
            today.refunds || 0,
            currency
          )} refunded today`}
        />

        <MetricCard
          icon={TrendingUp}
          label="This week"
          value={money(
            periods.week_net_sales || 0,
            currency
          )}
          detail={`${Number(
            periods.week_sale_count || 0
          )} sales`}
        />

        <MetricCard
          icon={BarChart3}
          label="This month"
          value={money(
            periods.month_net_sales || 0,
            currency
          )}
          detail={monthChange}
        />

        {canViewProfit ? (
          <MetricCard
            icon={TrendingUp}
            label="Today's net profit"
            value={money(
              today.net_profit || 0,
              currency
            )}
            detail={[
              `${money(
                today.gross_profit || 0,
                currency
              )} gross profit`,
              `${money(
                today.operating_expenses || 0,
                currency
              )} expenses`
            ].join(" · ")}
            tone="profit"
          />
        ) : (
          <MetricCard
            icon={Boxes}
            label="Active products"
            value={Number(
              dashboard.quick_counts
                ?.active_products || 0
            ).toLocaleString("en-US")}
            detail={`${Number(
              dashboard.quick_counts
                ?.active_customers || 0
            ).toLocaleString("en-US")} customers`}
          />
        )}
      </div>

      {!allBranches && (
        <RegisterBanner
          register={dashboard.register}
        />
      )}

      <section className="dashboard-quick-actions">
        {quickActions.map(
          ({ to, label, icon: Icon }) => (
            <Link to={to} key={to}>
              <Icon size={19} />
              <span>{label}</span>
            </Link>
          )
        )}
      </section>

      <div className="dashboard-main-grid">
        <DashboardTrendChart
          rows={dashboard.trend}
          currency={currency}
        />

        <section className="panel dashboard-alert-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">
                ACTION CENTER
              </p>
              <h2>Needs attention</h2>
              <span className="muted">
                {dashboard.alerts.length}
                {" "}
                active alert
                {dashboard.alerts.length === 1
                  ? ""
                  : "s"}
              </span>
            </div>
            <PackageSearch size={23} />
          </div>

          {dashboard.alerts.length === 0 ? (
            <div className="dashboard-all-clear">
              <span>✓</span>
              <strong>Everything looks good</strong>
              <p>
                There are no urgent operational
                alerts for this scope.
              </p>
            </div>
          ) : (
            <div className="dashboard-alert-list">
              {dashboard.alerts.map((alert) => (
                <DashboardAlertCard
                  key={alert.key}
                  alert={alert}
                  currency={currency}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="dashboard-secondary-grid">
        <section className="panel dashboard-payment-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">
                TODAY
              </p>
              <h2>Payment methods</h2>
            </div>
            <WalletCards size={22} />
          </div>

          {(dashboard.payment_methods || [])
            .length === 0 ? (
            <div className="empty-state compact">
              <p>No payments today.</p>
            </div>
          ) : (
            <div className="dashboard-progress-list">
              {dashboard.payment_methods.map(
                (row) => (
                  <article key={row.method}>
                    <div>
                      <strong>
                        {paymentMethodLabel(
                          row.method
                        )}
                      </strong>
                      <span>
                        {Number(
                          row.transaction_count || 0
                        )}
                        {" "}
                        transaction
                        {Number(
                          row.transaction_count || 0
                        ) === 1
                          ? ""
                          : "s"}
                      </span>
                    </div>

                    <b>
                      {money(
                        row.amount || 0,
                        currency
                      )}
                    </b>

                    <div className="dashboard-progress-track">
                      <div
                        style={{
                          width: `${
                            Number(row.amount || 0)
                            / paymentMaximum
                            * 100
                          }%`
                        }}
                      />
                    </div>

                    <small>
                      {Number(
                        row.percent || 0
                      ).toLocaleString("en-US", {
                        maximumFractionDigits: 1
                      })}
                      %
                    </small>
                  </article>
                )
              )}
            </div>
          )}
        </section>

        <section className="panel dashboard-products-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">
                LAST 7 DAYS
              </p>
              <h2>Top products</h2>
            </div>
            <Boxes size={22} />
          </div>

          {(dashboard.top_products || [])
            .length === 0 ? (
            <div className="empty-state compact">
              <p>No product sales yet.</p>
            </div>
          ) : (
            <div className="dashboard-ranked-list">
              {dashboard.top_products.map(
                (row, index) => (
                  <article
                    key={
                      row.product_id
                      || row.product_name
                    }
                  >
                    <span>{index + 1}</span>

                    <div>
                      <strong>
                        {row.product_name}
                      </strong>
                      <small>
                        {stockNumber(
                          row.base_quantity || 0
                        )}
                        {" base units sold"}
                      </small>
                    </div>

                    <div>
                      <b>
                        {money(
                          row.sales_amount || 0,
                          currency
                        )}
                      </b>

                      {canViewProfit
                        && row.profit_amount !== null
                        && (
                          <small>
                            {money(
                              row.profit_amount || 0,
                              currency
                            )}
                            {" profit"}
                          </small>
                        )}
                    </div>
                  </article>
                )
              )}
            </div>
          )}
        </section>
      </div>

      {allBranches
        && dashboard.branch_performance.length > 0
        && (
          <section className="panel dashboard-branch-panel">
            <div className="panel-title-row">
              <div>
                <p className="eyebrow">
                  TODAY
                </p>
                <h2>Branch performance</h2>
              </div>
              <Store size={22} />
            </div>

            <div className="dashboard-branch-list">
              {dashboard.branch_performance.map(
                (branch) => (
                  <article key={branch.branch_id}>
                    <div>
                      <strong>
                        {branch.branch_name}
                      </strong>
                      <span>
                        {branch.branch_code}
                        {" · "}
                        {Number(
                          branch.sale_count || 0
                        )}
                        {" sales"}
                      </span>
                    </div>

                    <div className="dashboard-branch-bar">
                      <div
                        style={{
                          width: `${
                            Math.max(
                              0,
                              Number(
                                branch.net_sales || 0
                              )
                            )
                            / branchMaximum
                            * 100
                          }%`
                        }}
                      />
                    </div>

                    <b>
                      {money(
                        branch.net_sales || 0,
                        currency
                      )}
                    </b>

                    {canViewProfit && (
                      <small>
                        {money(
                          branch.net_profit || 0,
                          currency
                        )}
                        {" profit"}
                      </small>
                    )}
                  </article>
                )
              )}
            </div>
          </section>
        )}

      <section className="panel dashboard-recent-panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">
              LATEST ACTIVITY
            </p>
            <h2>Recent sales</h2>
          </div>

          <Link
            to="/reports"
            className="secondary-button"
          >
            <BarChart3 size={17} />
            Open reports
          </Link>
        </div>

        {(dashboard.recent_sales || [])
          .length === 0 ? (
          <div className="empty-state compact">
            <p>No completed sales yet.</p>
          </div>
        ) : (
          <div className="dashboard-recent-table-wrap">
            <table className="dashboard-recent-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Cashier</th>
                  {allBranches && <th>Branch</th>}
                  <th>Status</th>
                  <th>Net total</th>
                </tr>
              </thead>

              <tbody>
                {dashboard.recent_sales.map(
                  (sale) => (
                    <tr key={sale.id}>
                      <td data-label="Invoice">
                        <strong>
                          {sale.invoice_number}
                        </strong>
                      </td>

                      <td data-label="Date">
                        {dashboardDateTime(
                          sale.completed_at
                        )}
                      </td>

                      <td data-label="Customer">
                        {sale.customer_name}
                      </td>

                      <td data-label="Cashier">
                        {sale.cashier_name}
                      </td>

                      {allBranches && (
                        <td data-label="Branch">
                          {sale.branch_name}
                        </td>
                      )}

                      <td data-label="Status">
                        <span
                          className={`status-pill ${
                            sale.status === "completed"
                              ? "active"
                              : "inactive"
                          }`}
                        >
                          {String(
                            sale.status || ""
                          ).replaceAll("_", " ")}
                        </span>
                      </td>

                      <td data-label="Net total">
                        <strong>
                          {money(
                            sale.net_total || 0,
                            currency
                          )}
                        </strong>

                        {Number(
                          sale.refund_total || 0
                        ) > 0 && (
                          <small>
                            {money(
                              sale.refund_total,
                              currency
                            )}
                            {" refunded"}
                          </small>
                        )}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dashboard-count-strip">
        <article>
          <Boxes size={19} />
          <span>Products</span>
          <strong>
            {Number(
              dashboard.quick_counts
                ?.active_products || 0
            ).toLocaleString("en-US")}
          </strong>
        </article>

        <article>
          <UsersRound size={19} />
          <span>Customers</span>
          <strong>
            {Number(
              dashboard.quick_counts
                ?.active_customers || 0
            ).toLocaleString("en-US")}
          </strong>
        </article>

        <article>
          <Store size={19} />
          <span>Branches</span>
          <strong>
            {Number(
              dashboard.quick_counts
                ?.active_branches || 0
            ).toLocaleString("en-US")}
          </strong>
        </article>

        <article>
          <ArrowLeftRight size={19} />
          <span>Staff</span>
          <strong>
            {Number(
              dashboard.quick_counts
                ?.active_staff || 0
            ).toLocaleString("en-US")}
          </strong>
        </article>
      </section>
    </div>
  );
}
