# Stream Events — SSE 协议与前端渲染指南

> **端点**: `POST /api/chat/:agentId/stream`
>
> **适用**: 前端对话窗需要实时展示 Agent 思考、工具调用、文本生成的全过程。
>
> **本文档聚焦于**：每个事件的 payload 结构、渲染时机、状态机管理，以及完整的前端对接代码。

---

## 0. 进入 SSE 前的前置校验（重要）

`POST /api/chat/:agentId/stream` **并不总是返回 SSE**。在发送任何 SSE 头之前，以下场景会直接返回普通 JSON：

| 场景 | 状态码 | 响应示例 |
|------|--------|----------|
| `message` 为空 | 400 | `{ "error": "message is required" }` |
| 消息命中高危命令（`whoami`、`/etc/passwd`、`rm -rf`、`bash -c`、反弹 shell、`sqlmap` 等） | 400 | `{ "error": "Message blocked by security policy (...)", "code": "UNSAFE_MESSAGE" }` |
| token 缺失/失效 | 401 | `{ "error": "Missing or invalid Authorization header" }` |
| `sessionId` 不属于当前用户 | 404 | `{ "error": "Session not found" }` |

前端 fetch 流程必须按顺序处理：

1. **先检查 `res.ok`**：非 2xx 直接按 JSON 错误处理，读取 `body.code` 区分 `UNSAFE_MESSAGE` 等业务错误码；
2. **再检查 `Content-Type`** 是否为 `text/event-stream`；
3. **确认是 SSE 后**才进入逐行事件流解析。

否则 `whoami` 这类被拦截的消息返回的 JSON 400 会被误当成 SSE 数据解析，UI 表现为「流还没开始就结束了」，且错误信息难以定位。安全整改（2026-08-12）之后该路径更容易触发，请务必补齐此校验。

---

## 1. 事件流全景

一次 `POST /api/chat/:agentId/stream` 请求会按以下时序产生 SSE 事件。事件之间可能有 **多轮 turn**（Agent 多次调用 LLM），也可能有 **并行 tool call**。

```
agent_start
  └─ turn_start
       ├─ thinking_delta  (0..N)
       ├─ message_start
       ├─ text_delta      (0..N) —— 与 thinking_delta 可能交错
       ├─ message_update  (随每个 delta 触发)
       ├─ tool_execution_start  (0..N)
       │    └─ tool_execution_update  (0..N)
       └─ tool_execution_end
  └─ turn_end
  └─ turn_start …
  └─ turn_end …
agent_end
done                                  ← SSE 流结束
```

> **注意**：`thinking_delta` 只在请求指定了 `thinkingLevel` 或 Agent 配置了 `defaultThinkingLevel` 时才会出现。否则直接出 `text_delta`。

---

## 2. 事件参考

### 2.1 agent_start

**触发时机**：Agent session 开始处理用户消息（调用 LLM 之前）。

```json5
event: agent_start
data: {}
```

**前端处理**：重置流状态计数器；如果 UI 有"正在思考"状态指示器，在此开启。

---

### 2.2 turn_start

**触发时机**：每个 LLM 轮次开始。Agent 可能产生多次 turn（例如首次生成 → 工具调用 → 再次生成）。

```json5
event: turn_start
data: {}
```

**前端处理**：如果上一个 turn 使用了工具，在此处清理"工具调用中"的 UI 状态，为新一轮文本输出做准备。

---

### 2.3 message_start

**触发时机**：新的助手消息块开始生成。

```json5
event: message_start
data: {
  "message": {
    "role": "assistant",
    "content": [],              // 初始可能为空数组
    "diagnostics": []           // Agent 运行日志
  }
}
```

**前端处理**：
- 在对话列表中**追加一条空的助手气泡**（占位），后续 `text_delta` / `thinking_delta` 会向这条气泡填充内容。
- 保存 `diagnostics` 数组以备展示（运行日志、权限检查等）。

---

### 2.4 text_delta

**触发时机**：模型正在生成文本内容。

```json5
event: text_delta
data: {
  "delta": "用户想让我"
}
```

**前端处理**：
- **实时拼接**到当前助手气泡的文本内容中。不要等待整个消息完成再渲染。
- 每次收到 `delta`，应直接 `append` 到 DOM 或虚拟 DOM 中对应的文本节点。
- 推荐使用 `textContent += delta`（纯文本）或 Markdown 增量渲染库。
- `delta` 是一个**字符块**，可能是一段话，也可能是一个字，不应拆分。

---

### 2.5 thinking_delta

**触发时机**：模型正在内部推理（需要 `thinkingLevel` 开启）。与 `text_delta` **交替出现**——thinking 在 text 之前。

```json5
event: thinking_delta
data: {
  "delta": "用户要求列出工作区文件，先读取目录..."
}
```

**前端处理**：
- 将 thinking 内容渲染到当前助手气泡的**折叠区域**（如一个可展开的 `<details>` 面板）。
- 典型 UI 方案：
  - **折叠面板**：`<details><summary>🤔 思考过程</summary>...</details>`
  - **浮层/底部面板**：固定在对话窗口底部的展开区域
- 内容同 `text_delta` 一样实时追加。
- 当用户关闭了 thinking 展开时，仍应持续在后台累积，下次展开时直接显示完整内容。

---

### 2.6 message_update

**触发时机**：每次 `text_delta` / `thinking_delta` 之后同步触发，携带当前累积的完整 `message` 对象。

```json5
event: message_update
data: {
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "用户要求列出工作区文件..." },
      { "type": "text", "text": "好的，我现在来查看工作区。\n\n我先列出文件..." }
    ],
    "diagnostics": [
      { "name": "skill_loader", "status": "loaded", "detail": "...", "durationMs": 12 }
    ]
  }
}
```

**前端处理**：
- **辅助事件**：如果前端需要获取完整的 content blocks（如 thinking + text 的完整内容、diagnostics 日志），可以依赖此事件。
- 正常的文本渲染仍应以 `text_delta` / `thinking_delta` 为主。
- 刷新/重连场景（如 SSE 断开后恢复）可以从此事件获取当前累积状态。

---

### 2.7 turn_end

**触发时机**：当前 LLM 轮次结束。

```json5
event: turn_end
data: {
  "toolResultCount": 1,
  "stopReason": "toolUse"         // "stop" | "toolUse" | "length" | "error" | "aborted"
}
```

**`stopReason` 含义**：

| 值 | 含义 | 前端处理 |
|---|---|---|
| `"stop"` | 模型完成本轮回复 | 无特殊操作，等待下一 turn |
| `"toolUse"` | 模型请求调用工具 | 准备展示 tool call UI |
| `"length"` | 超出 max tokens 截断 | 可提示用户"回复被截断" |
| `"error"` | LLM 调用出错 | 显示错误 UI |
| `"aborted"` | 请求被中断（超时/客户端断开） | 显示中断提示 |

**前端处理**：
- 根据 `stopReason` 决定下一步 UI 状态。
- 如果 `stopReason` 为 `"toolUse"`，后续会紧跟 `tool_execution_start`。

---

### 2.8 tool_execution_start

**触发时机**：Agent 开始执行一个工具调用。

```json5
event: tool_execution_start
data: {
  "toolCallId": "call_abc123",
  "toolName": "read",
  "args": { "filePath": "workplaces/agent-xxx/" }
}
```

**前端处理**：
- 在当前对话中渲染一个**工具调用卡片**。
- 卡片内容：工具名称、参数摘要（截断长参数）、加载中的动画。
- 用 `toolCallId` 作为唯一标识，关联后续的 `update` 和 `end` 事件。

---

### 2.9 tool_execution_update

**触发时机**：长时间运行的工具输出中间结果（如 bash 脚本逐行输出、网络请求逐步响应）。

```json5
event: tool_execution_update
data: {
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "partialResult": "Cloning into 'repo'...\nremote: Enumerating objects: 42"
}
```

**前端处理**：
- 找到对应 `toolCallId` 的工具卡片。
- 追加 `partialResult` 到卡片的结果预览区域（如 `<pre>` 元素）。
- 如果工具执行较快（< 1s），这个事件可能不会出现。

---

### 2.10 tool_execution_end

**触发时机**：工具执行完成。

```json5
event: tool_execution_end
data: {
  "toolCallId": "call_abc123",
  "toolName": "read",
  "isError": false
}
```

**前端处理**：
- 更新对应工具卡片的状态为完成。
- 如果 `isError: true`，卡片标记为错误（红色边框、错误图标）。
- 成功时可将结果摘要折叠显示（默认展开或折叠取决于工具）。

---

### 2.11 agent_end

**触发时机**：整个 Agent session 处理完成（所有 turn 结束）。

```json5
event: agent_end
data: {
  "messageCount": 4   // 当前 session 累积的消息总数
}
```

**前端处理**：
- 关闭"正在思考"状态指示器。
- 最终确认助手气泡的渲染完成。

---

### 2.12 done

**触发时机**：SSE 流正常结束。这是**最后一个事件**，之后服务端会关闭连接。

```json5
event: done
data: {
  "sessionId": "a1b2c3d4e5f6",
  "model": {
    "provider": "openai",
    "model": "gpt-4o"
  },
  "reply": "I can see the following files:\n\n- agent.md\n- skills/\n- reference/"
}
```

**前端处理**：
- 关闭 SSE 连接。
- 保存 `sessionId` 用于多轮对话的下一条请求。
- `reply` 是最终完整回复。如果前端没有实时拼接 `text_delta`，可从此事件获得完整文本。
- 更新 UI 中的模型名称显示。

---

### 2.13 error

**触发时机**：流处理过程中出现错误（超时、服务端异常、模型错误）。之后 SSE 连接关闭。

```json5
event: error
data: {
  "error": "Request timed out after 300s"
}
```

**前端处理**：
- 显示错误提示（toast / 气泡中的错误行）。
- 关闭 SSE 连接和加载状态。
- 不要销毁当前对话——用户可能希望重试。

---

## 3. 前端状态机

建议前端使用以下状态机管理 SSE 流：

```
IDLE
  │  POST /chat/:agentId/stream
  ▼
CONNECTING
  │  event: agent_start → event: turn_start → ...
  ▼
STREAMING
  │  event: done / event: error
  ▼
IDLE (or ERROR)
```

每个状态的 UI 表现：

| 状态 | 输入框 | 停止按钮 | 对话区 |
|---|---|---|---|
| `IDLE` | 可输入 | 隐藏 | 正常展示历史 |
| `CONNECTING` | 禁用 | 显示（但不可点击） | 追加空助手气泡 |
| `STREAMING` | 禁用（或可用，见下方"多轮交互"） | 显示可点击 | 实时更新气泡内容 |
| `ERROR` | 可输入 | 隐藏 | 末尾显示错误提示 |

---

## 4. 前端对接代码

以下为完整的 TypeScript SSE 客户端，覆盖所有事件的回调：

```typescript
// --- stream-chat.ts ---

interface StreamCallbacks {
  onAgentStart?: () => void;
  onAgentEnd?: (data: { messageCount: number }) => void;
  onTurnStart?: () => void;
  onTurnEnd?: (data: { toolResultCount: number; stopReason: string }) => void;
  onMessageStart?: (data: { message: any }) => void;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onMessageUpdate?: (data: { message: any }) => void;
  onToolStart?: (data: { toolCallId: string; toolName: string; args: any }) => void;
  onToolUpdate?: (data: { toolCallId: string; toolName: string; partialResult: string }) => void;
  onToolEnd?: (data: { toolCallId: string; toolName: string; isError: boolean }) => void;
  onDone?: (data: { sessionId: string; model: { provider: string; model: string }; reply: string }) => void;
  onError?: (error: string) => void;
}

interface ChatOptions {
  message: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

/**
 * 发起 SSE 流式聊天请求。
 * 返回 AbortController，调用方可随时取消。
 */
async function streamChat(
  agentId: string,
  options: ChatOptions,
  token: string,
  callbacks: StreamCallbacks,
): Promise<AbortController> {
  const ac = new AbortController();

  const response = await fetch(`/api/chat/${agentId}/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(options),
    signal: ac.signal,
  });

  if (!response.ok) {
    callbacks.onError?.(`HTTP ${response.status}: ${response.statusText}`);
    return ac;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";  // 最后一个片段可能不完整

    for (const frame of frames) {
      if (!frame.trim()) continue;

      const lines = frame.split("\n");
      let eventType = "message";
      let dataStr = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7);
        else if (line.startsWith("data: ")) dataStr = line.slice(6);
      }

      if (!dataStr) continue;

      let data: any;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }

      // 分发事件
      switch (eventType) {
        case "agent_start":
          callbacks.onAgentStart?.();
          break;
        case "agent_end":
          callbacks.onAgentEnd?.(data);
          break;
        case "turn_start":
          callbacks.onTurnStart?.();
          break;
        case "turn_end":
          callbacks.onTurnEnd?.(data);
          break;
        case "message_start":
          callbacks.onMessageStart?.(data);
          break;
        case "text_delta":
          callbacks.onTextDelta?.(data.delta);
          break;
        case "thinking_delta":
          callbacks.onThinkingDelta?.(data.delta);
          break;
        case "message_update":
          callbacks.onMessageUpdate?.(data);
          break;
        case "tool_execution_start":
          callbacks.onToolStart?.(data);
          break;
        case "tool_execution_update":
          callbacks.onToolUpdate?.(data);
          break;
        case "tool_execution_end":
          callbacks.onToolEnd?.(data);
          break;
        case "done":
          callbacks.onDone?.(data);
          break;
        case "error":
          callbacks.onError?.(data.error);
          break;
      }
    }
  }

  return ac;
}
```

**使用示例**（React / Vue 框架通用模式）：

```typescript
// 纯函数式用法
const ac = await streamChat("agent-xxx", { message: "你好" }, token, {
  onThinkingDelta: (delta) => appendToThinkingPanel(delta),
  onTextDelta: (delta) => currentBubble.appendText(delta),
  onDone: (data) => saveSessionId(data.sessionId),
  onError: (msg) => showToast(msg),
});

// 取消
stopBtn.onclick = () => ac.abort();
```

---

## 5. 多轮对话管理

多轮对话的关键是**复用 `sessionId`**：

1. 第一轮不带 `sessionId` 发起请求，服务端自动创建新 session。
2. 从 `done` 事件中取出 `sessionId`。
3. 后续请求将 `sessionId` 放在 body 中，历史消息会自动恢复。

```typescript
let currentSessionId: string | undefined;

async function sendMessage(text: string) {
  const ac = await streamChat("agent-xxx", {
    message: text,
    sessionId: currentSessionId,
  }, token, {
    onTextDelta: (delta) => appendText(delta),
    onDone: (data) => { currentSessionId = data.sessionId; },
    onError: (msg) => showError(msg),
  });
  return ac;
}
```

---

## 6. 常见 UI 场景速查

| 场景 | 做法 |
|------|------|
| **实时打字效果** | 拼接 `text_delta` 的 `delta`，边收边渲染 |
| **只想要最终回复** | 等 `done` 事件，读 `data.reply` |
| **展示模型推理过程** | 监听 `thinking_delta`（需开启 `thinkingLevel`） |
| **展示工具调用卡片** | 监听 `tool_execution_start` / `tool_execution_update` / `tool_execution_end` 三元组 |
| **展示运行日志** | 从 `message_update.data.message.diagnostics` 读取 |
| **取消生成** | 调用 `AbortController.abort()`，服务端自动中断 Agent |
| **错误处理** | `error` 事件 + turn_end 的 `stopReason: "error"` |
| **多轮对话** | 每轮从 `done` 事件拿 `sessionId`，下轮请求传入 |
| **新对话** | 调用 `POST /api/chat/:agentId/new` 获取新 sessionId |

---

## 7. 事件流转示意图

```
时间 →
─────

POST /api/chat/agent-xxx/stream
          │
          ▼    agent_start
          ├────────────────────► 重置流状态
          │
          ▼    turn_start
          ├────────────────────► turn 计数器 +1，准备渲染新 turn
          │
          ▼    thinking_delta (可选)
     ┌────┼────────────────────► 折叠面板实时追加
     │    │
     │    ▼    message_start
     │    ├────────────────────► 追加新助手气泡
     │    │
     │    ▼    text_delta
     │    ├────────────────────► 实时追加文本
     │    │
     │    ▼    message_update
     │    ├────────────────────► 保存完整 message 快照（用于恢复）
     │    │
     │    ▼    tool_execution_start
     │    ├────────────────────► 渲染工具调用卡片
     │    │    tool_execution_update
     │    ├────────────────────► 实时追加工具输出
     │    │    tool_execution_end
     │    ├────────────────────► 卡片标记完成/错误
     │    │
     │    ▼    turn_end
     └────┼────────────────────► 检查 stopReason，准备下一 turn
          │
          ▼    (可选) turn_start → ... → turn_end
          │
          ▼    agent_end
          ├────────────────────► 关闭思考指示器
          │
          ▼    done
          ├────────────────────► 保存 sessionId，关闭 SSE
          │
          ▼    (流结束)
```

---

## 8. 与 `POST /api/chat/:agentId`（非流式）的关系

| 端点 | 事件 | 适用场景 |
|------|------|----------|
| `POST /chat/:agentId` | 单次 HTTP 响应 `{ reply, sessionId, model }` | 简单问答、后台处理、非交互式调用 |
| `POST /chat/:agentId/stream` | SSE 事件流（本文档全部事件） | 前端对话窗、需要实时反馈、展示 thinking/tool call |

两者内部都使用同一 `ChatService` 实现；流式端点额外暴露了实时事件供前端渲染。
