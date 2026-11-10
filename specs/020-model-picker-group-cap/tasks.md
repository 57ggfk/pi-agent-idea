# 020 tasks

> 状态：**文档已定稿，未开工**（2026-11-10）。生效时把本节状态改为实际进度。
> 顺序即编号，串行执行。web 单测 `npx vitest run`，e2e `npx playwright test`，类型 `npm run typecheck`。
> 技术方案、数值表、接口契约、场景剧本一律以 [plan.md](./plan.md) 为准；本文只排顺序与验证方式。
> 每条 task 自带「— 验证：…」；无断言覆盖的实现不得标记完成（宪法第 II 条）。

## A. 纯函数与常量（`web/src/lib/modelGroups.ts`）

- [ ] **T201** [US1] 新增常量 `PROVIDER_LIMIT = 50` / `GROUP_BASE_BUDGET = 1000` / `GROUP_CAP_MAX = 200` / `GROUP_CAP_MIN = 5` 与纯函数 `groupCap(n) = clamp(floor(base / n), min, max)`，`n <= 0` 返回 `GROUP_CAP_MAX` — 验证：`modelGroups.test.ts` 按 plan 的「每家上限数值表」逐项断言 `groupCap` 在 n=1…50 的取值，并覆盖 n=0、n=51、base/min/max 边界
- [ ] **T202** [US1] `flattenGroups` 重写为按组截断：对每个组取 `min(group.models.length, P)`，`ModelGroup` 增 `total/shown/hidden`；超 `PROVIDER_LIMIT` 的组整组不渲染并累计 `hiddenProviders`；删除全局 `hidden` 字段 — 证据：20 家×100 条 → 每组 `shown=50/hidden=50`、扁平 1000 条；55 家×3 条 → 50 组 + `hiddenProviders=5`；3 家 (355/200/4) → 200+200+4 条全显示且 C 组完整（plan 场景 B）
- [ ] **T203** [US4] 当前模型豁免：组内截断后若当前模型不在 `shown` 集合内，把它插到该组首部并去重（不重复渲染、不影响其他组顺序）— 验证：1 家 355 条、当前模型为第 300 条 → 该组首条为当前模型、`activeFlatIndex` 非 null、扁平总长仍为 P
- [ ] **T204** [US1][US3] `buildPickerData` 第 4 参改为 options 对象（`collapsed/providerLimit/baseBudget/capMax/capMin`），`collapsed` 一律参与 `visibleFlat` 计算，删除「关键词非空即忽略折叠」的内部语义 — 验证：不传 opts 时等价旧默认；传临时折叠集合时 `visibleFlat` 排除折叠组；截断量不受折叠影响（plan D5）
- [ ] **T205** [US1] 改写 `modelGroups.test.ts` 既有用例：原「全局 200 截断」改为「每家 200 截断」，并补 `hiddenProviders`、`shown/total`、当前模型豁免、折叠×截断组合四组用例 — 验证：`npx vitest run src/lib/modelGroups.test.ts` 全绿，用例数不少于改造前

## B. 组件与样式

- [ ] **T206** [US3] ModelPicker 搜索态折叠：新增临时 `searchCollapsed` 状态（组件内，不进 localStorage）；关键词从空变非空时重置为空集；`buildPickerData` 传 `keywords.length > 0 ? searchCollapsed : collapsed`；`toggleCollapsed` 按当前是否搜索决定写哪个集合 — 验证：e2e 搜索后点组标题可折叠、清空关键词恢复原记忆；刷新页面后搜索态折叠不残留
- [ ] **T207** [US5] 组标题计数改为 `shown/total`（相等时只显示 `total`）；组末渲染「还有 N 个」；列表末尾渲染「还有 N 个供应商」（来自 `hiddenProviders`）— 验证：e2e 在 20 家×100 条 fixture 下断言每组标题文本含 `50/100`、组末提示存在且数字为 50、末尾供应商提示在 55 家 fixture 下为 5（plan D7）
- [ ] **T208** [US2] 修复标题居中：`.model-group-title` 改 `justify-content: flex-start`，`.model-group-name` 加 `flex: 1 1 auto` + `text-align: left` + 省略号截断，`.model-group-count` 加 `margin-left: auto`（plan D10） — 验证：e2e 几何断言 —— 名称左边界距标题左内边距 ≤ 60px（修复前 ≈150px+）、计数右边界距右内边距 ≤ 16px；长供应商名不把计数挤出容器（`count.right <= title.right`）
- [ ] **T209** [US5] i18n 新增 `model.group.count`（`{{shown}}/{{total}}`）、`model.group.more`（组内还剩 N 个）、`model.providers.more`（还有 N 个供应商），en/zh_CN 双份；`model.more` 迁到 `model.group.more` 并删除旧键 — 验证：`npm run typecheck` 0 错误；字典键对齐测试通过；`grep model.more` 无残留引用

## C. mock 与 e2e

- [ ] **T210** [US1] `bridge/mock.ts` 增加模型规模开关：`?models=now`（2 家 359 条，复刻实测）、`?models=many20`（20 家×100 条）、`?models=providers55`（55 家×3 条）；默认场景不变 — 验证：三个开关各自返回预期条数/组数，默认 e2e 零回归
- [ ] **T211** [US1][US2][US3][US5] `e2e/model-picker.spec.ts` 新增五例：①每家截断 + `shown/total` 文本 ②当前模型被截断时仍置顶可见 ③55 家 → 50 组 + 末尾供应商提示 ④搜索态可折叠且清空后恢复记忆 ⑤标题左对齐几何 — 验证：`npx playwright test e2e/model-picker.spec.ts` 全绿
- [ ] **T212** [US3] 修订 018 的既有断言：把「搜索强制展开」改为「搜索默认展开且可折叠」，其余折叠用例（键盘跳过、当前组自动展开、localStorage 记忆）保留 — 验证：该文件全绿且用例总数不减

## D. 收尾

- [ ] **T213** 全量基线：`npm run typecheck` / `npx vitest run` / `npx playwright test` — 验证：逐条记录结果，任何基线变化注明「非回归」及原因
- [ ] **T214** 文档：`CHANGELOG.md` 0.5.7「变更」补一条（含 50 上限、每家动态截断、标题左对齐、搜索态折叠）；`MANUAL_TEST.md` 增真机两条 — 验证：两处 diff 与实现行为逐字一致（文案按发布约束：一句一件事、不写类名）
- [ ] **T215** 真机：真实 pi 目录（2 家 359 条）打开选择器 → openrouter `200/355` + 组末「还有 155 个」、xiami 4 条完整、当前模型已定位；折叠 openrouter 后重开保持 — 验证：截图入 `build/`，结论写 run-report

## 待真机确认

1. 真实目录 359 条下打开首帧是否可接受（D9 / Q1 的 1000 行风险在此不触发，但作为手感基线记录）。
2. 极端 fixture（20 家 1000 条）在 IDE 内 JCEF 的展开/折叠手感 —— 若明显滞后，按 Q1 把 `GROUP_BASE_BUDGET` 降到 500 并复核数值表。
3. 组标题长供应商名（如 `openrouter` 之外的自定义长名）在 360px 窄工具窗下是否截断正常、计数不被挤出。

## 验证记录

- （待实现后补：vitest / playwright / 真机三段结果，及基线差异说明）
