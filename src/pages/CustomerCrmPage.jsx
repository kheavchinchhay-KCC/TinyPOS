import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CalendarClock, Gift, MessageCircle, Plus, RefreshCw, Search, Send, Tags, UserRoundCheck, UsersRound } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import CustomerSegmentModal from "../components/CustomerSegmentModal";
import CustomerCampaignModal from "../components/CustomerCampaignModal";
import CustomerTelegramLinkModal from "../components/CustomerTelegramLinkModal";
import {
  createCustomerTelegramCode,
  dispatchCustomerCampaign,
  loadCrmCustomers,
  loadCrmDashboard,
  loadCrmSetup,
  previewCrmSegment,
  recordCustomerContact,
  saveCrmSegment,
  saveCrmTag,
  saveCustomerCampaign,
  saveLoyaltySettings,
  setCustomerTags
} from "../lib/crm";

function dateTime(value) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

function money(value, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "KHR" ? 0 : 2
  }).format(Number(value || 0));
}

export default function CustomerCrmPage() {
  const { supabase, profile, session, can } = useAuth();
  const [tab, setTab] = useState("customers");
  const [dashboard, setDashboard] = useState({});
  const [customers, setCustomers] = useState([]);
  const [setup, setSetup] = useState({ tags: [], segments: [], campaigns: [], loyalty: null, coupons: [] });
  const [branches, setBranches] = useState([]);
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [segmentOpen, setSegmentOpen] = useState(false);
  const [editingSegment, setEditingSegment] = useState(null);
  const [campaignOpen, setCampaignOpen] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [telegramLink, setTelegramLink] = useState(null);
  const [botUsername, setBotUsername] = useState("");
  const [tagName, setTagName] = useState("");
  const [loyalty, setLoyalty] = useState({ enabled: true, usd_points_per_unit: 1, khr_points_per_1000: 1, award_on_tax: false, award_on_discounted_total: true, points_expire_after_days: "" });

  const refresh = useCallback(async () => {
    if (!supabase || !profile?.organization_id) return;
    setLoading(true);
    try {
      const [summary, rows, config, branchResult] = await Promise.all([
        loadCrmDashboard(supabase),
        loadCrmCustomers(supabase, profile.organization_id),
        loadCrmSetup(supabase, profile.organization_id),
        supabase.from("branches").select("id,name,code").eq("organization_id", profile.organization_id).eq("is_active", true).order("name")
      ]);
      setDashboard(summary);
      setCustomers(rows);
      setSetup(config);
      setBranches(branchResult.data || []);
      if (config.loyalty) setLoyalty({ ...config.loyalty, points_expire_after_days: config.loyalty.points_expire_after_days || "" });
      try {
        const response = await fetch("/api/telegram-admin", { headers: { Authorization: `Bearer ${session.access_token}` } });
        const result = await response.json();
        setBotUsername(result?.bot?.username || "");
      } catch { /* bot may not be configured yet */ }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.organization_id, session?.access_token]);

  useEffect(() => { refresh(); }, [refresh]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return customers.filter((c) => (lifecycle === "all" || c.lifecycle === lifecycle) && (!needle || [c.customer_code,c.name,c.phone,c.email,c.company_name,...(c.tags || []).map((t) => t.name)].filter(Boolean).join(" ").toLowerCase().includes(needle)));
  }, [customers, search, lifecycle]);

  async function run(action, success) {
    try { setBusy(true); setMessage(""); await action(); setMessage(success); await refresh(); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function invite(customer) {
    try { setBusy(true); setTelegramLink(await createCustomerTelegramCode(supabase, customer.id)); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function quickContact(customer) {
    const note = window.prompt(`Contact note for ${customer.name}`);
    if (!note) return;
    const follow = window.prompt("Follow-up date/time (optional, YYYY-MM-DD HH:MM)");
    await run(() => recordCustomerContact(supabase, { customer_id: customer.id, channel: "phone", direction: "outbound", subject: "CRM follow-up", note, follow_up_at: follow ? new Date(follow).toISOString() : null }), "Contact recorded.");
  }

  async function editTags(customer) {
    const current = new Set((customer.tags || []).map((t) => t.id));
    const text = window.prompt(`Enter tag names separated by commas. Available: ${setup.tags.map((t) => t.name).join(", ")}`, (customer.tags || []).map((t) => t.name).join(", "));
    if (text === null) return;
    const wanted = text.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const tagIds = setup.tags.filter((tag) => wanted.includes(tag.name.toLowerCase())).map((tag) => tag.id);
    if (!tagIds.length && wanted.length) return setMessage("Create those tags first, then assign them.");
    await run(() => setCustomerTags(supabase, profile, customer.id, tagIds), "Customer tags updated.");
  }

  return (
    <div className="page-stack crm-page">
      <div className="page-heading"><div><span className="eyebrow">CUSTOMER RELATIONSHIPS</span><h1>CRM, Loyalty & Campaigns</h1><p>Understand customer lifecycle, follow up consistently and send consent-based Telegram campaigns.</p></div><button className="secondary-button" onClick={refresh} disabled={loading}><RefreshCw size={18} />Refresh</button></div>
      {message && <div className="notice info">{message}</div>}
      <div className="crm-metrics"><div className="metric-card"><UsersRound /><span>Customers</span><strong className="viz-stat-value">{Number(dashboard.customers || 0).toLocaleString("en-US")}</strong></div><div className="metric-card"><Activity /><span>At risk</span><strong className="viz-stat-value">{Number(dashboard.at_risk || 0).toLocaleString("en-US")}</strong></div><div className="metric-card"><Send /><span>Telegram opted in</span><strong className="viz-stat-value">{Number(dashboard.marketing_opt_in || 0).toLocaleString("en-US")}</strong></div><div className="metric-card"><CalendarClock /><span>Follow-ups due</span><strong className="viz-stat-value">{Number(dashboard.follow_ups_due || 0).toLocaleString("en-US")}</strong></div><div className="metric-card"><Gift /><span>Loyalty points</span><strong className="viz-stat-value">{Number(dashboard.loyalty_points || 0).toLocaleString("en-US")}</strong></div></div>
      <div className="page-tabs">{[["customers","Customers"],["segments","Segments"],["campaigns","Campaigns"],["loyalty","Loyalty program"],["tags","Tags"]].map(([key,label]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}</div>

      {tab === "customers" && <section className="panel"><div className="toolbar"><div className="search-box"><Search size={18} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer, phone, email or tag" /></div><select value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}><option value="all">All lifecycle stages</option><option value="prospect">Prospect</option><option value="active">Active</option><option value="at_risk">At risk</option><option value="inactive">Inactive</option><option value="do_not_contact">Do not contact</option></select></div><div className="responsive-table"><table><thead><tr><th>Customer</th><th>Lifecycle</th><th>Last purchase</th><th>Spend</th><th>Points</th><th>Telegram</th><th>Tags</th><th /></tr></thead><tbody>{visible.map((c) => <tr key={c.id}><td><strong>{c.name}</strong><small>{[c.customer_code,c.phone].filter(Boolean).join(" · ")}</small></td><td><span className={`status-pill ${c.lifecycle}`}>{c.lifecycle?.replace("_"," ")}</span></td><td>{dateTime(c.last_purchase_at)}<small>{c.days_since_purchase == null ? "No purchase" : `${c.days_since_purchase} days ago`}</small></td><td>{money(c.lifetime_spend, c.summary_currency || "USD")}</td><td>{Number(c.loyalty_points || 0).toLocaleString("en-US")}</td><td>{c.telegram_connected ? <span className="status-pill active">Connected</span> : <span className="status-pill inactive">Not linked</span>}</td><td><div className="tag-row">{(c.tags || []).map((tag) => <span key={tag.id} className="viz-badge">{tag.name}</span>)}</div></td><td><div className="table-actions"><button title="Record contact" onClick={() => quickContact(c)}><MessageCircle size={17} /></button><button title="Edit tags" onClick={() => editTags(c)}><Tags size={17} /></button><button title="Connect Telegram" onClick={() => invite(c)}><Send size={17} /></button></div></td></tr>)}</tbody></table></div>

        <div className="crm-customer-mobile-list">{visible.map((c) => (
          <article className="crm-customer-mobile-card" key={`mobile-${c.id}`}>
            <header>
              <div className="crm-customer-mobile-identity">
                <strong>{c.name}</strong>
                <small>{[c.customer_code, c.phone].filter(Boolean).join(" · ") || "—"}</small>
              </div>
              <span className={`status-pill ${c.lifecycle}`}>{c.lifecycle?.replace("_", " ")}</span>
            </header>
            <div className="crm-customer-mobile-grid">
              <div><span>Last purchase</span><strong>{dateTime(c.last_purchase_at)}</strong><small>{c.days_since_purchase == null ? "No purchase" : `${c.days_since_purchase} days ago`}</small></div>
              <div><span>Spend</span><strong>{money(c.lifetime_spend, c.summary_currency || "USD")}</strong></div>
              <div><span>Points</span><strong>{Number(c.loyalty_points || 0).toLocaleString("en-US")}</strong></div>
              <div><span>Telegram</span><strong>{c.telegram_connected ? "Connected" : "Not linked"}</strong></div>
            </div>
            {(c.tags || []).length > 0 && <div className="tag-row crm-customer-mobile-tags">{(c.tags || []).map((tag) => <span key={tag.id} className="viz-badge">{tag.name}</span>)}</div>}
            <div className="crm-customer-mobile-actions">
              <button type="button" className="secondary-button compact-button" onClick={() => quickContact(c)}><MessageCircle size={16} />Contact</button>
              <button type="button" className="secondary-button compact-button" onClick={() => editTags(c)}><Tags size={16} />Tags</button>
              <button type="button" className="secondary-button compact-button" onClick={() => invite(c)}><Send size={16} />Telegram</button>
            </div>
          </article>
        ))}</div>
      </section>}

      {tab === "segments" && <section className="panel"><div className="section-heading"><div><h2>Dynamic customer segments</h2><p>Rules are evaluated again when a campaign is sent.</p></div><button className="primary-button" onClick={() => { setEditingSegment(null); setSegmentOpen(true); }}><Plus size={18} />New segment</button></div><div className="crm-card-grid">{setup.segments.map((s) => <article className="crm-card" key={s.id}><div><UsersRound /><span className={`status-pill ${s.is_active ? "active" : "inactive"}`}>{s.is_active ? "Active" : "Inactive"}</span></div><h3>{s.name}</h3><p>{s.description || "Dynamic CRM segment"}</p><button className="secondary-button" onClick={() => { setEditingSegment(s); setSegmentOpen(true); }}>Edit segment</button></article>)}</div></section>}

      {tab === "campaigns" && <section className="panel"><div className="section-heading"><div><h2>Telegram customer campaigns</h2><p>Campaigns are delivered only to linked, opted-in customers.</p></div><button className="primary-button" onClick={() => { setEditingCampaign(null); setCampaignOpen(true); }}><Plus size={18} />New campaign</button></div><div className="responsive-table"><table><thead><tr><th>Campaign</th><th>Type</th><th>Segment</th><th>Scheduled</th><th>Delivery</th><th>Status</th><th /></tr></thead><tbody>{setup.campaigns.map((c) => <tr key={c.id}><td><strong>{c.name}</strong><small>{c.title_en}</small></td><td>{c.campaign_type.replace("_"," ")}</td><td>{c.crm_segments?.name || "All opted-in"}</td><td>{dateTime(c.scheduled_at)}</td><td>{Number(c.sent_count || 0).toLocaleString("en-US")} sent · {Number(c.failed_count || 0).toLocaleString("en-US")} failed</td><td><span className={`status-pill ${c.status}`}>{c.status}</span></td><td><div className="table-actions"><button onClick={() => { setEditingCampaign(c); setCampaignOpen(true); }}>Edit</button>{["draft","scheduled"].includes(c.status) && <button onClick={() => run(() => dispatchCustomerCampaign(session, c.id), "Campaign dispatch started.")}><Send size={17} /></button>}</div></td></tr>)}</tbody></table></div></section>}

      {tab === "loyalty" && <section className="panel crm-loyalty-panel"><div className="section-heading"><div><h2>Automatic loyalty earning</h2><p>Points are earned when a sale completes and reversed proportionally after a refund.</p></div></div><div className="form-grid three"><label><span>USD points per $1.00</span><input type="number" min="0" step="0.01" value={loyalty.usd_points_per_unit} onChange={(e) => setLoyalty({ ...loyalty, usd_points_per_unit: e.target.value })} /></label><label><span>KHR points per ៛1,000</span><input type="number" min="0" step="0.01" value={loyalty.khr_points_per_1000} onChange={(e) => setLoyalty({ ...loyalty, khr_points_per_1000: e.target.value })} /></label><label><span>Point expiry days</span><input type="number" min="30" value={loyalty.points_expire_after_days} onChange={(e) => setLoyalty({ ...loyalty, points_expire_after_days: e.target.value })} placeholder="No expiry" /></label></div><div className="check-chip-row"><label className="form-check form-switch"><input className="form-check-input" type="checkbox" checked={Boolean(loyalty.enabled)} onChange={(e) => setLoyalty({ ...loyalty, enabled: e.target.checked })} /><span className="form-check-label">Enable automatic earning</span></label><label className="form-check form-switch"><input className="form-check-input" type="checkbox" checked={Boolean(loyalty.award_on_tax)} onChange={(e) => setLoyalty({ ...loyalty, award_on_tax: e.target.checked })} /><span className="form-check-label">Award points on tax</span></label></div><button className="primary-button" disabled={busy} onClick={() => run(() => saveLoyaltySettings(supabase, loyalty), "Loyalty settings saved.")}><Gift size={18} />Save loyalty settings</button></section>}

      {tab === "tags" && <section className="panel"><div className="section-heading"><div><h2>Customer tags</h2><p>Tags can be used inside dynamic campaign segments.</p></div></div><div className="inline-form"><input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="New tag name" /><button className="primary-button" disabled={!tagName.trim() || busy} onClick={() => run(async () => { await saveCrmTag(supabase, profile, { name: tagName, is_active: true }); setTagName(""); }, "Tag created.")}><Plus size={18} />Add tag</button></div><div className="tag-management">{setup.tags.map((tag) => <span key={tag.id} className="viz-badge">{tag.name}</span>)}</div></section>}

      <CustomerSegmentModal open={segmentOpen} segment={editingSegment} branches={branches} tags={setup.tags} busy={busy} onClose={() => setSegmentOpen(false)} onPreview={(rules, branch) => previewCrmSegment(supabase, rules, branch)} onSave={(values) => run(async () => { await saveCrmSegment(supabase, profile, values); setSegmentOpen(false); }, "Segment saved.")} />
      <CustomerCampaignModal open={campaignOpen} campaign={editingCampaign} branches={branches} segments={setup.segments} coupons={setup.coupons} busy={busy} onClose={() => setCampaignOpen(false)} onSave={(values, sendNow) => run(async () => { const saved = await saveCustomerCampaign(supabase, values); if (sendNow) await dispatchCustomerCampaign(session, saved.id); setCampaignOpen(false); }, sendNow ? "Campaign dispatch started." : "Campaign saved.")} />
      <CustomerTelegramLinkModal link={telegramLink} botUsername={botUsername} onClose={() => setTelegramLink(null)} />
    </div>
  );
}
