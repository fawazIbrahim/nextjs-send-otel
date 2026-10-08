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
