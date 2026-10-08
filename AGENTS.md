<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project guide for AI agents

Insurance products MVP: Next.js (App Router, TypeScript) frontend + BFF API in one app, calling a mocked remote service. Full design in [docs/DESIGN.md](docs/DESIGN.md); keep it updated when behaviour or structure changes.

## Commands

```bash
npm run dev         # http://localhost:3000
npm run lint
npm run typecheck   # runs `next typegen` first (needed for PageProps/RouteContext types)
npm test            # vitest
npm run build
```

Run lint, typecheck, test and build before declaring work done.

## Architecture (one-way dependencies)

```
src/app/page.tsx, products/[id]   UI (server components)
        │ via src/lib/bff-client.ts (HTTP)
src/app/api/products/**           BFF route handlers (thin: parse → service → JSON)
        │
src/server/bff                    service, mappers, HTTP error mapping
        │
src/server/remote                 HTTP client + zod schema + mock data
        │ HTTP
src/app/mock-remote/v1/**         mock remote service (replaced by REMOTE_SERVICE_URL)
```

- `src/lib/types.ts` is the BFF↔frontend contract. The frontend must never import from `src/server/**`, and must not use remote (snake_case/cents) shapes.
- Pages get data only through `src/lib/bff-client.ts`, never by importing the service or hitting the remote service.
- Route handlers stay thin; logic goes in `src/server/bff`. Services take their dependencies as arguments (testable without network).
- Validate every remote payload with zod in `src/server/remote`. Translate failures into `NotFoundError`/`UpstreamError`; `errorResponse` turns them into safe HTTP responses. Never leak upstream messages to clients.
- To change the remote shape: update `schema.ts`, `mock-data.ts`, `mappers.ts` and tests together.

## Conventions

- TypeScript strict, no `any`. Import with `@/` alias.
- Server components by default; add `"use client"` only when needed (currently only `error.tsx`).
- Next 16 specifics: `params` is a Promise (`await`); use the global `PageProps<'/route'>`, `LayoutProps`, `RouteContext` helpers.
- Styling: global CSS variables in `src/app/globals.css`; support dark mode and keep semantic, accessible markup.
- Tests are colocated `*.test.ts` (Vitest, node env). Add tests for new service/mapping/client logic.
- Telemetry rules: see the Telemetry section below.
- Config via env vars (see `.env.example`); don't commit secrets or `.env*` files.
- Don't add dependencies without a clear need.

## Telemetry (OpenTelemetry → Tempo/Mimir)

Implemented from [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md) (follow it for details). Code in `src/otel/`, `src/proxy.ts`, `src/instrumentation*.ts`, `src/app/otlp/[...path]/route.ts`, `src/lib/{request-ids,server-api,browser-api,get-base-url}.ts`. Tracer/meter name and service name: `safe-insurance`.

Standards to keep:

- **One initialisation path.** All OpenTelemetry setup lives in `src/otel/`. Never register a second `NodeTracerProvider`/`MeterProvider` for the main SDK (global state, easy to double-register under Fast Refresh).
- **Configure through `OTEL_*` environment variables**, not code constants: endpoints, service name, resource attributes, compression, export interval.
- **Browser never talks to Tempo/Mimir; server never goes through `/otlp`.**
- **Auth and tenant headers only through `getGrafanaHeaders()`.**
- **Nothing secret in `next.config.ts` `env`.**
- **Own API calls only through `apiFetch` / `browserApiFetch`**; any new outgoing request adds `outgoingIdHeaders()`.
- **Keep the exclusions**: static assets (hook *and* sampler), the exporters' own traffic, and `/otlp/`.
- **Use the helpers** (`withSpan`, `recordCounter`, `recordHistogram`) rather than raw `@opentelemetry/api`.
- **Never log credentials unmasked**; keep `TELEMETRY_AUTH_DEBUG_TOKEN` off outside local debugging.
- **After each telemetry change**: typecheck, lint, and re-run the mock-receiver check (guide step 9: `npm run mock:otlp`); update documentation in the same change.
