# Agent Service Kit

[English](README.md) | [简体中文](README.zh-CN.md)

Agent Service Kit 是一个生产可用、可自托管的大模型 Agent 服务快速部署框架。
它可以把任意兼容 OpenAI 协议的模型端点封装成多用户 Agent 服务，提供独立工作区、
持久化会话、按 Agent 配置工具、流式响应和运行健康检查。

适合已经跨过单次 LLM 原型阶段，准备部署内部 Agent 平台的团队。框架解决了用户认证、
多 Agent 管理、会话持久化、工具权限、并发控制和前端 API 接入等通用问题，业务侧只需
补充自己的系统提示词、技能和参考知识。

## 主要能力

- 创建、查询、修改和删除 Agent，每个 Agent 使用独立文件工作区
- 从 `agent.md` 加载 Agent 指令，从 `skills/` 加载可复用技能
- 为每个用户和 Agent 保存多个独立会话
- 接入 OpenAI-compatible Provider，并支持按请求切换模型
- 通过 SSE 流式输出文本、推理过程和工具调用事件
- 默认限制为只读工具，并拦截高置信度危险命令
- 使用 TTL + LRU 限制内存会话，并限制全局 LLM 并发
- 提供存活、MySQL 就绪、内存、会话和并发指标
- 使用 MySQL 持久化用户、Agent、Provider、会话、消息和 Token 用量

## 架构

```text
HTTP 客户端
    |
    v
Express API (/api)
    |
    +-- JWT 认证与登录限流
    +-- Agent 服务 ---------> workplaces/<agent-id>/
    +-- Chat 服务 ----------> Pi SDK 会话
    |                         |
    |                         +--> OpenAI-compatible Provider
    +-- Session 缓存 -------> MySQL
    +-- Provider 注册表 ----> Pi SDK 模型注册表
```

每个 Agent 只能访问自己的工作区。新建 Agent 默认只获得文件读取类工具，管理员可以
为不同 Agent 配置不同的提示词、技能、参考资料和工具权限。

## 快速开始

环境要求：

- Docker 与 Docker Compose
- 一个兼容 OpenAI 协议的模型端点和 API Key

创建本地配置：

```bash
cp .env.example .env
```

至少修改以下配置：

```dotenv
JWT_SECRET=<执行 openssl rand -hex 32 生成>
DB_PASSWORD=<一个强度足够的数据库密码>
PROVIDER_API_KEY=<你的模型 API Key>
```

启动 MySQL 和应用：

```bash
docker compose up --build
```

启动后可访问：

- API 文档：<http://localhost:3001/api/docs>
- 存活检查：<http://localhost:3001/api/health>
- 就绪检查：<http://localhost:3001/api/health/ready>

首次启动会创建 `admin` 管理员账号。可以在首次启动前设置
`ADMIN_INITIAL_PASSWORD`，也可以从应用日志中读取自动生成的密码：

```bash
docker compose logs app
```

登录并调用 API：

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<管理员密码>"}'

curl http://localhost:3001/api/agents \
  -H "Authorization: Bearer <token>"
```

## 本地开发

环境要求：Node.js 24+、MySQL 8+ 和 npm。

```bash
npm ci
cp .env.example .env
npm run dev
```

常用命令：

```bash
npm run build       # 编译 TypeScript
npm test            # 运行 Vitest 测试
npm run cli         # 启动交互式 Agent CLI
npm start           # 运行编译后的 JavaScript
```

测试默认使用名称中包含 `test` 的独立数据库 `agent_service_kit_test`，并拒绝清空其他
数据库。可以通过 `TEST_DB_NAME` 指定其他测试库。运行测试前先启动 MySQL：

```bash
docker compose up -d mysql
npm test
```

## Agent 工作区

Agent 工作区结构如下：

```text
workplaces/demo-agent/
  agent.md          # 当前 Agent 的系统指令
  skills/           # 可选的可复用技能
    <skill>/
      SKILL.md
  reference/        # 可选的私有参考资料
```

`agents.json` 列出服务启动时需要写入 MySQL 的预置 Agent。仓库中的 `demo-agent` 是
不包含业务数据的通用示例。可以在本地补充自己的提示词、技能和参考资料，但不要把
私有业务数据或凭据提交到公开仓库。

也可以通过 `POST /api/agents` 动态创建 Agent。新 Agent 默认只启用 `read`、`grep`、
`find` 和 `ls`。

## 主要 API

除注册和登录外，所有接口都需要：

```http
Authorization: Bearer <jwt>
```

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/auth/register` | 注册用户 |
| `POST` | `/api/auth/login` | 获取有效期 24 小时的 JWT |
| `GET/POST` | `/api/agents` | 列出或创建 Agent |
| `GET/PUT/DELETE` | `/api/agents/:id` | 查询、更新或删除 Agent |
| `GET/PUT` | `/api/agents/:id/workspace/agent.md` | 读取或更新 Agent 指令 |
| `POST` | `/api/chat/:agentId` | 发送消息 |
| `POST` | `/api/chat/:agentId/stream` | 使用 SSE 流式发送消息 |
| `GET` | `/api/chat/sessions` | 列出当前用户的会话 |
| `GET` | `/api/chat/:agentId/messages` | 读取会话消息 |
| `POST` | `/api/models/providers` | 注册 OpenAI-compatible Provider |
| `GET` | `/api/models` | 列出可用模型 |

请求和响应示例见 [docs/api.md](docs/api.md)，SSE 事件协议见
[docs/stream-events.md](docs/stream-events.md)。

流式接口使用 `POST` 和 Bearer Token，因此不能直接使用浏览器原生 `EventSource`。
请使用 `fetch` 并读取 `response.body.getReader()`。

## 配置说明

最重要的环境变量：

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | 生产环境必填 | JWT 签名密钥；生产环境缺失时服务拒绝启动 |
| `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME` | 是 | MySQL 连接配置 |
| `PROVIDER_NAME` | 否 | Provider 名称，默认 `openai` |
| `PROVIDER_BASE_URL` | 否 | OpenAI-compatible 服务地址 |
| `PROVIDER_API_KEY` | 是 | 模型服务凭据 |
| `DEFAULT_PROVIDER`、`DEFAULT_MODEL` | 否 | Agent 默认模型配置 |
| `ADMIN_INITIAL_PASSWORD` | 否 | 初始化管理员密码；不设置时自动生成 |
| `MAX_CONCURRENT_LLM_CALLS` | 否 | 全局 LLM 并发上限，默认 `2` |
| `SESSION_IDLE_TTL_MS` | 否 | 空闲会话淘汰时间，默认 30 分钟 |
| `SESSION_CACHE_CAPACITY` | 否 | 内存活跃会话上限，默认 `20` |
| `STREAM_TIMEOUT_MS` | 否 | SSE 请求最大时长，默认 5 分钟 |

完整配置见 [.env.example](.env.example)。

Provider 配置优先级从高到低为：请求或 Agent 指定、MySQL Provider 配置、
`PROVIDER_*` 环境变量兜底。数据库凭据和其他密钥不会被打包进镜像。

## 安全说明

- 使用独立且高熵的 `JWT_SECRET`。
- 将密钥放入 `.env`、Secret Manager 或容器运行时环境变量。
- 不要提交 `.env`、模型 Key、客户数据、原始问答导出或私有知识库。
- 新 Agent 默认使用只读工具；只有可信 Agent 才应开放 Shell 能力。
- 登录限流目前存储在进程内存中。多实例部署应替换为 Redis 等共享限流器。
- 聊天安全过滤只是纵深防御，不是安全沙箱。不可信 Agent 应运行在独立容器或虚拟机中。

安全问题请按照 [SECURITY.md](SECURITY.md) 报告。

## 当前边界

- 尚未实现多 Agent 自动路由和长期向量记忆。
- 进程内登录限流不能跨副本共享。
- 金融或其他受监管场景仍需自行补充数据保留、审计、访问控制和合规能力。

## 贡献

欢迎提交 Issue 和 Pull Request，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。
使用 Codex、Claude Code 等编码 Agent 时，请先阅读 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)
