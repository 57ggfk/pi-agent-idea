# Bridge 契约：Manage 面板功能补全

本文件定义 `001-manage-completeness` 新增的桥接方法。三处实现必须与本文件一致：
`src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt`、`web/src/bridge/types.ts`、`web/src/bridge/mock.ts`。

**通用约定**

- 传输：`POST /bridge`，请求体 `{ "method": string, "params": object }`。
- 成功：HTTP 200 + `{ "ok": true, ... }`；失败：HTTP 200 + `{ "ok": false, "error": string }`
  （桥接层不抛异常，错误走返回值，避免前端区分网络错误与业务错误）。
- 所有写操作必须先备份目标文件；备份失败即中止并返回 `ok:false`。
- `scope` 取值固定为 `"user" | "project"`，与 002 共用同一枚举。

---

## mcp.setEnabled

停用/启用一个 MCP 服务器。停用 = 从 `mcp.json` 移出条目并把原文存入插件侧停用仓库；启用 = 回填。

**请求**

```json
{ "name": "github", "scope": "user", "enabled": false }
```

**响应**

```json
{ "ok": true, "name": "github", "scope": "user", "enabled": false, "restartRequired": true }
```

| 字段 | 说明 |
|---|---|
| `restartRequired` | 该服务器当前被活跃会话使用时为 `true`，前端据此提示「需新会话生效」 |
| `conflict` | 启用时目标 `mcp.json` 已存在同名条目 → `{ "ok": false, "conflict": true, "error": "..." }` |

**错误**：`missing name` / `invalid scope` / `entry not found` / `config not readable` / `backup failed`

**幂等**：是。对已停用的项再停用返回 `ok:true` 且不重复写仓库。

---

## packages.update

更新单个扩展包。转发到 `pi update <source>`。

**请求**：`{ "source": "@scope/pkg" }`

**响应**

```json
{ "ok": true, "exitCode": 0, "output": "…pi 原始输出…" }
```

**约束**：`output` 为 stdout+stderr 合并后截断 2000 字符；**不得**由插件自行判断「是否有更新」，
一律转述 pi 的输出。超时 300s。

**错误**：`missing source` / 超时 / 非 0 退出码（`ok:false`，`output` 仍返回原始文本）

---

## env.update

更新 pi 本体。转发到 `pi update --self`。

**请求**：`{ "confirm": true }` —— 无 `confirm:true` 时直接返回 `{ "ok": false, "error": "confirmation required" }`，
防止误触。

**响应**

```json
{ "ok": true, "previousVersion": "1.4.0", "version": "1.5.0", "output": "…" }
```

**副作用**：成功后内部调用 `PiLocator.locate(forceRefresh = true)`；`version` 取刷新后的值。
若已有活跃会话，调用方必须先确认（前端负责，服务器不重复拦截）。

---

## models.readProvider

读取某个自定义 provider 的配置，敏感字段替换为布尔。

**请求**：`{ "name": "my-gateway" }`

**响应**

```json
{
  "ok": true,
  "provider": {
    "name": "my-gateway",
    "type": "openai-compatible",
    "baseUrl": "https://…",
    "models": [{ "id": "gpt-x", "contextWindow": 128000 }],
    "secrets": { "apiKey": true, "headers.Authorization": false }
  }
}
```

**强制约束（宪法第 VI 条）**：原始密钥值**绝不可**出现在响应任何字段中。
单测必须断言响应 JSON 字符串里不包含密钥明文。

**错误**：`missing name` / `provider not found` / `models.json unreadable`（附解析错误摘要）

---

## models.openFile

在 IDE 编辑器中打开 `models.json`，可选定位到某 provider。

**请求**：`{ "provider": "my-gateway" }`（`provider` 可省略）

**响应**：`{ "ok": true, "path": "C:\\Users\\…\\.pi\\agent\\models.json", "created": false }`

`created:true` 表示文件原本不存在、已写入 `{"providers":{}}` 骨架。

---

## 实体形状（与 types.ts 对齐）

```ts
type Scope = "user" | "project";

interface McpServerInfo {
  name: string;
  scope: Scope;
  enabled: boolean;
  transport: "stdio" | "http";
  state?: "connected" | "error" | "unknown";
  error?: string;
}
```

`McpServerInfo` 由既有 `mcp.list` 返回，本规格为其补 `scope` 与 `enabled` 两个字段——
**破坏性变更**：`mcp.list` 的消费方（`McpPanel.tsx`）必须同步更新，否则表格渲染会缺列。
