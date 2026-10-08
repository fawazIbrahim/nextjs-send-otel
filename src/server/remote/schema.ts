import { z } from "zod";

/** Shape returned by the (mocked) remote policy-administration service: snake_case, amounts in cents. */
export const remoteProductSchema = z.object({
  product_id: z.string(),
  product_name: z.string(),
  category: z.enum(["AUTO", "HOME", "HEALTH", "LIFE"]),
  short_description: z.string(),
  long_description: z.string(),
  monthly_premium_cents: z.number().int().nonnegative(),
  coverage_limit_cents: z.number().int().nonnegative(),
  deductible_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  coverages: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      description: z.string(),
      included: z.boolean(),
    }),
  ),
  terms: z.object({
    min_age: z.number().int(),
    max_age: z.number().int(),
    term_months: z.number().int(),
  }),
  status: z.enum(["ACTIVE", "RETIRED"]),
});

export const remoteProductListSchema = z.object({ items: z.array(remoteProductSchema) });

export type RemoteProduct = z.infer<typeof remoteProductSchema>;
