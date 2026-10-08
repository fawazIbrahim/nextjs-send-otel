import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  newId,
  sanitizeId,
} from "@/lib/request-ids";

// Next 16 "proxy" (called middleware.ts, function `middleware`, before Next 16):
// runs before every matched request. Guarantees each request has a request id
// and a correlation id. Normally they are already on the raw request:
// trackRequestIds() (otel/request-ids-processor.ts) mints/validates them first
// so that EVERY span carries them, and this just re-validates; the fallback
// mint only matters if telemetry isn't registered. Both are set on the
// request headers (so Route Handlers / Server Components see them via
// headers()) and echoed on the response.
//
// If you already have a proxy/middleware file, merge this into it: only one is
// allowed. This is unrelated to the /otlp Route Handler.
export function proxy(request: NextRequest) {
  const requestId = sanitizeId(request.headers.get(REQUEST_ID_HEADER)) ?? newId();
  const correlationId = sanitizeId(request.headers.get(CORRELATION_ID_HEADER)) ?? newId();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set(CORRELATION_ID_HEADER, correlationId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set(CORRELATION_ID_HEADER, correlationId);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
