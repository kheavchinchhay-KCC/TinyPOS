import { describe, expect, it } from "vitest";
import {
  calculateSaleTotals,
  saleUnitForProduct,
  buildSaleCartItem,
  exactSaleProductMatch
} from "./sales.js";

const product = {
  id: "p1",
  name: "Coca Cola",
  sku: "CC-01",
  barcode: "8880001",
  unit_name: "pcs",
  selling_price: 0.75,
  product_units: [
    {
      id: "u1",
      name: "pcs",
      short_name: "pcs",
      conversion_factor: 1,
      selling_price: 0.75,
      barcode: "8880001",
      is_base: true,
      is_active: true,
      sort_order: 0
    },
    {
      id: "u2",
      name: "box",
      short_name: "box",
      conversion_factor: 12,
      selling_price: 8.25,
      barcode: "8880012",
      is_base: false,
      is_active: true,
      sort_order: 1
    }
  ]
};

describe("calculateSaleTotals", () => {
  it("calculates subtotal, fixed discount, tax and total", () => {
    expect(
      calculateSaleTotals(
        [
          { selected_unit_price: 0.75, quantity: 2 },
          { selected_unit_price: 1.25, quantity: 1 }
        ],
        "fixed",
        0.25,
        10
      )
    ).toEqual({
      subtotal: 2.75,
      discountAmount: 0.25,
      taxableAmount: 2.5,
      taxAmount: 0.25,
      total: 2.75
    });
  });

  it("caps percentage discount at 100 percent and never produces a negative total", () => {
    expect(calculateSaleTotals([{ selected_unit_price: 5, quantity: 1 }], "percent", 150, 10)).toEqual({
      subtotal: 5,
      discountAmount: 5,
      taxableAmount: 0,
      taxAmount: 0,
      total: 0
    });
  });
});

describe("sale units", () => {
  it("selects an active requested unit and preserves its selling price and factor", () => {
    const unit = saleUnitForProduct(product, "u2");
    expect(unit.name).toBe("box");
    expect(unit.conversion_factor).toBe(12);
    expect(unit.selling_price).toBe(8.25);
  });

  it("builds a cart line from the selected unit without changing product identity", () => {
    const line = buildSaleCartItem(product, "u2", "line-1");
    expect(line.id).toBe("p1");
    expect(line.cart_line_id).toBe("line-1");
    expect(line.selected_unit_id).toBe("u2");
    expect(line.selected_unit_name).toBe("box");
    expect(line.selected_unit_factor).toBe(12);
    expect(line.selected_unit_price).toBe(8.25);
    expect(line.quantity).toBe(1);
  });
});

describe("exactSaleProductMatch", () => {
  it("matches a base product by SKU or barcode", () => {
    expect(exactSaleProductMatch([product], "cc-01").product.id).toBe("p1");
    expect(exactSaleProductMatch([product], "8880001").product.id).toBe("p1");
  });

  it("matches an active packaging unit by its barcode", () => {
    const result = exactSaleProductMatch([product], "8880012");
    expect(result.product.id).toBe("p1");
    expect(result.unit.id).toBe("u2");
  });

  it("does not match an empty scan value", () => {
    expect(exactSaleProductMatch([product], "")).toBeNull();
    expect(exactSaleProductMatch([product], "   ")).toBeNull();
  });
});
