import {
  BadgeDollarSign,
  Edit3,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRoundCheck
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { useAuth } from "../context/AuthContext";
import CustomerPriceListModal from "../components/CustomerPriceListModal";
import PriceListFormModal from "../components/PriceListFormModal";
import PriceListItemsModal from "../components/PriceListItemsModal";
import {
  assignCustomerPriceList,
  loadPriceListWorkspace,
  priceListScopeLabel,
  savePriceList,
  savePriceListItems
} from "../lib/priceLists";

function dateTime(value) {
  if (!value) return "Always";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function listState(list) {
  if (!list.is_active) return "inactive";

  const now = Date.now();

  if (
    list.starts_at
    && new Date(list.starts_at).getTime() > now
  ) {
    return "scheduled";
  }

  if (
    list.ends_at
    && new Date(list.ends_at).getTime() <= now
  ) {
    return "expired";
  }

  return "active";
}

export default function PriceListsPage() {
  const { supabase, profile, can } = useAuth();

  const canManage = can("price_lists.manage");
  const canAllBranches = can("branches.all");

  const [lists, setLists] = useState([]);
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [branches, setBranches] = useState([]);

  const [search, setSearch] = useState("");
  const [currency, setCurrency] = useState("");
  const [status, setStatus] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [itemList, setItemList] = useState(null);
  const [customerOpen, setCustomerOpen] = useState(false);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const refresh = useCallback(async () => {
    if (
      !supabase
      || !profile?.organization_id
      || !canManage
    ) {
      return;
    }

    try {
      setLoading(true);

      const workspace =
        await loadPriceListWorkspace(
          supabase,
          profile
        );

      setLists(workspace.lists);
      setProducts(workspace.products);
      setCustomers(workspace.customers);
      setBranches(workspace.branches);

      setItemList((current) => {
        if (!current) return null;

        return workspace.lists.find(
          (list) => list.id === current.id
        ) || null;
      });
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile, canManage]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    const needle = search
      .trim()
      .toLowerCase();

    return lists.filter((list) => {
      if (
        currency
        && list.currency !== currency
      ) {
        return false;
      }

      if (
        status
        && listState(list) !== status
      ) {
        return false;
      }

      if (!needle) return true;

      return [
        list.code,
        list.name,
        list.customer_type,
        list.branches?.name,
        list.notes
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [lists, search, currency, status]);

  const formBranches = !canAllBranches
    ? branches.filter(
        (branch) => branch.id === profile.branch_id
      )
    : branches;

  const metrics = useMemo(() => ({
    total: lists.length,
    active: lists.filter(
      (list) => listState(list) === "active"
    ).length,
    items: lists.reduce(
      (sum, list) =>
        sum + list.price_list_items.length,
      0
    ),
    assigned: customers.filter(
      (customer) => customer.price_list_id
    ).length
  }), [lists, customers]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function handleSaveList(values) {
    try {
      setBusy("list");

      const result = await savePriceList(
        supabase,
        values
      );

      setFormOpen(false);
      setEditing(null);
      announce(
        "success",
        `${result.code} · ${result.name} saved.`
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleSaveItems(listId, rows) {
    try {
      setBusy("items");

      const result = await savePriceListItems(
        supabase,
        listId,
        rows
      );

      announce(
        "success",
        `${result.item_count} unit price override${
          result.item_count === 1 ? "" : "s"
        } saved.`
      );

      setItemList(null);
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function handleAssignCustomer(
    customerId,
    priceListId
  ) {
    try {
      setBusy("customer");

      const result =
        await assignCustomerPriceList(
          supabase,
          customerId,
          priceListId
        );

      setCustomerOpen(false);
      announce(
        "success",
        result.price_list_name
          ? `Customer assigned to ${result.price_list_name}.`
          : "Customer returned to automatic pricing."
      );

      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  if (!canManage) {
    return (
      <section className="panel empty-state">
        <BadgeDollarSign size={46} />
        <h2>Management access required</h2>
        <p>
          Only an owner, admin or manager can
          manage price lists.
        </p>
      </section>
    );
  }

  return (
    <div className="page-stack price-lists-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            SELLING PRICES
          </p>
          <h1>Price Lists</h1>
          <p className="muted">
            Create VIP, wholesale, branch and
            customer-specific prices for every
            package unit.
          </p>
        </div>

        <div className="page-heading-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              setCustomerOpen(true)
            }
          >
            <UserRoundCheck size={18} />
            Assign Customer
          </button>

          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus size={18} />
            New Price List
          </button>

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

      <div className="price-list-metrics">
        <article>
          <BadgeDollarSign size={22} />
          <span>Total lists</span>
          <strong>{metrics.total}</strong>
        </article>

        <article>
          <BadgeDollarSign size={22} />
          <span>Active now</span>
          <strong>{metrics.active}</strong>
        </article>

        <article>
          <SlidersHorizontal size={22} />
          <span>Unit overrides</span>
          <strong>{metrics.items}</strong>
        </article>

        <article>
          <UserRoundCheck size={22} />
          <span>Direct assignments</span>
          <strong>{metrics.assigned}</strong>
        </article>
      </div>

      <section className="panel price-list-filter-panel">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) =>
              setSearch(event.target.value)
            }
            placeholder="Search code, name, group, branch or note"
          />
        </div>

        <select
          value={currency}
          onChange={(event) =>
            setCurrency(event.target.value)
          }
        >
          <option value="">All currencies</option>
          <option value="USD">USD</option>
          <option value="KHR">KHR</option>
        </select>

        <select
          value={status}
          onChange={(event) =>
            setStatus(event.target.value)
          }
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="scheduled">Scheduled</option>
          <option value="expired">Expired</option>
          <option value="inactive">Inactive</option>
        </select>
      </section>

      <section className="price-list-card-grid">
        {loading ? (
          <div className="panel empty-state">
            <RefreshCw className="spin" />
            <p>Loading price lists...</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="panel empty-state">
            <BadgeDollarSign size={48} />
            <h2>No matching price lists</h2>
            <p>
              Create a list or change the filters.
            </p>
          </div>
        ) : visible.map((list) => {
          const state = listState(list);

          return (
            <article
              className="panel price-list-card"
              key={list.id}
            >
              <header>
                <div>
                  <span className={`price-list-state ${state}`}>
                    {state}
                  </span>
                  <h2>{list.name}</h2>
                  <strong>{list.code}</strong>
                </div>

                <button
                  type="button"
                  className="icon-button"
                  onClick={() => {
                    setEditing(list);
                    setFormOpen(true);
                  }}
                  title="Edit price list"
                >
                  <Edit3 size={18} />
                </button>
              </header>

              <div className="price-list-card-info">
                <div>
                  <span>Applies to</span>
                  <strong>
                    {priceListScopeLabel(list)}
                  </strong>
                </div>

                <div>
                  <span>Branch</span>
                  <strong>
                    {list.branches?.name || "All branches"}
                  </strong>
                </div>

                <div>
                  <span>Priority</span>
                  <strong>{list.priority}</strong>
                </div>

                <div>
                  <span>Unit prices</span>
                  <strong>
                    {list.price_list_items.length}
                  </strong>
                </div>

                <div>
                  <span>Assigned customers</span>
                  <strong>
                    {list.assigned_customer_count}
                  </strong>
                </div>
              </div>

              <div className="price-list-schedule">
                <span>
                  Starts: {dateTime(list.starts_at)}
                </span>
                <span>
                  Ends: {dateTime(list.ends_at)}
                </span>
              </div>

              {list.notes && (
                <p>{list.notes}</p>
              )}

              <footer>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setItemList(list)}
                >
                  <SlidersHorizontal size={17} />
                  Edit Unit Prices
                </button>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    setCustomerOpen(true)
                  }
                >
                  <UserRoundCheck size={17} />
                  Assign Customer
                </button>
              </footer>
            </article>
          );
        })}
      </section>

      <PriceListFormModal
        open={formOpen}
        priceList={editing}
        branches={formBranches}
        defaultBranchId={
          !canAllBranches
            ? profile.branch_id
            : ""
        }
        allowAllBranches={
          canAllBranches
        }
        busy={busy === "list"}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSubmit={handleSaveList}
      />

      <PriceListItemsModal
        priceList={itemList}
        products={products}
        busy={busy === "items"}
        onClose={() => setItemList(null)}
        onSubmit={handleSaveItems}
      />

      <CustomerPriceListModal
        open={customerOpen}
        customers={customers}
        priceLists={lists}
        busy={busy === "customer"}
        onClose={() => setCustomerOpen(false)}
        onSubmit={handleAssignCustomer}
      />
    </div>
  );
}
