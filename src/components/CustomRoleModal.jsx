import { ChevronDown, Save, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import { roleLabel } from "../lib/staff";

const baseRoles = ["admin", "manager", "cashier", "viewer"];

function roleDefaults(definitions, baseRole) {
  return (definitions || [])
    .filter((definition) => (definition.default_roles || []).includes(baseRole))
    .map((definition) => definition.permission_key);
}

function readableModule(value) {
  return String(value || "Other")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function CustomRoleModal({
  open,
  role,
  definitions,
  callerRole,
  busy,
  onClose,
  onSave
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseRole, setBaseRole] = useState("viewer");
  const [permissionKeys, setPermissionKeys] = useState([]);
  const [isActive, setIsActive] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const nextBaseRole = role?.base_role || "viewer";
    setName(role?.name || "");
    setDescription(role?.description || "");
    setBaseRole(nextBaseRole);
    setPermissionKeys(
      role?.permission_keys?.length
        ? [...role.permission_keys]
        : roleDefaults(definitions, nextBaseRole)
    );
    setIsActive(role?.is_active !== false);
    setSearch("");
    setExpanded({});
    setError("");
  }, [open, role, definitions]);

  const allowedBaseRoles = useMemo(
    () => callerRole === "owner" ? baseRoles : baseRoles.filter((item) => item !== "admin"),
    [callerRole]
  );

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const map = new Map();

    for (const definition of definitions || []) {
      if (definition.approval_action || !definition.permission_key) continue;
      const label = definition.label || definition.permission_key;
      const descriptionText = definition.description || definition.permission_key;
      const haystack = [
        definition.permission_key,
        definition.module_key,
        label,
        descriptionText
      ].filter(Boolean).join(" ").toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      const key = definition.module_key || "Other";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ ...definition, label, description: descriptionText });
    }

    return [...map.entries()]
      .map(([moduleKey, rows]) => [
        moduleKey,
        rows.sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
      ])
      .sort(([a], [b]) => a.localeCompare(b));
  }, [definitions, search]);

  if (!open) return null;

  function changeBaseRole(nextRole) {
    setBaseRole(nextRole);
    setPermissionKeys(roleDefaults(definitions, nextRole));
    setError("");
  }

  function togglePermission(key) {
    setPermissionKeys((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    );
  }

  function toggleGroup(rows, checked) {
    const keys = rows.map((row) => row.permission_key);
    setPermissionKeys((current) => {
      const next = new Set(current);
      keys.forEach((key) => checked ? next.add(key) : next.delete(key));
      return [...next];
    });
  }

  function toggleExpanded(moduleKey) {
    setExpanded((current) => ({
      ...current,
      [moduleKey]: current[moduleKey] === false
    }));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (name.trim().length < 2) {
      setError("Role name must contain at least 2 characters.");
      return;
    }

    if (!allowedBaseRoles.includes(baseRole)) {
      setError("You cannot use that base role.");
      return;
    }

    try {
      await onSave({
        id: role?.id || null,
        name: name.trim(),
        description: description.trim(),
        base_role: baseRole,
        permission_keys: permissionKeys,
        is_active: isActive
      });
    } catch (saveError) {
      setError(saveError?.message || "The custom role could not be saved.");
    }
  }

  return (
    <Modal
      title={role?.id ? `Edit ${role.name}` : "Add custom staff role"}
      onClose={() => !busy && onClose()}
      wide
      className="custom-role-modal"
      bodyClassName="custom-role-modal-body"
      closeDisabled={busy}
    >
      <form className="custom-role-form custom-role-form-recovered" onSubmit={submit}>
        <div className="form-grid two custom-role-basic-grid">
          <label>
            <span>Role name *</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Stock Controller" autoFocus />
          </label>
          <label>
            <span>Base role *</span>
            <select value={baseRole} onChange={(event) => changeBaseRole(event.target.value)}>
              {allowedBaseRoles.map((item) => <option value={item} key={item}>{roleLabel(item)}</option>)}
            </select>
          </label>
        </div>

        <label>
          <span>Description</span>
          <textarea rows="3" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this role is responsible for" />
        </label>

        <label className="custom-role-active recovered">
          <span>
            <strong>Active role</strong>
            <small>Inactive roles stay on existing users but cannot be newly assigned.</small>
          </span>
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
        </label>

        <section className="custom-role-permissions recovered">
          <div className="custom-role-permission-heading recovered">
            <div className="custom-role-permission-summary">
              <ShieldCheck size={21} />
              <span>
                <strong>Permissions</strong>
                <small>{permissionKeys.length} selected</small>
              </span>
            </div>
            <label className="custom-role-search">
              <Search size={18} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search permission name, module or key" />
            </label>
          </div>

          <div className="custom-role-groups recovered">
            {groups.map(([moduleKey, rows]) => {
              const selectedCount = rows.filter((row) => permissionKeys.includes(row.permission_key)).length;
              const allSelected = rows.length > 0 && selectedCount === rows.length;
              const isOpen = search.trim() ? true : expanded[moduleKey] !== false;

              return (
                <section className={`custom-role-group recovered ${isOpen ? "is-open" : "is-collapsed"}`} key={moduleKey}>
                  <div className="custom-role-group-header">
                    <label className="custom-role-group-select">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={(event) => toggleGroup(rows, event.target.checked)}
                      />
                      <span className="custom-role-group-title">
                        <strong className="custom-role-group-name">{readableModule(moduleKey)}</strong>
                        <small className="custom-role-group-count">{selectedCount} of {rows.length} selected</small>
                      </span>
                    </label>
                    <button
                      type="button"
                      className="icon-button custom-role-group-toggle"
                      onClick={() => toggleExpanded(moduleKey)}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Collapse" : "Expand"} ${readableModule(moduleKey)}`}
                    >
                      <ChevronDown size={18} className={isOpen ? "" : "collapsed"} />
                    </button>
                  </div>

                  {isOpen && (
                    <div className="custom-role-permission-list">
                      {rows.map((definition) => (
                        <label className="custom-role-permission recovered" key={definition.permission_key}>
                          <input
                            type="checkbox"
                            checked={permissionKeys.includes(definition.permission_key)}
                            onChange={() => togglePermission(definition.permission_key)}
                          />
                          <span className="custom-role-permission-copy">
                            <strong>{definition.label}</strong>
                            <small>{definition.description}</small>
                            <code>{definition.permission_key}</code>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
            {!groups.length && <div className="empty-state compact"><p>No matching permissions.</p></div>}
          </div>
        </section>

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions custom-role-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy}><Save size={18} />{busy ? "Saving..." : "Save custom role"}</button>
        </div>
      </form>
    </Modal>
  );
}
