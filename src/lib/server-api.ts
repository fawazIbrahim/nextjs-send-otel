import { headers } from "next/headers";
import { CORRELATION_ID_HEADER, outgoingIdHeaders, sanitizeId } from "./request-ids";
import { getBaseUrl } from "./get-base-url";

// fetch() for this app's own API (/api/**) from Server Components. Resolves
// the absolute URL, gives the call a fresh X-Request-Id, and propagates the
// correlation id of the incoming request that triggered it.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const incoming = await headers();
  const correlationId = sanitizeId(incoming.get(CORRELATION_ID_HEADER));
  const requestHeaders = new Headers(init.headers);
  for (const [name, value] of Object.entries(outgoingIdHeaders(correlationId))) {
    requestHeaders.set(name, value);
  }
  return fetch(`${await getBaseUrl()}${path}`, { ...init, headers: requestHeaders });
}
