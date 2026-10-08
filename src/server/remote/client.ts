import { z } from "zod";
import { outgoingIdHeaders } from "@/lib/request-ids";
import { REMOTE_TIMEOUT_MS } from "../config";
import { NotFoundError, UpstreamError } from "../errors";
import { remoteProductListSchema, remoteProductSchema, type RemoteProduct } from "./schema";

async function remoteGet<T>(url: string, schema: z.ZodType<T>, correlationId?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", ...outgoingIdHeaders(correlationId) },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    throw new UpstreamError("Remote service unreachable", { cause });
  }
  if (res.status === 404) throw new NotFoundError("Resource not found");
  if (!res.ok) throw new UpstreamError(`Remote service responded ${res.status}`);

  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new UpstreamError("Remote service returned an unexpected payload");
  return parsed.data;
}

/** `correlationId` of the incoming request is propagated to the remote service (new request id per call). */
export function createRemoteClient(baseUrl: string, correlationId?: string) {
  return {
    async listProducts(): Promise<RemoteProduct[]> {
      return (await remoteGet(`${baseUrl}/products`, remoteProductListSchema, correlationId)).items;
    },
    getProduct(id: string): Promise<RemoteProduct> {
      return remoteGet(`${baseUrl}/products/${encodeURIComponent(id)}`, remoteProductSchema, correlationId);
    },
  };
}

export type RemoteClient = ReturnType<typeof createRemoteClient>;
