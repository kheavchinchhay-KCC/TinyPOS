import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Crown,
  Edit3,
  Gift,
  MoreHorizontal,
  RefreshCw,
  Search,
  UserCheck,
  UserPlus,
  UsersRound,
  UserX,
  WalletCards
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import CustomerDetailModal from "../components/CustomerDetailModal";
import CustomerFormModal from "../components/CustomerFormModal";
import LoyaltyAdjustModal from "../components/LoyaltyAdjustModal";
import ListViewControls, { defaultListView } from "../components/ListViewControls";
import { exportListExcel, printListDocument } from "../lib/listDocuments";
import { money } from "../lib/catalog";
import {
  adjustCustomerLoyalty,
  loadCustomerDetail,
  loadCustomerDirectory,
  saveCustomer,
  setCustomerStatus
} from "../lib/customers";

function dateOnly(value) {
  if (!value) return "Never";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(new Date(value));
}

function customerSearchText(customer) {
  return [
    customer.customer_code,
    customer.name,
    customer.company_name,
    customer.phone,
    customer.email,
    customer.address,
    customer.customer_type
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function friendlyError(error) {
  const message = error?.message || "The customer operation failed.";

  if (message.includes("customers_org_phone_uq")) {
    return "That phone number already belongs to another customer.";
  }

  if (message.includes("customers_org_code_uq")) {
    return "That customer code is already in use.";
  }

  return message;
}

export default function CustomersPage() {
  const { supabase, profile, shop, can } = useAuth();
  const canManage = can("customers.manage");

  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");
  const [viewMode, setViewMode] = useState(defaultListView);
  const [pageSize, setPageSize] = useState(30);
  const [page, setPage] = useState(1);

  const [formOpen, setFormOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [loyaltyCustomer, setLoyaltyCustomer] = useState(null);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerDetail, setCustomerDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id) return;

    try {
      setLoading(true);
      const rows = await loadCustomerDirectory(
        supabase,
        profile.organization_id
      );
      setCustomers(rows);

      if (selectedCustomer) {
        const updated = rows.find(
          (customer) => customer.id === selectedCustomer.id
        );
        setSelectedCustomer(updated || null);
      }
    } catch (error) {
      setMessageType("error");
      setMessage(friendlyError(error));
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, selectedCustomer?.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visibleCustomers = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return customers.filter((customer) => {
      const matchesSearch =
        !needle || customerSearchText(customer).includes(needle);
      const matchesStatus =
        statusFilter === "all"
        || (statusFilter === "active" && customer.is_active)
        || (statusFilter === "inactive" && !customer.is_active);
      const matchesType =
        typeFilter === "all"
        || customer.customer_type === typeFilter;

      return matchesSearch && matchesStatus && matchesType;
    });
  }, [customers, search, statusFilter, typeFilter]);

  useEffect(() => { setPage(1); }, [search, statusFilter, typeFilter, pageSize]);
  const totalPages = Math.max(1, Math.ceil(visibleCustomers.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedCustomers = visibleCustomers.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const customerReportColumns = [
    { label: "Code", value: (row) => row.customer_code },
    { label: "Customer", value: (row) => row.name },
    { label: "Company", value: (row) => row.company_name || "—" },
    { label: "Phone", value: (row) => row.phone || "—" },
    { label: "Email", value: (row) => row.email || "—" },
    { label: "Type", value: (row) => row.customer_type },
    { label: "Purchases", value: (row) => Number(row.sale_count || 0) },
    { label: "Net spent", value: (row) => money(row.net_spent, row.summary_currency || shop?.base_currency || "USD") },
    { label: "Points", value: (row) => Number(row.loyalty_points || 0) },
    { label: "Last purchase", value: (row) => dateOnly(row.last_purchase_at) },
    { label: "Status", value: (row) => row.is_active ? "Active" : "Inactive" }
  ];

  function printCustomers() {
    printListDocument({
      title: "Customer List",
      subtitle: `${visibleCustomers.length} customer(s)`,
      summary: [
        { label: "Type", value: typeFilter === "all" ? "All types" : typeFilter },
        { label: "Status", value: statusFilter === "all" ? "All statuses" : statusFilter },
        { label: "Search", value: search || "All customers" }
      ],
      columns: customerReportColumns,
      rows: visibleCustomers
    });
  }

  function exportCustomers() {
    exportListExcel({
      filename: `customers-${new Date().toISOString().slice(0, 10)}.xls`,
      title: "Customer List",
      subtitle: `${visibleCustomers.length} customer(s)`,
      summary: [{ label: "Search", value: search || "All customers" }],
      columns: customerReportColumns,
      rows: visibleCustomers
    });
  }

  const summary = useMemo(() => {
    return customers.reduce(
      (result, customer) => {
        result.active += customer.is_active ? 1 : 0;
        result.netSpent += Number(customer.net_spent || 0);
        result.loyalty += Number(customer.loyalty_points || 0);
        result.refunds += Number(customer.refund_amount || 0);
        return result;
      },
      {
        active: 0,
        netSpent: 0,
        loyalty: 0,
        refunds: 0
      }
    );
  }, [customers]);

  const summaryCurrency =
    customers[0]?.summary_currency || shop?.base_currency || "USD";

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  function openCreate() {
    setEditingCustomer(null);
    setFormOpen(true);
  }

  function openEdit(customer) {
    setEditingCustomer(customer);
    setFormOpen(true);
  }

  async function handleSaveCustomer(values) {
    try {
      setBusy(true);
      const saved = await saveCustomer(supabase, profile, values);
      setFormOpen(false);
      setEditingCustomer(null);
      announce(
        "success",
        `${saved.name} ${values.id ? "updated" : "created"} successfully.`
      );
      await refresh();
    } catch (error) {
      announce("error", friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleStatus(customer) {
    const nextStatus = !customer.is_active;
    const action = nextStatus ? "reactivate" : "deactivate";

    if (
      !window.confirm(
        `${action[0].toUpperCase()}${action.slice(1)} ${customer.name}?`
      )
    ) {
      return;
    }

    try {
      setBusy(true);
      await setCustomerStatus(
        supabase,
        profile,
        customer.id,
        nextStatus
      );
      announce(
        "success",
        `${customer.name} is now ${nextStatus ? "active" : "inactive"}.`
      );
      await refresh();
    } catch (error) {
      announce("error", friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleLoyalty(values) {
    try {
      setBusy(true);
      const result = await adjustCustomerLoyalty(
        supabase,
        values.customer_id,
        values.points_change,
        values.reason
      );
      setLoyaltyCustomer(null);
      announce(
        "success",
        `Loyalty balance updated to ${Number(result.points_after).toLocaleString("en-US")} points.`
      );
      await refresh();

      if (selectedCustomer?.id === values.customer_id) {
        await openDetails({
          ...selectedCustomer,
          loyalty_points: result.points_after
        });
      }
    } catch (error) {
      announce("error", friendlyError(error));
    } finally {
      setBusy(false);
    }
  }

  async function openDetails(customer) {
    setSelectedCustomer(customer);
    setCustomerDetail(null);
    setDetailLoading(true);

    try {
      const detail = await loadCustomerDetail(
        supabase,
        profile,
        customer.id
      );
      setCustomerDetail(detail);
    } catch (error) {
      announce("error", friendlyError(error));
    } finally {
      setDetailLoading(false);
    }
  }

  if (!canManage) {
    return (
      <section className="panel empty-state">
        <UsersRound size={46} />
        <h2>Customer management is restricted</h2>
        <p>
          Owners, admins, and managers can view complete customer analytics.
          Cashiers can still select or quickly create customers during a sale.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack customers-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CUSTOMER RELATIONSHIPS</p>
          <h1>Customers</h1>
          <p className="muted">
            Manage customer profiles, purchase history, refunds, and loyalty.
          </p>
        </div>

        <div className="heading-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={refresh}
            disabled={loading}
          >
            <RefreshCw size={18} className={loading ? "spin" : ""} />
            Refresh
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={openCreate}
          >
            <UserPlus size={18} />
            Add customer
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

      <section className="customer-summary-grid">
        <article>
          <UsersRound size={21} />
          <span>Total customers</span>
          <strong>{customers.length.toLocaleString("en-US")}</strong>
          <small>{summary.active.toLocaleString("en-US")} active</small>
        </article>
        <article>
          <WalletCards size={21} />
          <span>Customer net sales</span>
          <strong>{money(summary.netSpent, summaryCurrency)}</strong>
          <small>After refunds</small>
        </article>
        <article>
          <Gift size={21} />
          <span>Loyalty points</span>
          <strong>{summary.loyalty.toLocaleString("en-US")}</strong>
          <small>Across all customers</small>
        </article>
        <article>
          <Crown size={21} />
          <span>VIP customers</span>
          <strong>
            {customers
              .filter((customer) => customer.customer_type === "vip")
              .length.toLocaleString("en-US")}
          </strong>
          <small>{money(summary.refunds, summaryCurrency)} refunded</small>
        </article>
      </section>

      <section className="panel customer-toolbar">
        <label className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, code, phone, company, email or address"
          />
        </label>

        <select
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="all">All customer types</option>
          <option value="regular">Regular</option>
          <option value="vip">VIP</option>
          <option value="wholesale">Wholesale</option>
        </select>

        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </section>

      <ListViewControls
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        pageSize={pageSize}
        onPageSizeChange={setPageSize}
        totalRows={visibleCustomers.length}
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={setPage}
        onExport={exportCustomers}
        onPrint={printCustomers}
      />

      <section className="panel customers-table-panel">
        <div className="customer-table-summary">
          <strong>{visibleCustomers.length}</strong>
          <span>customers shown</span>
        </div>

        {loading ? (
          <div className="empty-state">
            <RefreshCw className="spin" size={34} />
            <p>Loading customers...</p>
          </div>
        ) : visibleCustomers.length === 0 ? (
          <div className="empty-state">
            <UsersRound size={46} />
            <h2>No customers found</h2>
            <p>Change the filters or add your first customer.</p>
          </div>
        ) : (
          viewMode === "cards" ? (
            <div className="list-card-grid customer-card-grid">
              {pagedCustomers.map((customer) => (
                <article className="list-record-card" key={customer.id}>
                  <header><button type="button" className="customer-name-button" onClick={() => openDetails(customer)}><span className="customer-avatar-small">{customer.name.slice(0, 1).toUpperCase()}</span><span><strong>{customer.name}</strong><small>{customer.customer_code}{customer.company_name ? ` · ${customer.company_name}` : ""}</small></span></button><span className={`status-pill ${customer.is_active ? "active" : "inactive"}`}>{customer.is_active ? "Active" : "Inactive"}</span></header>
                  <div className="list-card-fields">
                    <div><span>Contact</span><strong>{customer.phone || "—"}</strong><small>{customer.email || "No email"}</small></div>
                    <div><span>Type</span><strong>{customer.customer_type}</strong></div>
                    <div><span>Purchases</span><strong>{Number(customer.sale_count || 0).toLocaleString("en-US")}</strong></div>
                    <div><span>Net spent</span><strong>{money(customer.net_spent, customer.summary_currency || summaryCurrency)}</strong></div>
                    <div><span>Points</span><strong>{Number(customer.loyalty_points || 0).toLocaleString("en-US")}</strong></div>
                    <div><span>Last purchase</span><strong>{dateOnly(customer.last_purchase_at)}</strong></div>
                  </div>
                  <div className="list-card-actions customer-row-actions">
                    <button type="button" className="icon-button" title="Edit customer" onClick={() => openEdit(customer)}><Edit3 size={17} /></button>
                    <button type="button" className="icon-button" title="Adjust loyalty points" onClick={() => setLoyaltyCustomer(customer)}><Gift size={17} /></button>
                    <button type="button" className="icon-button" title={customer.is_active ? "Deactivate" : "Reactivate"} onClick={() => handleToggleStatus(customer)} disabled={busy}>{customer.is_active ? <UserX size={17} /> : <UserCheck size={17} />}</button>
                    <button type="button" className="icon-button" title="View details" onClick={() => openDetails(customer)}><MoreHorizontal size={18} /></button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="customers-table-wrap wide-list-scroll">
              <table className="customers-table">
                <thead><tr><th>Customer</th><th>Contact</th><th>Type</th><th>Purchases</th><th>Net spent</th><th>Points</th><th>Last purchase</th><th>Status</th><th /></tr></thead>
                <tbody>{pagedCustomers.map((customer) => (
                  <tr key={customer.id}>
                    <td data-label="Customer"><button type="button" className="customer-name-button" onClick={() => openDetails(customer)}><span className="customer-avatar-small">{customer.name.slice(0, 1).toUpperCase()}</span><span><strong>{customer.name}</strong><small>{customer.customer_code}{customer.company_name ? ` · ${customer.company_name}` : ""}</small></span></button></td>
                    <td data-label="Contact"><span className="customer-contact-cell"><strong>{customer.phone || "—"}</strong><small>{customer.email || "No email"}</small></span></td>
                    <td data-label="Type"><span className={`customer-type-badge ${customer.customer_type}`}>{customer.customer_type}</span></td>
                    <td data-label="Purchases">{Number(customer.sale_count || 0).toLocaleString("en-US")}</td>
                    <td data-label="Net spent"><strong>{money(customer.net_spent, customer.summary_currency || summaryCurrency)}</strong></td>
                    <td data-label="Points">{Number(customer.loyalty_points || 0).toLocaleString("en-US")}</td>
                    <td data-label="Last purchase">{dateOnly(customer.last_purchase_at)}</td>
                    <td data-label="Status"><span className={`status-pill ${customer.is_active ? "active" : "inactive"}`}>{customer.is_active ? "Active" : "Inactive"}</span></td>
                    <td data-label="Actions"><div className="customer-row-actions"><button type="button" className="icon-button" title="Edit customer" onClick={() => openEdit(customer)}><Edit3 size={17} /></button><button type="button" className="icon-button" title="Adjust loyalty points" onClick={() => setLoyaltyCustomer(customer)}><Gift size={17} /></button><button type="button" className="icon-button" title={customer.is_active ? "Deactivate" : "Reactivate"} onClick={() => handleToggleStatus(customer)} disabled={busy}>{customer.is_active ? <UserX size={17} /> : <UserCheck size={17} />}</button><button type="button" className="icon-button" title="View details" onClick={() => openDetails(customer)}><MoreHorizontal size={18} /></button></div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )
        )}
      </section>

      <CustomerFormModal
        open={formOpen}
        customer={editingCustomer}
        busy={busy}
        onClose={() => {
          if (!busy) {
            setFormOpen(false);
            setEditingCustomer(null);
          }
        }}
        onSave={handleSaveCustomer}
      />

      <LoyaltyAdjustModal
        customer={loyaltyCustomer}
        busy={busy}
        onClose={() => !busy && setLoyaltyCustomer(null)}
        onSubmit={handleLoyalty}
      />

      <CustomerDetailModal
        customer={selectedCustomer}
        detail={customerDetail}
        loading={detailLoading}
        onClose={() => {
          setSelectedCustomer(null);
          setCustomerDetail(null);
        }}
        onEdit={(customer) => {
          setSelectedCustomer(null);
          openEdit(customer);
        }}
        onLoyalty={(customer) => {
          setSelectedCustomer(null);
          setCustomerDetail(null);
          setLoyaltyCustomer(customer);
        }}
        onToggleStatus={async (customer) => {
          await handleToggleStatus(customer);
          setSelectedCustomer(null);
          setCustomerDetail(null);
        }}
      />
    </div>
  );
}
