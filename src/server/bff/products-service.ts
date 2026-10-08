import type { ProductDetails, ProductSummary } from "@/lib/types";
import { NotFoundError } from "../errors";
import type { RemoteClient } from "../remote/client";
import { toDetails, toSummary } from "./mappers";

/** BFF use-cases. Retired products are hidden from the frontend. */
export function createProductsService(remote: RemoteClient) {
  return {
    async list(): Promise<ProductSummary[]> {
      const products = await remote.listProducts();
      return products.filter((p) => p.status === "ACTIVE").map(toSummary);
    },
    async get(id: string): Promise<ProductDetails> {
      const product = await remote.getProduct(id);
      if (product.status !== "ACTIVE") throw new NotFoundError("Product not found");
      return toDetails(product);
    },
  };
}
