import Modal from "./Modal";

function pretty(value) {
  if (value === null || value === undefined) {
    return "No data";
  }

  return JSON.stringify(value, null, 2);
}

export default function AuditDetailModal({ entry, onClose }) {
  if (!entry) return null;

  return (
    <Modal title="Audit entry details" onClose={onClose} wide>
      <div className="audit-detail">
        <div className="audit-detail-summary">
          <div>
            <span>Action</span>
            <strong>{entry.action}</strong>
          </div>
          <div>
            <span>Entity</span>
            <strong>{entry.entity_type}</strong>
          </div>
          <div>
            <span>User</span>
            <strong>
              {entry.profiles?.full_name || "System"}
            </strong>
          </div>
          <div>
            <span>Branch</span>
            <strong>{entry.branches?.name || "—"}</strong>
          </div>
          <div>
            <span>Record ID</span>
            <strong>{entry.entity_id || "—"}</strong>
          </div>
          <div>
            <span>Date</span>
            <strong>
              {new Intl.DateTimeFormat("en-US", {
                dateStyle: "medium",
                timeStyle: "medium"
              }).format(new Date(entry.created_at))}
            </strong>
          </div>
        </div>

        <div className="audit-json-grid">
          <section>
            <h3>Before</h3>
            <pre>{pretty(entry.old_data)}</pre>
          </section>
          <section>
            <h3>After / Details</h3>
            <pre>{pretty(entry.new_data)}</pre>
          </section>
        </div>

        {(entry.ip_address || entry.user_agent) && (
          <div className="audit-client-info">
            {entry.ip_address && (
              <span>IP: {entry.ip_address}</span>
            )}
            {entry.user_agent && (
              <span>Client: {entry.user_agent}</span>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="primary-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
