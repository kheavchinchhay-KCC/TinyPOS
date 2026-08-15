import {
  RotateCcw,
  Save,
  ShieldCheck,
  ShieldX
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState
} from "react";
import Modal from "./Modal";

function fieldValue(value) {
  return value === null
    || value === undefined
      ? ""
      : String(value);
}

export default function UserPermissionModal({
  member,
  definitions,
  busy,
  onClose,
  onSubmit
}) {
  const [states, setStates] = useState({});
  const [limits, setLimits] = useState({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!member) return;

    const next = {};

    for (const definition of definitions) {
      if (
        Object.prototype.hasOwnProperty.call(
          member.overrides || {},
          definition.permission_key
        )
      ) {
        next[definition.permission_key] =
          member.overrides[
            definition.permission_key
          ]
            ? "allow"
            : "deny";
      } else {
        next[definition.permission_key] =
          "default";
      }
    }

    setStates(next);
    setLimits({
      max_discount_percent:
        fieldValue(
          member.limits
            ?.max_discount_percent
        ),
      max_discount_amount_usd:
        fieldValue(
          member.limits
            ?.max_discount_amount_usd
        ),
      max_discount_amount_khr:
        fieldValue(
          member.limits
            ?.max_discount_amount_khr
        ),
      max_refund_amount_usd:
        fieldValue(
          member.limits
            ?.max_refund_amount_usd
        ),
      max_refund_amount_khr:
        fieldValue(
          member.limits
            ?.max_refund_amount_khr
        )
    });
    setFilter("");
    setError("");
  }, [member, definitions]);

  const groups = useMemo(() => {
    const needle = filter
      .trim()
      .toLowerCase();

    const map = new Map();

    for (const definition of definitions) {
      if (
        needle
        && ![
          definition.label,
          definition.description,
          definition.module_key,
          definition.permission_key
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle)
      ) {
        continue;
      }

      if (!map.has(definition.module_key)) {
        map.set(
          definition.module_key,
          []
        );
      }

      map.get(definition.module_key)
        .push(definition);
    }

    return [...map.entries()];
  }, [definitions, filter]);

  if (!member) return null;

  const ownerProtected =
    member.role === "owner";

  function updateLimit(key, value) {
    if (
      value !== ""
      && Number(value) < 0
    ) {
      return;
    }

    setLimits((current) => ({
      ...current,
      [key]: value
    }));
  }

  function resetOverrides() {
    const next = {};

    for (const definition of definitions) {
      next[definition.permission_key] =
        "default";
    }

    setStates(next);
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (ownerProtected) {
      setError(
        "Owner access is always unrestricted."
      );
      return;
    }

    const numericKeys = [
      "max_discount_percent",
      "max_discount_amount_usd",
      "max_discount_amount_khr",
      "max_refund_amount_usd",
      "max_refund_amount_khr"
    ];

    for (const key of numericKeys) {
      const value = limits[key];

      if (
        value !== ""
        && (
          !Number.isFinite(Number(value))
          || Number(value) < 0
        )
      ) {
        setError(
          "Approval limits must be zero, positive, or blank for unlimited."
        );
        return;
      }
    }

    if (
      limits.max_discount_percent !== ""
      && Number(
        limits.max_discount_percent
      ) > 100
    ) {
      setError(
        "Discount percentage cannot exceed 100."
      );
      return;
    }

    await onSubmit({
      user_id: member.id,

      overrides: definitions.map(
        (definition) => ({
          permission_key:
            definition.permission_key,

          allowed:
            states[
              definition.permission_key
            ] === "default"
              ? null
              : states[
                  definition.permission_key
                ] === "allow"
        })
      ),

      limits: Object.fromEntries(
        numericKeys.map((key) => [
          key,
          limits[key] === ""
            ? null
            : Number(limits[key])
        ])
      )
    });
  }

  return (
    <Modal
      title={`Permissions · ${member.full_name}`}
      onClose={() =>
        !busy && onClose()
      }
      wide
    >
      <form
        className="permission-editor"
        onSubmit={submit}
      >
        <section className="permission-user-summary">
          <div>
            <strong>{member.full_name}</strong>
            <span>
              {member.email}
              {" · "}
              {member.role}
              {" · "}
              {member.branch_name
                || "No branch"}
            </span>
          </div>

          {ownerProtected && (
            <div className="notice info">
              The owner always has every
              permission and unlimited approval
              limits.
            </div>
          )}
        </section>

        <section className="permission-limit-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">
                APPROVAL LIMITS
              </p>
              <h3>
                Discount and refund limits
              </h3>
              <span className="muted">
                Leave a field blank for unlimited.
                Enter zero to require approval for
                every positive amount.
              </span>
            </div>
          </div>

          <div className="form-grid permission-limit-grid">
            <label>
              <span>Maximum discount %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.001"
                value={
                  limits.max_discount_percent
                  || ""
                }
                onChange={(event) =>
                  updateLimit(
                    "max_discount_percent",
                    event.target.value
                  )
                }
                disabled={ownerProtected}
                placeholder="Unlimited"
              />
            </label>

            <label>
              <span>Discount amount USD</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={
                  limits
                    .max_discount_amount_usd
                  || ""
                }
                onChange={(event) =>
                  updateLimit(
                    "max_discount_amount_usd",
                    event.target.value
                  )
                }
                disabled={ownerProtected}
                placeholder="Unlimited"
              />
            </label>

            <label>
              <span>Discount amount KHR</span>
              <input
                type="number"
                min="0"
                step="1"
                value={
                  limits
                    .max_discount_amount_khr
                  || ""
                }
                onChange={(event) =>
                  updateLimit(
                    "max_discount_amount_khr",
                    event.target.value
                  )
                }
                disabled={ownerProtected}
                placeholder="Unlimited"
              />
            </label>

            <label>
              <span>Refund amount USD</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={
                  limits
                    .max_refund_amount_usd
                  || ""
                }
                onChange={(event) =>
                  updateLimit(
                    "max_refund_amount_usd",
                    event.target.value
                  )
                }
                disabled={ownerProtected}
                placeholder="Unlimited"
              />
            </label>

            <label>
              <span>Refund amount KHR</span>
              <input
                type="number"
                min="0"
                step="1"
                value={
                  limits
                    .max_refund_amount_khr
                  || ""
                }
                onChange={(event) =>
                  updateLimit(
                    "max_refund_amount_khr",
                    event.target.value
                  )
                }
                disabled={ownerProtected}
                placeholder="Unlimited"
              />
            </label>
          </div>
        </section>

        <section className="permission-list-panel">
          <div className="permission-list-toolbar">
            <label className="search-box">
              <input
                value={filter}
                onChange={(event) =>
                  setFilter(
                    event.target.value
                  )
                }
                placeholder="Search permissions"
              />
            </label>

            <button
              type="button"
              className="secondary-button"
              onClick={resetOverrides}
              disabled={ownerProtected}
            >
              <RotateCcw size={17} />
              Use role defaults
            </button>
          </div>

          <div className="permission-groups">
            {groups.map(
              ([moduleKey, rows]) => (
                <article
                  key={moduleKey}
                  className="permission-group"
                >
                  <h3>{moduleKey}</h3>

                  {rows.map((definition) => {
                    const state =
                      states[
                        definition.permission_key
                      ] || "default";

                    const defaultAllowed =
                      (
                        definition.default_roles
                        || []
                      ).includes(member.role);

                    return (
                      <div
                        className="permission-row"
                        key={
                          definition
                            .permission_key
                        }
                      >
                        <div
                          className={`permission-risk ${definition.risk_level}`}
                        >
                          {definition.risk_level
                            === "critical"
                            ? (
                              <ShieldX
                                size={18}
                              />
                            )
                            : (
                              <ShieldCheck
                                size={18}
                              />
                            )}
                        </div>

                        <div>
                          <strong>
                            {definition.label}
                          </strong>
                          <span>
                            {
                              definition
                                .description
                            }
                          </span>
                          <small>
                            {
                              definition
                                .permission_key
                            }
                            {" · Role default: "}
                            {defaultAllowed
                              ? "Allowed"
                              : "Denied"}
                          </small>
                        </div>

                        <select
                          value={state}
                          onChange={(event) =>
                            setStates(
                              (current) => ({
                                ...current,
                                [
                                  definition
                                    .permission_key
                                ]:
                                  event.target
                                    .value
                              })
                            )
                          }
                          disabled={ownerProtected}
                        >
                          <option value="default">
                            Role default
                          </option>
                          <option value="allow">
                            Allow
                          </option>
                          <option value="deny">
                            Deny
                          </option>
                        </select>
                      </div>
                    );
                  })}
                </article>
              )
            )}
          </div>
        </section>

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
            disabled={busy}
          >
            Close
          </button>

          {!ownerProtected && (
            <button
              type="submit"
              className="primary-button"
              disabled={busy}
            >
              <Save size={18} />
              {busy
                ? "Saving access..."
                : "Save user access"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
