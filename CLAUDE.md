# Repo guide for Claude Code

This repo has three parts:
- `tesla-cf-mcp-worker/` — the Cloudflare Worker backend (TypeScript). `npm test` (vitest) and `npm run typecheck` (tsc --noEmit) both must pass before considering a backend change done.
- `tesla-dashboard/` — a static, zero-build-step JS dashboard (`app.js`/`api.js`/`charts.js`/`map.js`/`styles.css`) that talks to the worker's `/data/*` REST API. No bundler — edit the files directly, verify with `node --input-type=module --check < app.js` (or the other file) for a syntax check.
- `fleet-telemetry-bridge/` — a small forwarder from Tesla's Fleet Telemetry server to the worker's `/ingest/telemetry`.

## Dashboard versioning policy (`tesla-dashboard/`)

**Every change to `tesla-dashboard/` — UI, a new feature, a bug fix, or a change to a `/data/*` endpoint it depends on — must, in the same commit:**

1. Bump `APP_VERSION` near the top of `tesla-dashboard/app.js` (shown in the sidebar footer). Bump the **minor** version for a new feature/screen, the **patch** version for a fix/tweak/copy change, the **major** version only for a breaking change to how the dashboard is used or configured.
2. Add a dated entry to `tesla-dashboard/CHANGELOG.md` under that version, summarizing what changed and why (a few bullet points is enough — see existing entries for the format).

Do not skip this because a change feels small — the changelog's value is in being complete, not curated. If you're not sure whether something counts, it counts.

## General conventions observed in this repo

- Backend derivations/aggregations live in `tesla-cf-mcp-worker/src/tracking.ts`; the automation/cron engine is `rules.ts`; spend tracking is `budget.ts`. New read-only REST routes go in `handleData()` in `index.ts`, keyed by vin; new write routes are matched before the generic `/data/` prefix check (see `/data/assign-driver` and `/data/save-location` for the pattern — gate with `requestScope`, mirror the existing scope choice for similarly-trusted writes).
- New telemetry fields are mapped in `ingest.ts`'s `FIELD_MAP` (Tesla field name → canonical snake_case key). Only add a field to `POSITION_COLUMNS` (store.ts) if it's genuinely a per-sample driving/charging signal sampled at polling cadence — everything else should stay EAV-only (`telemetry_events`), which is cheaper and already covered by the `RETENTION_DAYS` prune.
- Raw time-series tables (`positions`, `charges`) are compacted (not deleted) after `COMPACT_AFTER_DAYS` — see `compactOldHistory` in `rules.ts`. Keep that principle if you add another raw per-sample table: summary rows are permanent, fine-grained history can be thinned.
- New MCP tools go in `mcp.ts`; add read-only ones to the `READ_TOOLS` allowlist so a `read`-scope token can use them.
- Run `npm test && npm run typecheck` in `tesla-cf-mcp-worker/` before considering any backend change done.
