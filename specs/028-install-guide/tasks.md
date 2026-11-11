# 028 安装引导 — Tasks

> 028 拥有 T10xx 编号段。

- [x] **T1001** Kotlin：`nodeMeetsMin` 表驱动（v18.20/v20.11/v22.18.9→false；v22.19/v23.0/v24.1→true）+
  `MIN_NODE="22.19"` + detect 的 `nodeVersion/minNode/installBlocker/canInstall`；
  `installScriptArgs` 双平台 + `installScript`（共用 beginInstall/cancel 通道）。
  — 验证：PiEnvironmentTest 表驱动 + installScriptArgs 断言；`./gradlew test --tests "*PiEnvironment*"` 绿。

- [x] **T1002** nodePath：PiAgentSettings 键 + 变更触发 restartPiEverywhere；PiLocator.locateNode/
  locateNpm 优先 settings；BridgeService 增 `manage.envSetNodePath`。
  — 验证：`./gradlew test` 全量绿。

- [ ] **T1003** Web：mock 旋钮（nonode/nodeold）+ detect 新字段四处同步；SetupCard 脚本区块
  （命令+URL 展示、确认、共用输出/停止、失败原文+改用 npm）；SettingsPanel nodePath 输入。
  — 验证：typecheck 0 错；`npx vitest run` 全绿；`npx playwright test setup` 7 条零回归。

- [ ] **T1004** e2e：新增 `web/e2e/install-methods.spec.ts`（nonode→npm 禁用+脚本命令可见+确认后成功；
  nodeold→文案含「22.19」与当前版本；nodePath 生效→detect.node.path 指向自定义）。
  — 验证：`npx playwright test install-methods setup` 全绿。

- [ ] **T1005** 收尾：全量三件套 + gradlew；`changelog.d/028-node-gate-and-nodepath.fixed.md`（两行）；
  run-report 更新。
  — 验证：全部绿；run-report 028 全 ✅。
