// Request / correlation ids for every API request this app makes or serves.
//
// - X-Correlation-Id: ties together everything that belongs to one user
//   interaction. Minted once at the edge (proxy.ts, or the caller) and then
//   ALWAYS propagated, never regenerated downstream.
// - X-Request-Id: unique per individual HTTP request.
//
// Safe to import from both server and browser code (no Node-only APIs).

export const REQUEST_ID_HEADER = "x-request-id";
export const CORRELATION_ID_HEADER = "x-correlation-id";

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // crypto.randomUUID is missing on non-secure browser origins (plain http
  // other than localhost); fall back to getRandomValues.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Accept an inbound id only if it looks like one (bounded, header-safe), so a
// hostile value can't end up in logs/spans/headers verbatim.
export function sanitizeId(value: string | null | undefined): string | undefined {
  return value && /^[\w.:-]{1,128}$/.test(value) ? value : undefined;
}

// Headers for an outgoing request: a brand-new request id, plus the given
// correlation id (a new one is minted only if there is none to propagate,
// e.g. for background work like telemetry exports that no request triggered).
export function outgoingIdHeaders(correlationId?: string): Record<string, string> {
  return {
    [REQUEST_ID_HEADER]: newId(),
    [CORRELATION_ID_HEADER]: correlationId ?? newId(),
  };
}
