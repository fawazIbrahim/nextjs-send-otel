# Guide: add traces & metrics to an existing Next.js app

A complete, self-contained walkthrough for retrofitting an existing Next.js
(App Router) application with OpenTelemetry traces and metrics that are sent
straight to Grafana Tempo (traces) and Mimir (metrics) over OTLP/HTTP, with
optional IBM Cloud App ID authentication, browser telemetry, and request /
correlation ids on every API call. Every file you need is included below in
full; there is nothing to look up elsewhere.

The code was built and tested on **Next.js 16.3**, React 19 and the
OpenTelemetry JS SDK 2.11 (contrib packages 0.222). Where Next 15 differs it is
noted. Whatever your Next version, skim the docs shipped with it
(`node_modules/next/dist/docs/`) before applying these conventions: file names and
APIs (`proxy.ts` vs `middleware.ts`, `RouteContext`, ...) have changed between
majors.

## 0. What you get

```
 Browser ── traces/metrics ──▶ /otlp  (a Route Handler in your Next server) ──┐
   │  X-Request-Id / X-Correlation-Id on every request                        │ adds auth
   ▼                                                                          │ + tenant headers
 Next server (Node) ── traces ────────────────────────────────────────────────┼──▶ Tempo (OTLP/HTTP)
   spans carry request.id + correlation.id                                    │
                     ── metrics ──────────────────────────────────────────────┴──▶ Mimir (OTLP/HTTP)
```

- Server traces and metrics are exported **directly** to Tempo and Mimir, over
  OTLP/HTTP with protobuf. No collector.
- Browser traces and metrics go through a same-origin `/otlp` proxy that adds
  the credentials server-side, because a browser must never hold them.
- Endpoints, service name and resource attributes come from the **standard
  `OTEL_*` environment variables**, as with the Java agent. Code only adds what
  environment variables cannot express: an expiring auth token, request
  filtering, ids and small helpers.
- Every API request has a unique `X-Request-Id` and a propagated
  `X-Correlation-Id`; both are attributes (`request.id`, `correlation.id`) on
  every span.
- Debug logging for token fetches and every export, with credentials masked.

### Modules

Steps 1-5 are the core. The rest are independent add-ons:

| Step | Module | Needed for |
|---|---|---|
| 4 | Server telemetry | everything (core) |
| 5 | Helpers (`withSpan`, metrics) | custom spans and metrics (core) |
| 6 | Request / correlation ids | ids on every request and span |
| 7 | Browser telemetry + `/otlp` proxy | traces/metrics from the browser |
| 8 | Auth layer (IBM App ID + tenant header) | backends that require auth |

`server.ts` (step 4) imports the id and auth modules, so either add steps 6
and 8 before first running, or delete the lines marked `// step 6` /
`// step 8` in it and in the files that reference them. Each such line is
labelled.

## 1. Prerequisites and decisions

1. An App Router app on the Node.js runtime. `instrumentation.ts` is supported
   natively by Next 15+ (no experimental flag).
2. The **full URLs** of your backends' OTLP/HTTP endpoints:
   - Tempo traces, e.g. `https://<gateway>/tempo/v1/traces`.
   - Mimir metrics, using Mimir's **native OTLP** route, e.g.
     `https://<gateway>/mimir/otlp/v1/metrics`. Do **not** use `/api/v1/push`
     (Prometheus remote-write): it answers `400 snappy: corrupt input` because
     the app sends OTLP, not remote-write. Native OTLP ingestion must be enabled
     on the Mimir side; that is an infrastructure prerequisite, not an app change.
3. If your backends need auth: an IBM Cloud App ID *client-credentials* client
   (token URL, client id, client secret). Another scheme is a small edit (step 8).
4. Ask whoever runs the gateway in front of Tempo/Mimir whether it **requires
   gzip request bodies**. Ours did (`400 gzip: invalid header` otherwise); the
   fix is one environment variable (step 3).
5. Whether the gateway needs a tenant header (`X-Scope-OrgID`). Optional,
   supported (`GRAFANA_ORG_ID`).

Why these choices:

- **Protobuf exporters.** Use the `-proto` exporter packages. In this SDK
  version the `-http` exporters default to JSON, not protobuf.
- **No collector.** The app exports itself; one less moving part. Add a
  collector later if you need fan-out or buffering; only the endpoint URLs change.
- **Browser through a proxy.** Browser code is public. Credentials and backend
  addresses must stay on the server, so the browser only ever talks to your own
  origin. The server does not need the proxy and never uses it (routing server
  telemetry through its own HTTP listener would only add latency and a failure
  mode).

## 2. Install packages

```bash
# core (server)
npm i @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/resources \
  @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base @opentelemetry/sdk-metrics \
  @opentelemetry/exporter-trace-otlp-proto @opentelemetry/exporter-metrics-otlp-proto \
  @opentelemetry/instrumentation @opentelemetry/instrumentation-http \
  @opentelemetry/instrumentation-undici

# only for step 7 (browser)
npm i @opentelemetry/instrumentation-fetch @opentelemetry/sdk-trace-web
```

Keep the OpenTelemetry packages on matching major lines (the 2.x SDK packages
with the 0.2xx contrib/exporter packages); mixing generations causes type and
runtime errors.

## 3. Environment variables

Put these in `.env.local` for development and in your deployment's configuration
for real environments. Commit a `.env.example` with the same keys and no secrets.

```bash
# --- Required: FULL URLs including the signal path -------------------------
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<gateway>/tempo/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://<gateway>/mimir/otlp/v1/metrics

# --- Identity of this service ----------------------------------------------
OTEL_SERVICE_NAME=my-app
OTEL_RESOURCE_ATTRIBUTES=service.version=1.0.0,deployment.environment.name=development

# --- Only if the gateway rejects uncompressed bodies ("gzip: invalid header")
OTEL_EXPORTER_OTLP_COMPRESSION=gzip

# --- Step 7: path the BROWSER exports to (the /otlp proxy) -----------------
OTLP_ENDPOINT=/otlp

# --- Step 8: auth (leave TELEMETRY_AUTH_PROVIDER unset for no auth) ---------
TELEMETRY_AUTH_PROVIDER=appid
APPID_TOKEN_URL=https://<region>.appid.cloud.ibm.com/oauth/v4/<tenantId>/token
APPID_CLIENT_ID=
APPID_CLIENT_SECRET=
GRAFANA_ORG_ID=tenant1                 # sent as X-Scope-OrgID when set

# --- Debugging (all optional) ----------------------------------------------
OTEL_METRIC_EXPORT_INTERVAL=5000   # ms between metric exports (default 60000)
TELEMETRY_EXPORT_LOG=              # "false" silences [otel-export]/[otel-proxy] logs
TELEMETRY_AUTH_DEBUG_TOKEN=        # "true" prints the FULL bearer token. Debug only!
```

Rules for these variables:

- `OTEL_EXPORTER_OTLP_*`, `APPID_*` and `GRAFANA_ORG_ID` are **server-only
  secrets/addresses**. Never list them in `next.config.ts`'s `env` block: that
  block is compiled into the browser bundle.
- Real environment variables win over `.env.local`: Next never overrides a
  variable that is already set. Remember this when testing against a local
  receiver (step 9).
- Restart the dev server after changing any of them; Next reads them at startup.

## 4. Server telemetry (core)

### 4.1 `src/otel/server.ts`: the SDK

Creates and starts a single `NodeSDK` (guarded by `globalThis` so Fast Refresh
or duplicate module instances can't register it twice). It is the only place
OpenTelemetry is initialised.

**`src/otel/server.ts`**

```ts
import { IncomingMessage, type RequestOptions } from "node:http";
import {
  SpanKind,
  type Attributes,
  type Context,
  type Link,
} from "@opentelemetry/api";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  SamplingDecision,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { getGrafanaHeaders } from "./auth"; // step 8 (auth). Remove with that step.
import { outgoingIdHeaders } from "../lib/request-ids"; // step 6 (ids). Remove with that step.
import { logBackendHttp, logExports } from "./export-logging";
import { RequestIdsSpanProcessor, trackRequestIds } from "./request-ids-processor"; // step 6

// Server-side OpenTelemetry wiring, called once from instrumentation.ts.
//
// Endpoints, service name and resource attributes come from the standard
// OTEL_* env vars (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
// OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, OTEL_SERVICE_NAME,
// OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_COMPRESSION, ...): the
// exporters and NodeSDK read them themselves. Code only adds what env vars
// can't express: the expiring auth token, request filtering and ids.
//
// State lives on `globalThis`: Next/Turbopack can give a Route Handler and
// instrumentation.ts separate instances of this module in dev.

declare global {
  var __otelSdk: NodeSDK | undefined;
}

// Called by the exporters on EVERY export, which is how an expiring token
// stays fresh (a static OTEL_EXPORTER_OTLP_HEADERS value would go stale).
// Each export request gets its own X-Request-Id and a correlation id; no
// incoming request triggered an export batch, so each batch is its own
// correlation scope.
const exportHeaders = async () => ({ ...outgoingIdHeaders(), ...(await getGrafanaHeaders()) });

const newTraceExporter = () =>
  logExports(new OTLPTraceExporter({ headers: exportHeaders }), "traces");
const newMetricExporter = () =>
  logExports(new OTLPMetricExporter({ headers: exportHeaders }), "metrics");

// Readers built in code don't pick up the standard OTEL_METRIC_EXPORT_INTERVAL
// (only NodeSDK's own env-built reader does), so honor it here (ms, default 60s).
const newMetricReader = (exporter: ReturnType<typeof newMetricExporter>) =>
  new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000,
  });

export function registerServerOtel(): void {
  if (globalThis.__otelSdk) {
    return;
  }

  const backendHosts = telemetryBackendHosts();
  logBackendHttp(backendHosts);
  trackRequestIds(); // step 6

  globalThis.__otelSdk = new NodeSDK({
    spanProcessors: [new RequestIdsSpanProcessor(), new BatchSpanProcessor(newTraceExporter())],
    metricReaders: [newMetricReader(newMetricExporter())],
    sampler: new ExcludeStaticAssetsSampler(new ParentBasedSampler({ root: new AlwaysOnSampler() })),
    instrumentations: [
      new HttpInstrumentation({
        // Static assets aren't traced.
        ignoreIncomingRequestHook: (request) => isStaticAssetPath(request.url),
        // Don't trace this app's own OTLP exports: without this, exporting a
        // batch of spans creates a new span about exporting spans.
        ignoreOutgoingRequestHook: (request) => backendHosts.has(getRequestHost(request) ?? ""),
        // Default span name is just the method; make it "GET /path".
        requestHook: (span, request) => {
          if (request instanceof IncomingMessage && request.url) {
            span.updateName(`${request.method ?? "GET"} ${pathnameOf(request.url)}`);
          }
        },
      }),
      new UndiciInstrumentation({
        // Next's server-side fetch() runs on undici.
        ignoreRequestHook: (request) => backendHosts.has(hostOf(request.origin)),
        requestHook: (span, request) => {
          span.updateName(`${request.method} ${pathnameOf(request.path)}`);
        },
      }),
    ],
  });
  globalThis.__otelSdk.start();
}

// Hosts of the configured OTLP endpoints, to keep exporter traffic out of traces.
function telemetryBackendHosts(): Set<string> {
  const urls = [
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  ];
  return new Set(urls.filter((u): u is string => !!u).map(hostOf));
}

function pathnameOf(rawUrl: string): string {
  return rawUrl.split("?")[0];
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function getRequestHost(request: RequestOptions): string | undefined {
  if (request.host) {
    return request.host;
  }
  if (request.hostname) {
    return request.port ? `${request.hostname}:${request.port}` : request.hostname;
  }
  return undefined;
}

// Paths that are never traced. "/otlp/" is the browser telemetry proxy
// (step 7): tracing it would create spans about shipping spans. Add your own
// static-like prefixes here, in this one list.
const STATIC_ASSET_PATH_PREFIXES = ["/_next/static/", "/_next/image", "/favicon.ico", "/otlp/"];

function isStaticAssetPath(rawUrl: string | undefined): boolean {
  return !!rawUrl && STATIC_ASSET_PATH_PREFIXES.some((p) => pathnameOf(rawUrl).startsWith(p));
}

// Catches static-looking spans created by Next's own tracer (e.g.
// /favicon.ico), which HttpInstrumentation's ignore hook can't see. Next
// renames these spans after sampling, so this checks path attributes as well
// as the span name. Both this sampler and the hook above are needed.
class ExcludeStaticAssetsSampler implements Sampler {
  constructor(private readonly delegate: Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[]
  ): SamplingResult {
    if (isStaticAssetSpan(spanName, attributes)) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `ExcludeStaticAssetsSampler{${this.delegate.toString()}}`;
  }
}

const STATIC_ASSET_PATH_ATTRIBUTE_KEYS = ["http.target", "url.path", "next.route", "http.route"];

function isStaticAssetSpan(spanName: string, attributes: Attributes): boolean {
  const spaceIndex = spanName.indexOf(" ");
  if (isStaticAssetPath(spaceIndex === -1 ? spanName : spanName.slice(spaceIndex + 1))) {
    return true;
  }
  return STATIC_ASSET_PATH_ATTRIBUTE_KEYS.some((key) => {
    const value = attributes[key];
    return typeof value === "string" && isStaticAssetPath(value);
  });
}
```

What to know about this file:

- **Exporters read their endpoint, compression and so on from `OTEL_*`
  variables themselves.** No URL appears in code.
- **`headers: exportHeaders` is a function, not an object.** The exporters call
  it on every export, which is what keeps an expiring token fresh. A static
  `OTEL_EXPORTER_OTLP_HEADERS` value would go stale.
- **The ignore hooks keep telemetry about telemetry out of your traces.** The
  hosts come from the same endpoint variables.
- **Two static-asset filters are both required.** The `HttpInstrumentation`
  hook alone doesn't catch `/favicon.ico`, whose span comes from Next's own
  tracer; the sampler does. Add static-like prefixes to
  `STATIC_ASSET_PATH_PREFIXES`, the single list both use.
- **`newMetricReader` reads `OTEL_METRIC_EXPORT_INTERVAL` itself.** A reader
  built in code does not honour that standard variable.
- **State lives on `globalThis`.** Next/Turbopack can give a Route Handler and
  `instrumentation.ts` separate instances of the same module in dev.

### 4.2 `src/otel/log.ts` and `src/otel/export-logging.ts`: visibility

Without these, a failed export is silent. They log every trace/metric export
(item count, request headers with credentials masked, response status and
headers, error body) as `[otel-export]` lines. `logExports` wraps an exporter's
`export()`; `logBackendHttp` listens to Node's `http.client.*` diagnostics
channels to show the real HTTP request and response.

**`src/otel/log.ts`**

```ts
// Shared helpers for the telemetry debug logs ([appid-token], [otel-export], [otel-proxy]).

export function otelLog(tag: string, message: string): void {
  console.log(`[${tag}] ${message}`);
}

// A bearer token / credential is masked unless TELEMETRY_AUTH_DEBUG_TOKEN=true.
export function maskSecret(secret: string): string {
  if (process.env.TELEMETRY_AUTH_DEBUG_TOKEN === "true") {
    return secret;
  }
  return `${secret.slice(0, 8)}…(${secret.length} chars)`;
}
```

**`src/otel/export-logging.ts`**

```ts
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
```

### 4.3 `src/instrumentation.ts`: register it

Next calls `register()` once per server instance. If you already have this file,
add the body of the `if` to your existing function. Put it in `src/` if your
app uses a `src` folder, otherwise in the project root, next to `app/`.

**`src/instrumentation.ts`**

```ts
// Next.js server-lifecycle hook: register() runs once when a new server
// instance starts, before it accepts requests. If you already have this file,
// add the body of the `if` to your existing register().
export async function register() {
  // NodeSDK can't load in the edge runtime, so guard on the Node.js runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerServerOtel } = await import("./otel/server");
    registerServerOtel();
  }
}
```

## 5. Helpers: custom spans and metrics

Next and the HTTP/undici instrumentations already produce spans for routing,
rendering and every `fetch`. What's missing is spans and metrics for **your own
logic**. Use these two helpers instead of calling `@opentelemetry/api` directly,
so tracer/meter names and request ids stay consistent.

**`src/otel/tracing.ts`**

```ts
import { headers } from "next/headers";
import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from "@/lib/request-ids";

// Helper for app-defined spans. Auto-instrumentation and Next already produce
// generic spans (one per request and per fetch); withSpan() wraps a specific
// piece of application logic as its own named, nested span, so a trace
// waterfall shows what the app was doing, not just that an HTTP call happened.

const TRACER_NAME = "my-app";

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes?: Attributes
): Promise<T> {
  const ids = await currentRequestIds();
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes: { ...ids, ...attributes } }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

// request.id / correlation.id of the incoming request being served, so custom
// spans can be found by either id. headers() throws outside a request scope
// (e.g. background work), in which case there are none.
async function currentRequestIds(): Promise<Attributes> {
  try {
    const incoming = await headers();
    const ids: Attributes = {};
    const requestId = incoming.get(REQUEST_ID_HEADER);
    const correlationId = incoming.get(CORRELATION_ID_HEADER);
    if (requestId) ids["request.id"] = requestId;
    if (correlationId) ids["correlation.id"] = correlationId;
    return ids;
  } catch {
    return {};
  }
}
```

**`src/otel/metrics.ts`**

```ts
import {
  metrics,
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
} from "@opentelemetry/api";

// Helper for recording app-defined ("custom") metrics from anywhere in the
// app: Route Handlers, Server Components, or Client Components. Reads the
// MeterProvider registered for the current runtime (server.ts on the server,
// client.ts in the browser), so callers never touch the OpenTelemetry SDK.

const METER_NAME = "my-app";

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, Gauge>();

function getMeter() {
  return metrics.getMeter(METER_NAME);
}

function getCounter(name: string): Counter {
  let counter = counters.get(name);
  if (!counter) {
    counter = getMeter().createCounter(name);
    counters.set(name, counter);
  }
  return counter;
}

function getHistogram(name: string): Histogram {
  let histogram = histograms.get(name);
  if (!histogram) {
    histogram = getMeter().createHistogram(name);
    histograms.set(name, histogram);
  }
  return histogram;
}

function getGauge(name: string): Gauge {
  let gauge = gauges.get(name);
  if (!gauge) {
    gauge = getMeter().createGauge(name);
    gauges.set(name, gauge);
  }
  return gauge;
}

export function recordCounter(name: string, value = 1, attributes?: Attributes): void {
  getCounter(name).add(value, attributes);
}

export function recordHistogram(name: string, value: number, attributes?: Attributes): void {
  getHistogram(name).record(value, attributes);
}

// A synchronous Gauge re-exports its LAST value on every export tick forever.
// Use it only for values that legitimately keep their last reading (queue
// depth, pool size), never for "is it still being checked" signals.
export function recordGauge(name: string, value: number, attributes?: Attributes): void {
  getGauge(name).record(value, attributes);
}
```

Replace the `"my-app"` tracer/meter names with yours. Usage:

```ts
import { withSpan } from "@/otel/tracing";
import { recordCounter, recordHistogram } from "@/otel/metrics";
import { apiFetch } from "@/lib/server-api"; // step 6

const orders = await withSpan(
  "orders.load", // span name: keep it low-cardinality
  async () => {
    const start = performance.now();
    const res = await apiFetch("/api/orders", { cache: "no-store" });
    recordHistogram("orders_fetch_duration_ms", performance.now() - start, {
      "http.status_code": res.status,
    });
    return res.json();
  },
  { "orders.source": "api" } // attributes
);
recordCounter("orders_page_view_count");
```

`withSpan` creates a child of the current span, records exceptions, sets the
status, always ends the span, and adds `request.id`/`correlation.id`.

### 5.1 Worked examples: where each helper belongs

**A Route Handler: `withSpan` + `recordCounter`.** Wrap the unit of work in a
span, count successes after it, count failures in the `catch`. The span name is
fixed; variable data (an id) goes in attributes. A value you only learn inside
the work (a result size) is set on the span the callback receives.

```ts
// src/app/api/products/route.ts
import { errorResponse, productsServiceFor } from "@/server/bff/http";
import { recordCounter } from "@/otel/metrics";
import { withSpan } from "@/otel/tracing";

export async function GET(request: Request) {
  try {
    const products = await withSpan("bff.products.list", async (span) => {
      const items = await productsServiceFor(request).list();
      span.setAttribute("products.count", items.length); // known only after the call
      return items;
    });
    recordCounter("bff_products_list_count"); // +1 per successful request
    return Response.json({ items: products });
  } catch (err) {
    // withSpan has already marked the span as ERROR and recorded the exception.
    recordCounter("bff_products_error_count", 1, { operation: "list" });
    return errorResponse(err);
  }
}
```

```ts
// src/app/api/products/[id]/route.ts: passing attributes as the 3rd argument
const product = await withSpan("bff.products.get", () => productsServiceFor(request).get(id), {
  "product.id": id, // attribute, NOT part of the span name
});
recordCounter("bff_product_get_count");
```

Rules of thumb:

- `withSpan(name, fn, attributes?)`: `fn` may be sync or async; whatever it
  returns is returned. A throw is recorded, marks the span `ERROR`, ends the
  span and is re-thrown, so keep your normal `try/catch` outside it.
- `recordCounter(name, value = 1, attributes?)`: call it **once per event**
  (after success, or in the `catch`). Keep attribute values low-cardinality
  (`operation: "list"`, never a user or product id). Use `recordHistogram` for
  durations and sizes, as in the `orders` example above.
- Don't wrap trivial code. Span the operations you'd want to see as a bar in a
  trace: a service call, a computation, a cache lookup.
- `withSpan` is server-only (it imports `next/headers`). In Client Components
  use `recordCounter`/`recordHistogram`, as `ViewTracker` does.

**A page: `ViewTracker`.** Drop it anywhere in a Server Component's JSX; it
renders nothing and increments the counter in the browser once per mount (so
once per page view, including client-side navigations).

```tsx
// src/app/page.tsx (list page)
import { ViewTracker } from "@/components/ViewTracker";

export default async function HomePage() {
  const products = await fetchProducts();
  return (
    <>
      <ViewTracker metricName="product_list_view_count" />
      <h1>Our insurance products</h1>
      {/* ... */}
    </>
  );
}
```

```tsx
// src/app/products/[id]/page.tsx (detail page): one metric name per page TYPE
<ViewTracker metricName="product_detail_view_count" />
```

Use a fixed `metricName` per page type, not per item: put the product id in
a span attribute if you need it, never in the metric name. The metrics reach
Mimir through the `/otlp` proxy (step 7), so `ViewTracker` needs step 7 to be
in place.

Conventions worth keeping:

- Span **names** are low-cardinality ("orders.load", not "orders.load 42"); put
  variable data in attributes. (If a specific span is the one people actually
  read and you want the id in the name, make that an explicit, documented
  exception.)
- Metric names are snake_case with a unit suffix (`_ms`, `_count`).
- Use `recordGauge` only for values that legitimately keep their last reading
  (queue depth, pool size). It re-exports the last value on every tick, forever,
  so it is wrong for "is this still being checked" signals. For those use an
  `ObservableGauge` that skips `observe()` when stale, **on its own
  `MeterProvider` with `DELTA` temporality**: under the default `CUMULATIVE`
  temporality the SDK keeps re-exporting the last value even if you stop
  observing it.

## 6. Request ids and correlation ids (optional, recommended)

**Requirement:** every API request, whether it starts in the browser or on the
server, carries a unique request id and a correlation id, and the correlation id
is always propagated.

| Header | Meaning | Lifetime |
|---|---|---|
| `X-Request-Id` | one HTTP request | new for every request |
| `X-Correlation-Id` | everything belonging to one user interaction | minted once at the edge, then propagated unchanged |

### 6.1 The helpers

**`src/lib/request-ids.ts`**: header names, id generation, validation. Safe for
server and browser.

```ts
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
```

**`src/lib/get-base-url.ts`**: Server Components need an absolute URL to call
their own API.

```ts
import { headers } from "next/headers";

// Server Components need an absolute URL to fetch this app's own Route
// Handlers (relative URLs aren't resolvable outside a browser). Derived from
// the incoming request's own headers instead of a hardcoded host/port, so it
// keeps working in dev, prod, and behind a reverse proxy.
export async function getBaseUrl(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}`;
}
```

**`src/lib/server-api.ts`**: `apiFetch`, for calling your own API from Server
Components. New request id; propagates the incoming correlation id.

```ts
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
```

**`src/lib/browser-api.ts`**: the browser counterpart.

```ts
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
```

### 6.2 `src/proxy.ts`: the edge

Next 16 calls this file `proxy.ts` (export `proxy`). **On Next 15 and earlier it
is `middleware.ts` with an exported function named `middleware`.** It re-validates
the ids, sets them on the request headers (so Route Handlers and Server
Components can read them via `headers()`) and echoes them on the response. Only
one proxy/middleware file is allowed per app: **if you already have one, merge
this logic into it** (and keep the `matcher` excluding static assets).

**`src/proxy.ts`**

```ts
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
```

### 6.3 Stamping every span

**`src/otel/request-ids-processor.ts`**

```ts
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
```

`server.ts` (step 4) already calls `trackRequestIds()` and registers
`RequestIdsSpanProcessor`. Why it is built this way, because the obvious
approaches do not work:

- Next's own spans (`GET /route`, render, middleware, metadata, ...) **start
  before your proxy runs**, and the proxy executes on its own detached
  "middleware" root span, outside the request's span tree. So the proxy cannot
  tag them, and neither the OpenTelemetry context nor Next's request store has
  the ids at that point.
- `HttpInstrumentation` creates **no incoming-request span for pages** (Next's
  tracer owns those), so its `requestHook` never fires for them either.
- Node's `http.server.request.start` diagnostics channel fires for **every**
  request, before any `'request'` handler. There we read or mint the ids, write
  them back onto the raw request headers (so proxy, `headers()` and `apiFetch`
  agree), and put them in an `AsyncLocalStorage` scoped to that request. The span
  processor stamps every span started in that chain. Concurrent requests each
  have their own chain, so ids don't leak between them (verified with several
  simultaneous requests carrying different correlation ids).
- `withSpan` additionally stamps from `headers()`, which also covers spans made
  by any extra `TracerProvider` you register that doesn't use this processor.
- Scoping is per **request**, not per trace: one trace can contain the page
  render and its `/api` call, each with its own `request.id` and the shared
  `correlation.id`. OTLP has no trace-level attributes, so "on the trace" means
  on every span; search your tracing backend by `correlation.id` to see the whole
  interaction.

### 6.4 Publish the page's correlation id to the browser

Add this to your root layout so browser requests share the id of the page load
that produced them. Reading `headers()` makes the layout dynamic.

**`src/app/layout.tsx`** (merge into yours)

```tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import { CORRELATION_ID_HEADER } from "@/lib/request-ids";

// Publishes this page load's correlation id (minted by proxy.ts) as
// <meta name="correlation-id">, so browser requests can propagate it
// (lib/browser-api.ts). Merge into your existing layout's metadata; note that
// reading headers() makes the layout dynamic.
export async function generateMetadata(): Promise<Metadata> {
  const correlationId = (await headers()).get(CORRELATION_ID_HEADER);
  return {
    title: "My App", // keep your existing metadata here
    other: correlationId ? { "correlation-id": correlationId } : {},
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

### 6.5 Use the helpers everywhere

- **Server Components / server code calling your own API:**
  `apiFetch("/api/x", init)` instead of `fetch("/api/x")`.
- **Browser code calling your own API:** `browserApiFetch("/api/x", init)`.
- **Any other outgoing request you add** must set
  `outgoingIdHeaders(correlationId)` from `src/lib/request-ids.ts`
  (for example the token fetch in step 8 and the export requests in step 4 do).

Search your codebase for bare `fetch("/api` and `fetch(\`${base}/api` calls and
replace them.

### 6.6 Check it

```bash
curl -i -H "X-Correlation-Id: demo-1" http://localhost:3000/
```

Expect `x-correlation-id: demo-1`, a fresh `x-request-id`, and the page HTML
containing `<meta name="correlation-id" content="demo-1">`. Without the header,
both ids are generated. A hostile value (spaces, `<`, over 128 characters) is
replaced, not echoed.

## 7. Browser telemetry (optional)

### 7.1 The browser SDK

**`src/otel/client.ts`**

```ts
"use client";

import { metrics } from "@opentelemetry/api";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  WebTracerProvider,
  StackContextManager,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-web";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { browserIdHeaders } from "../lib/browser-api"; // step 6 (ids). Remove with that step.

// Browser-side OpenTelemetry wiring, called once from instrumentation-client.ts.
//
// Sends telemetry to the same-origin OTLP_ENDPOINT ("/otlp" by default), which
// app/otlp/[...path]/route.ts forwards to Tempo/Mimir and attaches the auth
// headers to. The browser never learns the backend URLs or the credential.
//
// Config reaches the bundle only through next.config.ts's `env` block, and only
// via direct `process.env.X` access (Next inlines it statically).

let registered = false;

export function registerBrowserOtel(): void {
  if (registered) {
    return;
  }
  registered = true;

  const otlpEndpoint = process.env.OTLP_ENDPOINT || "/otlp";
  const resource = resourceFromAttributes({
    ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
    "service.name": process.env.OTEL_SERVICE_NAME,
    "service.runtime": "browser",
  });

  // Each export is an API request from the browser: fresh X-Request-Id and this
  // page load's X-Correlation-Id (step 6). Drop `headers` if you skip step 6.
  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
    headers: async () => browserIdHeaders(),
  });
  const tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });
  tracerProvider.register({
    contextManager: new StackContextManager(),
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${otlpEndpoint}/v1/metrics`,
    headers: async () => browserIdHeaders(),
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 60_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  registerInstrumentations({
    instrumentations: [
      new FetchInstrumentation({
        // Don't trace the telemetry exporter's own requests to itself.
        ignoreUrls: [new RegExp(`^${escapeRegExp(otlpEndpoint)}/`)],
      }),
    ],
  });
}

// OTEL_RESOURCE_ATTRIBUTES format: "key1=value1,key2=value2".
function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const separator = pair.indexOf("=");
    if (separator > 0) {
      attributes[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
  }
  return attributes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

**`src/instrumentation-client.ts`**: Next runs this file once in the browser,
before React hydrates.

```ts
// Next.js client-lifecycle file: runs after the HTML document loads but before
// React hydration begins.
import { registerBrowserOtel } from "./otel/client";

registerBrowserOtel();
```

### 7.2 The `/otlp` proxy

The browser exports to your own origin; this Route Handler forwards to the same
two endpoint variables the server uses, adds the auth/tenant headers, gzips when
`OTEL_EXPORTER_OTLP_COMPRESSION=gzip`, forwards the request/correlation ids and
logs each forward. It answers `404` for any path except `v1/traces` and
`v1/metrics`, `500` if no upstream is configured, `502` if the backend is
unreachable. It must live at `app/otlp/[...path]/route.ts` (or
`src/app/otlp/[...path]/route.ts`); the folder name is the URL, so if you change
`OTLP_ENDPOINT` from `/otlp`, move the folder to match. After adding it run
`npx next typegen` (or just start `next dev`) so the generated `RouteContext`
type exists.

**`src/app/otlp/[...path]/route.ts`**

```ts
import { NextResponse } from "next/server";
import { gzipSync } from "node:zlib";
import { getGrafanaHeaders } from "@/otel/auth"; // step 8 (auth). Remove with that step.
import { maskSecret, otelLog } from "@/otel/log";
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER, newId } from "@/lib/request-ids"; // step 6

// Browser-facing OTLP proxy. The browser sends traces/metrics to this
// same-origin route; it forwards them to the backends and attaches the
// auth/tenant headers server-side, because the browser can never hold that
// credential. Server-side telemetry does NOT go through here: it exports
// directly from the Node process.
//
// Upstream URLs are the same standard env vars the server exporters use
// (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / _METRICS_ENDPOINT, full URLs), and
// OTEL_EXPORTER_OTLP_COMPRESSION=gzip is honored too, so browser and server
// telemetry always reach the backend in the same shape.
//
// This route's own path is fixed by its folder (app/otlp/[...path]), not by the
// OTLP_ENDPOINT env var: if you change OTLP_ENDPOINT away from "/otlp", move
// this folder to match.

const TAG = "otel-proxy";

const SIGNAL_ENDPOINT_ENV: Record<string, string> = {
  "v1/traces": "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "v1/metrics": "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
};

function resolveUpstream(signal: string): string | undefined {
  const specific = process.env[SIGNAL_ENDPOINT_ENV[signal]];
  if (specific) {
    return specific;
  }
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  return base ? `${base.replace(/\/$/, "")}/${signal}` : undefined;
}

function logEnabled(): boolean {
  return process.env.TELEMETRY_EXPORT_LOG !== "false";
}

export async function POST(request: Request, ctx: RouteContext<"/otlp/[...path]">) {
  const { path } = await ctx.params;
  const signal = path.join("/");

  if (!(signal in SIGNAL_ENDPOINT_ENV)) {
    return NextResponse.json({ error: `Unsupported OTLP path: /${signal}` }, { status: 404 });
  }
  const upstream = resolveUpstream(signal);
  if (!upstream) {
    return NextResponse.json(
      { error: `No upstream configured for ${signal} (set ${SIGNAL_ENDPOINT_ENV[signal]}).` },
      { status: 500 }
    );
  }

  const authHeaders = await getGrafanaHeaders();
  const received = Buffer.from(await request.arrayBuffer());
  const gzip = process.env.OTEL_EXPORTER_OTLP_COMPRESSION === "gzip";
  const body = gzip ? gzipSync(received) : received;

  // Forward the browser's ids (proxy.ts guarantees both are present).
  const idHeaders = {
    [REQUEST_ID_HEADER]: request.headers.get(REQUEST_ID_HEADER) ?? newId(),
    [CORRELATION_ID_HEADER]: request.headers.get(CORRELATION_ID_HEADER) ?? newId(),
  };
  const headers: Record<string, string> = {
    ...idHeaders,
    "Content-Type": request.headers.get("content-type") ?? "application/x-protobuf",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    ...authHeaders,
  };

  const started = Date.now();
  if (logEnabled()) {
    otelLog(
      TAG,
      `browser ${signal}: received ${received.length}B, forwarding${gzip ? ` (gzip ${body.length}B)` : ""} ` +
        `-> POST ${upstream} headers=${formatHeaders(headers)}`
    );
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream, { method: "POST", headers, body: new Uint8Array(body) });
  } catch (error) {
    otelLog(TAG, `browser ${signal}: upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: "Upstream telemetry backend unreachable." }, { status: 502 });
  }

  const responseBody = await upstreamResponse.arrayBuffer();
  if (logEnabled()) {
    const detail = upstreamResponse.ok ? "" : ` body=${Buffer.from(responseBody).toString("utf8").slice(0, 500)}`;
    otelLog(
      TAG,
      `browser ${signal}: <- ${upstreamResponse.status} ${upstreamResponse.statusText} in ${Date.now() - started}ms${detail}`
    );
  }

  return new NextResponse(responseBody, {
    status: upstreamResponse.status,
    headers: {
      "Content-Type": upstreamResponse.headers.get("content-type") ?? "application/json",
    },
  });
}

// Credentials are masked in logs, like the server exporters' logs.
function formatHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers).map(([name, value]) => {
    if (name.toLowerCase() !== "authorization") {
      return `${name}: ${value}`;
    }
    const [scheme, ...rest] = value.split(" ");
    return `${name}: ${scheme} ${maskSecret(rest.join(" "))}`;
  });
  return `{ ${entries.join("; ")} }`;
}
```

`/otlp/` is already in `STATIC_ASSET_PATH_PREFIXES` in `server.ts`, so the proxy
requests are not traced (tracing them would create spans about shipping spans).

### 7.3 `next.config.ts`: the only browser-visible config

Next inlines `process.env.X` into the client bundle only for variables listed
here and only for direct `process.env.X` access (not destructuring or dynamic
keys). Nothing secret or backend-specific belongs in this block.

**`next.config.ts`** (merge into yours)

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exposes ONLY these vars to the browser bundle, under their exact names (no
  // NEXT_PUBLIC_ prefix), so otel/client.ts can read them. Never add
  // OTEL_EXPORTER_OTLP_*, APPID_* or GRAFANA_ORG_ID here: this block ships to
  // the browser. Merge into your existing config.
  env: {
    OTLP_ENDPOINT: process.env.OTLP_ENDPOINT || "/otlp",
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || "my-app",
    OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES || "",
    OTEL_METRIC_EXPORT_INTERVAL: process.env.OTEL_METRIC_EXPORT_INTERVAL || "",
  },
};

export default nextConfig;
```

### 7.4 Recording a metric from the browser

Use a tiny Client Component so the page itself can stay a Server Component:

**`src/components/ViewTracker.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import { recordCounter } from "@/otel/metrics";

// Records a custom counter metric from the browser when a page is viewed.
// Its own Client Component so the pages that use it can stay Server Components.
export function ViewTracker({ metricName }: { metricName: string }) {
  useEffect(() => {
    recordCounter(metricName);
    // Intentionally runs once per mount, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
```

```tsx
// in any Server Component page
<ViewTracker metricName="orders_page_view_count" />
```

Browser and server share `service.name`; browser telemetry carries
`service.runtime=browser` so you can tell them apart.

## 8. Auth layer (optional, replaceable)

Everything auth-related sits behind one function:

```ts
getGrafanaHeaders(): Promise<Record<string, string>>
```

**`src/otel/auth/index.ts`**

```ts
import { getAppIdAccessToken } from "./appid-token-provider";

// The ONLY export other code should import from the auth/ folder. Every header
// needed to talk to the telemetry backends is produced here, behind this one
// function, so each concern stays independently:
// - deactivatable: unset the env var that gates it (TELEMETRY_AUTH_PROVIDER
//   for the bearer token, GRAFANA_ORG_ID for the tenant header) and that
//   header stops being sent, no other file touched.
// - replaceable: change the body to produce whatever headers your backend
//   needs (static API key, another OAuth provider, ...).
// - removable: delete this folder and the `getGrafanaHeaders` uses in
//   server.ts (exportHeaders) and the /otlp route.
export async function getGrafanaHeaders(): Promise<Record<string, string>> {
  return {
    ...(await getAppIdAuthHeader()),
    ...getTenantHeader(),
  };
}

async function getAppIdAuthHeader(): Promise<Record<string, string>> {
  if (process.env.TELEMETRY_AUTH_PROVIDER !== "appid") {
    return {};
  }
  const token = await getAppIdAccessToken();
  return { Authorization: `Bearer ${token}` };
}

// X-Scope-OrgID is Mimir/Tempo's (Cortex-derived) multi-tenancy header: which
// tenant's data a request reads/writes. Optional: only sent when
// GRAFANA_ORG_ID is set, so single-tenant setups (or a gateway that injects
// it itself) don't need it.
function getTenantHeader(): Record<string, string> {
  const orgId = process.env.GRAFANA_ORG_ID;
  return orgId ? { "X-Scope-OrgID": orgId } : {};
}
```

**`src/otel/auth/appid-token-provider.ts`**: OAuth2 client-credentials against
IBM Cloud App ID. The token is cached, refreshed 60 s before expiry, and
concurrent callers (the trace and metric exporters often ask at the same moment)
share one in-flight request. Every step is logged as `[appid-token]` with the
token masked.

```ts
// Fetches and caches an IBM Cloud App ID access token via the OAuth2
// client-credentials grant. Nothing outside the auth/ folder should import
// this file directly; go through ./index.ts's getGrafanaHeaders().
//
// The cache lives on globalThis, not a module-scope variable: Next/Turbopack
// can hand a Route Handler and instrumentation.ts separate instances of a
// module in dev, and globalThis is shared across all of them in the process.

import { outgoingIdHeaders } from "../../lib/request-ids"; // step 6 (ids). Remove with that step.
import { maskSecret, otelLog } from "../log";

const REFRESH_SKEW_MS = 60_000; // refetch this long before the token actually expires

declare global {
  var __appIdTokenCache: { accessToken: string; expiresAt: number } | undefined;
  var __appIdTokenFetchInFlight: Promise<string> | undefined;
}

export async function getAppIdAccessToken(): Promise<string> {
  const cached = globalThis.__appIdTokenCache;
  if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    log(`using cached token ${describeToken(cached.accessToken)}, expires in ${secondsUntil(cached.expiresAt)}s`);
    return cached.accessToken;
  }
  log(cached ? "cached token expired or near expiry, refetching" : "no cached token, fetching");

  // Dedupe concurrent callers (the trace and metric exporters can both ask
  // for a header at once) into a single in-flight token request.
  if (!globalThis.__appIdTokenFetchInFlight) {
    globalThis.__appIdTokenFetchInFlight = fetchAppIdAccessToken().finally(() => {
      globalThis.__appIdTokenFetchInFlight = undefined;
    });
  }
  return globalThis.__appIdTokenFetchInFlight;
}

async function fetchAppIdAccessToken(): Promise<string> {
  const tokenUrl = requireEnv("APPID_TOKEN_URL");
  const clientId = requireEnv("APPID_CLIENT_ID");
  const clientSecret = requireEnv("APPID_CLIENT_SECRET");

  log(`POST ${tokenUrl} (client_id=${clientId})`);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        ...outgoingIdHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
    });
  } catch (error) {
    log(`token request failed before a response: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    log(`token request failed: ${response.status} ${response.statusText} ${detail}`);
    throw new Error(`IBM App ID token request failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  globalThis.__appIdTokenCache = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  log(
    `token fetched in ${Date.now() - started}ms: ${response.status}, expires_in=${body.expires_in}s, ` +
      describeToken(body.access_token)
  );
  return body.access_token;
}

// Token logging is for diagnosing auth problems. The token is masked unless
// TELEMETRY_AUTH_DEBUG_TOKEN=true: a full bearer token in logs is a credential.
function log(message: string): void {
  otelLog("appid-token", message);
}

function describeToken(token: string): string {
  return `value=${maskSecret(token)}`;
}

function secondsUntil(timestampMs: number): number {
  return Math.round((timestampMs - Date.now()) / 1000);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required when TELEMETRY_AUTH_PROVIDER=appid.`);
  }
  return value;
}
```

- **Turn a piece off:** unset `TELEMETRY_AUTH_PROVIDER` (no bearer token) or
  `GRAFANA_ORG_ID` (no tenant header). No code change.
- **Use another scheme** (static API key, a different OAuth provider): change the
  body of `getGrafanaHeaders()` only. Nothing else knows how authentication works.
- **Remove it:** delete `src/otel/auth/`, and delete the `getGrafanaHeaders`
  import and use in `server.ts` (`exportHeaders`) and the `/otlp` route.
- **Debugging:** the token is masked in logs (first 8 characters and length).
  `TELEMETRY_AUTH_DEBUG_TOKEN=true` prints it in full; a bearer token is a live
  credential, so never enable that in shared or production environments.

## 9. Verify before touching the real backends

Use a throwaway OTLP receiver so you can see exactly what the app sends.

**`scripts/mock-otlp-receiver.mjs`**

```js
// Zero-dependency stand-in for Tempo/Mimir's OTLP/HTTP receivers, for local
// development only. Logs every request it receives (method, path,
// content-type, byte size) so you can see traces/metrics arriving, then
// responds 200. Point both OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and
// OTEL_EXPORTER_OTLP_METRICS_ENDPOINT at this same server.
import http from "node:http";

const port = Number(process.env.MOCK_OTLP_PORT) || 4318;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const contentType = req.headers["content-type"] ?? "(none)";
    const encoding = req.headers["content-encoding"] ?? "-";
    console.log(
      `[mock-otlp] ${req.method} ${req.url}  content-type=${contentType}  content-encoding=${encoding}  bytes=${bytes}`
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});

server.listen(port, () => {
  console.log(`[mock-otlp] listening on http://localhost:${port}`);
});
```

Add `"mock:otlp": "node scripts/mock-otlp-receiver.mjs"` to your `package.json`
scripts if you like, then:

```bash
# terminal 1
node scripts/mock-otlp-receiver.mjs

# terminal 2: environment variables set on the command line beat .env.local
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics \
TELEMETRY_AUTH_PROVIDER=none OTEL_METRIC_EXPORT_INTERVAL=5000 \
npm run dev
```

(On Windows PowerShell set them with `$env:NAME = "value"` before `npm run dev`.)

Check, in order:

1. **Pages return 200.** A 500 mentioning `Module not found` usually means a
   browser file (`client.ts`, `instrumentation-client.ts`) is present but its
   packages from step 2 aren't installed.
2. **The receiver logs `POST /v1/traces` and `POST /v1/metrics`**, as
   `application/x-protobuf`, within a few seconds.
3. **The app log shows**
   `[otel-export] sending traces: N span(s)`, the request headers,
   `<- 200 OK`, and `traces export succeeded`. The same for metrics.
4. **Ids (step 6):** the `curl` check from 6.6; plus fire several requests at
   once with different `X-Correlation-Id` values and confirm each response echoes
   its own id.
5. **Proxy (step 7):**
   `curl -i -X POST -H "Content-Type: application/x-protobuf" --data-binary t http://localhost:3000/otlp/v1/traces`
   returns 200, the receiver sees it, and an unknown path
   (`/otlp/v1/logs`) returns 404. With `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` the
   receiver shows `content-encoding=gzip`. Then open a page in a **real browser**,
   wait one metric interval, and look for `[otel-proxy] browser v1/traces: <- 200`
   in the server log (a `curl` cannot exercise the browser SDK).
6. **Types and lint are clean** (`npx tsc --noEmit`, your linter).

Then switch to the real endpoints and credentials and look at the same log
lines. The `<-` line and any `FAILED ... body=...` text tell you exactly what
the gateway said.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `400 gzip: invalid header` from the Tempo gateway | Gateway requires gzip bodies | `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` (server exporters and the `/otlp` proxy both honour it) |
| `400 decompress snappy: snappy: corrupt input` from Mimir; URL ends `/api/v1/push` | Metrics endpoint is the Prometheus remote-write route | Use the OTLP route, e.g. `.../mimir/otlp/v1/metrics` |
| `404` from the gateway on the OTLP path | Gateway has no route for it | Add the route on the gateway; Mimir needs native OTLP ingestion enabled |
| `401`/`403` from the backend | Missing or invalid token, or wrong tenant | Read the masked `[appid-token]` and `[otel-export] ->` lines; check `GRAFANA_ORG_ID` |
| No `[appid-token]` lines at all | Auth is off, or the env var wasn't loaded | Check `TELEMETRY_AUTH_PROVIDER=appid` and restart the dev server |
| Metrics only every 60 s | Readers built in code ignore `OTEL_METRIC_EXPORT_INTERVAL` | Already handled by `newMetricReader` in `server.ts` |
| `Another next dev server is already running` | Next allows one dev server per project folder | Stop the first one, or use its port |
| `Module not found: @opentelemetry/instrumentation-fetch` | Browser files exist but the step 7 packages don't | Install them, or remove `client.ts` and `instrumentation-client.ts` |
| Outer `GET /` span or Next's spans have no ids | Ids were set from a span hook or the proxy | Use `trackRequestIds()` + `RequestIdsSpanProcessor` exactly as in 6.3 |
| Spans about exporting spans | Missing ignore hooks | Keep `ignoreOutgoingRequestHook`/`ignoreRequestHook` and the `/otlp/` prefix |
| A "stays up forever" gauge never goes away | `CUMULATIVE` temporality keeps re-exporting the last value | Dedicated `DELTA` `MeterProvider` and skip `observe()` when stale (step 5) |
| Env var is `undefined` in browser code | Not inlined | List it in `next.config.ts` `env` and use direct `process.env.NAME` |
| Env change has no effect | Variable already set in the shell, or dev server not restarted | Real env vars beat `.env.local`; restart `next dev` |
| `RouteContext` type missing | Types not generated yet | Run `npx next typegen` or start `next dev` once |
| Exports fail with `ECONNREFUSED` to `localhost:4318` | Endpoint variables unset, so the exporters fall back to their default | Set both `OTEL_EXPORTER_OTLP_*_ENDPOINT` variables |

## 11. Standards to keep

Add this list to your project's contributing guide (or `AGENTS.md`):

- **One initialisation path.** All OpenTelemetry setup lives in `src/otel/`.
  Never register a second `NodeTracerProvider`/`MeterProvider` for the main SDK
  (global state, easy to double-register under Fast Refresh).
- **Configure through `OTEL_*` environment variables**, not code constants:
  endpoints, service name, resource attributes, compression, export interval.
- **Browser never talks to Tempo/Mimir; server never goes through `/otlp`.**
- **Auth and tenant headers only through `getGrafanaHeaders()`.**
- **Nothing secret in `next.config.ts` `env`.**
- **Own API calls only through `apiFetch` / `browserApiFetch`**; any new outgoing
  request adds `outgoingIdHeaders()`.
- **Keep the exclusions**: static assets (hook *and* sampler), the exporters'
  own traffic, and `/otlp/`.
- **Use the helpers** (`withSpan`, `recordCounter`, `recordHistogram`) rather
  than raw `@opentelemetry/api`.
- **Never log credentials unmasked**; keep `TELEMETRY_AUTH_DEBUG_TOKEN` off
  outside local debugging.
- **After each telemetry change**: typecheck, lint, and re-run the mock-receiver
  check in step 9; update your documentation in the same change.

## Appendix: file checklist

```
instrumentation.ts                      step 4   (or add to existing register())
instrumentation-client.ts               step 7
proxy.ts                                step 6   (merge with existing middleware)
next.config.ts                          step 7   (env block, merge)
app/layout.tsx                          step 6   (generateMetadata, merge)
app/otlp/[...path]/route.ts             step 7
components/ViewTracker.tsx              step 7
lib/request-ids.ts                      step 6
lib/get-base-url.ts                     step 6
lib/server-api.ts                       step 6
lib/browser-api.ts                      step 6
otel/server.ts                          step 4
otel/log.ts                             step 4
otel/export-logging.ts                  step 4
otel/tracing.ts                         step 5
otel/metrics.ts                         step 5
otel/request-ids-processor.ts           step 6
otel/client.ts                          step 7
otel/auth/index.ts                      step 8
otel/auth/appid-token-provider.ts       step 8
scripts/mock-otlp-receiver.mjs          step 9   (dev tool)
```

(Paths are relative to `src/` if your app uses a `src` folder, otherwise to the
project root; `scripts/` is always at the root. Adjust the `@/` import alias to
match your `tsconfig.json` `paths`.)
