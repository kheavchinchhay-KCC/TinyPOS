import { useEffect, useState } from "react";
import Modal from "./Modal";

export default function AccountingMappingModal({ mapping, accounts, busy, onClose, onSave }) {
  const [accountId, setAccountId] = useState("");
  useEffect(() => { setAccountId(mapping?.account_id || ""); }, [mapping]);
  return <Modal title="Update accounting mapping" onClose={onClose}>
    <form className="form-stack" onSubmit={(event) => { event.preventDefault(); onSave({ mapping_key: mapping.mapping_key, account_id: accountId }); }}>
      <div className="mapping-key-card"><strong>{mapping?.mapping_key?.replaceAll("_", " ")}</strong><small>{mapping?.description || "Operational posting mapping"}</small></div>
      <label><span>Post to account</span><select value={accountId} onChange={(e) => setAccountId(e.target.value)} required><option value="">Select account</option>{accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></label>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "Saving..." : "Save mapping"}</button></div>
    </form>
  </Modal>;
}
