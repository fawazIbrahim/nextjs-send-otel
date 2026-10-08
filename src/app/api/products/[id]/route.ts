import { errorResponse, productsServiceFor } from "@/server/bff/http";
import { recordCounter } from "@/otel/metrics";
import { withSpan } from "@/otel/tracing";

export async function GET(request: Request, ctx: RouteContext<"/api/products/[id]">) {
  try {
    const { id } = await ctx.params;
    // Span name stays low-cardinality; the product id is an attribute.
    const product = await withSpan("bff.products.get", () => productsServiceFor(request).get(id), {
      "product.id": id,
    });
    recordCounter("bff_product_get_count");
    return Response.json(product);
  } catch (err) {
    recordCounter("bff_products_error_count", 1, { operation: "get" });
    return errorResponse(err);
  }
}
