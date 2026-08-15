import { useEffect, useState } from "react";
import { Send, Save } from "lucide-react";
import Modal from "./Modal";

const blank = { id: null, name: "", branch_id: "", segment_id: "", campaign_type: "message", title_en: "", title_km: "", message_en: "", message_km: "", coupon_id: "", bonus_points: "0", scheduled_at: "", status: "draft" };

export default function CustomerCampaignModal({ open, campaign, branches, segments, coupons, busy, onClose, onSave }) {
  const [form, setForm] = useState(blank);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm({ ...blank, ...campaign, branch_id: campaign?.branch_id || "", segment_id: campaign?.segment_id || "", coupon_id: campaign?.coupon_id || "", scheduled_at: campaign?.scheduled_at ? new Date(campaign.scheduled_at).toISOString().slice(0,16) : "", bonus_points: String(campaign?.bonus_points || 0) });
    setError("");
  }, [open, campaign]);

  if (!open) return null;
  const includesCoupon = ["coupon","mixed"].includes(form.campaign_type);
  const includesPoints = ["bonus_points","mixed"].includes(form.campaign_type);

  async function submit(event, sendNow = false) {
    event.preventDefault();
    if (!form.name.trim() || !form.title_en.trim() || !form.message_en.trim()) return setError("Name, English title and English message are required.");
    if (includesCoupon && !form.coupon_id) return setError("Choose a coupon for this campaign.");
    if (includesPoints && Number(form.bonus_points || 0) <= 0) return setError("Enter bonus points greater than zero.");
    await onSave({ ...form, scheduled_at: sendNow ? new Date().toISOString() : (form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null), status: sendNow || form.scheduled_at ? "scheduled" : "draft", bonus_points: includesPoints ? Number(form.bonus_points || 0) : 0, coupon_id: includesCoupon ? form.coupon_id : null }, sendNow);
  }

  return (
    <Modal title={form.id ? "Edit customer campaign" : "New customer campaign"} onClose={onClose} wide>
      <form className="crm-form" onSubmit={(e) => submit(e, false)}>
        <div className="form-grid two">
          <label><span>Campaign name *</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label><span>Campaign type</span><select value={form.campaign_type} onChange={(e) => setForm({ ...form, campaign_type: e.target.value })}><option value="message">Message only</option><option value="coupon">Coupon campaign</option><option value="bonus_points">Bonus points</option><option value="mixed">Coupon + bonus points</option></select></label>
          <label><span>Branch scope</span><select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label><span>Target segment</span><select value={form.segment_id} onChange={(e) => setForm({ ...form, segment_id: e.target.value })}><option value="">All opted-in customers</option>{segments.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          {includesCoupon && <label><span>Coupon</span><select value={form.coupon_id} onChange={(e) => setForm({ ...form, coupon_id: e.target.value })}><option value="">Choose coupon</option>{coupons.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label>}
          {includesPoints && <label><span>Bonus points</span><input type="number" min="0.01" step="0.01" value={form.bonus_points} onChange={(e) => setForm({ ...form, bonus_points: e.target.value })} /></label>}
          <label><span>Schedule</span><input type="datetime-local" value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} /></label>
        </div>
        <div className="crm-language-grid">
          <section><h3>English</h3><label><span>Title *</span><input value={form.title_en} onChange={(e) => setForm({ ...form, title_en: e.target.value })} /></label><label><span>Message *</span><textarea rows="6" value={form.message_en} onChange={(e) => setForm({ ...form, message_en: e.target.value })} placeholder="Use a clear message. The coupon code and bonus points are added automatically." /></label></section>
          <section><h3>ខ្មែរ</h3><label><span>ចំណងជើង</span><input value={form.title_km} onChange={(e) => setForm({ ...form, title_km: e.target.value })} /></label><label><span>សារ</span><textarea rows="6" value={form.message_km} onChange={(e) => setForm({ ...form, message_km: e.target.value })} placeholder="បើទុកទទេ ប្រព័ន្ធប្រើសារអង់គ្លេស។" /></label></section>
        </div>
        <div className="notice info">Only customers who explicitly opted in and linked Telegram are eligible. Every customer can send /stop at any time.</div>
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="secondary-button" disabled={busy}><Save size={18} />Save draft</button><button type="button" className="primary-button" disabled={busy} onClick={(e) => submit(e, true)}><Send size={18} />Send now</button></div>
      </form>
    </Modal>
  );
}
