# 任务清单：诊断页的环境识别卡重做

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214748` · **Issue**: #14

## T1 版本来源（先断言）

- [x] T1.1 `PiManage.environment()` 的版本改用 `PiDiskVersion.current()`，路径用
      `PiLocator.locatePath()` —— 不再起 `pi --version` 子进程（FR-004）
      —— 验证：单测断言探针未被调用
- [x] T1.2 前端诊断卡的版本改读 store 的 `piDiskVersion`（与状态栏同源，FR-005）
- [x] T1.3 运行版与磁盘版不同时 → 显示「重启后生效」

## T2 布局重做

- [x] T2.1 `DiagnosticsPanel.tsx`：环境卡改成每项一行，头部行放版本 + 按钮
- [x] T2.2 `styles.css`：容器改纵向；行用 grid（标签列固定宽）；**去掉 `word-break: break-all`**
      （FR-002）；路径 `ellipsis` + `title` 承载全文
- [x] T2.3 窄面板（360px）不横向溢出 —— 验证：e2e 断言（FR-007）
- [x] T2.4 既有 testid 保持不变（`manage-env` / `pi-version` / `env-node` / `env-npm` /
      `env-plugin` / `pi-update`）

## T3 文案

- [x] T3.1 探测失败 → 「未检测到」而不是 `?` 或空白（FR-006）
- [x] T3.2 i18n 中英各一份
- [ ] T3.3 非 npm 安装退化时的说明文案
      —— 不适用：非 npm 安装时 `PiDiskVersion` 退化为 `pi --version` 探测，**仍能拿到版本号**，不存在「无版本可显示」的情形，因此没有单独的退化文案

## T4 真机验收

- [x] T4.1 环境卡每项一行、路径不拦腰断行
- [x] T4.2 版本号立刻出现（不等子进程）
- [ ] T4.3 外部升级 pi → 诊断卡版本自动变，不刷新页面
      —— 未做：外部升级 pi 再看诊断卡自动变，需要真的升级一次 pi（本轮未做）；机制沿用 #6 已验的 `pi-disk-version` 事件（每 30s 推一次），本轮未改动
- [x] T4.4 窄面板不横向溢出
- [x] T4.5 「更新 pi」按钮仍可用

## T5 收尾

- [x] T5.1 `changelog.d/` 碎片（正好两行）
- [x] T5.2 `./gradlew build` + `cd web && npm test` + `npm run typecheck` 全绿
- [x] T5.3 提交

## 实现记录（2026-11-28）

- **提交**：`4210643`（Kotlin 半边）+ `5d37631`（前端半边）；issue #14 已关闭。
- **版本同源**：诊断卡与状态栏读**同一个** store 事实（`piVersion` / `piDiskVersion`），
  用**同一个** `piVersionDisplay` 判定；「磁盘上的已是 X，重启后生效」复用现成的
  `status.diskVersionTitle`，没另造文案键。Kotlin 侧 `PiManage.environment()` 改用
  `PiDiskVersion.current()` + `PiLocator.locatePath()`（零子进程），**JSON 字段名与结构一律不变**。
- **布局**：每项一行、标签列对齐；去掉 `word-break: break-all`，路径走 ellipsis + `title`；
  每行各自有未知态（桥接读取不再挡住整张卡）。既有 testid 全部保留。
- **测试**：Kotlin `Issue14EnvironmentProbeTest` 4 例（含 JSON 形状未变的逐字段断言）+
  e2e `issue14-diagnostics-env.spec.ts` 6 例（含 360px 不溢出）。
- **真机**：环境卡实测 7 行、标签左边界全部 = 21px、`wordBreak: normal` + `textOverflow: ellipsis`
  + `title` 带完整路径、无横向溢出；运行版与磁盘版分开两行。
- **未做**：T4.3（需真的外部升级一次 pi）。
