import diagnosticsChannel from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";
import { maskSecret, otelLog } from "./log";

// Structural copy of @opentelemetry/core's ExportResult (SUCCESS = 0), to avoid a direct dependency.
type ExportResult = { code: number; error?: Error };
const EXPORT_SUCCESS = 0;

// Debug logging for every trace/metric export: what is being sent, the
// request headers (credentials masked), and the HTTP response. On by
// default; set TELEMETRY_EXPORT_LOG=false to silence it.
//
// Two pieces, because the OTLP exporters hide the HTTP layer:
//  - logExports() wraps an exporter's export() to log item counts, duration
//    and the final result/error (OTLPExporterError carries status + body).
//  - logBackendHttp() subscribes to Node's http client diagnostics channels
//    to log the actual request headers and response status/headers for
//    requests to the configured OTLP hosts. It doesn't depend on the OTEL
//    instrumentations, which deliberately ignore these requests.

const TAG = "otel-export";

function enabled(): boolean {
  return process.env.TELEMETRY_EXPORT_LOG !== "false";
}

type Exportable<T> = {
  export(items: T, resultCallback: (result: ExportResult) => void): void;
};

export function logExports<T, E extends Exportable<T>>(
  exporter: E,
  kind: "traces" | "metrics"
): E {
  const original = exporter.export.bind(exporter);
  exporter.export = (items, resultCallback) => {
    if (!enabled()) {
      return original(items, resultCallback);
    }
    const started = Date.now();
    otelLog(TAG, `sending ${kind}: ${describeItems(items)}`);
    original(items, (result) => {
      const took = `${Date.now() - started}ms`;
      if (result.code === EXPORT_SUCCESS) {
        otelLog(TAG, `${kind} export succeeded in ${took}`);
      } else {
        const error = result.error as (Error & { code?: number; data?: string }) | undefined;
        otelLog(
          TAG,
          `${kind} export FAILED in ${took}: ${error?.name ?? "Error"}: ${error?.message ?? "unknown"}` +
            (error?.code !== undefined ? ` (status/code ${error.code})` : "") +
            (error?.data ? ` body=${error.data.slice(0, 500)}` : "")
        );
      }
      resultCallback(result);
    });
  };
  return exporter;
}

function describeItems(items: unknown): string {
  if (Array.isArray(items)) {
    return `${items.length} span(s)`;
  }
  const scopeMetrics = (items as { scopeMetrics?: Array<{ metrics: unknown[] }> }).scopeMetrics;
  if (scopeMetrics) {
    const count = scopeMetrics.reduce((total, scope) => total + scope.metrics.length, 0);
    return `${count} metric(s) in ${scopeMetrics.length} scope(s)`;
  }
  return "unknown payload";
}

declare global {
  var __otelExportHttpLogging: boolean | undefined;
}

export function logBackendHttp(backendHosts: Set<string>): void {
  if (globalThis.__otelExportHttpLogging) {
    return;
  }
  globalThis.__otelExportHttpLogging = true;

  diagnosticsChannel.subscribe("http.client.request.start", (message) => {
    const { request } = message as { request: ClientRequest };
    if (!enabled() || !isBackend(request, backendHosts)) {
      return;
    }
    otelLog(
      TAG,
      `-> ${request.method} ${request.protocol}//${request.getHeader("host") ?? request.host}${request.path} headers=${formatHeaders(request.getHeaders())}`
    );
  });

  diagnosticsChannel.subscribe("http.client.response.finish", (message) => {
    const { request, response } = message as { request: ClientRequest; response: IncomingMessage };
    if (!enabled() || !isBackend(request, backendHosts)) {
      return;
    }
    otelLog(
      TAG,
      `<- ${response.statusCode} ${response.statusMessage ?? ""} from ${request.getHeader("host") ?? request.host}${request.path} ` +
        `headers=${formatHeaders(response.headers)}`
    );
  });
}

function isBackend(request: ClientRequest, backendHosts: Set<string>): boolean {
  // request.host is the hostname only; the Host header carries host[:port], like backendHosts.
  const hostHeader = request.getHeader("host")?.toString();
  return backendHosts.has(request.host) || (hostHeader !== undefined && backendHosts.has(hostHeader));
}

function formatHeaders(headers: Record<string, unknown>): string {
  const entries = Object.entries(headers).map(([name, value]) => {
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    return `${name}: ${isSensitive(name) ? maskAuthValue(text) : text}`;
  });
  return `{ ${entries.join("; ")} }`;
}

function isSensitive(name: string): boolean {
  return ["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(name.toLowerCase());
}

function maskAuthValue(value: string): string {
  const [scheme, ...rest] = value.split(" ");
  return rest.length ? `${scheme} ${maskSecret(rest.join(" "))}` : maskSecret(value);
}
