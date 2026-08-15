import { useEffect, useState } from "react";
import { Save } from "lucide-react";

export default function CategoryForm({ category, busy, onCancel, onSave }) {
  const [form, setForm] = useState({ name: "", description: "", sort_order: 0, is_active: true });
  const [error, setError] = useState("");

  useEffect(() => {
    setForm(category ? {
      name: category.name || "",
      description: category.description || "",
      sort_order: category.sort_order || 0,
      is_active: category.is_active
    } : { name: "", description: "", sort_order: 0, is_active: true });
  }, [category]);

  async function submit(event) {
    event.preventDefault();
    if (!form.name.trim()) return setError("Category name is required.");
    try { await onSave(form); } catch (saveError) { setError(saveError.message); }
  }

  return (
    <form className="category-form" onSubmit={submit}>
      {error && <div className="notice error">{error}</div>}
      <label><span>Category name *</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label><span>Description</span><textarea rows="3" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <label><span>Sort order</span><input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: e.target.value })} /></label>
      <label className="check-row"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /><span>Active category</span></label>
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="primary-button" disabled={busy}><Save size={18} />{busy ? "Saving..." : "Save category"}</button>
      </div>
    </form>
  );
}
