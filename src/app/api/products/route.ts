import { errorResponse, productsServiceFor } from "@/server/bff/http";
import { recordCounter } from "@/otel/metrics";
import { withSpan } from "@/otel/tracing";

export async function GET(request: Request) {
  try {
    const products = await withSpan("bff.products.list", async (span) => {
      const items = await productsServiceFor(request).list();
      span.setAttribute("products.count", items.length);
      return items;
    });
    recordCounter("bff_products_list_count");
    return Response.json({ items: products });
  } catch (err) {
    recordCounter("bff_products_error_count", 1, { operation: "list" });
    return errorResponse(err);
  }
}
