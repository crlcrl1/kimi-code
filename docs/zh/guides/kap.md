# Kimi Agent Protocol (KAP)

`kimi web` 启动的本地服务（以及 Kimi Code 桌面端内嵌服务）对外提供 **Kimi Agent Protocol（KAP）**：一套基于 HTTP REST（`/api/v1`）与 WebSocket（`/api/v1/ws`）的本地 Agent 控制协议。协议目前处于 Beta 阶段，通用接口与消息定义完整收录于单文件规范 [`kap.md`](https://code.kimi.com/kimi-code/kap.md)，运行中的实例也实时提供 `GET /openapi.json` 与 `GET /asyncapi.json`。

## KAP 能做什么

KAP 将 Kimi Code 的 Agent 引擎与具体界面解耦——官方桌面端与 Web UI 本身就是构建在 KAP 之上的客户端。任何外部应用或上层编排器都可以通过 HTTP 发送控制请求、通过单条 WebSocket 连接接收实时状态，获得完整的 Agent 运行时能力：

- **多工作区与会话托管**：在本地目录或已注册的[远程环境](./remote-environment.md)（SSH / Docker）上创建、恢复、分叉（`:fork`）、归档和导出会话；多个客户端可同时连接同一服务实例并实时同步状态。
- **结构化流式对话与中途控制**：按轮次（`Turn`）与条目（`Item`）流式接收思考过程、回复增量、工具调用阶段及输出；随时提交输入、向运行中的轮次插话（`/steer`）、取消（`:cancel`）、按轮次撤销（`:undo`）、手动压缩上下文（`:compact`）或开启只读旁路对话（`:btw`）。
- **交互审批与后台任务流**：将工具权限审批与结构化提问（`interaction` 帧）交由自定义界面展示，或由上层程序按策略自动答复；按字节偏移订阅 Shell 与 subagent 任务的实时输出流，支持单独停止或转入后台。
- **运行时配置与扩展管理**：按会话切换模型、思考强度、权限模式与目标（Goal），并管理工作区文件、[Agent Skills](../customization/skills.md)、[插件](../customization/plugins.md)和 [MCP 服务](../customization/mcp.md)。

## 选择接入方式

| 你想做什么 | 使用 | 能获得什么 |
| --- | --- | --- |
| 自建第三方客户端（Web、桌面、IM 机器人、团队看板），或在多 Agent 系统中将 Kimi Code 作为协作 / 下级 Agent 编排调用 | **KAP** | 常驻 HTTP + WebSocket 服务（[`kimi web`](../reference/kimi-command.md#kimi-web)），具备与官方桌面端同源的[会话管理](./sessions.md)、流式对话、中途插话、审批回调、后台任务流，以及 [Skills](../customization/skills.md)、[插件](../customization/plugins.md)与 [MCP](../customization/mcp.md) 能力。 |
| 将 Kimi Code 接入支持 ACP 标准的编辑器或 IDE（如 Zed、JetBrains AI Chat） | **[`kimi acp`](../reference/kimi-acp.md)** | 运行在子进程 `stdio` 上的 [Agent Client Protocol](https://agentclientprotocol.com/) 服务，与单个宿主 IDE 窗口绑定，支持多轮会话、工具审批，并可将文件读写与终端执行委托给 IDE（配置方法见[在 IDE 中使用](./ides.md)）。 |
| 在终端做日常交互式开发，或在脚本与 CI/CD 中运行无需人工介入的单次任务 | **[`kimi` / `kimi -p`](../reference/kimi-command.md#非交互执行)** | 面向日常开发的终端交互界面（TUI）；加上 `-p` 则以单次子进程运行并向 stdout 输出纯文本或 `stream-json`（JSONL）后退出。 |

## 用 AI Agent 快速接入

KAP 的通用协议规范完整维护在 [`https://code.kimi.com/kimi-code/kap.md`](https://code.kimi.com/kimi-code/kap.md)。按你的场景复制下方提示词，填好方括号后直接发给你的 AI Coding Agent 即可：

### 作为第三方客户端接入

适用于自建 Web / 桌面 / 移动界面、IM 机器人（飞书、Slack、Discord 等）或团队多会话看板：

```text
我在做 [飞书机器人 / 团队 Web 看板 / 自定义客户端]，想要底层的 Agent 服务通过 KAP 协议接入 Kimi Code，完整协议规范在 https://code.kimi.com/kimi-code/kap.md ，请按规范帮我完成接入。
```

### 在多 Agent 系统中编排 Kimi Code

适用于在多 Agent 协作系统、主控编排器或自动化工作流中，将 Kimi Code 作为同级协作 Agent 或下级 subagent 驱动：

```text
我在做 [多 Agent 协作系统 / 自动化研发工作流]，希望将 Kimi Code 作为其中的 [同级协作 Agent / 下级 subagent] 通过 KAP 协议驱动并收发任务结果，完整协议规范在 https://code.kimi.com/kimi-code/kap.md ，请按规范帮我实现调用与状态同步。
```

## 快速开始

如果想先在终端手动验证服务连通性，下面 5 步用 `curl` 和一段零依赖的 Node.js 脚本（Node.js 22+ 内置 `WebSocket`）走完最小闭环：

### 1. 启动服务

运行 `kimi web --no-open --port 0`，将启动输出中 `Local` 行的基地址（不含 `#token=...`）与 `Token` 填入环境变量（未传 `--port 0` 时默认地址为 `http://127.0.0.1:58627`）：

```sh
export KAP="http://127.0.0.1:<启动输出中的端口>"
export TOKEN="<启动输出中的 Token>"
```

### 2. 创建会话

`/api/v1` 的 JSON 响应包裹在 `{ code, msg, data, request_id }` 信封中，`code: 0` 表示成功：

```sh
curl -s -X POST "$KAP/api/v1/sessions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\": \"$PWD\"}"
```

将返回的 `data.id`（形如 `session_...`）记为 `SESSION`：

```sh
export SESSION="<上一步返回的 data.id>"
```

### 3. 订阅实时事件

先建立订阅再提交输入，确保不漏掉轮次开头的事件。将下面代码存为 `subscribe.mjs` 并运行 `node subscribe.mjs`：

```js
const { KAP, TOKEN, SESSION } = process.env;
const ws = new WebSocket(`${KAP.replace(/^http/, 'ws')}/api/v1/ws`, [
  `kimi-code.bearer.${TOKEN}`,
]);

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      request_id: 'sub-1',
      session_id: SESSION,
      agent_ids: ['main'],
    }),
  );
};

ws.onmessage = (frame) => {
  const event = JSON.parse(frame.data);
  if (event.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
  console.log(event.type, event);
};
```

### 4. 提交输入

另开一个终端提交提示词（携带客户端生成的 `prompt_id` 保证网络重试幂等）：

```sh
curl -s -X POST "$KAP/api/v1/sessions/$SESSION/prompts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt_id": "p-1", "content": [{"type": "text", "text": "用一句话介绍这个仓库"}]}'
```

订阅端会先收到初始状态帧与 `turns`，随后依次收到 `agent`（`running`）、`turn.started`、流式 `item.started` / `item.delta` / `item.ended`、`turn.updated`、`turn.ended` 以及回到空闲的 `agent`（`idle`）。

### 5. 翻页读取历史

订阅时的 `turns` 帧最多携带最近 10 轮。当 `has_more` 为 `true` 时，传入最早一轮的 `ordinal`（`FIRST_ORDINAL`）作为 `before_ordinal` 向前翻页：

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "$KAP/api/v1/sessions/$SESSION/agents/main/turns?before_ordinal=$FIRST_ORDINAL&page_size=20"
```

## 下一步

- [`kap.md` 完整协议规范](https://code.kimi.com/kimi-code/kap.md) — 通用协议约定、错误码、全部 REST 接口与 WebSocket 状态归并细则
- [`kimi` 命令](../reference/kimi-command.md#kimi-web) — `kimi web` 与 `-p` 非交互模式的命令行选项
- [在 IDE 中使用](./ides.md) — 通过 `kimi acp` 接入 Zed 与 JetBrains IDE
