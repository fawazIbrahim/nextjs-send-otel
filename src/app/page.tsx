import { ProductCard } from "@/components/product-card";
import { ViewTracker } from "@/components/ViewTracker";
import { fetchProducts } from "@/lib/bff-client";

// Data comes from the BFF at request time; never prerender at build.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const products = await fetchProducts();

  return (
    <>
      <ViewTracker metricName="product_list_view_count" />
      <h1 className="page-title">Our insurance products</h1>
      <p className="lead">Pick a product to see what it covers and what it costs.</p>
      {products.length === 0 ? (
        <p>No products are available right now.</p>
      ) : (
        <ul className="grid">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </ul>
      )}
    </>
  );
}
