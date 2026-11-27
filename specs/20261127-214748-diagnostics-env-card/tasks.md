# 任务清单：诊断页的环境识别卡重做

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214748` · **Issue**: #14

## T1 版本来源（先断言）

- [ ] T1.1 `PiManage.environment()` 的版本改用 `PiDiskVersion.current()`，路径用
      `PiLocator.locatePath()` —— 不再起 `pi --version` 子进程（FR-004）
      —— 验证：单测断言探针未被调用
- [ ] T1.2 前端诊断卡的版本改读 store 的 `piDiskVersion`（与状态栏同源，FR-005）
- [ ] T1.3 运行版与磁盘版不同时 → 显示「重启后生效」

## T2 布局重做

- [ ] T2.1 `DiagnosticsPanel.tsx`：环境卡改成每项一行，头部行放版本 + 按钮
- [ ] T2.2 `styles.css`：容器改纵向；行用 grid（标签列固定宽）；**去掉 `word-break: break-all`**
      （FR-002）；路径 `ellipsis` + `title` 承载全文
- [ ] T2.3 窄面板（360px）不横向溢出 —— 验证：e2e 断言（FR-007）
- [ ] T2.4 既有 testid 保持不变（`manage-env` / `pi-version` / `env-node` / `env-npm` /
      `env-plugin` / `pi-update`）

## T3 文案

- [ ] T3.1 探测失败 → 「未检测到」而不是 `?` 或空白（FR-006）
- [ ] T3.2 i18n 中英各一份
- [ ] T3.3 非 npm 安装退化时的说明文案

## T4 真机验收

- [ ] T4.1 环境卡每项一行、路径不拦腰断行
- [ ] T4.2 版本号立刻出现（不等子进程）
- [ ] T4.3 外部升级 pi → 诊断卡版本自动变，不刷新页面
- [ ] T4.4 窄面板不横向溢出
- [ ] T4.5 「更新 pi」按钮仍可用

## T5 收尾

- [ ] T5.1 `changelog.d/` 碎片（正好两行）
- [ ] T5.2 `./gradlew build` + `cd web && npm test` + `npm run typecheck` 全绿
- [ ] T5.3 提交
