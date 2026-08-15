import { describe, expect, it } from "vitest";
import {
  accessAllows,
  accessAllowsAny,
  fallbackAccessForRole,
  moneyLimit,
  ROLE_LIMIT_FALLBACKS,
  ROLE_PERMISSION_FALLBACKS
} from "./permissions.js";

describe("fallbackAccessForRole", () => {
  it("grants the owner role the wildcard permission", () => {
    const access = fallbackAccessForRole("owner");
    expect(access.permissions["*"]).toBe(true);
    expect(access.fallback).toBe(true);
  });

  it("only grants the specific permissions listed for a non-owner role", () => {
    const access = fallbackAccessForRole("viewer");
    expect(access.permissions["*"]).toBeUndefined();
    for (const key of ROLE_PERMISSION_FALLBACKS.viewer) {
      expect(access.permissions[key]).toBe(true);
    }
    // A permission that is NOT in the viewer list must not be granted.
    expect(access.permissions["products.manage"]).toBeUndefined();
  });

  it("falls back to the viewer limits for an unrecognized role", () => {
    const access = fallbackAccessForRole("not-a-real-role");
    expect(access.limits).toEqual(ROLE_LIMIT_FALLBACKS.viewer);
    expect(access.permissions).toEqual({});
  });
});

describe("accessAllows", () => {
  it("always allows when no permission key is required", () => {
    expect(accessAllows(null, undefined)).toBe(true);
    expect(accessAllows({}, "")).toBe(true);
  });

  it("allows an owner regardless of the specific permissions map", () => {
    expect(accessAllows({ role: "owner", permissions: {} }, "anything.manage")).toBe(true);
  });

  it("allows anyone holding the wildcard permission", () => {
    expect(accessAllows({ role: "manager", permissions: { "*": true } }, "anything.manage")).toBe(true);
  });

  it("allows only when the specific permission key is present and truthy", () => {
    const access = { role: "cashier", permissions: { "sales.create": true } };
    expect(accessAllows(access, "sales.create")).toBe(true);
    expect(accessAllows(access, "products.manage")).toBe(false);
  });

  it("denies when access is missing entirely", () => {
    expect(accessAllows(undefined, "sales.create")).toBe(false);
    expect(accessAllows(null, "sales.create")).toBe(false);
  });
});

describe("accessAllowsAny", () => {
  it("allows if at least one of the requested permissions is granted", () => {
    const access = { role: "cashier", permissions: { "returns.process": true } };
    expect(accessAllowsAny(access, ["sales.create", "returns.process"])).toBe(true);
  });

  it("denies when none of the requested permissions are granted", () => {
    const access = { role: "cashier", permissions: {} };
    expect(accessAllowsAny(access, ["sales.create", "returns.process"])).toBe(false);
  });

  it("denies for an empty permission list", () => {
    const access = { role: "owner", permissions: { "*": true } };
    expect(accessAllowsAny(access, [])).toBe(false);
  });
});

describe("moneyLimit", () => {
  it("reads the USD-suffixed limit key by default", () => {
    expect(moneyLimit({ max_discount_amount_usd: 50 }, "max_discount_amount", "USD")).toBe(50);
  });

  it("reads the KHR-suffixed limit key for KHR currency", () => {
    expect(moneyLimit({ max_discount_amount_khr: 200000 }, "max_discount_amount", "KHR")).toBe(200000);
  });

  it("returns null when the limit is null or undefined (meaning unlimited)", () => {
    expect(moneyLimit({ max_discount_amount_usd: null }, "max_discount_amount", "USD")).toBeNull();
    expect(moneyLimit({}, "max_discount_amount", "USD")).toBeNull();
  });

  it("coerces a numeric-looking value to a number", () => {
    expect(moneyLimit({ max_refund_amount_usd: "100" }, "max_refund_amount", "USD")).toBe(100);
  });
});
