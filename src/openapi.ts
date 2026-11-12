/**
 * OpenAPI 3.0.3 specification for the Agent Service Kit API.
 *
 * Served as interactive UI at GET /api/docs and as raw JSON at
 * GET /api/docs/openapi.json. Kept as a hand-written plain object so the
 * route files stay clean (no JSDoc annotation framework).
 *
 * Keep this in sync with src/routes/*.ts when routes change.
 */
const VERSION = "0.1.0";

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Agent Service Kit API",
    version: VERSION,
    description:
      "Backend service for the News LLM Web App. Provides REST APIs for managing AI agents, conversations (incl. SSE streaming), model providers, and auth.\n\n" +
      "All endpoints except `/auth/*` and `/health` require a Bearer JWT token. Click **Authorize** and paste your token (from `POST /auth/login`) to try secured endpoints directly here.",
    license: { name: "UNLICENSED" },
  },
  // Relative URL → adapts to whatever host the service is deployed on.
  servers: [{ url: "/api", description: "relative to current host" }],
  tags: [
    { name: "Auth", description: "User registration & login (public)" },
    { name: "Agents", description: "Agent configuration & workspaces" },
    { name: "Chat", description: "Conversations, sessions & streaming" },
    { name: "Models", description: "Model & provider registry" },
    { name: "Health", description: "Service health" },
  ],
  // Global default: every operation needs a Bearer token unless it
  // overrides `security: []` (auth routes + health).
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT obtained from POST /auth/login. Header: `Authorization: Bearer <token>`",
      },
    },
    parameters: {
      AgentId: {
        name: "agentId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Agent ID or name",
      },
    },
    schemas: {
      TokenUsage: {
        type: "object",
        description: "Token consumption for a prompt or session",
        properties: {
          inputTokens: { type: "integer" },
          outputTokens: { type: "integer" },
          cacheReadTokens: { type: "integer" },
          cacheWriteTokens: { type: "integer" },
          totalTokens: { type: "integer" },
          cost: { type: "number" },
        },
      },
      ContextUsage: {
        type: "object",
        description: "Context window fill status",
        properties: {
          tokens: { type: "integer", nullable: true },
          contextWindow: { type: "integer" },
          percent: { type: "number", nullable: true },
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" } },
      },
      UserPublic: {
        type: "object",
        required: ["id", "username", "displayName"],
        properties: {
          id: { type: "string", format: "uuid" },
          username: { type: "string" },
          displayName: { type: "string" },
        },
      },
      LoginResponse: {
        type: "object",
        required: ["token", "user"],
        properties: {
          token: { type: "string", description: "JWT (HS256), 24h expiry" },
          user: { $ref: "#/components/schemas/UserPublic" },
        },
      },
      AgentConfig: {
        type: "object",
        required: ["id", "name", "description", "allowedTools", "workspacePath", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          defaultProvider: { type: "string" },
          defaultModel: { type: "string" },
          defaultThinkingLevel: {
            type: "string",
            enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            description: "Default thinking level for this agent; overrides the system \"off\" default. Fallback chain: request → agent → \"off\".",
          },
          allowedTools: {
            type: "array",
            items: { type: "string" },
            description: "Allowed tool names — read-only by default (read/grep/find/ls)",
          },
          systemPrompt: { type: "string", description: "Falls back to the agent's workspace agent.md" },
          workspacePath: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      ChatRequest: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          provider: { type: "string", description: "Override the agent's default provider" },
          model: { type: "string", description: "Override the agent's default model" },
          sessionId: { type: "string", description: "Resume a specific session" },
          thinkingLevel: {
            type: "string",
            enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            description: "LLM thinking depth. \"off\" disables; \"medium\" recommended for reasoning. Sent as thinking_delta SSE events.",
          },
        },
      },
      ChatResponse: {
        type: "object",
        required: ["agentId", "sessionId", "reply", "model"],
        properties: {
          agentId: { type: "string" },
          sessionId: { type: "string" },
          reply: { type: "string", description: "Full assembled assistant reply" },
          model: {
            type: "object",
            required: ["provider", "model"],
            properties: {
              provider: { type: "string" },
              model: { type: "string" },
            },
          },
        },
      },
      ProviderModel: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          api: { type: "string" },
          contextWindow: { type: "integer" },
          maxTokens: { type: "integer" },
          reasoning: { type: "boolean" },
          compat: {
            type: "object",
            description: "OpenAI-compat overrides, e.g. { supportsUsageInStreaming, supportsStrictMode, maxTokensField }",
            additionalProperties: true,
          },
        },
      },
      ProviderConfig: {
        type: "object",
        required: ["name", "baseUrl", "models"],
        properties: {
          name: { type: "string" },
          displayName: { type: "string" },
          baseUrl: { type: "string" },
          apiKey: { type: "string", format: "password" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          models: { type: "array", items: { $ref: "#/components/schemas/ProviderModel" } },
        },
      },
      ModelInfo: {
        type: "object",
        required: ["provider", "id", "name", "contextWindow"],
        properties: {
          provider: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          contextWindow: { type: "integer" },
        },
      },
      SessionSummary: {
        type: "object",
        required: ["userId", "agentId", "sessionId", "createdAt", "updatedAt", "messageCount"],
        properties: {
          userId: { type: "string" },
          agentId: { type: "string" },
          sessionId: { type: "string" },
          title: { type: "string", nullable: true, description: "First user message, auto-captured; null until the first message is sent" },
          createdAt: { type: "string", format: "date-time", description: "UTC ISO 8601" },
          updatedAt: { type: "string", format: "date-time", description: "UTC ISO 8601" },
          messageCount: { type: "integer" },
        },
      },
      AgentSessionSummary: {
        type: "object",
        required: ["sessionId", "createdAt", "updatedAt", "messageCount"],
        properties: {
          sessionId: { type: "string" },
          title: { type: "string", nullable: true, description: "First user message, auto-captured; null until the first message is sent" },
          createdAt: { type: "string", format: "date-time", description: "UTC ISO 8601" },
          updatedAt: { type: "string", format: "date-time", description: "UTC ISO 8601" },
          messageCount: { type: "integer" },
        },
      },
      Message: {
        type: "object",
        required: ["role", "content"],
        properties: {
          role: { type: "string", example: "assistant" },
          content: { type: "string" },
        },
      },
      Skill: {
        type: "object",
        required: ["name", "file", "description", "content"],
        properties: {
          name: { type: "string" },
          file: { type: "string" },
          description: { type: "string" },
          content: { type: "string" },
        },
      },
      Ok: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean", example: true } },
      },
      ResetResult: {
        type: "object",
        required: ["ok", "deleted", "sessionsDeleted"],
        properties: {
          ok: { type: "boolean", example: true },
          deleted: { type: "boolean", description: "Whether the session file was actually deleted" },
          sessionsDeleted: { type: "integer", description: "Number of session files removed" },
        },
      },
    },
  },

  paths: {
    // ── Health ─────────────────────────────────────────────────────────
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Service health check (liveness + memory/session observability)",
        security: [],
        responses: {
          "200": {
            description: "Service is up",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "version", "memory", "sessions", "llmGate"],
                  properties: {
                    status: { type: "string", example: "ok" },
                    version: { type: "string", example: VERSION },
                    uptimeSec: { type: "integer", description: "Seconds since process start" },
                    timestamp: { type: "string", description: "ISO timestamp" },
                    memory: {
                      type: "object",
                      description: "process.memoryUsage() counters in bytes",
                      properties: {
                        rssBytes: { type: "integer" },
                        heapUsedBytes: { type: "integer" },
                        heapTotalBytes: { type: "integer" },
                        externalBytes: { type: "integer" },
                      },
                    },
                    sessions: {
                      type: "object",
                      description: "Bounded live-session cache stats (TTL+LRU evicted sessions are rebuilt from the DB on demand)",
                      properties: {
                        size: { type: "integer" },
                        capacity: { type: "integer" },
                        ttlMs: { type: "integer" },
                        evictedIdle: { type: "integer" },
                        evictedOther: { type: "integer" },
                      },
                    },
                    llmGate: {
                      type: "object",
                      description: "LLM concurrency gate stats",
                      properties: {
                        limit: { type: "integer" },
                        active: { type: "integer" },
                        waiting: { type: "integer" },
                        totalRejected: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── Auth ───────────────────────────────────────────────────────────
    "/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a new user",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: {
                  username: { type: "string" },
                  password: { type: "string", format: "password" },
                  displayName: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "User created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UserPublic" } } },
          },
          "400": {
            description: "username and password required, or password fails the policy (min 8 chars, letters + digits, not a common weak password, not the username)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
          "409": { description: "User already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Authenticate and obtain a JWT token",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: {
                  username: { type: "string" },
                  password: { type: "string", format: "password" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Token + user",
            content: { "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } } },
          },
          "400": { description: "username and password required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "Invalid credentials", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "423": {
            description: "Account temporarily locked after too many failed attempts (LOGIN_MAX_ATTEMPTS). Body includes code=ACCOUNT_LOCKED and retryAfterMs.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },

    // ── Agents ─────────────────────────────────────────────────────────
    "/agents": {
      get: {
        tags: ["Agents"],
        summary: "List all agents",
        responses: {
          "200": {
            description: "All agents (shared across users)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["agents"],
                  properties: { agents: { type: "array", items: { $ref: "#/components/schemas/AgentConfig" } } },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Agents"],
        summary: "Create a new agent (also creates an isolated workspace)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  allowedTools: { type: "array", items: { type: "string" }, example: ["read", "grep", "find", "ls"] },
                  defaultProvider: { type: "string" },
                  defaultModel: { type: "string" },
                  defaultThinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh"] },
                  systemPrompt: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Agent created", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } } },
          "400": { description: "name is required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/agents/{id}": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      get: {
        tags: ["Agents"],
        summary: "Get a single agent",
        responses: {
          "200": { description: "Agent config", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } } },
          "404": { description: "Agent not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        tags: ["Agents"],
        summary: "Update agent configuration (partial)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  allowedTools: { type: "array", items: { type: "string" } },
                  defaultProvider: { type: "string" },
                  defaultModel: { type: "string" },
                  defaultThinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh"] },
                  systemPrompt: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated agent", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentConfig" } } } },
          "404": { description: "Agent not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Agents"],
        summary: "Delete an agent (workspace files remain on disk)",
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
        },
      },
    },
    "/agents/{id}/skills": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      get: {
        tags: ["Agents"],
        summary: "List skill files in the agent's workspace (skills/*.md)",
        responses: {
          "200": {
            description: "Skills",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["skills"],
                  properties: { skills: { type: "array", items: { $ref: "#/components/schemas/Skill" } } },
                },
              },
            },
          },
          "404": { description: "Agent not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/agents/{id}/workspace/agent.md": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      get: {
        tags: ["Agents"],
        summary: "Read the agent's system prompt file",
        responses: {
          "200": {
            description: "agent.md content",
            content: { "application/json": { schema: { type: "object", required: ["content"], properties: { content: { type: "string" } } } } },
          },
          "404": { description: "agent.md not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        tags: ["Agents"],
        summary: "Update the agent's system prompt file",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["content"], properties: { content: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
          "400": { description: "content is required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Chat ───────────────────────────────────────────────────────────
    "/chat/sessions": {
      get: {
        tags: ["Chat"],
        summary: "List the current user's sessions across all agents",
        responses: {
          "200": {
            description: "Sessions",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["sessions"],
                  properties: { sessions: { type: "array", items: { $ref: "#/components/schemas/SessionSummary" } } },
                },
              },
            },
          },
        },
      },
    },
    "/chat/{agentId}/sessions": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      get: {
        tags: ["Chat"],
        summary: "List sessions for a specific agent (scoped to the caller)",
        responses: {
          "200": {
            description: "Sessions",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["sessions"],
                  properties: { sessions: { type: "array", items: { $ref: "#/components/schemas/AgentSessionSummary" } } },
                },
              },
            },
          },
        },
      },
    },
    "/chat/{agentId}": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      post: {
        tags: ["Chat"],
        summary: "Send a message and get the full reply as JSON",
        description: "With `sessionId`: resume that session (must belong to the caller, otherwise 404). Without: reuse the most recent in-memory session or create a fresh one.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ChatRequest" } } },
        },
        responses: {
          "200": { description: "Reply", content: { "application/json": { schema: { $ref: "#/components/schemas/ChatResponse" } } } },
          "400": {
            description: "message is required, or message blocked by security policy (code=UNSAFE_MESSAGE)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/chat/{agentId}/stream": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      post: {
        tags: ["Chat"],
        summary: "Stream a message via SSE (text deltas, tool calls, lifecycle)",
        description:
          "Server-Sent Events stream (`Content-Type: text/event-stream`). Each event is a block:\n" +
          "```\nevent: <type>\ndata: <json>\n\n```\n" +
          "Event types:\n" +
          "- `agent_start` `{}`\n" +
          "- `turn_start` `{}`\n" +
          "- `text_delta` `{ delta }` — assemble in order for live typing\n" +
          "- `thinking_delta` `{ delta }` — model reasoning (if thinking enabled)\n" +
          "- `tool_execution_start` `{ toolCallId, toolName, args }`\n" +
          "- `tool_execution_update` `{ toolCallId, toolName, partialResult }`\n" +
          "- `tool_execution_end` `{ toolCallId, toolName, isError }`\n" +
          "- `turn_end` `{ toolResultCount, stopReason }`\n" +
          "- `agent_end` `{ messageCount }`\n" +
          "- `error` `{ error }`\n" +
          "- `done` `{ sessionId, model, reply }` — final event; `reply` equals all `text_delta.delta` concatenated\n" +
          "Client disconnect aborts the agent session automatically.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ChatRequest" } } },
        },
        responses: {
          "200": {
            description: "SSE event stream",
            content: {
              "text/event-stream": {
                schema: { type: "string", description: "Concatenated SSE frames" },
                example:
                  "event: agent_start\ndata: {}\n\n" +
                  "event: text_delta\ndata: {\"delta\":\"Hello\"}\n\n" +
                  "event: text_delta\ndata: {\"delta\":\"!\"}\n\n" +
                  "event: agent_end\ndata: {\"messageCount\":2}\n\n" +
                  "event: done\ndata: {\"sessionId\":\"a1b2c3d4e5f6\",\"model\":{\"provider\":\"openai\",\"model\":\"gpt-4o\"},\"reply\":\"Hello!\"}\n\n",
              },
            },
          },
          "400": {
            description: "JSON error BEFORE the SSE stream starts: message is required, or message blocked by security policy (code=UNSAFE_MESSAGE). Clients must check res.ok / Content-Type before parsing the event stream.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/chat/{agentId}/messages": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      get: {
        tags: ["Chat"],
        summary: "Get full message history for a session",
        parameters: [
          { name: "sessionId", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Messages",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["messages"],
                  properties: { messages: { type: "array", items: { $ref: "#/components/schemas/Message" } } },
                },
              },
            },
          },
          "400": { description: "sessionId query parameter is required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/{agentId}/new": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      post: {
        tags: ["Chat"],
        summary: "Create a new session for the agent",
        responses: {
          "200": {
            description: "New session id",
            content: { "application/json": { schema: { type: "object", required: ["ok", "sessionId"], properties: { ok: { type: "boolean" }, sessionId: { type: "string" } } } } },
          },
        },
      },
    },
    "/chat/{agentId}/reset": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      post: {
        tags: ["Chat"],
        summary: "Delete a specific session, or all sessions for the agent if no sessionId",
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: { sessionId: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Reset", content: { "application/json": { schema: { $ref: "#/components/schemas/ResetResult" } } } },
          "404": { description: "Session not found (when sessionId was specified)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/chat/{agentId}/resume": {
      parameters: [{ $ref: "#/components/parameters/AgentId" }],
      post: {
        tags: ["Chat"],
        summary: "Resume a specific session by ID",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } } },
        },
        responses: {
          "200": {
            description: "Resumed",
            content: { "application/json": { schema: { type: "object", required: ["ok", "sessionId"], properties: { ok: { type: "boolean" }, sessionId: { type: "string" } } } } },
          },
          "400": { description: "sessionId is required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Session not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },

    // ── Models ─────────────────────────────────────────────────────────
    "/models": {
      get: {
        tags: ["Models"],
        summary: "List available models with configured credentials",
        responses: {
          "200": {
            description: "Models",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["models"],
                  properties: { models: { type: "array", items: { $ref: "#/components/schemas/ModelInfo" } } },
                },
              },
            },
          },
        },
      },
    },
    "/models/providers": {
      get: {
        tags: ["Models"],
        summary: "List registered custom providers",
        responses: {
          "200": {
            description: "Providers",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["providers"],
                  properties: { providers: { type: "array", items: { $ref: "#/components/schemas/ProviderConfig" } } },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Models"],
        summary: "Register an OpenAI-compatible provider",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "baseUrl", "models"],
                properties: {
                  name: { type: "string" },
                  baseUrl: { type: "string" },
                  apiKey: { type: "string", format: "password" },
                  headers: { type: "object", additionalProperties: { type: "string" } },
                  models: { type: "array", items: { $ref: "#/components/schemas/ProviderModel" }, minItems: 1 },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Provider registered",
            content: { "application/json": { schema: { type: "object", required: ["ok", "provider"], properties: { ok: { type: "boolean" }, provider: { type: "string" } } } } },
          },
          "400": { description: "name, baseUrl, and models are required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/models/providers/{name}": {
      parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" }, description: "Provider name" }],
      delete: {
        tags: ["Models"],
        summary: "Unregister a custom provider",
        responses: {
          "200": { description: "Unregistered", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } },
        },
      },
    },
  },
};
