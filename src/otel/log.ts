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
