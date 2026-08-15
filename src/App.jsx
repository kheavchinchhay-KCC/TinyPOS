import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { useLanguage } from "./context/LanguageContext";
import ProtectedRoute from "./components/ProtectedRoute";
import TinyPosLoader from "./components/TinyPosLoader";
import PermissionRoute from "./components/PermissionRoute";
import AppShell from "./components/AppShell";
// Login and the public storefront are the first things an unauthenticated
// visitor sees, so they stay in the main bundle. Every other page is behind
// auth/permission checks and is only ever needed after login, so each one
// is loaded on demand as its own chunk instead of bloating the initial
// bundle every visitor has to download up front.
import LoginPage from "./pages/LoginPage";
import PublicStorefrontPage from "./pages/PublicStorefrontPage";

const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const SalesPage = lazy(() => import("./pages/SalesPage"));
const ReturnsPage = lazy(() => import("./pages/ReturnsPage"));
const CustomersPage = lazy(() => import("./pages/CustomersPage"));
const UsersPage = lazy(() => import("./pages/UsersPage"));
const ReportsPage = lazy(() => import("./pages/ReportsPage"));
const CashExpensesPage = lazy(() => import("./pages/CashExpensesPage"));
const TransfersPage = lazy(() => import("./pages/TransfersPage"));
const PurchaseOrdersPage = lazy(() => import("./pages/PurchaseOrdersPage"));
const LabelsPage = lazy(() => import("./pages/LabelsPage"));
const ProductsPage = lazy(() => import("./pages/ProductsPage"));
const InventoryPage = lazy(() => import("./pages/InventoryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AdminToolsPage = lazy(() => import("./pages/AdminToolsPage"));
const CouponsPage = lazy(() => import("./pages/CouponsPage"));
const CashRegisterPage = lazy(() => import("./pages/CashRegisterPage"));
const ReorderPage = lazy(() => import("./pages/ReorderPage"));
const StockCountsPage = lazy(() => import("./pages/StockCountsPage"));
const ImportCenterPage = lazy(() => import("./pages/ImportCenterPage"));
const CreditAccountsPage = lazy(() => import("./pages/CreditAccountsPage"));
const QuotesPage = lazy(() => import("./pages/QuotesPage"));
const PriceListsPage = lazy(() => import("./pages/PriceListsPage"));
const InvoicesPage = lazy(() => import("./pages/InvoicesPage"));
const SupplierPayablesPage = lazy(() => import("./pages/SupplierPayablesPage"));
const TelegramPage = lazy(() => import("./pages/TelegramPage"));
const PermissionsPage = lazy(() => import("./pages/PermissionsPage"));
const BatchesPage = lazy(() => import("./pages/BatchesPage"));
const SalesOrdersPage = lazy(() => import("./pages/SalesOrdersPage"));
const SystemHealthPage = lazy(() => import("./pages/SystemHealthPage"));
const StaffOperationsPage = lazy(() => import("./pages/StaffOperationsPage"));
const AccountingPage = lazy(() => import("./pages/AccountingPage"));
const PayrollPage = lazy(() => import("./pages/PayrollPage"));
const OnlineStorePage = lazy(() => import("./pages/OnlineStorePage"));
const OfflineCheckoutPage = lazy(() => import("./pages/OfflineCheckoutPage"));
const CustomerCrmPage = lazy(() => import("./pages/CustomerCrmPage"));
const DemandPlanningPage = lazy(() => import("./pages/DemandPlanningPage"));
const IntegrationCenterPage = lazy(() => import("./pages/IntegrationCenterPage"));

export default function App() {
  const { loading } = useAuth();
  const { t } = useLanguage();

  if (loading) {
    return <TinyPosLoader label={t("Loading Tiny POS…")} />;
  }

  return (
    <Suspense fallback={<TinyPosLoader label={t("Loading Tiny POS…")} />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/shop/:slug" element={<PublicStorefrontPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<PermissionRoute permission="dashboard.view"><DashboardPage /></PermissionRoute>} />
        <Route path="/sales" element={<PermissionRoute permission="sales.create"><SalesPage /></PermissionRoute>} />
        <Route path="/offline-checkout" element={<PermissionRoute permission="offline_checkout.use"><OfflineCheckoutPage /></PermissionRoute>} />
        <Route path="/quotes" element={<PermissionRoute permission="quotations.manage"><QuotesPage /></PermissionRoute>} />
        <Route path="/sales-orders" element={<PermissionRoute any={["sales_orders.manage","sales_orders.deliver"]}><SalesOrdersPage /></PermissionRoute>} />
        <Route path="/online-store" element={<PermissionRoute any={["online_store.manage","online_orders.manage","online_orders.fulfill"]}><OnlineStorePage /></PermissionRoute>} />
        <Route path="/invoices" element={<PermissionRoute permission="invoices.view"><InvoicesPage /></PermissionRoute>} />
        <Route path="/returns" element={<PermissionRoute permission="returns.process"><ReturnsPage /></PermissionRoute>} />
        <Route path="/customers" element={<PermissionRoute permission="customers.manage"><CustomersPage /></PermissionRoute>} />
        <Route path="/crm" element={<PermissionRoute permission="crm.view"><CustomerCrmPage /></PermissionRoute>} />
        <Route path="/credit-accounts" element={<PermissionRoute any={["credit_accounts.manage","credit_accounts.collect"]}><CreditAccountsPage /></PermissionRoute>} />
        <Route path="/coupons" element={<PermissionRoute permission="coupons.manage"><CouponsPage /></PermissionRoute>} />
        <Route path="/price-lists" element={<PermissionRoute permission="price_lists.manage"><PriceListsPage /></PermissionRoute>} />
        <Route path="/users" element={<PermissionRoute permission="staff.manage"><UsersPage /></PermissionRoute>} />
        <Route path="/staff-operations" element={<PermissionRoute any={["staff_operations.self","attendance.manage","commissions.manage","leave.request","leave.manage"]}><StaffOperationsPage /></PermissionRoute>} />
        <Route path="/reports" element={<PermissionRoute permission="reports.view"><ReportsPage /></PermissionRoute>} />
        <Route path="/accounting" element={<PermissionRoute permission="accounting.view"><AccountingPage /></PermissionRoute>} />
        <Route path="/payroll" element={<PermissionRoute any={["payroll.view_self","payroll.manage"]}><PayrollPage /></PermissionRoute>} />
        <Route path="/cash-expenses" element={<PermissionRoute any={["cash_expenses.manage","cash_expenses.void"]}><CashExpensesPage /></PermissionRoute>} />
        <Route path="/cash-register" element={<PermissionRoute any={["cash_register.use","cash_register.close"]}><CashRegisterPage /></PermissionRoute>} />
        <Route path="/transfers" element={<PermissionRoute any={["inventory.view","transfers.create","transfers.receive","transfers.cancel","transfers.edit","transfers.count","transfers.approve"]}><TransfersPage /></PermissionRoute>} />
        <Route path="/purchase-orders" element={<PermissionRoute any={["purchases.manage","purchases.receive","purchases.cancel","purchases.supplier_return"]}><PurchaseOrdersPage /></PermissionRoute>} />
        <Route path="/supplier-payables" element={<PermissionRoute any={["supplier_payables.view","supplier_payables.pay"]}><SupplierPayablesPage /></PermissionRoute>} />
        <Route path="/reorder" element={<PermissionRoute permission="reorder.manage"><ReorderPage /></PermissionRoute>} />
        <Route path="/demand-planning" element={<PermissionRoute permission="demand_planning.view"><DemandPlanningPage /></PermissionRoute>} />
        <Route path="/labels" element={<PermissionRoute permission="labels.print"><LabelsPage /></PermissionRoute>} />
        <Route path="/products" element={<PermissionRoute permission="products.manage"><ProductsPage /></PermissionRoute>} />
        <Route path="/inventory" element={<PermissionRoute any={["inventory.view","inventory.adjust"]}><InventoryPage /></PermissionRoute>} />
        <Route path="/batches" element={<PermissionRoute any={["inventory.view","inventory.adjust"]}><BatchesPage /></PermissionRoute>} />
        <Route path="/stock-counts" element={<PermissionRoute permission="stock_counts.manage"><StockCountsPage /></PermissionRoute>} />
        <Route path="/settings" element={<PermissionRoute permission="settings.view"><SettingsPage /></PermissionRoute>} />
        <Route path="/telegram" element={<PermissionRoute permission="telegram.use"><TelegramPage /></PermissionRoute>} />
        <Route path="/integrations" element={<PermissionRoute permission="integrations.view"><IntegrationCenterPage /></PermissionRoute>} />
        <Route path="/access-control" element={<PermissionRoute any={["access.manage","approvals.review"]}><PermissionsPage /></PermissionRoute>} />
        <Route path="/admin-tools" element={<PermissionRoute permission="audit_backup.manage"><AdminToolsPage /></PermissionRoute>} />
        <Route path="/system-health" element={<PermissionRoute permission="system_health.manage"><SystemHealthPage /></PermissionRoute>} />
        <Route path="/import-center" element={<PermissionRoute permission="import.manage"><ImportCenterPage /></PermissionRoute>} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
    </Suspense>
  );
}
