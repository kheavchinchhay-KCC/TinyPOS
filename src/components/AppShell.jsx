import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Activity,
  ArrowLeftRight,
  BadgeDollarSign,
  Banknote,
  Barcode,
  BarChart3,
  BookOpenCheck,
  Boxes,
  Cable,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ClipboardCheck,
  ClipboardList,
  CloudOff,
  FileText,
  FileUp,
  Globe2,
  HandCoins,
  HeartHandshake,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  PackageCheck,
  ReceiptText,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Sun,
  Tags,
  TicketPercent,
  TrendingUp,
  UserCog,
  UsersRound,
  WalletCards,
  Warehouse,
  Clock3
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { switchMyBranch } from "../lib/staff";
import PwaManager from "./PwaManager";
import LanguageSwitcher from "./LanguageSwitcher";
import OfflineSyncManager from "./OfflineSyncManager";
import TinyPosLoader from "./TinyPosLoader";
import { useLanguage } from "../context/LanguageContext";

const navigationItems = {
  dashboard: { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, permission: "dashboard.view" },
  newSale: { to: "/sales", label: "New Sale", icon: ShoppingCart, permission: "sales.create" },
  offlineCheckout: { to: "/offline-checkout", label: "Offline Checkout", icon: CloudOff, permission: "offline_checkout.use" },
  quotations: { to: "/quotes", label: "Quotations", icon: FileText, permission: "quotations.manage" },
  salesOrders: { to: "/sales-orders", label: "Sales Orders", icon: PackageCheck, any: ["sales_orders.manage", "sales_orders.deliver"] },
  onlineStore: { to: "/online-store", label: "Online Store", icon: Globe2, any: ["online_store.manage", "online_orders.manage", "online_orders.fulfill"] },
  invoices: { to: "/invoices", label: "Invoice Center", icon: ReceiptText, permission: "invoices.view" },
  returns: { to: "/returns", label: "Returns & Refunds", icon: RotateCcw, permission: "returns.process" },
  customers: { to: "/customers", label: "Customers", icon: UsersRound, permission: "customers.manage" },
  crm: { to: "/crm", label: "CRM & Campaigns", icon: HeartHandshake, permission: "crm.view" },
  creditAccounts: { to: "/credit-accounts", label: "Credit Accounts", icon: BadgeDollarSign, any: ["credit_accounts.manage", "credit_accounts.collect"] },
  coupons: { to: "/coupons", label: "Coupons", icon: TicketPercent, permission: "coupons.manage" },
  priceLists: { to: "/price-lists", label: "Price Lists", icon: Tags, permission: "price_lists.manage" },
  products: { to: "/products", label: "Products", icon: Boxes, permission: "products.manage" },
  labels: { to: "/labels", label: "Barcode Labels", icon: Barcode, permission: "labels.print" },
  inventory: { to: "/inventory", label: "Inventory", icon: Warehouse, any: ["inventory.view", "inventory.adjust"] },
  batches: { to: "/batches", label: "Batch & Expiry", icon: CalendarClock, any: ["inventory.view", "inventory.adjust"] },
  stockCounts: { to: "/stock-counts", label: "Stock Count", icon: ClipboardCheck, permission: "stock_counts.manage" },
  transfers: { to: "/transfers", label: "Stock Transfers", icon: ArrowLeftRight, any: ["inventory.view", "transfers.create", "transfers.receive", "transfers.cancel", "transfers.edit", "transfers.count", "transfers.approve"] },
  purchaseOrders: { to: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList, any: ["purchases.manage", "purchases.receive", "purchases.cancel", "purchases.supplier_return"] },
  supplierPayables: { to: "/supplier-payables", label: "Supplier Payables", icon: HandCoins, any: ["supplier_payables.view", "supplier_payables.pay"] },
  reorder: { to: "/reorder", label: "Reorder Planner", icon: ListChecks, permission: "reorder.manage" },
  demandPlanning: { to: "/demand-planning", label: "Demand Planning", icon: TrendingUp, permission: "demand_planning.view" },
  cashExpenses: { to: "/cash-expenses", label: "Cash & Expenses", icon: WalletCards, any: ["cash_expenses.manage", "cash_expenses.void"] },
  cashRegister: { to: "/cash-register", label: "Cash Register", icon: Banknote, any: ["cash_register.use", "cash_register.close"] },
  reports: { to: "/reports", label: "Reports", icon: BarChart3, permission: "reports.view" },
  accounting: { to: "/accounting", label: "Accounting Center", icon: BookOpenCheck, permission: "accounting.view" },
  payroll: { to: "/payroll", label: "Payroll Center", icon: Landmark, any: ["payroll.view_self", "payroll.manage"] },
  staffBranches: { to: "/users", label: "Staff & Branches", icon: UserCog, permission: "staff.manage" },
  staffOperations: { to: "/staff-operations", label: "Attendance & Commission", icon: Clock3, any: ["staff_operations.self", "attendance.manage", "commissions.manage"] },
  accessControl: { to: "/access-control", label: "Access & Approvals", icon: KeyRound, any: ["access.manage", "approvals.review"] },
  adminTools: { to: "/admin-tools", label: "Audit & Backup", icon: ShieldCheck, permission: "audit_backup.manage" },
  systemHealth: { to: "/system-health", label: "System Health", icon: Activity, permission: "system_health.manage" },
  importCenter: { to: "/import-center", label: "Import Center", icon: FileUp, permission: "import.manage" },
  telegram: { to: "/telegram", label: "Telegram", icon: Send, permission: "telegram.use" },
  integrations: { to: "/integrations", label: "Integration & API Center", icon: Cable, permission: "integrations.view" },
  settings: { to: "/settings", label: "Settings", icon: Settings, permission: "settings.view" }
};

const standaloneKeys = ["dashboard", "newSale"];

const navigationGroups = [
  {
    id: "sales",
    label: "Sales",
    icon: ReceiptText,
    items: ["offlineCheckout", "quotations", "salesOrders", "onlineStore", "invoices", "returns"]
  },
  {
    id: "customers",
    label: "Customers & Marketing",
    icon: UsersRound,
    items: ["customers", "crm", "creditAccounts", "coupons"]
  },
  {
    id: "products",
    label: "Products & Inventory",
    icon: Boxes,
    items: ["products", "priceLists", "labels", "inventory", "batches", "stockCounts", "transfers", "reorder", "demandPlanning"]
  },
  {
    id: "purchasing",
    label: "Purchasing",
    icon: ClipboardList,
    items: ["purchaseOrders", "supplierPayables"]
  },
  {
    id: "cash-accounting",
    label: "Cash & Accounting",
    icon: Banknote,
    items: ["cashExpenses", "cashRegister", "accounting"]
  },
  {
    id: "staff",
    label: "Staff",
    icon: UserCog,
    items: ["staffOperations", "payroll", "staffBranches", "accessControl"]
  },
  {
    id: "reports",
    label: "Reports",
    icon: BarChart3,
    items: ["reports"]
  },
  {
    id: "system",
    label: "Integrations & Settings",
    icon: Settings,
    items: ["telegram", "integrations", "importCenter", "adminTools", "systemHealth", "settings"]
  }
];

function isLinkAllowed(link, can, canAny) {
  if (link.permission) return can(link.permission);
  if (link.any) return canAny(link.any);
  return true;
}

export default function AppShell() {
  const { t } = useLanguage();
  const location = useLocation();
  const { supabase, session, profile, shop, preferences, can, canAny, signOut, savePreferencePatch } = useAuth();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("tiny-pos-sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [openGroup, setOpenGroup] = useState(() => {
    try {
      return window.localStorage.getItem("tiny-pos-sidebar-group") || "";
    } catch {
      return "";
    }
  });
  const [flyoutGroup, setFlyoutGroup] = useState("");
  const [flyoutPosition, setFlyoutPosition] = useState({ top: 84, left: 94 });
  const groupButtonRefs = useRef(new Map());
  const [branches, setBranches] = useState([]);
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [switchingTheme, setSwitchingTheme] = useState(false);

  const standaloneLinks = useMemo(
    () => standaloneKeys.map((key) => navigationItems[key]).filter((link) => isLinkAllowed(link, can, canAny)),
    [can, canAny]
  );

  const visibleGroups = useMemo(
    () => navigationGroups
      .map((group) => ({
        ...group,
        links: group.items
          .map((key) => navigationItems[key])
          .filter((link) => isLinkAllowed(link, can, canAny))
      }))
      .filter((group) => group.links.length > 0),
    [can, canAny]
  );

  const activeGroupId = useMemo(
    () => visibleGroups.find((group) => group.links.some((link) => location.pathname === link.to || location.pathname.startsWith(`${link.to}/`)))?.id || "",
    [location.pathname, visibleGroups]
  );

  const flyoutNavigationGroup = useMemo(
    () => visibleGroups.find((group) => group.id === flyoutGroup) || null,
    [flyoutGroup, visibleGroups]
  );

  const canSwitchBranch = can("branches.switch");

  useEffect(() => {
    if (!activeGroupId) return;
    setOpenGroup(activeGroupId);
  }, [activeGroupId]);

  useEffect(() => {
    setFlyoutGroup("");
  }, [location.pathname]);

  useEffect(() => {
    if (!collapsed) setFlyoutGroup("");
  }, [collapsed]);

  useEffect(() => {
    if (!flyoutGroup) return undefined;

    const refreshPosition = () => {
      const button = groupButtonRefs.current.get(flyoutGroup);
      if (!button) return;

      const rect = button.getBoundingClientRect();
      const group = visibleGroups.find((entry) => entry.id === flyoutGroup);
      const estimatedHeight = Math.min(
        82 + ((group?.links.length || 1) * 46),
        window.innerHeight * 0.74
      );
      const top = Math.max(
        12,
        Math.min(rect.top, window.innerHeight - estimatedHeight - 12)
      );
      const left = Math.min(rect.right + 10, window.innerWidth - 292);

      setFlyoutPosition({ top, left: Math.max(92, left) });
    };

    refreshPosition();
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);

    const onKeyDown = (event) => {
      if (event.key === "Escape") setFlyoutGroup("");
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [flyoutGroup, visibleGroups]);

  useEffect(() => {
    try {
      window.localStorage.setItem("tiny-pos-sidebar-collapsed", collapsed ? "1" : "0");
    } catch {
      // Sidebar preference is optional.
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem("tiny-pos-sidebar-group", openGroup);
    } catch {
      // Navigation preference is optional.
    }
  }, [openGroup]);

  useEffect(() => {
    if (!supabase || !profile?.organization_id || !canSwitchBranch) {
      setBranches([]);
      return;
    }

    let active = true;

    (async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("id,name,code,is_active")
        .eq("organization_id", profile.organization_id)
        .eq("is_active", true)
        .order("name");

      if (!active || error) return;
      setBranches(data || []);
    })();

    return () => {
      active = false;
    };
  }, [supabase, profile?.organization_id, canSwitchBranch]);

  async function handleSignOut() {
    try {
      await signOut();
    } catch (error) {
      window.alert(error.message);
    }
  }

  async function handleBranchChange(event) {
    const branchId = event.target.value;
    if (!branchId || branchId === profile.branch_id) return;

    try {
      setSwitchingBranch(true);
      await switchMyBranch(session, branchId);
      window.location.reload();
    } catch (error) {
      window.alert(error.message);
      setSwitchingBranch(false);
    }
  }


  const effectiveTheme = (() => {
    const selected = preferences?.theme || preferences?.theme_mode || "system";
    if (selected === "dark" || selected === "light") return selected;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  })();

  async function toggleTheme() {
    if (switchingTheme) return;
    const previous = effectiveTheme;
    const next = previous === "dark" ? "light" : "dark";
    const root = document.documentElement;

    // Apply immediately so the one-tap button feels instant, then persist only
    // the theme field. The shared preference state keeps Settings in sync.
    root.dataset.theme = next;
    root.dataset.forceTheme = next;
    setSwitchingTheme(true);

    try {
      await savePreferencePatch({ theme: next });
    } catch (error) {
      root.dataset.theme = previous;
      root.dataset.forceTheme = previous;
      window.alert(error.message || "Unable to change theme.");
    } finally {
      setSwitchingTheme(false);
    }
  }

  function handleGroupToggle(groupId) {
    if (collapsed && window.innerWidth > 800) {
      setFlyoutGroup((current) => (current === groupId ? "" : groupId));
      return;
    }

    setFlyoutGroup("");
    setOpenGroup((current) => (current === groupId ? "" : groupId));
  }

  function closeMobileMenu() {
    setOpen(false);
  }

  const FlyoutGroupIcon = flyoutNavigationGroup?.icon || Settings;

  return (
    <div className={`shell ${collapsed ? "collapsed" : ""}`}>
      {switchingBranch && <TinyPosLoader overlay label={t("Switching branch…")} />}
      <aside className={open ? "side open" : "side"}>
        <div className="brand">
          <img
            className="side-app-logo"
            src="/icons/tiny-pos-brand.png"
            alt="Tiny POS"
          />
          <span className="side-label" data-i18n-skip>{shop?.shop_name || "Tiny POS"}</span>
          <button
            type="button"
            className="side-mobile-close"
            onClick={closeMobileMenu}
            aria-label={t("Close menu")}
          >
            <ChevronLeft size={22} />
          </button>
        </div>

        <nav className="side-nav-scroll" aria-label={t("Main navigation")}>
          <div className="side-primary-links side-nav-items">
            {standaloneLinks.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={closeMobileMenu}
                title={collapsed ? t(label) : undefined}
                className={({ isActive }) => [
                  label === "New Sale" ? "side-new-sale-link" : "",
                  isActive ? "active" : ""
                ].filter(Boolean).join(" ")}
              >
                <Icon size={21} />
                <span className="side-label">{t(label)}</span>
              </NavLink>
            ))}
          </div>

          <div className="side-menu-groups side-nav-items">
            {visibleGroups.map((group) => {
              const GroupIcon = group.icon;
              const expanded = openGroup === group.id;
              const active = activeGroupId === group.id;

              return (
                <section className={`side-menu-group ${expanded ? "open" : ""} ${active ? "active" : ""} ${flyoutGroup === group.id ? "flyout-open" : ""}`} key={group.id}>
                  <button
                    type="button"
                    className="side-group-button"
                    ref={(node) => {
                      if (node) groupButtonRefs.current.set(group.id, node);
                      else groupButtonRefs.current.delete(group.id);
                    }}
                    onClick={() => handleGroupToggle(group.id)}
                    aria-expanded={collapsed ? flyoutGroup === group.id : expanded}
                    aria-controls={`side-group-${group.id}`}
                    title={collapsed ? t(group.label) : undefined}
                  >
                    <GroupIcon size={21} />
                    <span className="side-label">{t(group.label)}</span>
                    <ChevronDown className="side-group-chevron side-label" size={18} />
                  </button>

                  <div id={`side-group-${group.id}`} className="side-submenu" hidden={!expanded}>
                    {group.links.map(({ to, label, icon: Icon }) => (
                      <NavLink
                        key={to}
                        to={to}
                        onClick={closeMobileMenu}
                        className={({ isActive }) => (isActive ? "active" : "")}
                      >
                        <Icon size={18} />
                        <span className="side-label">{t(label)}</span>
                      </NavLink>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <button
            type="button"
            className="side-collapse-control desktop-only"
            onClick={() => setCollapsed((value) => !value)}
            title={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
            aria-label={collapsed ? t("Expand sidebar") : t("Collapse sidebar")}
          >
            <ChevronLeft className="side-collapse-chevron" size={19} />
            <span className="side-collapse-label">{t("Collapse")}</span>
          </button>
        </nav>

        <div className="side-footer">
          <div className="side-account side-label">
            <strong data-i18n-skip>{profile?.full_name || t("Owner")}</strong>
            <small data-i18n-skip>{profile?.custom_staff_roles?.name || t(profile?.role || "Owner")}</small>
          </div>

          <button type="button" className="logout" onClick={handleSignOut} title={collapsed ? t("Log out") : undefined}>
            <LogOut size={20} />
            <span className="side-label">{t("Log out")}</span>
          </button>
        </div>
      </aside>

      {collapsed && flyoutNavigationGroup && typeof document !== "undefined" && createPortal(
        <>
          <button
            type="button"
            className="side-flyout-dismiss"
            aria-label={t("Close menu")}
            onClick={() => setFlyoutGroup("")}
          />
          <nav
            className="side-collapsed-flyout"
            style={{ top: flyoutPosition.top, left: flyoutPosition.left }}
            aria-label={t(flyoutNavigationGroup.label)}
          >
            <header>
              <FlyoutGroupIcon size={21} />
              <strong>{t(flyoutNavigationGroup.label)}</strong>
            </header>
            <div className="side-collapsed-flyout-links">
              {flyoutNavigationGroup.links.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setFlyoutGroup("")}
                  className={({ isActive }) => (isActive ? "active" : "")}
                >
                  <Icon size={18} />
                  <span>{t(label)}</span>
                </NavLink>
              ))}
            </div>
          </nav>
        </>,
        document.body
      )}

      {open && (
        <button type="button" className="backdrop" aria-label={t("Close menu")} onClick={closeMobileMenu} />
      )}

      <main>
        <header>
          <button type="button" className="menu" onClick={() => setOpen(true)} aria-label={t("Open menu")}>
            <Menu />
          </button>

          {canSwitchBranch && branches.length > 1 ? (
            <label className="header-branch-switcher">
              <Store size={18} />
              <select value={profile?.branch_id || ""} onChange={handleBranchChange} disabled={switchingBranch} aria-label={t("Switch active branch")}>
                {branches.map((branch) => (
                  <option value={branch.id} key={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <div>
              <Store size={18} />
              {profile?.branches?.name || "Main Branch"}
            </div>
          )}

          <div className="header-appearance-controls">
            <button
              type="button"
              className="header-theme-toggle"
              onClick={toggleTheme}
              disabled={switchingTheme}
              aria-label={effectiveTheme === "dark" ? t("Use light theme") : t("Use dark theme")}
              title={effectiveTheme === "dark" ? t("Use light theme") : t("Use dark theme")}
            >
              {effectiveTheme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <LanguageSwitcher compact />
          </div>

          <strong data-i18n-skip>
            {profile?.full_name || t("Owner")} · {profile?.custom_staff_roles?.name || t(profile?.role || "Owner")}
          </strong>
        </header>

        <PwaManager />
        <OfflineSyncManager />

        <section key={location.pathname} className="content route-slide-content" data-i18n-auto><Outlet /></section>
      </main>
    </div>
  );
}
