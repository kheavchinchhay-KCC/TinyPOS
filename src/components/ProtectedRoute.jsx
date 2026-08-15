import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import TinyPosLoader from "./TinyPosLoader";

export default function ProtectedRoute({ children }) {
  const {
    session,
    profile,
    access,
    error
  } = useAuth();
  const location = useLocation();

  if (!session) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  // Never render the application with an authenticated session but no loaded
  // POS profile/access. Previously this state looked like every permission was
  // denied and hid the whole sidebar, which was misleading.
  if (!profile || !access) {
    if (!error) {
      return <TinyPosLoader label="Loading POS account…" />;
    }

    return (
      <div className="loading loading-error">
        <div>
          <strong>Unable to load the POS account.</strong>
          <p>{error}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return children;
}
