import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ViewTracker } from "@/components/ViewTracker";
import { BffRequestError, fetchProduct } from "@/lib/bff-client";
import { formatMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

async function loadProduct(id: string) {
  try {
    return await fetchProduct(id);
  } catch (err) {
    if (err instanceof BffRequestError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: PageProps<"/products/[id]">): Promise<Metadata> {
  const { id } = await params;
  try {
    const product = await fetchProduct(id);
    return { title: product.name, description: product.summary };
  } catch {
    return { title: "Product" };
  }
}

export default async function ProductPage({ params }: PageProps<"/products/[id]">) {
  const { id } = await params;
  const product = await loadProduct(id);
  const { eligibility } = product;

  return (
    <>
      <ViewTracker metricName="product_detail_view_count" />
      <Link href="/" className="back">
        ← All products
      </Link>
      <span className="badge" style={{ marginTop: "1rem", display: "inline-block" }}>
        {product.category}
      </span>
      <h1 className="page-title">{product.name}</h1>
      <p className="lead">{product.description}</p>

      <section className="panel" aria-labelledby="key-facts">
        <h2 id="key-facts">Key facts</h2>
        <dl className="facts">
          <div>
            <dt>Monthly premium</dt>
            <dd>{formatMoney(product.monthlyPremium)}</dd>
          </div>
          <div>
            <dt>Coverage limit</dt>
            <dd>{formatMoney(product.coverageLimit)}</dd>
          </div>
          <div>
            <dt>Deductible</dt>
            <dd>{formatMoney(product.deductible)}</dd>
          </div>
          <div>
            <dt>Eligible ages</dt>
            <dd>
              {eligibility.minAge}–{eligibility.maxAge}
            </dd>
          </div>
          <div>
            <dt>Term</dt>
            <dd>{eligibility.termMonths} months</dd>
          </div>
        </dl>
      </section>

      <section className="panel" aria-labelledby="coverages">
        <h2 id="coverages">What&apos;s covered</h2>
        <ul className="coverages">
          {product.coverages.map((c) => (
            <li key={c.code} className={c.included ? undefined : "off"}>
              <span className="mark" aria-hidden="true">
                {c.included ? "✓" : "✕"}
              </span>
              <div>
                <strong>{c.name}</strong>
                <span>
                  {c.description} {c.included ? "" : "(not included)"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
