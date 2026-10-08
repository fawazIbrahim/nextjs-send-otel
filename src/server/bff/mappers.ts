import type { Money, ProductDetails, ProductSummary } from "@/lib/types";
import type { RemoteProduct } from "../remote/schema";

const money = (cents: number, currency: string): Money => ({ amount: cents / 100, currency });

export function toSummary(p: RemoteProduct): ProductSummary {
  return {
    id: p.product_id,
    name: p.product_name,
    category: p.category.toLowerCase() as ProductSummary["category"],
    summary: p.short_description,
    monthlyPremium: money(p.monthly_premium_cents, p.currency),
  };
}

export function toDetails(p: RemoteProduct): ProductDetails {
  return {
    ...toSummary(p),
    description: p.long_description,
    coverageLimit: money(p.coverage_limit_cents, p.currency),
    deductible: money(p.deductible_cents, p.currency),
    coverages: p.coverages,
    eligibility: { minAge: p.terms.min_age, maxAge: p.terms.max_age, termMonths: p.terms.term_months },
  };
}
