# HTTP API

Base URL: `http://localhost:3001/api`

Interactive OpenAPI UI: `/api/docs`
Raw OpenAPI document: `/api/docs/openapi.json`

Except for registration and login, every endpoint requires:

```http
Authorization: Bearer <jwt>
```

Errors use JSON:

```json
{
  "error": "Description",
  "code": "OPTIONAL_MACHINE_READABLE_CODE"
}
```

## Authentication

### Register

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "alice",
  "password": "Str0ng-Passw0rd",
  "displayName": "Alice"
}
```

Passwords must be at least eight characters and contain both letters and
numbers. Common weak passwords and passwords equal to the username are rejected.

### Login

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "alice",
  "password": "Str0ng-Passw0rd"
}
```

Response:

```json
{
  "token": "<jwt>",
  "user": {
    "id": "<uuid>",
    "username": "alice",
    "displayName": "Alice"
  }
}
```

Tokens expire after 24 hours. Repeated failures lock the same IP + username
combination and return `423` with `code: "ACCOUNT_LOCKED"` and `retryAfterMs`.

## Agents

### List agents

```http
GET /api/agents
```

### Create an agent

```http
POST /api/agents
Content-Type: application/json

{
  "name": "Research Assistant",
  "description": "Answers questions using the provided workspace",
  "defaultProvider": "openai",
  "defaultModel": "gpt-4o",
  "defaultThinkingLevel": "medium",
  "allowedTools": ["read", "grep", "find", "ls"],
  "systemPrompt": "You are a concise research assistant."
}
```

Creating an agent also creates `workplaces/<agent-id>/`. The default tools are
read-only.

### Read, update, or delete

```http
GET    /api/agents/:id
PUT    /api/agents/:id
DELETE /api/agents/:id
```

The `:id` path accepts either the agent ID or its name.

### Read or update instructions

```http
GET /api/agents/:id/workspace/agent.md
PUT /api/agents/:id/workspace/agent.md
Content-Type: application/json

{
  "content": "# Instructions\n\nBe accurate and concise."
}
```

## Chat

### Send a message

```http
POST /api/chat/:agentId
Content-Type: application/json

{
  "message": "Summarize the project.",
  "sessionId": "optional-existing-session",
  "provider": "openai",
  "model": "gpt-4o",
  "thinkingLevel": "medium"
}
```

Response:

```json
{
  "sessionId": "<session-id>",
  "model": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "reply": "The project is..."
}
```

Omit `sessionId` to create a session. Reuse the returned ID for a follow-up
message in the same conversation.

### Stream a message

```http
POST /api/chat/:agentId/stream
Content-Type: application/json
```

The response is `text/event-stream`. The final successful event is `done` and
contains the complete reply and `sessionId`. See
[stream-events.md](stream-events.md) for every event type and a browser client
example.

Validation, authentication, and unsafe-message errors happen before SSE headers
are sent and therefore return a normal JSON response.

### Session operations

```http
GET  /api/chat/sessions
GET  /api/chat/:agentId/sessions
GET  /api/chat/:agentId/messages?sessionId=<id>
POST /api/chat/:agentId/new
POST /api/chat/:agentId/resume
POST /api/chat/:agentId/reset
```

Sessions are scoped to the authenticated user. A session belonging to another
user is treated as not found.

## Models and Providers

### List configured models

```http
GET /api/models
```

### Register an OpenAI-compatible provider

```http
POST /api/models/providers
Content-Type: application/json

{
  "name": "my-provider",
  "baseUrl": "https://example.com/v1",
  "apiKey": "<provider-key>",
  "headers": {
    "X-Custom-Header": "value"
  },
  "models": [
    {
      "id": "my-model",
      "name": "My Model",
      "contextWindow": 128000,
      "maxTokens": 4096
    }
  ]
}
```

Provider configuration is stored in MySQL and takes precedence over the
`PROVIDER_*` environment fallback.

## Health

```http
GET /api/health
GET /api/health/ready
```

`/api/health` is a liveness endpoint. `/api/health/ready` pings MySQL and returns
`503` when the database is unavailable. Responses include process memory,
session-cache, LLM concurrency, database pool, and heartbeat status.

## Common Status Codes

| Status | Meaning |
| --- | --- |
| `400` | Invalid input, weak password, or blocked message |
| `401` | Missing, invalid, or expired authentication |
| `404` | Resource or session not found |
| `409` | Duplicate resource |
| `423` | Login temporarily locked |
| `503` | Database unavailable or LLM queue timeout |
