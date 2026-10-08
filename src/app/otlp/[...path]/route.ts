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
