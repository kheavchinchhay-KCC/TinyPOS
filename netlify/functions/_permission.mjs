/**
 * Resolve a permission for service-role Netlify functions.
 * Precedence matches the database permission engine:
 *   owner -> individual override -> active custom role -> standard role default.
 */
export async function hasEffectivePermission(
  service,
  profile,
  permissionKey,
  defaultRoles = []
) {
  if (!profile?.id || !profile?.is_active) return false;
  if (profile.role === "owner") return true;

  try {
    const { data: override, error: overrideError } = await service
      .from("user_permission_overrides")
      .select("allowed")
      .eq("user_id", profile.id)
      .eq("permission_key", permissionKey)
      .maybeSingle();

    if (!overrideError && override) {
      return Boolean(override.allowed);
    }
  } catch {
    // Older schemas may not have granular permissions yet.
  }

  try {
    let customRoleId = profile.custom_role_id;

    if (customRoleId === undefined) {
      const { data: roleLink, error: roleLinkError } = await service
        .from("profiles")
        .select("custom_role_id")
        .eq("id", profile.id)
        .maybeSingle();

      if (!roleLinkError) customRoleId = roleLink?.custom_role_id || null;
    }

    if (customRoleId) {
      const query = service
        .from("custom_staff_roles")
        .select("permission_keys,is_active,organization_id")
        .eq("id", customRoleId);

      if (profile.organization_id) {
        query.eq("organization_id", profile.organization_id);
      }

      const { data: customRole, error: customRoleError } = await query.maybeSingle();

      if (!customRoleError && customRole) {
        if (!customRole.is_active) return false;
        return (customRole.permission_keys || []).includes(permissionKey);
      }
    }
  } catch {
    // Fall back safely when Step 46 has not been installed yet.
  }

  return defaultRoles.includes(profile.role);
}
