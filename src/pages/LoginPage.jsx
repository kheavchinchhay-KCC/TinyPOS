import { useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  ShieldCheck,
  ShoppingBag
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";

export default function LoginPage() {
  const { session, signIn, error } = useAuth();
  const { language, t } = useLanguage();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/dashboard" replace />;

  async function submit(event) {
    event.preventDefault();

    try {
      setBusy(true);
      setMessage("");
      await signIn(email.trim(), password);
    } catch (signInError) {
      setMessage(signInError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login login-secure">
      <div className="login-secure-pattern" aria-hidden="true" />

      <section className="login-secure-shell">
        <header className="login-secure-heading">
          <div className="login-secure-brand" data-i18n-skip>
            <span className="login-secure-logo" aria-hidden="true">
              <ShoppingBag size={31} strokeWidth={2.2} />
              <i>✓</i>
            </span>
            <strong>
              <span>Tiny</span>
              <b>POS</b>
            </strong>
          </div>

          <p className="login-secure-eyebrow">{t("SECURE STAFF LOGIN")}</p>
          <h1>{t("Welcome back")}</h1>
          <p className="login-secure-subtitle">
            {language === "km" ? "បញ្ចូលឈ្មោះដើម្បីបន្ត" : "Sign in to continue to"}{" "}
            <strong data-i18n-skip>Tiny POS</strong>.
          </p>
        </header>

        <form className="login-secure-card" onSubmit={submit}>
          <div className="login-secure-fields">
            {(message || error) && (
              <div className="notice error login-secure-error" role="alert">
                {t(message || error)}
              </div>
            )}

            <label className="login-secure-field">
              <div>
                <Mail size={21} aria-hidden="true" />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck="false"
                  placeholder="Tiny@example.com"
                  aria-label={t("Email")}
                  autoFocus
                />
              </div>
            </label>

            <label className="login-secure-field">
              <div>
                <LockKeyhole size={21} aria-hidden="true" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                  aria-label={t("Password")}
                />
                <button
                  type="button"
                  className="login-password-toggle"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? t("Hide password") : t("Show password")}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff size={21} /> : <Eye size={21} />}
                </button>
              </div>
            </label>

            <button className="login-secure-submit" disabled={busy}>
              {busy ? t("Signing in…") : t("Log in")}
            </button>
          </div>

          <footer className="login-secure-footer">
            <ShieldCheck size={25} aria-hidden="true" />
            <p>
              <span>{t("Protected by KCC authentication and role permissions.")}</span>
              <small>{t("A certified KCC Enterprise solution.")}</small>
            </p>
          </footer>
        </form>
      </section>
    </main>
  );
}
