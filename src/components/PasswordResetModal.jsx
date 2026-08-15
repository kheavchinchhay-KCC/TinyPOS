import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import Modal from "./Modal";

export default function PasswordResetModal({
  member,
  busy,
  onClose,
  onReset
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setPassword("");
    setConfirmPassword("");
    setError("");
  }, [member]);

  if (!member) return null;

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("The new password must contain at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("The password confirmation does not match.");
      return;
    }

    await onReset(password);
  }

  return (
    <Modal title={`Reset password · ${member.full_name}`} onClose={onClose}>
      <form className="password-reset-form" onSubmit={submit}>
        <p className="muted">
          Enter a temporary password and share it privately with this staff member.
        </p>

        <label>
          <span>New temporary password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 8 characters"
          />
        </label>

        <label>
          <span>Confirm password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Repeat the password"
          />
        </label>

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            <KeyRound size={18} />
            {busy ? "Resetting..." : "Reset password"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
