import { apiFetch } from "./server-api";
import type { ApiError, ProductDetails, ProductSummary } from "./types";

export class BffRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Server-side client the pages use to call the BFF over HTTP (same contract any other client would use). */
async function bffGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new BffRequestError(res.status, body?.error.message ?? "Request failed");
  }
  return res.json() as Promise<T>;
}

export const fetchProducts = async () => (await bffGet<{ items: ProductSummary[] }>("/api/products")).items;
export const fetchProduct = (id: string) => bffGet<ProductDetails>(`/api/products/${encodeURIComponent(id)}`);
