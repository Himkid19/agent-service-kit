# Agent Service Kit

[English](README.md) | [简体中文](README.zh-CN.md)

Agent Service Kit is a production-ready, self-hosted framework for quickly
deploying configurable LLM agent services. It turns an OpenAI-compatible model
endpoint into a multi-user service with isolated workspaces, persistent
conversations, per-agent tools, streaming responses, and operational health
checks.

It is designed for teams that have moved past a one-off LLM prototype and need
a reusable deployment layer: user accounts, several agents with different
prompts and knowledge, session persistence, tool permissions, concurrency
control, and an HTTP API that a web frontend or internal service can consume.

## Features

- Create, update, list, and delete agents with isolated filesystem workspaces
- Load agent instructions from `agent.md` and reusable skills from `skills/`
- Keep multiple persistent conversations per user and agent
- Use OpenAI-compatible providers and switch provider/model per request
- Stream text, reasoning, and tool events over Server-Sent Events (SSE)
- Enforce read-only tools by default and block high-confidence unsafe commands
- Bound in-memory sessions with TTL + LRU and limit concurrent LLM calls
- Expose liveness, MySQL readiness, memory, session, and concurrency metrics
- Store users, agents, providers, sessions, messages, usage, and context state in MySQL

## Architecture

```text
HTTP client
    |
    v
Express API (/api)
    |
    +-- JWT auth and rate limiting
    +-- Agent service ------> workplaces/<agent-id>/
    +-- Chat service -------> Pi SDK sessions
    |                         |
    |                         +--> OpenAI-compatible provider
    +-- Session cache ------> MySQL
    +-- Provider registry --> Pi SDK model registry
```

Each agent runs against its own workspace. New agents receive read-only file
tools by default. Operators can add skills, private reference documents, and
agent-specific instructions without exposing another agent's workspace.

## Quick Start

Requirements:

- Docker with Docker Compose
- An OpenAI-compatible API endpoint and API key

Create the local configuration:

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
JWT_SECRET=<output of: openssl rand -hex 32>
DB_PASSWORD=<a strong local database password>
PROVIDER_API_KEY=<your API key>
```

Start MySQL and the application:

```bash
docker compose up --build
```

Open:

- API documentation: <http://localhost:3001/api/docs>
- Liveness: <http://localhost:3001/api/health>
- Readiness: <http://localhost:3001/api/health/ready>

On the first start, the service creates an `admin` account. Set
`ADMIN_INITIAL_PASSWORD` before the first start, or read the generated password
from the application log:

```bash
docker compose logs app
```

Log in and call the API:

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<your-admin-password>"}'

curl http://localhost:3001/api/agents \
  -H "Authorization: Bearer <token>"
```

## Local Development

Requirements: Node.js 24+, MySQL 8+, and npm.

```bash
npm ci
cp .env.example .env
npm run dev
```

Useful commands:

```bash
npm run build       # compile TypeScript
npm test            # run the Vitest suite
npm run cli         # interactive agent CLI
npm start           # run compiled JavaScript
```

The test suite uses a separate database named with `test` in it
(`agent_service_kit_test` by default) and refuses to truncate other databases.
Set `TEST_DB_NAME` to override the test database. Start MySQL first:

```bash
docker compose up -d mysql
npm test
```

## Agent Workspaces

An agent workspace has this shape:

```text
workplaces/demo-agent/
  agent.md          # system instructions for this agent
  skills/           # optional reusable skills
    <skill>/
      SKILL.md
  reference/        # optional private reference material
```

`agents.json` lists agents that are seeded into MySQL at startup. The included
`demo-agent` is a safe, generic example. Add your own prompts, skills, and
reference material locally; do not publish private business data or credentials.

Agents can also be created through `POST /api/agents`. New agents default to the
read-only tools `read`, `grep`, `find`, and `ls`.

## Main API

All routes except registration and login require `Authorization: Bearer <jwt>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Register a user |
| `POST` | `/api/auth/login` | Obtain a 24-hour JWT |
| `GET/POST` | `/api/agents` | List or create agents |
| `GET/PUT/DELETE` | `/api/agents/:id` | Read, update, or delete an agent |
| `GET/PUT` | `/api/agents/:id/workspace/agent.md` | Read or update instructions |
| `POST` | `/api/chat/:agentId` | Send a message |
| `POST` | `/api/chat/:agentId/stream` | Stream a reply with SSE |
| `GET` | `/api/chat/sessions` | List the current user's sessions |
| `GET` | `/api/chat/:agentId/messages` | Read session messages |
| `POST` | `/api/models/providers` | Register an OpenAI-compatible provider |
| `GET` | `/api/models` | List configured models |

See [docs/api.md](docs/api.md) for request and response examples. See
[docs/stream-events.md](docs/stream-events.md) for the SSE event contract.

The stream endpoint uses `POST` with a Bearer token, so the browser
`EventSource` API is not sufficient. Use `fetch` and read
`response.body.getReader()`.

## Configuration

The most important environment variables are:

| Variable | Required | Description |
| --- | --- | --- |
| `JWT_SECRET` | Production | JWT signing secret. Production startup fails if omitted. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Yes | MySQL connection |
| `PROVIDER_NAME` | No | Provider name; defaults to `openai` |
| `PROVIDER_BASE_URL` | No | OpenAI-compatible base URL |
| `PROVIDER_API_KEY` | Yes | Provider credential |
| `DEFAULT_PROVIDER`, `DEFAULT_MODEL` | No | Agent defaults |
| `ADMIN_INITIAL_PASSWORD` | No | Bootstrap password; otherwise generated once |
| `MAX_CONCURRENT_LLM_CALLS` | No | Global LLM concurrency limit; default `2` |
| `SESSION_IDLE_TTL_MS` | No | Idle session eviction time; default 30 minutes |
| `SESSION_CACHE_CAPACITY` | No | Active in-memory session limit; default `20` |
| `STREAM_TIMEOUT_MS` | No | Maximum SSE request duration; default 5 minutes |

See [.env.example](.env.example) for the full list.

Provider precedence is: request/agent selection, then provider configuration in
MySQL, then the `PROVIDER_*` fallback from the environment. Database credentials
and other secrets are never included in the image.

## Security Notes

- Use a unique, high-entropy `JWT_SECRET`.
- Put secrets in `.env`, a secret manager, or container runtime environment variables.
- Do not commit `.env`, model keys, customer data, raw Q&A exports, or private knowledge bases.
- New agents use read-only tools by default. Add shell access only for trusted agents.
- Login throttling is stored in process memory. Multi-instance deployments should
  replace it with a shared rate limiter such as Redis.
- The built-in chat filter is defense in depth, not a sandbox. Run untrusted agents
  in a separately isolated container or VM.

Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## Limitations

- Multi-agent routing and long-term vector memory are not implemented.
- The in-process login limiter is not shared across replicas.
- Financial or other regulated deployments must add their own data-retention,
  audit, access-control, and compliance controls.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
