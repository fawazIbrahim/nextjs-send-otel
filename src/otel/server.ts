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
