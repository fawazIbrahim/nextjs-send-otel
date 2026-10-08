/** Public contract between the BFF and the frontend. Independent of the remote service's shape. */
export type ProductCategory = "auto" | "home" | "health" | "life";

export interface Coverage {
  code: string;
  name: string;
  description: string;
  included: boolean;
}

export interface Money {
  /** Amount in major currency units (e.g. 49.9). */
  amount: number;
  currency: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  category: ProductCategory;
  summary: string;
  monthlyPremium: Money;
}

export interface ProductDetails extends ProductSummary {
  description: string;
  coverageLimit: Money;
  deductible: Money;
  coverages: Coverage[];
  eligibility: { minAge: number; maxAge: number; termMonths: number };
}

export interface ApiError {
  error: { code: string; message: string };
}
