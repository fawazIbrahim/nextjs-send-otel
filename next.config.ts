import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exposes ONLY these vars to the browser bundle, under their exact names (no
  // NEXT_PUBLIC_ prefix), so otel/client.ts can read them. Never add
  // OTEL_EXPORTER_OTLP_*, APPID_* or GRAFANA_ORG_ID here: this block ships to
  // the browser. Merge into your existing config.
  env: {
    OTLP_ENDPOINT: process.env.OTLP_ENDPOINT || "/otlp",
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || "safe-insurance",
    OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES || "",
    OTEL_METRIC_EXPORT_INTERVAL: process.env.OTEL_METRIC_EXPORT_INTERVAL || "",
  },
};

export default nextConfig;
