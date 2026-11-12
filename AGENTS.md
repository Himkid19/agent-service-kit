# Agent Service Kit — Agent Operating Manual

This file is the repository-level instruction set for coding agents and
harnesses. Read it before changing code.

## Project Purpose

Agent Service Kit is a self-hosted backend framework for deploying configurable
LLM agent services. It provides authentication, isolated workspaces, persistent
conversations, OpenAI-compatible provider registration, tool scoping, SSE
streaming, concurrency control, and operational health checks.

The project is a reusable framework. Keep changes generic and reusable; do not
introduce private business data, internal hostnames, or deployment credentials.

## Stack

- Node.js 24+
- TypeScript ESM (`"type": "module"`)
- Express
- Pi Coding Agent SDK
- MySQL 8+
- Vitest
- Docker and Docker Compose

## Structure

```text
src/
  app.ts               Express app and middleware
  config.ts            Environment configuration
  db.ts                MySQL pool, migrations, and query helpers
  index.ts             Service startup and shutdown
  middleware/          Authentication and HTTP error handling
  repositories/        MySQL persistence
  routes/              HTTP routes
  services/            Agent, chat, model, workspace, and health logic
workplaces/
  demo-agent/
    agent.md           Example agent instructions
tests/                 Vitest integration and unit tests
docs/                  API and SSE documentation
migrations/            MySQL schema
```

## Core Invariants

- Each agent is confined to its own `workplaces/<agent-id>/` directory.
- New agents use read-only tools (`read`, `grep`, `find`, `ls`) by default.
- Chat sessions belong to exactly one user and one agent; cross-user access
  must return `Session not found`.
- Provider and model resolution order is request/agent selection, then MySQL
  provider configuration, then the `PROVIDER_*` environment fallback.
- Secrets must come from environment variables or a secret manager. Never
  commit `.env`, API keys, database passwords, JWTs, or generated auth state.
- Do not add private customer data, raw business Q&A exports, internal
  hostnames, or proprietary datasets to the repository.
- Keep schema and runtime upgrades idempotent. Existing MySQL installations
  must continue to start without manual table edits.

## Before Changing Code

1. Inspect `git status` and avoid overwriting unrelated work.
2. Read the files and tests that own the behavior being changed.
3. Check callers, routes, database columns, docs, and environment variables that
   must change together.
4. Start MySQL before running the integration suite.

## Commands

```bash
npm ci
npm run dev
npm run build
npm test
npm start
npm run cli
```

`npm test` expects MySQL and uses `agent_service_kit_test` by default. Set
`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and optionally `TEST_DB_NAME`.
Tests refuse to truncate databases that do not contain `test` in their name.

## Verification

- Run `npm run build` after TypeScript changes.
- Run `npm test` after code, schema, route, or behavior changes.
- For API changes, update:
  - `docs/api.md`
  - `src/openapi.ts`
  - `docs/stream-events.md` when SSE events change
- For setup or configuration changes, update:
  - `README.md`
  - `README.zh-CN.md`
  - `.env.example`
- For container changes, verify both the image build and `/api/health/ready`.
- Never mark a change complete without relevant verification output.

## Security Boundaries

- Treat prompts and model output as untrusted input.
- Do not weaken authentication, session ownership checks, password policy,
  test-database guards, workspace path handling, or default tool restrictions.
- Shell-execution tools are opt-in for trusted agents only. The chat safety
  filter is defense in depth, not a sandbox.
- Multi-instance deployments require a shared login rate limiter; the built-in
  limiter is process-local.

## Change Style

- Keep the existing route/service/repository layering.
- Prefer the smallest complete change over new abstractions.
- Use standard library or existing dependencies before adding packages.
- Add tests for non-trivial branches, persistence behavior, and security
  boundaries.
- Preserve forward-only behavior for public API consumers.

## Reference Documents

- [README.md](README.md)
- [README.zh-CN.md](README.zh-CN.md)
- [docs/api.md](docs/api.md)
- [docs/stream-events.md](docs/stream-events.md)
- [SECURITY.md](SECURITY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
