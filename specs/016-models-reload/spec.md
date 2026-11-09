# 016 新认证后模型列表自动生效

> 来源：0.5.6 真机反馈——「增加新的认证之后，希望能够自动刷新，去聊天标签页选模型能选到新的」。
> 版本归属：0.5.6。关联：spec 014（浏览器 OAuth 写 auth.json）、spec 012 US5/US6（provider 表单与凭据写入）、spec 011（模型选择器）。

## 现象与根因

认证页保存成功后模型列表不动，回到聊天页的模型选择器只有启动那一刻的模型。

两层原因，实测确认只有第二层需要额外动作：

1. **前端从不重读**。`store.ts:1263` 是 `get_available_models` 的唯一调用点（`init()` 内）；`AuthPanel.tsx:71` 的 `refresh()` 只重拉 `authOverview`；`ModelPicker.tsx:24` 只读 `store.models`。
2. **pi 对 auth.json 与 models.json 的热加载行为不同**（2026-11-09 实测，pi 1.5.0，临时 `PI_CODING_AGENT_DIR` 隔离）：
   - **auth.json**：空 auth 基线 0 个可用模型 → 直接写 `deepseek` 的 `api_key` → 再调 `get_available_models` 立即返回 2 个模型。**无需重启、无需刷新**。
   - **models.json**：新增一个带 `models` 列表的自定义 provider → 再调仍是 0 个；在扩展命令里 `await ctx.modelRegistry.refresh({ allowNetwork: false })` 后立即变成 1 个，且 `set_model` 返回成功。

## 调研结论（决定方案的关键事实）

1. pi 把模型刷新能力暴露给了扩展：`model-registry.js:11` 的 `refresh()` 是「exposed to extensions」的同步门面，内部转 `ModelRuntime.refresh()`（会重读 models.json 并重算可用性）。
2. 扩展命令可以被 RPC 的 `prompt` 触发：`agent-session.js:1658` 先查扩展命令，命中后 `await command.handler(...)`（`:1727`），再回 `disposition: "handled"`；不写会话、不产生模型请求。
3. 扩展注入通道已成熟：`PiApprovalSupport` 用 `pi --extension <path>` 加载 `pi-approve.js`，只影响插件拉起的 pi 进程。
4. 因此**不需要重启 pi 进程**，也就不存在丢会话/打断任务的问题；`rpc.restart` 只作为旧版 pi 的兜底。

## User Stories

### US1 认证保存后立刻可选

在认证页保存 API key、完成浏览器 OAuth、或删除某个 provider 后，聊天页的模型选择器**立即**包含新增/移除的模型；不重启工具窗、不重启 pi、当前会话不中断。

- 触发点：`ProviderForm` 保存成功（`authSet` / `providerSetKey`）、`authLogin.done.ok`、`authDelete` 成功。
- 统一走 store 的 `reloadModels()` → bridge `models.reload`。

### US2 覆盖 models.json 自定义 provider

`models.reload` 在 bridge 侧编排：确认扩展命令存在 → RPC `prompt` 触发 `ctx.modelRegistry.refresh({ allowNetwork: false })` → 再 `get_available_models` 返回新列表。一次往返给前端拿结果，前端不自行拼两步。

- 命令不存在（旧扩展未注入、pi 版本不支持）时降级：仍然重拉列表（auth.json 场景本就能生效），并在结果里标记 `refreshed: false`。

### US3 打开选择器时的兜底

`ModelPicker` 打开时，若 `sources.models` 的成功时间超过 TTL（15s），后台触发一次 `reloadModels()`。覆盖「在终端里 `pi /login` 或手改 models.json」这类插件感知不到的外部变更；不阻塞下拉框渲染，列表到达后按现有 `locatedRef` 逻辑定位。

### US4 内部命令不出现在补全里

`pi-agent-reload-models` 会出现在 `get_commands` 结果中；`refreshCommands()` 落地前按前缀过滤，避免污染斜杠命令补全和 e2e 命令断言。命令本身保留，仍是手动排障入口（终端里 `/pi-agent-reload-models` 亦可触发）。

### US5 失败必须可见

`models.reload` 抛错时写入 `sources.models`（沿用 spec 003 状态机），诊断面板可见；认证面板显示一条提示「模型列表刷新失败，可重启 pi 后再试」。不静默吞掉。

## 设计决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 不重启 pi 进程 | 实测 refresh 足够；重启会新开会话（启动参数不带 `--session`）并重载扩展/MCP |
| D2 | 新增独立扩展 `pi-agent-models.js`，不复用 `pi-approve.js` | 审批与模型刷新是两件事；`--extension` 可重复传，`PiStartArgs` 改为列表 |
| D3 | 命令固定 `pi-agent-reload-models`，`allowNetwork: false` | 认证与 models.json 都在本地；联网探测会让保存动作变慢且可能失败 |
| D4 | bridge 侧一次编排 + 互斥 | 连续保存多个 provider 时不并发 refresh，避免 pi 端重复重算 |
| D5 | 失败降级为「重拉列表 + 提示」 | 旧 pi（<1.4）或无扩展命令时，至少 auth.json 场景仍正确 |
| D6 | 不新增确认弹窗/成功 toast | 保存本身已有反馈，列表变化是期望结果，静默生效最符合直觉 |

## 非目标

- 模型目录本身的联网刷新（`pi update --models`）——属于 pi 的更新链路，不并入认证保存。
- `settings.json` / 扩展包变更后的自动重载——各自有独立的「重启生效」语义。
- 选中的模型因认证删除而失效时的自动改选——本轮只保证列表正确；失效由 pi 在下次请求时报错，UI 已有错误可见性。

## 验收口径

- 真机：认证页新增一个尚未认证的内置 provider（如 anthropic）的 key → 切到聊天页打开模型选择器，该 provider 分组出现且可选中、可发送。
- 真机：`models.json` 新增自定义 provider → 保存 key → 选择器立即可见（这条依赖扩展 refresh）。
- 自动化：store 单测覆盖 `reloadModels` 成功/失败；mock 覆盖 `models.reload`；e2e 覆盖「认证保存 → 切页 → 选择器出现新 provider」。
- 回归：`sources.models` 状态、诊断面板、模型选择器 011 的三条交互（打开定位/分组/点外关闭）零变化。
