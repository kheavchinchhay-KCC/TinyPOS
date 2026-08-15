import {
  Bell,
  Bot,
  CheckCircle2,
  ExternalLink,
  Link2,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Unlink,
  UsersRound
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { useAuth } from "../context/AuthContext";
import {
  createTelegramLinkCode,
  disconnectTelegram,
  isTelegramMiniApp,
  openTelegramUrl,
  saveTelegramPreferences,
  telegramAdminRequest,
  telegramDateTime,
  telegramLinkUrl,
  telegramUnsafeUser,
  telegramWebApp
} from "../lib/telegram";

const preferenceFields = [
  ["stock_alerts", "Stock alerts", "Low-stock and out-of-stock products"],
  ["forecast_alerts", "Forecast alerts", "Daily demand risks and purchase suggestions"],
  ["sale_alerts", "Completed sales", "Cashier sale receipts for the seller and relevant managers"],
  ["sales_summary", "Daily sales summary", "Daily transaction, refund, USD and KHR totals"],
  ["credit_alerts", "Customer credit", "Overdue credit invoices and balances"],
  ["supplier_alerts", "Supplier payables", "Due and overdue supplier balances"],
  ["purchase_alerts", "Purchase deliveries", "Orders that are past the expected delivery date"],
  ["transfer_alerts", "Stock transfers", "Pending inbound and outbound transfers"],
  ["quotation_alerts", "Quotations", "Customer quotations expiring soon"],
  ["sales_order_alerts", "Sales orders", "Due and overdue reserved customer deliveries"],
  ["online_order_alerts", "Online orders", "New customer web orders waiting for review"],
  ["cash_register_alerts", "Cash register", "Long-open registers and closing variances"],
  ["attendance_alerts", "Attendance", "Forgotten check-outs and long-open staff sessions"],
  ["leave_alerts", "Take Leave", "New, approved, rejected and cancelled leave requests"],
  ["payroll_alerts", "Payroll alerts", "Pending payroll approvals and salary payments"],
  ["integration_alerts", "Integration alerts", "Dead webhooks and API server failures"],
  ["system_alerts", "System alerts", "Reserved for backup and service errors"]
];

export default function TelegramPage() {
  const {
    supabase,
    session,
    profile,
    can
  } = useAuth();

  const [status, setStatus] = useState(null);
  const [preferences, setPreferences] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [staffLinks, setStaffLinks] = useState([]);
  const [linkCode, setLinkCode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const insideTelegram = isTelegramMiniApp();
  const unsafeTelegramUser = telegramUnsafeUser();
  const canAdmin = can("telegram.admin");

  const refresh = useCallback(async () => {
    if (!supabase || !session || !profile?.id) return;

    try {
      setLoading(true);

      const [botStatus, deliveryResult, staffResult] = await Promise.all([
        telegramAdminRequest(session, "status"),
        supabase
          .from("telegram_notification_deliveries")
          .select("id,event_type,status,message_text,error_message,created_at,sent_at")
          .eq("user_id", profile.id)
          .order("created_at", { ascending: false })
          .limit(15),
        canAdmin
          ? supabase
              .from("telegram_user_links")
              .select(`
                id,
                user_id,
                username,
                first_name,
                is_active,
                linked_at,
                last_seen_at,
                profiles!inner(full_name,role,branch_id,branches(name,code))
              `)
              .eq("organization_id", profile.organization_id)
              .order("linked_at", { ascending: false })
          : Promise.resolve({ data: [], error: null })
      ]);

      if (deliveryResult.error) throw deliveryResult.error;
      if (staffResult.error) throw staffResult.error;

      setStatus(botStatus);
      setPreferences(botStatus.preferences);
      setDeliveries(deliveryResult.data || []);
      setStaffLinks(staffResult.data || []);
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [
    supabase,
    session,
    profile,
    canAdmin
  ]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deepLink = useMemo(() => {
    if (!status?.bot?.username || !linkCode?.code) return "";
    return telegramLinkUrl(
      status.bot.username,
      linkCode.code
    );
  }, [status?.bot?.username, linkCode]);

  function announce(type, text) {
    setMessageType(type);
    setMessage(text);
  }

  async function connectCurrentMiniApp() {
    const app = telegramWebApp();

    if (!app?.initData) {
      announce(
        "error",
        "Open Tiny POS from the Telegram bot before using one-click connection."
      );
      return;
    }

    try {
      setBusy("link-mini-app");
      await telegramAdminRequest(
        session,
        "link-mini-app",
        { init_data: app.initData }
      );
      announce(
        "success",
        "This Telegram account is now connected to your POS user."
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function createCode() {
    try {
      setBusy("code");
      const result = await createTelegramLinkCode(supabase);
      setLinkCode(result);
      announce(
        "success",
        "A one-time Telegram link code was created. It expires in 10 minutes."
      );
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function savePreferences() {
    try {
      setBusy("preferences");
      const result = await saveTelegramPreferences(
        supabase,
        preferences
      );
      setPreferences(result);
      announce(
        "success",
        "Telegram notification settings saved."
      );
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function disconnect() {
    const confirmed = window.confirm(
      "Disconnect Telegram notifications from this POS user?"
    );
    if (!confirmed) return;

    try {
      setBusy("disconnect");
      await disconnectTelegram(supabase);
      setLinkCode(null);
      announce(
        "success",
        "Telegram disconnected. You may reconnect at any time."
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function setupBot() {
    try {
      setBusy("setup");
      await telegramAdminRequest(session, "setup");
      announce(
        "success",
        "Telegram webhook, Mini App menu button, and bot commands are configured."
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  async function sendTest() {
    try {
      setBusy("test");
      await telegramAdminRequest(session, "test");
      announce(
        "success",
        "Test message sent to your Telegram account."
      );
      await refresh();
    } catch (error) {
      announce("error", error.message);
    } finally {
      setBusy("");
    }
  }

  function updatePreference(name, value) {
    setPreferences((current) => ({
      ...(current || {}),
      [name]: value
    }));
  }

  const linked = Boolean(status?.link?.is_active);

  return (
    <div className="page-stack telegram-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CONNECTED POS</p>
          <h1>Telegram Mini App</h1>
          <p className="muted">
            Open Tiny POS inside Telegram and route operational messages to the relevant branch users.
          </p>
        </div>

        <div className="page-heading-actions">
          {status?.bot?.username && (
            <button
              type="button"
              className="primary-button"
              onClick={() => openTelegramUrl(
                `https://t.me/${status.bot.username}`
              )}
            >
              <MessageCircle size={18} />
              Open @{status.bot.username}
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

      <div className="telegram-status-grid">
        <article>
          <Bot size={22} />
          <span>Bot</span>
          <strong>
            {status?.bot?.username
              ? `@${status.bot.username}`
              : "Not configured"}
          </strong>
          <small>
            {status?.webhook?.configured
              ? "Webhook connected"
              : "Webhook not connected"}
          </small>
        </article>

        <article>
          <Smartphone size={22} />
          <span>Current app</span>
          <strong>
            {insideTelegram
              ? "Telegram Mini App"
              : "Web browser / PWA"}
          </strong>
          <small>
            {insideTelegram && unsafeTelegramUser
              ? `${unsafeTelegramUser.first_name || "Telegram user"}${unsafeTelegramUser.username ? ` · @${unsafeTelegramUser.username}` : ""}`
              : "Both access methods are supported"}
          </small>
        </article>

        <article>
          <Link2 size={22} />
          <span>Your connection</span>
          <strong>
            {linked ? "Connected" : "Not connected"}
          </strong>
          <small>
            {linked
              ? `Linked ${telegramDateTime(status.link.linked_at)}`
              : "Connect to receive personal alerts"}
          </small>
        </article>

        <article>
          <Bell size={22} />
          <span>Delivery schedule</span>
          <strong>Every 15 minutes</strong>
          <small>
            Daily summaries follow your selected local hour
          </small>
        </article>
      </div>

      <section className="panel telegram-connect-panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">YOUR ACCOUNT</p>
            <h2>Connect Telegram</h2>
          </div>
          {linked
            ? <CheckCircle2 size={24} />
            : <Link2 size={24} />}
        </div>

        {linked ? (
          <div className="telegram-linked-card">
            <div>
              <strong>
                {status.link.first_name || "Telegram user"}
                {status.link.username
                  ? ` · @${status.link.username}`
                  : ""}
              </strong>
              <span>
                Last seen {telegramDateTime(status.link.last_seen_at)}
              </span>
            </div>

            <div className="telegram-linked-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={sendTest}
                disabled={busy === "test"}
              >
                <Send size={17} />
                {busy === "test" ? "Sending..." : "Send test"}
              </button>

              <button
                type="button"
                className="danger-button"
                onClick={disconnect}
                disabled={busy === "disconnect"}
              >
                <Unlink size={17} />
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="telegram-connect-options">
            {insideTelegram && (
              <article>
                <Smartphone size={25} />
                <div>
                  <strong>One-click Mini App connection</strong>
                  <span>
                    Securely validate the Telegram account that opened this Mini App.
                  </span>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={connectCurrentMiniApp}
                  disabled={busy === "link-mini-app"}
                >
                  Connect this Telegram
                </button>
              </article>
            )}

            <article>
              <ExternalLink size={25} />
              <div>
                <strong>Connect from a normal browser</strong>
                <span>
                  Create a one-time code, then open the bot or send /link CODE.
                </span>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={createCode}
                disabled={busy === "code"}
              >
                Create link code
              </button>
            </article>

            {linkCode && (
              <div className="telegram-code-card">
                <span>One-time code</span>
                <strong>{linkCode.code}</strong>
                <small>
                  Expires {telegramDateTime(linkCode.expires_at)}
                </small>

                {deepLink && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => openTelegramUrl(deepLink)}
                  >
                    Open bot and connect
                  </button>
                )}

                <code>/link {linkCode.code}</code>
              </div>
            )}
          </div>
        )}
      </section>

      {preferences && (
        <section className="panel telegram-preferences-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">RELEVANT MESSAGES</p>
              <h2>Notification settings</h2>
              <span className="muted">
                Messages are filtered by your active role and branch before delivery.
              </span>
            </div>
            <Bell size={23} />
          </div>

          <div className="telegram-preference-list">
            {preferenceFields.map(([key, label, description]) => (
              <label className="form-check form-switch" key={key}>
                <input
                  className="form-check-input"
                  type="checkbox"
                  checked={Boolean(preferences[key])}
                  onChange={(event) =>
                    updatePreference(key, event.target.checked)
                  }
                />
                <span className="form-check-label">
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </div>

          <div className="form-grid three telegram-time-settings">
            <label>
              <span>Daily summary hour</span>
              <select
                value={preferences.daily_summary_hour}
                onChange={(event) =>
                  updatePreference(
                    "daily_summary_hour",
                    Number(event.target.value)
                  )
                }
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option value={hour} key={hour}>
                    {String(hour).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Quiet hours start</span>
              <select
                value={preferences.quiet_start_hour ?? ""}
                onChange={(event) =>
                  updatePreference(
                    "quiet_start_hour",
                    event.target.value === ""
                      ? null
                      : Number(event.target.value)
                  )
                }
              >
                <option value="">Disabled</option>
                {Array.from({ length: 24 }, (_, hour) => (
                  <option value={hour} key={hour}>
                    {String(hour).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Quiet hours end</span>
              <select
                value={preferences.quiet_end_hour ?? ""}
                onChange={(event) =>
                  updatePreference(
                    "quiet_end_hour",
                    event.target.value === ""
                      ? null
                      : Number(event.target.value)
                  )
                }
              >
                <option value="">Disabled</option>
                {Array.from({ length: 24 }, (_, hour) => (
                  <option value={hour} key={hour}>
                    {String(hour).padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </label>
          </div>

          {canAdmin && (
            <label className="form-check form-switch telegram-all-branches">
              <input
                className="form-check-input"
                type="checkbox"
                checked={Boolean(preferences.all_branches)}
                onChange={(event) =>
                  updatePreference("all_branches", event.target.checked)
                }
              />
              <span className="form-check-label">
                <strong>Receive alerts for all branches</strong>
                <small>
                  Owner/admin only. Disabled means current assigned branch.
                </small>
              </span>
            </label>
          )}

          <div className="panel-actions">
            <button
              type="button"
              className="primary-button"
              onClick={savePreferences}
              disabled={busy === "preferences"}
            >
              Save notification settings
            </button>
          </div>
        </section>
      )}

      {canAdmin && (
        <section className="panel telegram-admin-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">OWNER / ADMIN</p>
              <h2>Bot setup</h2>
            </div>
            <ShieldCheck size={23} />
          </div>

          <p className="muted">
            Setup connects the secure webhook, creates the default Open Tiny POS menu button, and registers bot commands.
          </p>

          <div className="telegram-admin-actions">
            <button
              type="button"
              className="primary-button"
              onClick={setupBot}
              disabled={busy === "setup"}
            >
              <Bot size={18} />
              {busy === "setup" ? "Configuring..." : "Configure Telegram bot"}
            </button>

            <span>
              Webhook: {status?.webhook?.configured ? "Connected" : "Not connected"}
            </span>
          </div>

          {!status?.webhook?.configured && status?.webhook?.url && (
            <div className="notice error">
              Telegram is using a different webhook URL: {status.webhook.url}. Press Configure Telegram bot to replace it with {status.webhook.expected_url}.
            </div>
          )}

          {status?.webhook?.last_error_message && (
            <div className="notice error">
              Telegram webhook error: {status.webhook.last_error_message}
            </div>
          )}
        </section>
      )}

      <section className="panel telegram-history-panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">DELIVERY HISTORY</p>
            <h2>Your recent Telegram messages</h2>
          </div>
          <Send size={22} />
        </div>

        {deliveries.length === 0 ? (
          <p className="muted">No notification delivery history yet.</p>
        ) : (
          <div className="telegram-delivery-list">
            {deliveries.map((delivery) => (
              <article key={delivery.id}>
                <span className={`status-pill ${delivery.status === "sent" ? "active" : "inactive"}`}>
                  {delivery.status}
                </span>
                <div>
                  <strong>{delivery.event_type.replaceAll("_", " ")}</strong>
                  <span>{delivery.message_text.replace(/<[^>]+>/g, "").split("\n")[0]}</span>
                </div>
                <small>
                  {telegramDateTime(delivery.sent_at || delivery.created_at)}
                </small>
              </article>
            ))}
          </div>
        )}
      </section>

      {canAdmin && (
        <section className="panel telegram-staff-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">LINKED STAFF</p>
              <h2>Telegram connections</h2>
            </div>
            <UsersRound size={23} />
          </div>

          {staffLinks.length === 0 ? (
            <p className="muted">No staff Telegram accounts connected.</p>
          ) : (
            <div className="telegram-staff-list">
              {staffLinks.map((link) => (
                <article key={link.id}>
                  <div>
                    <strong>{link.profiles?.full_name}</strong>
                    <span>
                      {link.profiles?.role} · {link.profiles?.branches?.name || "No branch"}
                    </span>
                  </div>
                  <div>
                    <strong>
                      {link.username ? `@${link.username}` : link.first_name || "Telegram user"}
                    </strong>
                    <span>
                      Last seen {telegramDateTime(link.last_seen_at)}
                    </span>
                  </div>
                  <span className={`status-pill ${link.is_active ? "active" : "inactive"}`}>
                    {link.is_active ? "active" : "inactive"}
                  </span>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
