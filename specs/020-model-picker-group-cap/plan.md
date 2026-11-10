# Implementation Plan: 020 模型选择器供应商上限与每家展示上限

**Branch**: `release/0.5.7` | **Date**: 2026-11-10 | **Spec**: [spec.md](./spec.md)
**Tasks**: [tasks.md](./tasks.md)（T201–T215）

## 摘要

把「整张列表 200 条」的单一上限，拆成两个正交的维度：**供应商最多 50 组**、**每组最多 P(n) 条**（`P` 只随组数递减，`n≤5` 时 200、下限 5）。每家按自己的实际条数截断、配额不跨组搬运，因此分布极不均的真实目录（355 / 4）也能各自完整可见。顺带修 018 引入的标题居中回归、把「搜索强制全展开」改为「默认展开 + 可手动折叠」。

全部改动落在 `web/src`（两个文件 + 样式 + 字典），Kotlin 侧零改动、桥接零新增。

## 技术上下文

- **语言/栈**：TypeScript + React，Vite 构建；无新增依赖（不引虚拟列表库）。
- **存储**：仅沿用既有 localStorage 键 `pi-agent.model-collapsed` 存折叠集合；搜索态折叠为内存态。
- **测试**：`vitest`（`modelGroups` 纯函数）+ `playwright`（交互、几何、文本）。
- **平台**：JCEF（Chromium），窄工具窗下最小宽度按 360px 考虑（既有 e2e 有 360px 几何用例）。
- **性能目标**：渲染条目上界 ≈ `n × P ≤ 1000`；折叠组零条目渲染；分组/截断计算在 `useMemo` 内完成，渲染期不测量 DOM。
- **约束**：不改 store 形状、不加桥接方法、不引虚拟列表（沿 011 Non-goal）。

## Constitution Check

| 条款 | 本次是否涉及 | 结论 |
|---|---|---|
| I 双端契约同步 | 纯前端，`ModelInfo` 形状与桥接信封不变 | 通过 |
| II 断言含几何与行为 | 标题左对齐、计数靠右、窄窗不溢出都必须给数值阈值 | 通过（见验证命令） |
| III 布局不依赖运行时假设 | 标题用 flex 分配而非按滚动条宽度推算；不新增固定宽度 | 通过 |
| IV 对 pi 写操作可回滚 | 只读模型目录，不写 `~/.pi/agent` | 不涉及 |
| V 桥接双向声明 | 不新增桥接方法 | 不涉及 |
| VI 凭据零托管 | 不接触凭据 | 不涉及 |

无违反项，Complexity Tracking 免填。

## 现状与代码定位

| 位置 | 现状 | 问题 |
|---|---|---|
| `web/src/lib/modelGroups.ts:13` | `MODEL_RENDER_CAP = 200` | 全局上限，不是每家 |
| `web/src/lib/modelGroups.ts:118-140` | `flattenGroups(groups, cap)` 顺序累加凑满即停 | 一家大供应商吃掉全部配额，后续组整组消失 |
| `web/src/lib/modelGroups.ts:146-169` | `buildPickerData(models, current, keywords, cap, collapsed)` | 位置参数，维度扩展后可读性差；`collapsed` 传 `null` 时代码路径等价「全展开」 |
| `web/src/components/ModelPicker.tsx:72-77` | `keywords.length > 0 ? null : collapsed` | 搜索即强制展开，用户无法折叠 |
| `web/src/components/ModelPicker.tsx:237-253` | 组标题 = chevron + name + count | 三段子项配 `.model-group-title` 的 `space-between` → 名称居中 |
| `web/src/components/ModelPicker.tsx:291-293` | `data.hidden > 0` 渲染全局「…还有 N 个」 | 只有一级提示，无法表达「哪家被截了多少」 |
| `web/src/styles.css:1189-1207` | `.model-group-title` 用 `justify-content: space-between` | 两段时代的写法，三段下失效 |
| `web/src/i18n/locales/{en,zh}.ts:179-182` | `model.more` 单一键 | 需要拆成组内/供应商两级 |
| `web/src/bridge/mock.ts` `availableModels(knob)`（约 `:2154`） | 已有 `ep` / `long` 开关 | 缺「多家」「超 50 家」两档 fixture |
| `web/e2e/model-picker.spec.ts:91` | `cap truncates at 200 entries…` | 断言的是全局 200，需改写为每家 200 |
| `web/e2e/model-picker.spec.ts:314` | `a non-empty search force-expands collapsed groups` | 断言与 020 US3 相反，必须改写 |

## 设计决策

### D1 供应商渲染上限 50

`PROVIDER_LIMIT = 50`。取序 = 当前模型所在组置顶（011 FR-007 既有语义）+ 其余按 pi 原序。超出的组既不渲染条目也不渲染标题，只在列表末尾给出总数提示。

用户在 2026-11-10 明确选择「搜索也只查前 50」，因此 `providerLimit` 在搜索态同样生效——不做「搜索时放开上限」的例外。

### D2 每家上限 `P(n) = clamp(floor(GROUP_BASE_BUDGET / n), GROUP_CAP_MIN, GROUP_CAP_MAX)`

`GROUP_BASE_BUDGET = 1000`、`GROUP_CAP_MAX = 200`、`GROUP_CAP_MIN = 5`、`n = 实际渲染的组数`。

- `n ≤ 5 → 200`（用户口径「少于 5 家每家 200」；`n=5` 也是 200，阈值处连续）
- `n = 10 → 100`、`n = 20 → 50`、`n = 50 → 20`
- **为什么基准是 1000 而不是 200**：若基准取 200，`n` 从 4 家变 5 家时每家上限从 200 骤降到 40，是断崖；1000 让 `n≤5` 全部落在 200。
- **为什么不守恒**：用户指出每家数量极不均（1 / 几个 / 上百个）。任何「总量守恒 + 按权重分配」的模型都会让大供应商吃掉大头、小供应商被挤掉，正是本次要修的病。因此每家独立取 `min(count, P)`，小供应商省下的配额不回填。总量上界 `n × P ≈ 1000`，真实分布下远低于此。

### D3 `n` 取「实际渲染的组数」

即 `min(实际供应商数, PROVIDER_LIMIT)`，含空 provider 兜底组。若不先截断再算 `P`，200 家供应商会把 `P` 压到下限 5，而列表只渲染 50 家——白白变紧。

### D4 当前模型豁免（组内截断也要可见）

组内截断后若当前模型的 `provider/id` 不在 `shown` 集合里，把它**插到该组首部**并去重（不重复渲染）。理由：011 US1 的验收是「打开即定位到当前模型」，若当前模型是某 355 条组里的第 300 条而被截掉，等于把该修复打回去。

置换只影响该组一次，其余条目保持 pi 原序。

### D5 截断与折叠解耦

`P` 与 `providerLimit` 只按组数计算，**不看折叠状态**。若折叠组不占配额，展开它会把别家挤掉，列表长度随交互抖动；解耦后「展开某组」只是显示它已截断后的那 `P` 条，其他组条数恒定（US1 第 4 条）。

### D6 搜索态折叠：默认展开 + 临时态

组件内新增 `searchCollapsed: Set<string>`。`keywords` 从空变非空时重置为空集（即默认全展开，保住 018「搜到了却看不见」的原始顾虑）；`toggleCollapsed` 在搜索态写 `searchCollapsed`、非搜索态写 `collapsed` + localStorage；清空关键词时不把 `searchCollapsed` 写回持久化集合。

`buildPickerData` 一律接收「生效的折叠集合」，删除「关键词非空即忽略折叠」的内部语义。

### D7 两级截断提示

- 组标题：`shown === total` 时显示 `total`；否则 `shown/total`（`model.group.count`）。
- 组内末行：该组 `hidden > 0` 时显示「还有 N 个」（`model.group.more`）。
- 列表末行：`hiddenProviders > 0` 时显示「还有 N 个供应商」（`model.providers.more`）。
- 不重复计数：被 50 上限挡掉的整组只进 `hiddenProviders`，不进任何组的 `hidden`。

### D8 `buildPickerData` 第 4 参改 options 对象

```ts
buildPickerData(models, current, keywords, {
  collapsed?: ReadonlySet<string> | null;
  providerLimit?: number;
  baseBudget?: number;
  capMax?: number;
  capMin?: number;
})
```

上限维度从一个变四个，位置参数会失去可读性；options 也让 Q1 的降级（只改 `baseBudget`）成为单点改动。

### D9 数据结构：`ModelGroup` 增 `total/shown/hidden`，新增 `hiddenProviders`，删除全局 `hidden`

`flat` / `visibleFlat` / `activeFlatIndex` 语义保持不变 —— `visibleFlat` 仍是高亮、键盘、Enter、打开定位的唯一索引空间（018 的既有约定），只是它现在来自「已截断 + 已折叠」之后的条目序列。

### D10 标题左对齐的修法

`.model-group-title` 改 `justify-content: flex-start`；`.model-group-name` 加 `flex: 1 1 auto; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`；`.model-group-count` 加 `margin-left: auto`（保持条数列右对齐）。

不用「给 name 固定宽度」的做法：固定宽度在 360px 窄窗会挤压计数，违反宪法第 III 条。

### D11 不引虚拟列表，基准常量可调

折叠组零条目渲染已是主要收敛手段。若真机 1000 行打开卡顿，把 `GROUP_BASE_BUDGET` 改为 500（`n=5` → 每家 100），数值表整体减半，结构不变。

### D12 i18n 键拆分

`model.more` 拆为 `model.group.more`（组内剩余）与 `model.providers.more`（供应商剩余），新增 `model.group.count`（`{{shown}}/{{total}}`）。字典双份，不留旧键。

## 每家上限数值表（实现与测试的共同事实源）

| n | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 15 | 20 | 25 | 30 | 40 | 50 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| P | 200 | 200 | 200 | 200 | 200 | 166 | 125 | 100 | 83 | 66 | 50 | 40 | 33 | 25 | 20 |
| 上界 | 200 | 400 | 600 | 800 | 1000 | 996 | 1000 | 1000 | 996 | 990 | 1000 | 1000 | 990 | 1000 | 1000 |

边界：`n = 0` 不渲染，`P` 返回 `GROUP_CAP_MAX`（防除零）。

## 接口契约

```ts
export const PROVIDER_LIMIT = 50;
export const GROUP_BASE_BUDGET = 1000;
export const GROUP_CAP_MAX = 200;
export const GROUP_CAP_MIN = 5;

/** 每家展示上限；n<=0 时返回 GROUP_CAP_MAX。 */
export function groupCap(providerCount: number): number;

export interface ModelGroup {
  provider: string;
  models: ModelInfo[];   // 已截断的条目（含当前模型豁免）
  total: number;         // 该组过滤后的实际条数
  shown: number;         // 渲染条数
  hidden: number;        // total - shown
}

export interface PickerModelData {
  groups: ModelGroup[];
  flat: FlatModelEntry[];
  visibleFlat: FlatModelEntry[];   // 折叠后仍然可见的条目 = 索引空间
  total: number;
  activeFlatIndex: number | null;
  hiddenProviders: number;         // 被 PROVIDER_LIMIT 挡掉的组数
}
```

## 场景剧本（实现自检与测试共用）

| # | 输入 | 断言 |
|---|---|---|
| A | 2 组：355 + 4 | `groupCap(2)=200`；组1 `shown=200/hidden=155`、组2 `4/0`；`hiddenProviders=0` |
| B | 3 组：355 + 200 + 4 | 组2 完整 200 条（不被组1挤掉）；组3 完整 4 条 |
| C | 10 组 × 40 | 全部完整，`hidden=0`，无任何提示节点 |
| D | 20 组 × 100 | `groupCap(20)=50`；每组 `50/50`；扁平 1000 条 |
| E | 55 组 × 3 | 渲染 50 组；`hiddenProviders=5`；每组 `3/0` |
| F | 1 组 355，当前模型为第 300 条 | 该组首条 = 当前模型；`activeFlatIndex != null`；组内不重复 |
| G | 20 组 × 100，折叠其中 3 组 | `visibleFlat` 少 150 条；各组 `shown` 仍为 50（D5） |

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/lib/modelGroups.ts` | 常量 + `groupCap`；`flattenGroups` 按组截断；`buildPickerData` 改 options；`ModelGroup` 增字段、增 `hiddenProviders` |
| `web/src/lib/modelGroups.test.ts` | 数值表逐项、A–G 剧本、改写既有 200 全局截断用例 |
| `web/src/components/ModelPicker.tsx` | `searchCollapsed` 状态与写入分流；标题渲染 `shown/total`；两级提示；`buildPickerData` 传参改 options |
| `web/src/styles.css` | `.model-group-title` flex-start；`.model-group-name` flex/省略号；`.model-group-count` margin-left auto |
| `web/src/i18n/locales/en.ts` / `zh.ts` | 三个新键，删 `model.more` |
| `web/src/bridge/mock.ts` | `availableModels` 增 `now` / `many20` / `providers55` 夹具 |
| `web/e2e/model-picker.spec.ts` | 改写 2 条旧断言 + 新增 5 条 |

## 顺序与依赖

```
阶段 1 纯函数（T201–T205）── 单测先行，红 → 绿
      ↓
阶段 2 组件与样式（T206–T209）── 依赖阶段 1 的数据形状
      ↓
阶段 3 mock + e2e（T210–T212）── 需要阶段 2 的 DOM 结构（testid/文本）
      ↓
阶段 4 收尾（T213–T215）── 全量基线 + 真机
```

不可颠倒的只有一条：`modelGroups.ts` 的契约先定，组件与测试都以它为准。

## 风险与降级

| 风险 | 缓解 |
|---|---|
| 1000 行 DOM 首帧偏慢 | 折叠组零渲染；若真机明显滞后，`GROUP_BASE_BUDGET` 降 500（D11） |
| 用户配置 60+ 供应商时第 51 名之后搜不到（用户已确认接受） | 末尾提示可见；后续放开只需在搜索态不传 `providerLimit` |
| 当前模型被插到组首后该组不再纯原序 | 仅一次置换，其余保持原序；`data-model-key` 去重 |
| 改写既有 e2e 断言时误改语义 | 两条旧断言逐条对照 020 US1/US3，改动写进验证记录 |

## 验证命令

```bash
cd web
npx tsc --noEmit                       # 0 错误
npx vitest run src/lib/modelGroups.test.ts
npx playwright test e2e/model-picker.spec.ts
npx playwright test                    # 全量零回归
```

几何阈值（宪法第 II 条）：标题名称左边界距标题左内边距 ≤ 60px；计数右边界距右内边距 ≤ 16px；`count.right <= title.right`；360px 窄窗下不溢出。
