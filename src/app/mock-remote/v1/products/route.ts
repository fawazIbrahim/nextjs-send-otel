import { MOCK_LATENCY_MS } from "@/server/config";
import { MOCK_PRODUCTS } from "@/server/remote/mock-data";

/** Mock of the remote policy-administration service. Replace via REMOTE_SERVICE_URL. */
export async function GET() {
  await new Promise((r) => setTimeout(r, MOCK_LATENCY_MS));
  return Response.json({ items: MOCK_PRODUCTS });
}
