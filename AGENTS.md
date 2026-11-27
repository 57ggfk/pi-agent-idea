# AGENTS.md

Pi Agent for JetBrains —— 把 [pi coding agent](https://github.com/earendil-works/pi) 嵌进 IDE 的 JetBrains 插件。
Kotlin 宿主 + React/TypeScript 前端（`web/dist` 由 Gradle 同步进插件资源）。

> 给所有 AI 编码代理与贡献者看的项目说明。
> **本机私有约定写在 `agents.local.md`**——该文件若存在，先读它并以其为准（它不入库，只对作者本人生效）。

## 命令

- 构建：       `./gradlew build`（Windows：`\.\gradlew.bat build`）
- 插件兼容性： `./gradlew verifyPlugin`（跨 IDE 版本的二进制兼容检查）
- 发布：       `PI_MARKETPLACE_TOKEN=… ./gradlew publishPlugin`（渠道默认 `default`）
- 前端单测：   `cd web && npm ci && npm test`（vitest）
- 前端 E2E：   `cd web && npx playwright test`
- 前端类型：   `cd web && npm run typecheck`
- 汇总文案：   `./gradlew collectChangelog`（发版时一次；`-PdryRun` 先看）

## 目录

- `src/` — Kotlin 宿主（工具窗口、桥接、内嵌浏览器内核）
- `web/` — React + TypeScript 前端（产物由 Gradle 同步进插件资源，**不要手工拷贝**）
- `specs/` — 每个功能的 spec → plan → tasks 三件套
- `changelog.d/` — 发布文案碎片，一个用户可见变化一个文件
- `docs/` — 长期文档（架构、产品设计、竞品、编号规则）
- `scripts/` — 探针与真机验证脚本

## 贡献者路径（外部 PR）

1. fork 仓库，从 `main` 切分支（`feat/<主题>` / `fix/<主题>`）
2. 小改动直接改；**有设计取舍的大功能先开 issue 讨论**
3. 每个用户可见变化在 `changelog.d/` 写一条碎片（**正好两行：中文在前、英文在后**）
4. 本地跑通上面的测试命令
5. 开 PR：写清「改了什么 / 用户可见变化 / 怎么验证的」

**不需要写 spec，也不需要抢编号**——spec 目录名用 `<时间戳>-<主题>`；编号规则见 [docs/SPEC_NUMBERING.md](docs/SPEC_NUMBERING.md)。

## 所有者路径（内部）

0. 并行多条线时用 `git worktree` 分目录推进，一条线只在一台机器上走
1. 立项 → `specs/<时间戳>-<主题>/` 三件套：spec（用户价值与可验收行为）、plan（技术方案）、tasks（可执行步骤）
2. 实现 → 先补自动化断言再改实现（断言红 → 实现绿）
3. 每个用户可见变化在 `changelog.d/` 写一条碎片
4. 真机验收：IDE 扩展点注册、右键菜单、JCEF 渲染差异**只能真机确认**，不可连续跳过两版
5. 提交信息：conventional commits，不带内部编号；引用 issue 用 `(#N)`

## 发版

1. 从 `main` 切 `release/x.y.z`，**此时才定版本号**（已发布号不复用）；release 分支只做冻结，不接功能 PR
2. 汇总文案：`./gradlew collectChangelog` → `CHANGELOG.md` 顶部生成 `## <version> — <发布日>` 段；商店 What's New 与 GitHub Release notes 都从这一段切，**只维护一处**
3. 校验：`./gradlew build` + `./gradlew verifyPlugin` 全 Compatible + web E2E 全绿
4. 发布：`PI_MARKETPLACE_TOKEN=… ./gradlew publishPlugin` → 等 Marketplace 审核通过
5. 合并回 `main`（`--no-ff`）→ 打 tag `v<version>` → 出 Release（notes 从 CHANGELOG 切段，不手写第二版）
6. 线上问题：从 tag 拉 `hotfix/`，修完**同时**并回 `main` 与 `release`

**三条不变量**：main 恒可发布 · 版本号发版时定 · 文案只维护一处。

## 规则速查

- **双端契约同步**：跨 Kotlin ↔ web 的默认值 / 枚举 / 字段名 / 状态机必须同一次改动里一起改；真源是 `web/src/store/types.ts` 与 Kotlin 数据类
- **验收断言要含几何与行为**：`toBeVisible()` 只证明有非空包围盒，证明不了用户看得见
- **不靠环境假设对齐**：不按「滚动条刚好 N px」推算；不允许用 `overflow: hidden` 掩盖溢出
- **凭据零托管**：插件只读凭据的键名与就绪状态，不读值、不存储、不打印
- **对 `~/.pi/agent/` 的写入**：先备份 → 本地 JSON 校验 → 失败原样呈现错误
- **JCEF 是单向的**：前端资源走 `LocalUiServer` 的 HTTP bridge，不注入 JS

完整约束基准：`.specify/memory/constitution.md` · 编号与命名：[docs/SPEC_NUMBERING.md](docs/SPEC_NUMBERING.md) · 贡献细则：[CONTRIBUTING.md](CONTRIBUTING.md)
