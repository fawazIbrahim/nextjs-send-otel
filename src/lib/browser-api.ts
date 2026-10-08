"use client";

import { outgoingIdHeaders } from "./request-ids";

// Browser-side counterpart of server-api.ts. The correlation id is the one the
// server minted for this page load (proxy.ts), published in
// <meta name="correlation-id"> by the root layout, so browser requests and the
// page render that produced them share one id.

let cachedCorrelationId: string | undefined;

export function getBrowserCorrelationId(): string | undefined {
  if (!cachedCorrelationId && typeof document !== "undefined") {
    cachedCorrelationId =
      document.querySelector<HTMLMetaElement>('meta[name="correlation-id"]')?.content || undefined;
  }
  return cachedCorrelationId;
}

// Fresh X-Request-Id + the page's X-Correlation-Id, for any browser request.
export function browserIdHeaders(): Record<string, string> {
  return outgoingIdHeaders(getBrowserCorrelationId());
}

// fetch() for this app's own API from the browser.
export function browserApiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const requestHeaders = new Headers(init.headers);
  for (const [name, value] of Object.entries(browserIdHeaders())) {
    requestHeaders.set(name, value);
  }
  return fetch(path, { ...init, headers: requestHeaders });
}
