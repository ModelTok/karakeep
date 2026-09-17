# Karakeep Project Overview

This document provides context about the Karakeep project for coding agents. `CLAUDE.md` and `GEMINI.md` are symlinks to this file — edit `AGENTS.md`.

## What it is

Karakeep (formerly Hoarder) is a self-hostable "bookmark-everything" app with AI tagging/summarization. Turborepo monorepo, pnpm workspaces.

- **Web:** Next.js (app router), React 19, Tailwind, NextAuth.
- **API:** Hono REST (`packages/api`) wrapping tRPC (`packages/trpc`).
- **DB:** SQLite only (`better-sqlite3`) via Drizzle ORM (`drizzle-orm/sqlite-core`).
- **Search:** Meilisearch (full-text + semantic).
- **Queue:** `liteque` (SQLite-backed job queue).
- **Crawling:** Puppeteer against a headless Chrome instance.
- **Mobile:** Expo / React Native (new architecture).
- **Tooling:** oxfmt (format), oxlint (lint), Vitest (test), Node 24.

## Architecture (the big picture)

Request/business-logic flow:

1. **`packages/trpc/routers/*`** — tRPC procedures. **Most business logic lives here.** Each router has a co-located `*.test.ts`.
2. **`packages/api`** — public REST v1 surface (`/api/v1/...`). Thin: `middlewares/trpcAdapter.ts` invokes the tRPC caller and maps `TRPCError` codes to HTTP status. OpenAPI spec generated from this (`packages/open-api`).
3. **`apps/web`** — Next.js frontend, calls tRPC directly (not through REST). NextAuth with the Drizzle adapter.
4. **`apps/workers`** — long-running background processors, one per job type in `apps/workers/workers/`:
   `crawler` (link fetch + parse, YouTube transcripts), `inference` (LLM tag/summarize, OpenAI or Ollama), `feed` (RSS ingest), `embeddings`, `search` (Meili indexing), `ruleEngine`, `video` (yt-dlp archival), `webhook`, `import`, `backup`, `adminMaintenance`.
   Jobs are enqueued via helpers in `packages/shared/queueing.ts` (these are mocked in tRPC tests — see `packages/trpc/testUtils.ts`).

Cross-cutting:

- **`packages/shared`** — zod types (`types/`), central config parser (`config.ts`), logger, search-query parser, inference client. Imported everywhere.
- **`packages/shared-server`** / **`packages/shared-react`** — server-only and React-only shared code.
- **`packages/db`** — `schema.ts` (single Drizzle schema file), `drizzle/` migrations, `drizzle.ts` exposes `getInMemoryDB()` used by tests.
- **`packages/sdk`** — generated TS client for the REST API. **`apps/cli`** and **`apps/mcp`** consume it.
- **`tooling/*`** — shared base configs (tsconfig, tailwind, oxlint, prettier). **`tools/*`** — `compare-models`, `seed-snapshot` scripts.

## Configuration

All configuration is via environment variables, parsed and validated centrally in **`packages/shared/config.ts`**. User docs: `docs/docs/03-configuration/`. Local `.env` needs at least `DATA_DIR` and `NEXTAUTH_SECRET` (`.env.sample`).

## Local development

Runtime deps (both via Docker): **Meilisearch** on `:7700`, **headless Chrome** on `:9222`.

- **`./start-dev.sh`** — starts Meilisearch + Chrome containers, runs `db:migrate`, then `pnpm web` and `pnpm workers`. Cleans up on Ctrl+C.
- Or run pieces manually:
  - `pnpm web` — Next.js dev server on `:3000` (does not return).
  - `pnpm workers` — background workers (does not return).
  - `pnpm db:migrate` — apply migrations.

## Common commands

Run from repo root (Turborepo fans out to all packages):

- `pnpm typecheck` / `pnpm lint` / `pnpm lint:fix` / `pnpm format` / `pnpm format:fix`
- `pnpm test` — all package test suites.
- `pnpm preflight` — typecheck + lint + format together. `pnpm preflight:fix` — the autofix variant. Run before committing (a Husky pre-commit hook also runs checks).
- `pnpm db:generate --name description_of_change` — generate a migration after editing `packages/db/schema.ts`.
- `pnpm db:studio` — Drizzle Studio.

### Running a single test

Vitest is configured per-package; there is no root vitest workspace. `cd` into the package first:

```
cd packages/trpc && pnpm vitest run routers/bookmarks.test.ts
cd packages/trpc && pnpm vitest run -t "creates a bookmark"
```

E2E tests: `cd packages/e2e_tests && pnpm test` (builds first; `pnpm test:no-build` to skip).

## Conventions

- **oxfmt owns import ordering and Tailwind class sorting** (`.oxfmtrc.json`; sorts args to `cn` and `cva`). Don't hand-order imports or classes — run `pnpm format:fix`.
- shadcn/ui components live in **`apps/web/components/ui`**.
- Migrations in `packages/db/drizzle/` are generated, never hand-edited; they're excluded from formatting.
- Some deps are patched (`patches/`, listed in `pnpm-workspace.yaml`) — notably React Native, Expo, `react-tweet`. `react`/`react-dom` versions are pinned workspace-wide for RN compatibility.
