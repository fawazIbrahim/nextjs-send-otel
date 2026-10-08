import { MOCK_LATENCY_MS } from "@/server/config";
import { MOCK_PRODUCTS } from "@/server/remote/mock-data";

export async function GET(_req: Request, ctx: RouteContext<"/mock-remote/v1/products/[id]">) {
  const { id } = await ctx.params;
  await new Promise((r) => setTimeout(r, MOCK_LATENCY_MS));
  const product = MOCK_PRODUCTS.find((p) => p.product_id === id);
  return product ? Response.json(product) : Response.json({ message: "not found" }, { status: 404 });
}
