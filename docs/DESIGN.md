# Design: Safe-Insurance Products MVP

## 1. Goal and scope

A small web app where customers browse a list of insurance products and open a product to see its details.

**In scope (MVP):** product list page, product detail page, a BFF API serving both, a mocked remote service.
**Out of scope:** authentication, quotes/purchase flows, search/filtering, i18n, persistence, caching, observability stack.

## 2. Architecture

Everything lives in one Next.js (App Router, TypeScript) application. Three logical layers talk over HTTP, so each can be split into its own deployable later.

```
Browser ──► Next.js pages (RSC) ──HTTP──► BFF  /api/products ──HTTP──► Remote service
                                                                         (mock: /mock-remote/v1)
```

| Layer | Location | Responsibility |
|---|---|---|
| Frontend | `src/app/page.tsx`, `src/app/products/[id]`, `src/components` | Render UI; server components fetch from the BFF |
| BFF | `src/app/api/products/**`, `src/server/bff` | Frontend-shaped contract, mapping, filtering, error translation |
| Remote client | `src/server/remote` | HTTP calls, timeout, payload validation (zod) |
| Remote mock | `src/app/mock-remote/v1/**`, `src/server/remote/mock-data.ts` | Stand-in for the real policy-administration service |

### Why the pages call the BFF over HTTP
The BFF is the frontend's only data source. Server components call `/api/products` through `src/lib/bff-client.ts` instead of importing the service directly. This keeps the contract honest (what the pages use is what any other client, such as a mobile app, would use) at the cost of one extra in-process hop. The origin is derived from the incoming request headers (`x-forwarded-host`/`host`).

### Why the mock is an HTTP route
The BFF talks to the "remote service" with a real HTTP client. In local dev the base URL defaults to the app's own `/mock-remote/v1`; setting `REMOTE_SERVICE_URL` points the BFF at a real service with **no code change**. The mock intentionally uses a *different* shape (snake_case, amounts in cents, uppercase enums, `RETIRED` status) so the BFF's mapping layer is exercised and the frontend never depends on upstream quirks.

## 3. API

### BFF (public, consumed by the frontend)

| Method & path | Success | Errors |
|---|---|---|
| `GET /api/products` | `200 { items: ProductSummary[] }` | `502` upstream down |
| `GET /api/products/{id}` | `200 ProductDetails` | `404` unknown or retired product, `502` upstream down |

Error body: `{ "error": { "code": "NOT_FOUND" | "UPSTREAM_ERROR" | "INTERNAL_ERROR", "message": string } }`. Upstream details are logged server-side, never returned.

Types are in `src/lib/types.ts`:

- `ProductSummary`: `id`, `name`, `category` (`auto|home|health|life`), `summary`, `monthlyPremium: Money`
- `ProductDetails` = summary + `description`, `coverageLimit`, `deductible`, `coverages[]`, `eligibility {minAge,maxAge,termMonths}`
- `Money`: `{ amount (major units), currency (ISO 4217) }`

### Remote service (mock)

| Path | Result |
|---|---|
| `GET /mock-remote/v1/products` | `{ items: RemoteProduct[] }` (4 active, 1 retired) |
| `GET /mock-remote/v1/products/{product_id}` | `RemoteProduct`, or `404` |

`RemoteProduct` is defined (and validated at runtime) in `src/server/remote/schema.ts`. Mock data: `src/server/remote/mock-data.ts`.

## 4. BFF behaviour

- **Mapping:** `RemoteProduct` → `ProductSummary`/`ProductDetails` in `src/server/bff/mappers.ts` (cents → major units, enum lower-casing, field renames).
- **Business rule:** `RETIRED` products are excluded from the list and return `404` on the detail endpoint.
- **Resilience:** 5 s timeout (`REMOTE_TIMEOUT_MS`); network failures, non-2xx and schema-invalid payloads become `UpstreamError` (HTTP 502). Remote `404` becomes `NotFoundError`.
- **Validation at the boundary:** remote payloads are parsed with zod so a contract drift fails loudly in one place rather than rendering `undefined`.
- **Dependency injection:** `createProductsService(remoteClient)` takes the client as an argument, so it is unit-tested with a fake and no network.

## 5. Frontend

- `/` lists active products as cards (name, category, summary, monthly price) linking to `/products/{id}`.
- `/products/{id}` shows key facts and a covered/not-covered list.
- Server components only; no client JS besides the error boundary. Pages are `force-dynamic` because data comes from the BFF at request time.
- States: `loading.tsx` (skeleton), `error.tsx` (retry), `not-found.tsx` (unknown product, via `notFound()` on BFF 404).
- Accessibility: semantic headings/lists/`dl`, labelled sections, focus outlines, status conveyed by text as well as icons, `prefers-reduced-motion` and dark mode respected.
- Styling: plain global CSS with custom properties (no UI dependency).
- Money is formatted with `Intl.NumberFormat`.

Known behaviour: because `loading.tsx` streams the shell first, an unknown product URL renders the not-found UI with HTTP 200 (plus the `noindex` meta Next adds). The BFF itself returns a proper 404.

## 6. Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REMOTE_SERVICE_URL` | in-app mock | Base URL of the real remote service |
| `REMOTE_TIMEOUT_MS` | `5000` | Upstream timeout |
| `MOCK_LATENCY_MS` | `150` | Simulated latency of the mock |

See `.env.example`.

## 7. Testing

Vitest, node environment, colocated `*.test.ts`:

- `products-service.test.ts`: mapping, retired filtering, not-found.
- `client.test.ts`: payload validation, 404/5xx/network-failure translation (stubbed `fetch`).

Checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## 8. Trade-offs and next steps

- The mock shares the deployment with the app. In production it must be disabled or removed; the app should set `REMOTE_SERVICE_URL`. (Next step: block `/mock-remote` when `NODE_ENV=production` and the variable is set.)
- No caching: every request goes page → BFF → remote, and the product page also fetches twice (metadata and body). Product data changes rarely; add `use cache`/revalidation (`cacheComponents`) when real latency matters.
- No auth, rate limiting or request IDs on the BFF.
- Add component and end-to-end tests (Playwright), search/filter by category, pagination once the catalogue grows, and a contract test against the real remote service.

## 9. Observability

Implemented as specified in [INTEGRATION-GUIDE.md](INTEGRATION-GUIDE.md): server traces/metrics exported directly to Tempo/Mimir (OTLP/HTTP, protobuf), browser telemetry through the same-origin `/otlp` proxy, optional IBM App ID bearer token and `X-Scope-OrgID` header, and `X-Request-Id`/`X-Correlation-Id` on every API call and as `request.id`/`correlation.id` span attributes.

Project-specific integration points:

- `src/proxy.ts` guarantees both ids on every request; `src/app/layout.tsx` publishes the correlation id as `<meta name="correlation-id">`.
- Pages call the BFF via `apiFetch` (`src/lib/bff-client.ts`), which creates a new request id and propagates the correlation id.
- The BFF forwards the incoming correlation id, with a fresh request id, to the remote service (`src/server/remote/client.ts`), so one user interaction is traceable end to end.
- Service name is `safe-insurance` (tracer/meter name and `OTEL_SERVICE_NAME` default).
- Custom telemetry: BFF route handlers wrap their work in `withSpan` (`bff.products.list`, `bff.products.get` with `product.id`) and count `bff_products_list_count`, `bff_product_get_count`, `bff_products_error_count{operation}`; `ViewTracker` records `product_list_view_count` and `product_detail_view_count` from the browser.
- Verified locally against `scripts/mock-otlp-receiver.mjs` (guide step 9) only; not yet against real Tempo/Mimir/App ID.
