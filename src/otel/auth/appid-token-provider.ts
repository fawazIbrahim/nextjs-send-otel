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
