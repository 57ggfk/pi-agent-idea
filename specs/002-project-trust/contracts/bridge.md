# Bridge 契约：项目级资源的信任模型

本文件定义 `002-project-trust` 新增/变更的桥接方法，三处实现必须一致：
`BridgeService.kt`、`web/src/bridge/types.ts`、`web/src/bridge/mock.ts`。

**通用约定**：同 `001-manage-completeness/contracts/bridge.md`（`ok` 语义、`scope` 枚举、写前备份）。

---

## trust.get

读取当前项目的信任状态及受影响的项目级资源。

**请求**：`{}`（项目由 bridge 的 per-project 路由确定，不由前端传路径——避免前端伪造其他项目路径。）

**响应**

```json
{
  "ok": true,
  "trusted": false,
  "path": "D:/code/github/pi-agent-idea",
  "resources": [
    { "type": "skills",   "scope": "project", "active": false, "reason": "project not trusted" },
    { "type": "mcp",      "scope": "project", "active": false, "reason": "project not trusted" },
    { "type": "settings", "scope": "project", "active": false, "reason": "project not trusted" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `path` | 归一化后的项目路径（小写化仅在 Windows 生效），供 UI 展示，不可用于回传 |
| `trusted` | 是否在 `trust.json` 中命中 |
| `resources` | 仅列出**实际存在**的项目级资源；目录不存在时不出现在数组里（FR/EC：不渲染空分组） |
| `reason` | 未生效原因，仅 `active:false` 时出现 |

**降级**：`trust.json` 不存在 → `ok:true, trusted:false`（不报错）；
解析失败 → `ok:false, trusted:false, error:"trust.json unreadable: <parser message>"`，
调用方按未信任渲染并显示错误横幅。

**缓存**：无。每次调用重新读文件（FR-012）。

---

## trust.grant

信任当前项目。

**请求**：`{ "confirmed": true }` —— 无 `confirmed:true` 返回 `{ "ok": false, "error": "confirmation required" }`。

**响应**：`{ "ok": true, "trusted": true, "path": "…", "restartRequired": true }`

`restartRequired`：存在活跃 pi 进程时为 `true`（信任态对已启动进程不生效）。

**副作用**：写 `trust.json`（备份 → 只增目标键 → 校验 → 原子写），其他项目的键必须原样保留。

**错误**：`trust.json unreadable`（损坏时必须拒绝写入，避免覆盖掉其他项目的信任）、
`backup failed`、`write failed: <os message>`

---

## trust.revoke

撤销当前项目的信任。

**请求**：`{ "confirmed": true }`

**响应**：`{ "ok": true, "trusted": false, "path": "…", "restartRequired": true }`

**副作用**：删除 `trust.json` 中该项目的键；删除后为空对象时保留 `{}`，不删文件。

---

## skills.list（变更）

**破坏性变更**：条目新增 `scope` 字段，且项目级扫描基准从「进程工作目录」改为「项目根」。

**响应**

```json
{
  "ok": true,
  "skills": [
    { "name": "my-skill", "description": "…", "path": "D:/proj/.pi/skills/my-skill", "scope": "project", "disableModelInvocation": false },
    { "name": "global-skill", "description": "…", "path": "C:/Users/x/.pi/agent/skills/global-skill", "scope": "user", "disableModelInvocation": false }
  ]
}
```

**行为变更**：

| 项 | 变更前 | 变更后 |
|---|---|---|
| 项目级路径 | `File(".pi/skills")`（相对进程 cwd） | `File(projectBasePath, ".pi/skills")` |
| 层级标识 | 无 | `scope: "user" \| "project"` |
| 未信任项目 | 照常列出（但 pi 不会加载） | 照常列出，`active` 由 `trust.get` 决定，UI 标注「未生效」 |

`skills.list` 本身**不**返回 `active`——生效与否由 `trust.get` 统一判定，避免两处逻辑漂移。

---

## 实体形状

```ts
type Scope = "user" | "project";

interface ProjectResource {
  type: "skills" | "mcp" | "settings" | "extensions";
  scope: Scope;
  active: boolean;
  reason?: string;
}

interface TrustState {
  trusted: boolean;
  path: string;
  resources: ProjectResource[];
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: Scope;
  disableModelInvocation: boolean;
}
```
