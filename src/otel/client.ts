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
