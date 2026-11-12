# Agent Service Kit

[English](README.md) | [简体中文](README.zh-CN.md)

Turn any OpenAI-compatible model endpoint into a deployable, multi-user Agent
service. Agent Service Kit supplies the missing backend layer around the model:
accounts, agents, isolated workspaces, conversation history, tool permissions,
streaming responses, and a frontend-ready HTTP API.

## What Problem It Solves

Calling a model API is easy. Turning it into a service that a team or frontend
can actually use usually requires a lot of repeated infrastructure work.

| Without Agent Service Kit | With Agent Service Kit |
| --- | --- |
| Every prototype invents its own prompt and model-calling layer | One service manages multiple agents and providers |
| Users and conversation ownership must be built separately | JWT auth and per-user session isolation are included |
| Prompt files and private references are mixed into application code | Each agent gets an isolated workspace |
| Streaming and tool events require custom protocols | A documented SSE contract is ready for frontends |
| Sessions disappear when the process restarts | Conversations and metadata persist in MySQL |
| Concurrent model calls can exhaust the service | Queueing, limits, cache bounds, and health metrics are built in |

The project is not another chat UI. It is the backend that lets you add a UI,
connect an internal knowledge base, or give domain-specific agents to a team
without rebuilding the same plumbing every time.

## Typical Uses

- Deploy an internal knowledge assistant backed by prompt files and reference documents.
- Give different teams separate agents for research, support, operations, or data lookup.
- Add an LLM chat API to an existing web application.
- Prototype an agent product with authentication, persistence, and streaming from day one.
- Give Codex, Claude Code, or another coding harness a repeatable deployment target.

## Connect Through Codex or Claude Code

The repository includes [AGENTS.md](AGENTS.md), so a coding harness can inspect
the repository, configure the service, run validation, and diagnose failures
without a long setup explanation from the user.

1. Clone or open this repository in Codex, Claude Code, or another harness that
   reads `AGENTS.md`.
2. Create `.env` from [.env.example](.env.example).
3. Fill in the model endpoint, model API key, database password, and
   `JWT_SECRET`. Do not paste secrets into the prompt.
4. Give the harness this one-sentence task:

> Read `AGENTS.md` and deploy this repository as my local Agent service: prepare
> `.env` from `.env.example`, run `docker compose up --build -d`, wait for
> `/api/health/ready`, create a `support-assistant` agent, verify one JSON and
> one SSE conversation, and give me the frontend base URL.

A properly operating harness should finish by reporting:

- the service URL, normally `http://localhost:3001`;
- whether `/api/health/ready` is ready;
- the created agent ID;
- a successful normal chat response;
- a successful SSE `done` event;
- any settings that still require your model key or frontend origin.

The harness should keep `.env` local and must not commit credentials or test
data. The same prompt can be used after moving the project to a new machine.

## Quick Start

Requirements:

- Docker and Docker Compose
- An OpenAI-compatible endpoint and API key

Create the configuration:

```bash
cp .env.example .env
```

At minimum, replace:

```dotenv
JWT_SECRET=<run: openssl rand -hex 32>
DB_PASSWORD=<a strong local database password>
PROVIDER_BASE_URL=https://your-model-endpoint/v1
PROVIDER_API_KEY=<your model API key>
DEFAULT_PROVIDER=your-provider
DEFAULT_MODEL=your-model
```

Set `ADMIN_INITIAL_PASSWORD` if you want a known bootstrap administrator
password. If it is omitted, the service generates one and prints it once in the
application log.

Start the service:

```bash
docker compose up --build -d
docker compose logs -f app
```

Service endpoints:

- API base: `http://localhost:3001/api`
- Swagger UI: `http://localhost:3001/api/docs`
- Liveness: `http://localhost:3001/api/health`
- Readiness: `http://localhost:3001/api/health/ready`

Stop the service:

```bash
docker compose down
```

Use `docker compose down -v` only when you intentionally want to delete the
development MySQL data and agent workspace volume.

## Scenario Walkthrough

Assume you want a support assistant for a web application.

1. The harness deploys Agent Service Kit and confirms `/api/health/ready`.
2. A backend or frontend user logs in through `POST /api/auth/login`.
3. The application creates a `support-assistant` agent with a system prompt.
4. The browser sends messages to `POST /api/chat/:agentId/stream`.
5. The UI appends `text_delta` events as they arrive.
6. The UI stores the `sessionId` from the `done` event.
7. Subsequent requests reuse that `sessionId`, so the assistant keeps context.
8. Sessions and messages survive an application restart because they are stored
   in MySQL.

You can also place reusable domain knowledge in the agent workspace:

```text
workplaces/support-assistant/
  agent.md
  skills/
    product-faq/
      SKILL.md
  reference/
    product-guide.md
```

Keep private customer information and proprietary documents outside the public
repository. Mount or copy them into the agent workspace in your deployment.

## Create an Agent

After login, create an agent with one API call:

```bash
curl -X POST http://localhost:3001/api/agents \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "support-assistant",
    "description": "Answers product support questions",
    "defaultProvider": "openai",
    "defaultModel": "gpt-4o",
    "systemPrompt": "Answer support questions accurately and concisely."
  }'
```

The response includes the `id` used by the chat endpoints. New agents receive
the read-only tools `read`, `grep`, `find`, and `ls` by default.

## Frontend Integration

### 1. Authentication

Log in and store the returned JWT:

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "<admin password>"
}
```

Send it on protected requests:

```http
Authorization: Bearer <jwt>
```

### 2. Discover agents and models

```http
GET /api/agents
GET /api/models
```

### 3. Send a normal message

```http
POST /api/chat/:agentId
Content-Type: application/json

{
  "message": "How do I reset my password?",
  "sessionId": "optional-existing-session",
  "provider": "openai",
  "model": "gpt-4o"
}
```

The response contains `reply`, `sessionId`, and the selected model. Reuse
`sessionId` for the next turn.

### 4. Stream chat to the browser

The stream endpoint uses `POST` and a Bearer token, so browser `EventSource`
will not work. Use `fetch` and read the response stream:

```js
const response = await fetch(`${API_BASE}/api/chat/${agentId}/stream`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ message, sessionId }),
});

if (!response.ok) throw new Error(`HTTP ${response.status}`);
if (!response.headers.get("content-type")?.includes("text/event-stream")) {
  throw new Error("Expected an SSE response");
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  let boundary;
  while ((boundary = buffer.indexOf("\n\n")) >= 0) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);

    const event = frame.match(/^event: (.+)$/m)?.[1];
    const dataLine = frame.match(/^data: (.+)$/m)?.[1];
    if (!event || !dataLine) continue;

    const data = JSON.parse(dataLine);
    if (event === "text_delta") appendToBubble(data.delta);
    if (event === "done") saveSessionId(data.sessionId);
    if (event === "error") showError(data.error);
  }
}
```

For the full event sequence, see [docs/stream-events.md](docs/stream-events.md).

### 5. Configure browser CORS

For local development, `CORS_ORIGIN=*` is allowed. In production, replace it
with an exact allowlist:

```dotenv
CORS_ORIGIN=https://app.example.com,https://admin.example.com
```

### 6. Frontend error handling

- `400`: invalid input, weak password, context limit, or unsafe message.
- `401`: missing, invalid, or expired JWT.
- `404`: unknown agent/session or a session owned by another user.
- `409`: duplicate user or provider conflict.
- `423`: login temporarily locked.
- `503`: database unavailable or LLM request queue timeout.

Check `response.ok` and the status before treating a response as JSON or SSE.

## Main API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Register a user |
| `POST` | `/api/auth/login` | Obtain a JWT |
| `GET/POST` | `/api/agents` | List or create agents |
| `GET/PUT/DELETE` | `/api/agents/:id` | Manage one agent |
| `GET/PUT` | `/api/agents/:id/workspace/agent.md` | Read or update instructions |
| `POST` | `/api/chat/:agentId` | Normal message request |
| `POST` | `/api/chat/:agentId/stream` | SSE stream |
| `GET` | `/api/chat/sessions` | List current-user sessions |
| `GET` | `/api/chat/:agentId/messages` | Read session messages |
| `POST` | `/api/models/providers` | Register an OpenAI-compatible provider |
| `GET` | `/api/models` | List available models |

Detailed request and response examples are in [docs/api.md](docs/api.md).

## Configuration

Core variables:

| Variable | Purpose |
| --- | --- |
| `JWT_SECRET` | Production JWT signing secret |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL persistence |
| `PROVIDER_NAME`, `PROVIDER_BASE_URL`, `PROVIDER_API_KEY` | Default model provider |
| `DEFAULT_PROVIDER`, `DEFAULT_MODEL` | Agent defaults |
| `ADMIN_INITIAL_PASSWORD` | Optional known bootstrap password |
| `CORS_ORIGIN` | Browser origin allowlist |
| `MAX_CONCURRENT_LLM_CALLS` | Global LLM concurrency limit |
| `SESSION_IDLE_TTL_MS` | In-memory session idle timeout |
| `SESSION_CACHE_CAPACITY` | In-memory session limit |
| `STREAM_TIMEOUT_MS` | Maximum SSE request duration |

See [.env.example](.env.example) for all options.

Docker build options:

- `NODE_IMAGE`: override the Node base image, usually not needed.
- `NPM_REGISTRY`: override the npm registry for restricted networks.
- `MYSQL_IMAGE`: override the bundled MySQL image for restricted networks.
- `INSTALL_PYTHON_RUNTIME=true`: install Python and workspace Python
  dependencies. Disabled by default to keep the quick-start image small.

If a provider runs on the host machine, use `host.docker.internal` from inside
the container instead of `localhost`.

## Maintainer Smoke Test

Before claiming a deployment is usable, verify:

1. `docker compose up --build -d`
2. `/api/health` returns `ok`
3. `/api/health/ready` returns ready with `db.reachable=true`
4. Admin login succeeds
5. Agent creation succeeds
6. `/api/chat/:agentId` returns a model reply
7. `/api/chat/:agentId/stream` emits `text_delta` and `done`
8. Sessions remain visible after `docker compose restart app`
9. `npm run build`
10. `npm test`

## Security and Deployment Boundaries

- Never commit `.env`, provider keys, customer data, or private knowledge bases.
- Set a strong `JWT_SECRET`, database password, and administrator password.
- Restrict `CORS_ORIGIN` in production.
- Keep shell tools disabled for untrusted agents. The built-in message filter is
  not a sandbox.
- The bundled login limiter is process-local; use shared rate limiting for
  multi-replica deployments.
- Multi-agent routing and long-term vector memory are not included.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
