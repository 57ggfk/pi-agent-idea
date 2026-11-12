## 改了什么

<!-- 一两句话。用户看不见的改动（重构、测试、文档）写「无用户可见变化」并说明原因。 -->

## 发布文案

<!--
每个用户可见变化在 changelog.d/ 建一个碎片：
  文件名 <slug>.<added|changed|fixed>.md（建议 slug 带规格号，如 024-session-rename.added.md）
  内容正好两行：第 1 行中文、第 2 行英文，只写用户看得到的效果
不要写版本号，也不要直接改 CHANGELOG.md——发版时用 ./gradlew collectChangelog 统一汇总。
规范见 changelog.d/README.md。
-->

- [ ] 已写 `changelog.d/` 碎片；或本 PR 无数值用户可见变化（说明原因）

## 验证

- [ ] `./gradlew build` 通过
- [ ] 前端：`cd web && npm test`、`npx playwright test` 通过
- [ ] 交互改动补了**真点击**的 e2e（`toHaveCount` / `toBeVisible` 抓不到裁切类回归）
