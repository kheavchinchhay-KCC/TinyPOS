import { useEffect, useMemo, useState } from "react";
import { Save, UsersRound } from "lucide-react";
import Modal from "./Modal";

const empty = {
  id: null,
  name: "",
  description: "",
  branch_id: "",
  customer_types: [],
  lifecycles: [],
  min_lifetime_spend: "",
  min_loyalty_points: "",
  inactive_days_min: "",
  inactive_days_max: "",
  birthday_month: "",
  tag_ids: [],
  marketing_opt_in: true,
  is_active: true
};

export default function CustomerSegmentModal({ open, segment, branches, tags, busy, onClose, onPreview, onSave }) {
  const [form, setForm] = useState(empty);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const rules = segment?.rules || {};
    setForm({
      ...empty,
      ...segment,
      branch_id: segment?.branch_id || "",
      customer_types: rules.customer_types || [],
      lifecycles: rules.lifecycles || [],
      min_lifetime_spend: rules.min_lifetime_spend ?? "",
      min_loyalty_points: rules.min_loyalty_points ?? "",
      inactive_days_min: rules.inactive_days_min ?? "",
      inactive_days_max: rules.inactive_days_max ?? "",
      birthday_month: rules.birthday_month ?? "",
      tag_ids: rules.tag_ids || [],
      marketing_opt_in: rules.marketing_opt_in ?? true
    });
    setPreview(null);
    setError("");
  }, [open, segment]);

  const rules = useMemo(() => ({
    customer_types: form.customer_types,
    lifecycles: form.lifecycles,
    tag_ids: form.tag_ids,
    marketing_opt_in: form.marketing_opt_in,
    ...(form.min_lifetime_spend !== "" ? { min_lifetime_spend: Number(form.min_lifetime_spend) } : {}),
    ...(form.min_loyalty_points !== "" ? { min_loyalty_points: Number(form.min_loyalty_points) } : {}),
    ...(form.inactive_days_min !== "" ? { inactive_days_min: Number(form.inactive_days_min) } : {}),
    ...(form.inactive_days_max !== "" ? { inactive_days_max: Number(form.inactive_days_max) } : {}),
    ...(form.birthday_month !== "" ? { birthday_month: Number(form.birthday_month) } : {})
  }), [form]);

  if (!open) return null;

  function toggle(key, value) {
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value]
    }));
  }

  async function previewNow() {
    try {
      setError("");
      setPreview(await onPreview(rules, form.branch_id || null));
    } catch (err) {
      setError(err.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) return setError("Segment name is required.");
    await onSave({
      id: form.id,
      name: form.name,
      description: form.description,
      branch_id: form.branch_id || null,
      rules,
      is_active: form.is_active
    });
  }

  return (
    <Modal title={form.id ? "Edit CRM segment" : "New CRM segment"} onClose={onClose} wide>
      <form className="crm-form" onSubmit={submit}>
        <div className="form-grid two">
          <label><span>Segment name *</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label><span>Branch scope</span><select value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="span-2"><span>Description</span><textarea rows="2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        </div>

        <section className="crm-rule-section">
          <h3>Customer types</h3>
          <div className="check-chip-row">{["regular","vip","wholesale"].map((value) => <label key={value} className="form-check"><input className="form-check-input" type="checkbox" checked={form.customer_types.includes(value)} onChange={() => toggle("customer_types", value)} /><span className="form-check-label">{value}</span></label>)}</div>
        </section>

        <section className="crm-rule-section">
          <h3>Lifecycle</h3>
          <div className="check-chip-row">{["prospect","active","at_risk","inactive"].map((value) => <label key={value} className="form-check"><input className="form-check-input" type="checkbox" checked={form.lifecycles.includes(value)} onChange={() => toggle("lifecycles", value)} /><span className="form-check-label">{value.replace("_", " ")}</span></label>)}</div>
        </section>

        <div className="form-grid four">
          <label><span>Minimum lifetime spend</span><input type="number" min="0" step="0.01" value={form.min_lifetime_spend} onChange={(e) => setForm({ ...form, min_lifetime_spend: e.target.value })} /></label>
          <label><span>Minimum points</span><input type="number" min="0" step="1" value={form.min_loyalty_points} onChange={(e) => setForm({ ...form, min_loyalty_points: e.target.value })} /></label>
          <label><span>Inactive days from</span><input type="number" min="0" value={form.inactive_days_min} onChange={(e) => setForm({ ...form, inactive_days_min: e.target.value })} /></label>
          <label><span>Inactive days to</span><input type="number" min="0" value={form.inactive_days_max} onChange={(e) => setForm({ ...form, inactive_days_max: e.target.value })} /></label>
          <label><span>Birthday month</span><select value={form.birthday_month} onChange={(e) => setForm({ ...form, birthday_month: e.target.value })}><option value="">Any month</option>{Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{new Intl.DateTimeFormat("en-US", { month: "long" }).format(new Date(2026, i, 1))}</option>)}</select></label>
        </div>

        <section className="crm-rule-section">
          <h3>Tags</h3>
          <div className="check-chip-row">{tags.map((tag) => <label key={tag.id} className="form-check"><input className="form-check-input" type="checkbox" checked={form.tag_ids.includes(tag.id)} onChange={() => toggle("tag_ids", tag.id)} /><span className="form-check-label">{tag.name}</span></label>)}</div>
        </section>

        <label className="form-check form-switch"><input className="form-check-input" type="checkbox" checked={form.marketing_opt_in} onChange={(e) => setForm({ ...form, marketing_opt_in: e.target.checked })} /><span className="form-check-label">Require marketing opt-in</span></label>

        {preview && <div className="crm-preview"><UsersRound size={20} /><div><strong>{Number(preview.count || 0).toLocaleString("en-US")} matching customers</strong><small>{Number(preview.telegram_eligible || 0).toLocaleString("en-US")} can receive Telegram campaigns</small></div></div>}
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={previewNow}>Preview segment</button><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}><Save size={18} />{busy ? "Saving…" : "Save segment"}</button></div>
      </form>
    </Modal>
  );
}
