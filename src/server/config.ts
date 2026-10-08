const MOCK_PATH = "/mock-remote/v1";

/**
 * Base URL of the remote products service.
 * Set REMOTE_SERVICE_URL to point at a real service; otherwise the BFF
 * calls the in-app mock (served by this same Next.js app) at `origin`.
 */
export function getRemoteBaseUrl(origin: string): string {
  return (process.env.REMOTE_SERVICE_URL ?? `${origin}${MOCK_PATH}`).replace(/\/$/, "");
}

export const REMOTE_TIMEOUT_MS = Number(process.env.REMOTE_TIMEOUT_MS ?? 5000);
export const MOCK_LATENCY_MS = Number(process.env.MOCK_LATENCY_MS ?? 150);
