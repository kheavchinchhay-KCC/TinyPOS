import { describe, expect, it } from "vitest";
import {
  accessAllows,
  fallbackAccessForRole,
  ROLE_PERMISSION_FALLBACKS
} from "./permissions.js";

describe("permission regression guards", () => {
  it("does not grant cash register override through normal manager fallback", () => {
    expect(ROLE_PERMISSION_FALLBACKS.manager).not.toContain("cash_register.override");
    const access = fallbackAccessForRole("manager");
    expect(accessAllows(access, "cash_register.override")).toBe(false);
  });

  it("allows an explicitly granted cash register override permission", () => {
    const access = {
      role: "manager",
      permissions: { "cash_register.override": true }
    };
    expect(accessAllows(access, "cash_register.override")).toBe(true);
  });

  it("keeps unrelated permissions out of a manager fallback", () => {
    const access = fallbackAccessForRole("manager");
    expect(accessAllows(access, "system.super_admin")).toBe(false);
    // accounting.manage is a critical, owner/admin-only permission (chart of
    // accounts, manual journals, period locks — see 34_accounting_export_general_ledger.sql).
    // Managers keep accounting.export, which they are meant to have.
    expect(accessAllows(access, "accounting.manage")).toBe(false);
    expect(accessAllows(access, "accounting.export")).toBe(true);
  });
});
