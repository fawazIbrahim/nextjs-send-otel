import { describe, expect, it } from "vitest";
import { NotFoundError } from "../errors";
import type { RemoteClient } from "../remote/client";
import { MOCK_PRODUCTS } from "../remote/mock-data";
import { createProductsService } from "./products-service";

const fakeRemote: RemoteClient = {
  listProducts: async () => MOCK_PRODUCTS,
  getProduct: async (id) => {
    const p = MOCK_PRODUCTS.find((x) => x.product_id === id);
    if (!p) throw new NotFoundError("nope");
    return p;
  },
};

const service = createProductsService(fakeRemote);

describe("products service", () => {
  it("lists only active products, mapped to the BFF contract", async () => {
    const items = await service.list();
    expect(items.map((p) => p.id)).not.toContain("home-legacy");
    expect(items[0]).toEqual({
      id: "auto-comprehensive",
      name: "Comprehensive Car Insurance",
      category: "auto",
      summary: expect.any(String),
      monthlyPremium: { amount: 89, currency: "EUR" },
    });
  });

  it("returns details with money converted from cents", async () => {
    const p = await service.get("home-secure");
    expect(p.coverageLimit).toEqual({ amount: 300000, currency: "EUR" });
    expect(p.eligibility).toEqual({ minAge: 21, maxAge: 99, termMonths: 12 });
  });

  it("treats retired products as not found", async () => {
    await expect(service.get("home-legacy")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("propagates not found for unknown ids", async () => {
    await expect(service.get("missing")).rejects.toBeInstanceOf(NotFoundError);
  });
});
