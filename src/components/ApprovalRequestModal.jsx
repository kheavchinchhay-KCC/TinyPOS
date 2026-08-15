import {
  CheckCircle2,
  Clock3,
  RefreshCw,
  Send,
  ShieldCheck,
  XCircle
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState
} from "react";
import { useAuth } from "../context/AuthContext";
import { notifyTelegramEvent } from "../lib/telegram";
import Modal from "./Modal";
import { money } from "../lib/catalog";
import {
  approvalStatusLabel,
  createApprovalRequest,
  loadApprovalRequest
} from "../lib/permissions";

export default function ApprovalRequestModal({
  request,
  onClose,
  onApproved
}) {
  const { supabase, session } = useAuth();

  const [record, setRecord] =
    useState(null);
  const [loading, setLoading] =
    useState(false);
  const [error, setError] =
    useState("");

  const requestKeyRef = useRef("");

  const requestKey = request
    ? JSON.stringify({
        permission_key:
          request.permission_key,
        action_type:
          request.action_type,
        payload:
          request.payload
      })
    : "";

  useEffect(() => {
    if (!request || !supabase) {
      setRecord(null);
      setError("");
      requestKeyRef.current = "";
      return;
    }

    if (
      requestKeyRef.current === requestKey
    ) {
      return;
    }

    requestKeyRef.current = requestKey;

    let active = true;

    (async () => {
      try {
        setLoading(true);
        setError("");

        const result =
          await createApprovalRequest(
            supabase,
            request
          );

        if (active) {
          setRecord(result);
          void notifyTelegramEvent(session, "approval_requested", result.id);
        }
      } catch (createError) {
        if (active) {
          setError(createError.message);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [
    request,
    requestKey,
    supabase,
    session
  ]);

  useEffect(() => {
    if (
      !record?.id
      || !["pending", "approved"]
        .includes(record.status)
      || !supabase
    ) {
      return undefined;
    }

    let active = true;

    const timer = window.setInterval(
      async () => {
        try {
          const latest =
            await loadApprovalRequest(
              supabase,
              record.id
            );

          if (active) {
            setRecord(latest);
          }
        } catch (pollError) {
          if (active) {
            setError(pollError.message);
          }
        }
      },
      5000
    );

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    record?.id,
    record?.status,
    supabase
  ]);

  if (!request) return null;

  async function refresh() {
    if (!record?.id) return;

    try {
      setLoading(true);
      setError("");

      const latest =
        await loadApprovalRequest(
          supabase,
          record.id
        );

      setRecord(latest);
    } catch (refreshError) {
      setError(refreshError.message);
    } finally {
      setLoading(false);
    }
  }

  const status =
    record?.status || "pending";

  return (
    <Modal
      title="Manager approval required"
      onClose={onClose}
    >
      <div className="approval-request-modal">
        <section
          className={`approval-request-status ${status}`}
        >
          {status === "approved" ? (
            <CheckCircle2 size={30} />
          ) : status === "rejected" ? (
            <XCircle size={30} />
          ) : (
            <Clock3 size={30} />
          )}

          <div>
            <strong>
              {loading && !record
                ? "Creating approval request..."
                : approvalStatusLabel(
                    status
                  )}
            </strong>

            <span>
              {request.summary}
            </span>
          </div>
        </section>

        {request.amount !== null
          && request.amount !== undefined
          && request.currency && (
            <div className="approval-request-amount">
              <span>Action amount</span>
              <strong>
                {money(
                  request.amount,
                  request.currency
                )}
              </strong>
            </div>
          )}

        <div className="approval-request-details">
          <div>
            <span>Requested action</span>
            <strong>
              {request.action_label
                || request.action_type}
            </strong>
          </div>

          <div>
            <span>Expires</span>
            <strong>
              {record?.expires_at
                ? new Intl.DateTimeFormat(
                    "en-US",
                    {
                      dateStyle: "medium",
                      timeStyle: "short"
                    }
                  ).format(
                    new Date(
                      record.expires_at
                    )
                  )
                : "30 minutes after request"}
            </strong>
          </div>
        </div>

        {status === "pending" && (
          <div className="notice info">
            <Send size={19} />
            <span>
              Relevant managers with Telegram
              notifications enabled will receive
              this approval request. You can also
              ask a manager to open Access &
              Approvals.
            </span>
          </div>
        )}

        {record?.review_note && (
          <div
            className={`notice ${
              status === "approved"
                ? "success"
                : "error"
            }`}
          >
            {record.review_note}
          </div>
        )}

        {error && (
          <div className="notice error">
            {error}
          </div>
        )}

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            Close
          </button>

          {record?.id
            && status === "pending" && (
              <button
                type="button"
                className="secondary-button"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw
                  size={18}
                  className={
                    loading ? "spin" : ""
                  }
                />
                Check status
              </button>
            )}

          {record?.id
            && status === "approved" && (
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  onApproved(record.id)
                }
              >
                <ShieldCheck size={18} />
                Use approval
              </button>
            )}
        </div>
      </div>
    </Modal>
  );
}
