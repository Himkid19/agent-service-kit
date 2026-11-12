# Agent Service Kit

[English](README.md) | [简体中文](README.zh-CN.md)

把一个兼容 OpenAI 协议的模型端点，快速变成可部署、多用户使用的 Agent 服务。
Agent Service Kit 补齐模型 API 之外最容易重复建设的一层：账号、Agent 管理、独立工作区、
会话历史、工具权限、流式输出和前端可直接调用的 HTTP API。

## 它解决什么问题

调用模型 API 很简单，但把模型变成团队或前端真正可用的服务，需要反复处理大量基础设施。

| 没有 Agent Service Kit | 使用 Agent Service Kit |
| --- | --- |
| 每个原型都重新实现提示词和模型调用层 | 统一管理多个 Agent、Provider 和模型 |
| 用户体系与会话归属需要另行开发 | 已包含 JWT 认证和按用户隔离的会话 |
| 提示词与私有参考资料混在业务代码中 | 每个 Agent 使用独立工作区 |
| 流式输出和工具事件需要自定义协议 | 提供可直接对接前端的 SSE 契约 |
| 进程重启后会话丢失 | 会话和元数据持久化到 MySQL |
| 并发模型调用可能拖垮服务 | 内置排队、并发上限、缓存上限和健康指标 |

这个项目不是另一个聊天 UI，而是聊天 UI、内部知识助手或业务 Agent 后面的服务层。

## 典型使用场景

- 部署内部知识助手：用 `agent.md`、技能和参考资料定义不同领域知识。
- 为不同团队创建独立 Agent：研发、客服、运营、数据分析分别使用不同提示词和工具。
- 给已有 Web 应用增加 Agent 对话 API。
- 从第一天就带认证、持久化和流式输出的 Agent 产品原型。
- 让 Codex、Claude Code 等编码 harness 用固定流程部署、验证和排查 Agent 服务。

## 通过 Codex / Claude Code 接入

仓库包含 [AGENTS.md](AGENTS.md)。编码 Harness 读取后可以自行检查项目、配置环境、
启动服务并完成验证，不需要用户逐步解释部署命令。

1. 在 Codex、Claude Code 或其他支持 `AGENTS.md` 的 Harness 中打开本仓库。
2. 复制 [.env.example](.env.example) 为 `.env`。
3. 填入模型地址、模型 API Key、数据库密码和 `JWT_SECRET`。不要把密钥直接写进 Prompt。
4. 对 Harness 说这一句话：

> 请阅读 `AGENTS.md`，把当前仓库部署为我的本地 Agent 服务：根据 `.env.example`
> 准备 `.env`，执行 `docker compose up --build -d`，等待 `/api/health/ready`，
> 创建一个名为 `support-assistant` 的 Agent，分别验证普通对话和 SSE 对话，
> 最后告诉我前端 Base URL 和仍然需要我处理的事项。

Harness 正常情况下应返回：

- 服务地址，通常是 `http://localhost:3001`；
- `/api/health/ready` 是否通过；
- 创建出的 Agent ID；
- 一次普通模型回复；
- 一次 SSE `done` 事件；
- 是否还有模型 Key、前端域名等待你配置。

Harness 必须把 `.env` 保留在本地，不能提交密钥或测试数据。同一个 Prompt 也可以用于
迁移机器后的重新部署和验收。

## 快速开始

环境要求：

- Docker 与 Docker Compose
- 一个兼容 OpenAI 协议的模型端点与 API Key

创建配置：

```bash
cp .env.example .env
```

至少修改：

```dotenv
JWT_SECRET=<执行 openssl rand -hex 32 生成>
DB_PASSWORD=<一个强度足够的本地数据库密码>
PROVIDER_BASE_URL=https://你的模型服务/v1
PROVIDER_API_KEY=<你的模型 API Key>
DEFAULT_PROVIDER=your-provider
DEFAULT_MODEL=your-model
```

如果希望知道初始管理员密码，请设置 `ADMIN_INITIAL_PASSWORD`。未设置时服务会自动生成，
并在启动日志中只打印一次。

启动：

```bash
docker compose up --build -d
docker compose logs -f app
```

服务地址：

- API Base：`http://localhost:3001/api`
- Swagger UI：`http://localhost:3001/api/docs`
- 存活检查：`http://localhost:3001/api/health`
- 就绪检查：`http://localhost:3001/api/health/ready`

停止：

```bash
docker compose down
```

只有明确要删除本地 MySQL 数据和 Agent 工作区时，才使用
`docker compose down -v`。

## 场景演示

假设要为 Web 应用增加一个客服助手：

1. Harness 部署服务并确认 `/api/health/ready` 通过。
2. 前端或后台用户调用 `POST /api/auth/login` 登录。
3. 应用创建 `support-assistant` Agent，并设置系统提示词。
4. 浏览器向 `POST /api/chat/:agentId/stream` 发送问题。
5. 前端收到 `text_delta` 后逐段渲染文本。
6. 前端保存 `done` 事件中的 `sessionId`。
7. 下一轮继续携带 `sessionId`，助手即可保留上下文。
8. 应用重启后，会话和消息仍可从 MySQL 恢复。

可以在 Agent 工作区中补充领域知识：

```text
workplaces/support-assistant/
  agent.md
  skills/
    product-faq/
      SKILL.md
  reference/
    product-guide.md
```

私有客户资料和内部文档不要提交到公开仓库，应在实际部署时挂载或复制到工作区。

## 一句话创建 Agent

登录后，只需要一次 API 调用：

```bash
curl -X POST http://localhost:3001/api/agents \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "support-assistant",
    "description": "回答产品使用问题",
    "defaultProvider": "openai",
    "defaultModel": "gpt-4o",
    "systemPrompt": "准确、简洁地回答产品支持问题。"
  }'
```

返回结果中的 `id` 用于后续聊天。新 Agent 默认只有 `read`、`grep`、`find`、`ls`
四个只读工具。

## 前端如何对接

### 1. 登录

```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "<管理员密码>"
}
```

后续接口统一携带：

```http
Authorization: Bearer <jwt>
```

### 2. 获取 Agent 和模型

```http
GET /api/agents
GET /api/models
```

### 3. 普通对话

```http
POST /api/chat/:agentId
Content-Type: application/json

{
  "message": "如何重置密码？",
  "sessionId": "可选，已有会话 ID",
  "provider": "openai",
  "model": "gpt-4o"
}
```

响应包含 `reply`、`sessionId` 和实际使用的模型。下一轮继续传入相同 `sessionId`
即可保持上下文。

### 4. 流式对话

流式接口使用 `POST` + Bearer Token，浏览器原生 `EventSource` 不支持这种组合。
请使用 `fetch` 读取响应流：

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

完整事件说明见 [docs/stream-events.md](docs/stream-events.md)。

### 5. 跨域配置

本地开发可以使用 `CORS_ORIGIN=*`。生产环境应设置明确的前端域名：

```dotenv
CORS_ORIGIN=https://app.example.com,https://admin.example.com
```

### 6. 前端错误处理

- `400`：参数错误、弱密码、上下文到达上限或不安全消息。
- `401`：JWT 缺失、无效或过期。
- `404`：Agent/会话不存在，或会话不属于当前用户。
- `409`：用户或 Provider 冲突。
- `423`：登录尝试过多，暂时锁定。
- `503`：数据库不可用或 LLM 请求排队超时。

前端必须先检查 HTTP 状态，再按 JSON 或 SSE 处理响应。

## 主要 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/auth/register` | 注册用户 |
| `POST` | `/api/auth/login` | 获取 JWT |
| `GET/POST` | `/api/agents` | 列出或创建 Agent |
| `GET/PUT/DELETE` | `/api/agents/:id` | 管理单个 Agent |
| `GET/PUT` | `/api/agents/:id/workspace/agent.md` | 读取或更新指令 |
| `POST` | `/api/chat/:agentId` | 普通对话 |
| `POST` | `/api/chat/:agentId/stream` | SSE 流式对话 |
| `GET` | `/api/chat/sessions` | 当前用户的会话列表 |
| `GET` | `/api/chat/:agentId/messages` | 读取会话消息 |
| `POST` | `/api/models/providers` | 注册 OpenAI-compatible Provider |
| `GET` | `/api/models` | 获取模型列表 |

请求与响应示例见 [docs/api.md](docs/api.md)。

## 配置

核心环境变量：

| 变量 | 用途 |
| --- | --- |
| `JWT_SECRET` | 生产环境 JWT 签名密钥 |
| `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME` | MySQL 持久化 |
| `PROVIDER_NAME`、`PROVIDER_BASE_URL`、`PROVIDER_API_KEY` | 默认模型 Provider |
| `DEFAULT_PROVIDER`、`DEFAULT_MODEL` | Agent 默认模型 |
| `ADMIN_INITIAL_PASSWORD` | 可选的初始管理员密码 |
| `CORS_ORIGIN` | 浏览器跨域白名单 |
| `MAX_CONCURRENT_LLM_CALLS` | 全局 LLM 并发上限 |
| `SESSION_IDLE_TTL_MS` | 内存会话空闲淘汰时间 |
| `SESSION_CACHE_CAPACITY` | 内存会话数量上限 |
| `STREAM_TIMEOUT_MS` | SSE 最大持续时间 |

完整配置见 [.env.example](.env.example)。

Docker 构建选项：

- `NODE_IMAGE`：覆盖 Node 基础镜像，通常不需要。
- `NPM_REGISTRY`：受限网络下覆盖 npm registry。
- `MYSQL_IMAGE`：受限网络下覆盖 MySQL 镜像。
- `INSTALL_PYTHON_RUNTIME=true`：安装 Python 与工作区 Python 依赖。默认关闭，
  用于缩小快速部署镜像并减少网络下载。

如果模型服务运行在宿主机，容器内不要使用 `localhost`，应改用
`host.docker.internal` 或宿主机实际地址。

## 维护者验收清单

在宣称部署可用前，必须验证：

1. `docker compose up --build -d`
2. `/api/health` 返回 `ok`
3. `/api/health/ready` 返回 ready 且 `db.reachable=true`
4. 管理员登录成功
5. 创建 Agent 成功
6. `/api/chat/:agentId` 返回模型回复
7. `/api/chat/:agentId/stream` 收到 `text_delta` 和 `done`
8. 执行 `docker compose restart app` 后仍能看到历史会话
9. `npm run build`
10. `npm test`

## 安全与部署边界

- 不要提交 `.env`、模型 Key、客户数据或私有知识库。
- 生产环境必须设置强 `JWT_SECRET`、数据库密码和管理员密码。
- 生产环境应限制 `CORS_ORIGIN`，不要长期保留 `*`。
- 不可信 Agent 不要开放 Shell 工具；消息过滤不是安全沙箱。
- 登录限流保存在单进程内存中，多副本部署需要共享限流器。
- 当前不包含多 Agent 自动路由和长期向量记忆。

安全问题请按照 [SECURITY.md](SECURITY.md) 报告。

## 贡献

欢迎提交 Issue 和 Pull Request，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
