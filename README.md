# Safe-Insurance (MVP)

A Next.js app that lists insurance products and shows each product's details. It contains the frontend and its Backend-for-Frontend (BFF) API, which calls a mocked remote service.

## Quick start

Requires Node.js 20.19+ (developed on Node 24).

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Try the API

```bash
curl localhost:3000/api/products
curl localhost:3000/api/products/home-secure
curl localhost:3000/mock-remote/v1/products   # the mocked remote service
```

Product ids: `auto-comprehensive`, `home-secure`, `health-plus`, `life-family` (`home-legacy` is retired and hidden by the BFF).

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript check |

## Configuration

Copy `.env.example` to `.env.local` to override. Set `REMOTE_SERVICE_URL` to use a real remote service instead of the built-in mock.

## Structure

```
src/app/            pages, BFF routes (api/), mock remote service (mock-remote/)
src/server/         BFF services/mappers, remote client, schema, mock data
src/lib/            shared types, formatting, BFF client used by pages
src/components/     UI components
docs/DESIGN.md      architecture and decisions
AGENTS.md           guide for AI coding agents (CLAUDE.md points to it)
```

See [docs/DESIGN.md](docs/DESIGN.md) for the design, API contract and trade-offs.

## Telemetry

Traces and metrics (server and browser) are exported over OTLP/HTTP to Tempo and Mimir, with optional IBM App ID auth. See [docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md); all variables are in `.env.example` (copy to `.env.local` and fill in real values).

To try it locally without real backends:

```bash
npm run mock:otlp          # terminal 1: fake receiver on :4318
# terminal 2 (PowerShell: set $env:NAME = "value" instead)
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://localhost:4318/v1/metrics \
TELEMETRY_AUTH_PROVIDER=none OTEL_METRIC_EXPORT_INTERVAL=5000 npm run dev
```
