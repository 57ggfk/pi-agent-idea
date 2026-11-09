# 016 tasks

> 状态：2026-11-09 全部实现并自测（typecheck ✓；vitest 268 绿；playwright 246 绿；`gradlew test` ✓；`gradlew buildPlugin` ✓）。真机项见文末。

## A. Kotlin（扩展注入 + 桥接）

- [x] T1 新增 `process/PiModelReload.kt`：按 `PiApprovalSupport` 的模式把 `pi-models/pi-models.js` 解压到 IDE 配置目录 `pi-agent/`，暴露 `ensureExtensionInstalled(): File?`；资源内容为 `export default function (pi) { pi.registerCommand("pi-agent-reload-models", { handler: async (_a, ctx) => { await ctx.modelRegistry.refresh({ allowNetwork: false }); } }) }` — 验证：单测断言解压文件存在且包含命令名；资源缺失时返回 null 不抛。
- [x] T2 `PiStartArgs.build` 的 `approvalExtension: String?` 改为 `extensions: List<String>`，按顺序追加多个 `--extension`；`PiProcessManager.start()` 同时传审批扩展与模型扩展 — 验证：`PiStartArgsTest` 断言两个 `--extension` 均出现、顺序稳定、null/空列表不产生参数。
- [x] T3 `BridgeService` 新增 `models.reload`：`synchronized` 互斥 → `get_commands` 检查命令存在（不存在则跳过 prompt，`refreshed=false`）→ `prompt` 发 `/pi-agent-reload-models`（超时 30s）→ `get_available_models` 返回 `{ models, refreshed }` — 验证：取消 pi 运行时返回明确错误；命令缺失路径不报错只降级。
- [x] T4 `bridge/types.ts` 的方法白名单同步 `models.reload` — 验证：typecheck 通过；grep 四处契约（types / store 调用 / BridgeService / mock）齐全。

## B. Web（刷新链路）

- [x] T5 store 新增 `reloadModels(): Promise<void>`，内部 `loadSource("models", ...)` 调 `models.reload` 并 `set({ models })`；`refreshCommands()` 过滤 `pi-agent-` 前缀命令 — 验证：单测断言调用 bridge、更新状态、失败写入 `sources.models.error`；命令列表不含内部命令。
- [x] T6 三个触发点接线：`ProviderForm` 保存成功（`authSet`/`providerSetKey` 之后）、`authLogin.done.ok`、`authDelete` 成功 — 验证：单测/人工走查断言 `reloadModels` 被调用一次，且不阻塞表单收起。
- [x] T7 `ModelPicker` 打开时按 TTL（15s）触发 `reloadModels()`，不阻塞首帧、不打断定位 — 验证：e2e 断言超过 TTL 打开会发请求、未超过不发。
- [x] T8 `bridge/mock.ts` 实现 `models.reload`：返回当前 fixture 并支持「认证后新增 provider」场景开关，供 e2e 使用 — 验证：mock 单测覆盖默认与新增两条。
- [x] T9 i18n：认证面板刷新失败提示（en/zh 双份字典）— 验证：typecheck 与字典键对齐测试通过。
- [x] T10 e2e `models-reload.spec.ts`：认证页保存 → 切聊天页 → 选择器出现新 provider 分组且可选中 — 验证：playwright 单文件绿。

## C. 收尾

- [x] T11 `specs/README.md` 追加 0.5.6 批次注记；`CHANGELOG.md` 0.5.6 增「修复」条目；`MANUAL_TEST.md` 增真机验收两条 — 验证：三项文档 diff 存在且与实际行为一致。
- [x] T12 全量基线：`npm run typecheck` / `vitest` / `playwright` / `gradlew test` / `gradlew buildPlugin` — 验证：逐条记录结果，非回归的基线变化注明原因。

## 待真机确认

1. 认证保存后未切页时选择器是否已更新（预期：是，store 已刷新）。
2. `models.json` 自定义 provider 保存后立即可选（依赖 T1–T3 的扩展 refresh）。
3. 正在流式生成时保存认证：refresh 不打断当前 run（扩展命令在 streaming 中也会执行）。

## 验证记录

- **隔离实证**（pi 1.5.0，临时 `PI_CODING_AGENT_DIR`，未触碰真实 `~/.pi/agent`）：
  - auth.json：空 auth 基线 0 个可用模型 → 直接写 `deepseek` 的 `api_key` → `get_available_models` 立即返回 2 个。pi 自己会重读，**无需刷新**。
  - models.json：新增带 `models` 列表的自定义 provider 后仍是 0 个；扩展命令内 `ctx.modelRegistry.refresh({ allowNetwork: false })` 后变 1 个，`set_model` 返回成功。命令响应 `disposition:"handled"`，handler 被 await（`agent-session.js:1727`），不写会话、不产生模型请求。
- `web`：typecheck ✓；vitest 268 ✓（store 4 条 + mock 2 条）；playwright 全量 246 ✓（基线 243 + 新增 3）。
- `gradlew test` ✓；`gradlew buildPlugin` ✓ → `build/distributions/pi-agent-idea-0.5.6.zip`。
- **踩坑记录**：playwright 的 `reuseExistingServer` 会复用 5173 上**任意 checkout** 的 dev server——本次复用了主工作树的旧代码，新用例因此误报「找不到模型」。已给 `playwright.config.ts` 增加 `PI_E2E_PORT`，多工作树并行时用它隔离。
