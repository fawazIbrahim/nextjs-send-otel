import Link from "next/link";
import { formatMoney } from "@/lib/format";
import type { ProductSummary } from "@/lib/types";

export function ProductCard({ product }: { product: ProductSummary }) {
  return (
    <li>
      <Link href={`/products/${encodeURIComponent(product.id)}`} className="card">
        <span className="badge">{product.category}</span>
        <h2>{product.name}</h2>
        <p>{product.summary}</p>
        <span className="price">
          {formatMoney(product.monthlyPremium)} <small>/ month</small>
        </span>
      </Link>
    </li>
  );
}
