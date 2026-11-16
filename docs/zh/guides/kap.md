# Kimi Agent Protocol (KAP)

`kimi web` 启动的本地服务（以及 Kimi Code 桌面端内嵌服务）对外提供 **Kimi Agent Protocol（KAP）**：一套基于 HTTP REST（`/api/v1`）与 WebSocket（`/api/v1/ws`）的本地 Agent 控制协议。协议目前处于 Beta 阶段，通用行为约定与全量接口目录收录于单文件规范 [`kap.md`](https://code.kimi.com/kimi-code/kap.md)，运行中的实例也实时提供 `GET /openapi.json` 与 `GET /asyncapi.json` 机器可读 Schema。

## KAP 能做什么

KAP 将 Kimi Code 的 Agent 引擎与具体界面解耦——官方桌面端与 Web UI 本身就是构建在 KAP 之上的客户端。任何外部应用或上层编排器都可以通过 HTTP 发送控制请求、通过单条 WebSocket 连接接收实时状态，在受控的角色权限边界内驱动 Agent：

- **多工作区与会话托管**：在本地目录或已注册的[远程环境](./remote-environment.md)（SSH / Docker）上创建、恢复、分叉（`:fork`）、归档和导出会话；多个客户端可同时连接同一服务实例并实时同步状态。
- **结构化流式对话与中途控制**：按轮次（`Turn`）与条目（`Item`）流式接收思考过程、回复增量、工具调用阶段及输出；随时提交输入、向运行中的轮次插话（`/steer`）、取消（`:cancel`）、按轮次撤销（`:undo`）、手动压缩上下文（`:compact`）或开启只读旁路对话（`:btw`）。
- **交互审批与后台任务流**：将工具权限审批与结构化提问（`interaction` 帧）交由自定义界面展示，或由上层程序按策略自动答复；按 UTF-8 字节偏移订阅 Shell 与 subagent 任务的实时输出流，支持单独停止或转入后台。
- **轻量角色隔离与免密接入**：外部客户端使用按角色隔离的独立凭据——只读 `viewer` 仅能观测状态与输出，默认 `operator` 可创建并驱动工作区会话（拥有 Agent 运行时的代码与工作区文件操作能力），但禁止篡改宿主全局配置、供应商、插件与 MCP，也禁止调用无会话的宿主机全局文件浏览接口；支持 `kimi web --port 0 --json` 子进程拉起、本机免密核对码握手以及纯 CLI `kimi access` 管理。

## 选择接入方式

| 你想做什么 | 使用 | 能获得什么 |
| --- | --- | --- |
| 自建第三方客户端（Web、桌面、IM 机器人、团队看板），或在多 Agent 系统中将 Kimi Code 作为需实时观测、中途插话或审批回调的协作 / 下级 Agent | **KAP** | 常驻 HTTP + WebSocket 服务（[`kimi web`](../reference/kimi-command.md#kimi-web)），具备与官方桌面端同源的[会话管理](./sessions.md)、流式对话、中途插话、审批回调、后台任务流，以及 [Skills](../customization/skills.md)、[插件](../customization/plugins.md)与 [MCP](../customization/mcp.md) 能力。 |
| 将 Kimi Code 接入支持 ACP 标准的编辑器或 IDE（如 Zed、JetBrains AI Chat） | **[`kimi acp`](../reference/kimi-acp.md)** | 运行在子进程 `stdio` 上的 [Agent Client Protocol](https://agentclientprotocol.com/) 服务，与单个宿主 IDE 窗口绑定，支持多轮会话、工具审批，并可将文件读写与终端执行委托给 IDE（配置方法见[在 IDE 中使用](./ides.md)）。 |
| 在终端做日常交互式开发，或在脚本、CI/CD 与上层编排中委派**一次性、无需中途交互**的单次任务 | **[`kimi` / `kimi -p`](../reference/kimi-command.md#非交互执行)** | 面向日常开发的终端交互界面（TUI）；一次性无交互任务直接运行 `kimi -p "任务" --output-format stream-json`，向 stdout 输出结构化 JSONL 流并在完成后自动退出，无需维护常驻服务。 |

## 用 AI Agent 快速接入

KAP 的协议行为规范与接口目录完整维护在 [`https://code.kimi.com/kimi-code/kap.md`](https://code.kimi.com/kimi-code/kap.md)（Agent 在开发期还会按规范指引直接读取运行中实例的 `/openapi.json` 与 `/asyncapi.json`）。如果只是单次无交互委派，优先用 `kimi -p "任务" --output-format stream-json`；需要常驻会话、实时状态流或中途控制时，复制下方提示词并替换方括号后发给你的 AI Coding Agent 即可：

### 作为第三方客户端接入

```text
我在做 [一个 coding agent 客户端]，想要底层的 Agent 服务通过 KAP 协议接入 Kimi Code，完整协议规范在 https://code.kimi.com/kimi-code/kap.md ，请按规范帮我完成接入。
```

### 在多 Agent 系统中编排 Kimi Code

```text
我在做 [一个多 Agent 协作系统]，想把 Kimi Code 作为其中的 [同级协作 Agent / 受控下级 Agent] 通过 KAP 协议驱动（支持实时状态同步、中途插话与审批回调），完整协议规范在 https://code.kimi.com/kimi-code/kap.md ，请按规范帮我完成接入。
```

## 连接与鉴权方式

外部客户端与编排器**绝不应读取 `~/.kimi-code/server.token`**（该文件仅属 CLI 宿主凭据，且不被桌面端内嵌服务接受），而是按运行形态选择以下标准方式之一：

- **子进程拉起（推荐编排器与独立客户端使用）**：执行 `kimi web --port 0 --json`。进程自动跳过打开浏览器、不读写 `server.token`，在内存中生成仅随本进程存活的临时 `operator` Token，并在 `stdout` 第一行输出单行纯 JSON：`{"origin":"http://127.0.0.1:<port>","ws_url":"ws://127.0.0.1:<port>/api/v1/ws","token":"kap_...","role":"operator","kimi_agent_protocol_version":"0.1.0"}`。
- **接入本机已运行的桌面端或 `kimi web` 实例**：通过 `~/.kimi-code/server/instances/*.json` 发现存活实例后，调用免密握手接口 `POST /api/v1/access/requests` 获取核对码 `user_code`——桌面端 / Web UI 会弹出极简确认框，纯 CLI 终端会提示运行 `kimi access approve <user_code>`，批准后客户端凭 `device_code` 调用 `:exchange` 一次性领走 `kap_...` Token。
- **纯 CLI 手动签发与管理**：运行 `kimi access create --name <名称> [--role operator|viewer]` 签发独立 Token（明文仅打印一次），随时通过 `kimi access list` 查看或 `kimi access revoke <id>` 吊销（吊销后运行中的服务热感知并实时断开对应 WebSocket 连接）。

## 快速开始

下面用一段零依赖的 Node.js 脚本（Node.js 22+ 内置 `WebSocket`）演示通过 `kimi web --port 0 --json` 拉起服务、创建会话、订阅实时事件并流式打印回复的最小闭环。将代码保存为 `demo.mjs` 后运行 `node demo.mjs`：

```js
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn('kimi', ['web', '--port', '0', '--json'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const { value: bootLine } = await createInterface({ input: proc.stdout })[Symbol.asyncIterator]().next();
const { origin, ws_url, token } = JSON.parse(bootLine);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const { data: session } = await fetch(`${origin}/api/v1/sessions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ cwd: process.cwd() }),
}).then((r) => r.json());

const ws = new WebSocket(ws_url, [`kimi-code.bearer.${token}`]);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

let promptConsumed = false;
let mainStatus = 'idle';
const assistantItemIds = new Set();
const done = new Promise((resolve, reject) => {
  const maybeFinish = () => {
    if (promptConsumed && mainStatus === 'idle') {
      process.stdout.write('\n');
      resolve();
    }
  };
  ws.addEventListener('message', async ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (frame.type === 'turns' && !promptConsumed) {
      const submit = await fetch(`${origin}/api/v1/sessions/${session.id}/prompts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt_id: 'p-1',
          content: [{ type: 'text', text: '用一句话介绍当前目录' }],
        }),
      }).then((r) => r.json());
      if (submit.code !== 0 || submit.data?.status === 'blocked' || submit.data?.status === 'failed') {
        reject(new Error(`Prompt rejected (${submit.code}/${submit.data?.status}): ${submit.msg}`));
      }
      return;
    }
    if (frame.type === 'item.ended' && frame.item.type === 'user_message' && frame.item.prompt_ids?.includes('p-1')) {
      promptConsumed = true;
      maybeFinish();
    }
    if (frame.type === 'item.started' && frame.item.type === 'assistant_message') {
      assistantItemIds.add(frame.item.item_id);
      if (frame.item.text) process.stdout.write(frame.item.text);
    }
    if (frame.type === 'item.delta' && frame.field === 'text' && assistantItemIds.has(frame.item_id)) {
      process.stdout.write(frame.delta);
    }
    if (frame.type === 'agent' && frame.agent_id === 'main') {
      mainStatus = frame.status;
      maybeFinish();
    }
  });
});

ws.send(JSON.stringify({ type: 'subscribe', request_id: 'sub-1', session_id: session.id, agent_ids: ['main'] }));
try {
  await done;
} finally {
  ws.close();
  proc.kill('SIGTERM');
}
```

## 下一步

- [`kap.md` 完整协议规范](https://code.kimi.com/kimi-code/kap.md) — 鉴权角色边界、多版本 `meta.capabilities` 探测、WebSocket 防御式归并规则与全量接口目录
- [`kimi` 命令](../reference/kimi-command.md#kimi-web) — `kimi web`、`kimi access` 与 `-p` 非交互模式的命令行选项
- [在 IDE 中使用](./ides.md) — 通过 `kimi acp` 接入 Zed 与 JetBrains IDE
