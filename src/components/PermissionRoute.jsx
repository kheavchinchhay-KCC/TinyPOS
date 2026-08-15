import { ShieldX } from "lucide-react";
import { useAuth } from "../context/AuthContext";

export default function PermissionRoute({
  permission,
  any = [],
  children
}) {
  const {
    can,
    canAny
  } = useAuth();

  const allowed = permission
    ? can(permission)
    : canAny(any);

  if (allowed) {
    return children;
  }

  return (
    <section className="panel empty-state permission-denied">
      <ShieldX size={48} />
      <h2>Permission required</h2>
      <p>
        This function is hidden for your account.
        Contact an owner or administrator when you
        need access.
      </p>
    </section>
  );
}
