import { AsyncLocalStorage } from "node:async_hooks";
import diagnosticsChannel from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import type { Attributes } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  newId,
  sanitizeId,
} from "../lib/request-ids";

// Puts request.id / correlation.id on EVERY span created while serving a
// request: Next's own spans, the proxy's span, outgoing-fetch spans and
// custom spans alike.
//
// Why not just read headers when a span starts? Next's spans start before
// (and outside the trace context of) proxy.ts, so neither the OpenTelemetry
// context nor Next's request store has the ids yet, and HttpInstrumentation
// creates no incoming-request span for pages (Next's own tracer owns those),
// so its requestHook never fires for them. Instead trackRequestIds()
// subscribes to Node's http.server.request.start diagnostics channel, which
// fires for every request before any 'request' handler (Next's included): it
// takes the valid inbound ids or mints new ones, writes them back onto the
// raw request headers (so proxy.ts, headers() and everything downstream
// agree), and makes them ambient via AsyncLocalStorage.enterWith().
// RequestIdsSpanProcessor then stamps every span started in that async chain.
// Each incoming request starts its own chain, so concurrent requests don't
// see each other's ids.

declare global {
  var __requestIdsStore: AsyncLocalStorage<Attributes> | undefined;
  var __requestIdsTracking: boolean | undefined;
}

function store(): AsyncLocalStorage<Attributes> {
  return (globalThis.__requestIdsStore ??= new AsyncLocalStorage<Attributes>());
}

export function trackRequestIds(): void {
  if (globalThis.__requestIdsTracking) {
    return;
  }
  globalThis.__requestIdsTracking = true;
  diagnosticsChannel.subscribe("http.server.request.start", (message) => {
    beginRequestIds((message as { request: IncomingMessage }).request);
  });
}

function beginRequestIds(request: IncomingMessage): void {
  const requestId = sanitizeId(headerValue(request.headers[REQUEST_ID_HEADER])) ?? newId();
  const correlationId = sanitizeId(headerValue(request.headers[CORRELATION_ID_HEADER])) ?? newId();
  request.headers[REQUEST_ID_HEADER] = requestId;
  request.headers[CORRELATION_ID_HEADER] = correlationId;

  store().enterWith({ "request.id": requestId, "correlation.id": correlationId });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export class RequestIdsSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const ids = store().getStore();
    if (ids) {
      span.setAttributes(ids);
    }
  }

  onEnd(): void {}

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
