# Feature Specification: Spec 编号与命名规则 v2（协作版）

**Feature Branch**: `[20261127-005429-spec-numbering]`
**Created**: 2026-11-27
**Status**: 已定案（规则全文见 [docs/SPEC_NUMBERING.md](../../../docs/SPEC_NUMBERING.md)）

**GitHub Issue / PR**: 无 —— 流程规则变更，由仓库维护者直接拍板。

**Input**: 用户 2026-11-27 提了三问——「批号上千了怎么办」「改成 GitHub 号是不是更合理」，
以及关键约束：「将来要吸引他人贡献 PR，那时各搞各的怎么办」。最终拍板：**目录用时间戳+主题；
对外号只进 spec 头部，不进任何文件名。**

## 用户场景与验收

### User Story 1 — 外部贡献者不查任何内部编号就能开工（Priority: P1）

作为第一次给本仓库提 PR 的外部贡献者，我希望不必先问维护者要一个编号就能开工。

**为什么重要**：编号需要「分配」，分配需要全局视野；多作者协作下不存在全局视野，
本地计数器必然撞号或各搞各的。这是本次规则变更的根因，不是审美偏好。

**独立可测**：fork → 改代码 → 建目录 → 开 PR，全程不需要知道任何内部号。

**验收场景**：

1. **Given** 贡献者第一次提 PR，**When** 他创建 spec 目录，**Then** 目录名只需 `<时间戳>-<主题>`，不必问维护者要号
2. **Given** 贡献者写了用户可见变化，**When** 他写 changelog 碎片，**Then** slug 只需主题词，CI 不因编号挡下
3. **Given** 两个贡献者同时开工，**When** 目录名或碎片名撞了，**Then** 互不覆盖

### User Story 2 — 维护者也不再需要协调取号（Priority: P1）

**验收场景**：

1. **Given** 两个 PR 同时开工，**When** 各自建 spec 目录，**Then** 不产生重号
2. **Given** 编号用到三位数上限，**When** 继续开工，**Then** 排序不乱、发布说明顺序不错乱
3. **Given** 一次跨线搬入（浏览器线并入主线），**When** 两条线编号撞了，**Then** 有明确的让位规则与映射表

### User Story 3 — 存量历史可追溯（Priority: P2）

**验收场景**：

1. **Given** 有人问「048 那批做了什么」，**When** 查 `specs/README.md` 与 git log，**Then** 仍能定位
2. **Given** 浏览器线已平移到 060–070，**When** 跨线查同一批工作，**Then** 有旧号 → 新号映射可查

## 需求（Functional Requirements）

- **FR-001** 新 spec 目录名 = `<YYYYMMDD-HHMMSS>-<topic-slug>`；时间戳取立项时刻；同秒加 `-2`/`-3` 后缀
- **FR-002** 主题 slug = 小写英文 + 连字符，2–3 个词，与 spec 功能名一致
- **FR-003** GitHub issue / PR 号写在 spec 头部 `GitHub Issue:` 字段；主号取先落地的那个（需求单 issue 优先）；**号不进任何文件名**
- **FR-004** 号在正文按 `#N` 写法；文件名里不带 `#`；引用上游仓库 `57ggfk/pi-agent-idea` 的号
- **FR-005** changelog 碎片名 = `<时间戳>-<主题>.<added|changed|fixed>.md`；CI 现行校验规则不变
- **FR-006** 提交信息不带编号；引用 issue 用 `(#N)`
- **FR-007** 存量三位号（001–070）只读：不再新增、不再扩展、不重命名
- **FR-008** 规则条文本体进版本控制（`.specify/memory/constitution.md` + `.specify/templates/`），并在 `docs/` 留副本
- **FR-009** 贡献入口齐备：`CONTRIBUTING.md` + issue 模板；碎片命名不再要求「规格号」
- **FR-010** 排序不依赖位宽：任何位数下 `git ls-files specs | Sort-Object` 与 CHANGELOG 汇总顺序均正确

## 非目标（Non-goals）

- 不迁移存量 spec 目录名（001–070 一个不动）
- 不改写历史提交信息里的批号
- 不把 `.specify/scripts/` 纳入版本控制（上游工具链拷贝，`specify init --force` 会重新生成）
- 不要求每个批号都有 spec 目录（有碎片无目录是合法的）
- 不用主题名当唯一键（唯一性由时间戳保证）
- 本次是流程变更，无用户可见影响 → **不写 changelog.d 碎片**（碎片只写用户看得到的变化）

## 验收口径

- `git ls-files specs | Sort-Object` 按立项时间序，无位宽断裂
- CI 的 `changelog` job 绿（碎片名正则 + 正好两行 + 中英各就各位）
- `docs/SPEC_NUMBERING.md` 与 constitution「编号与命名」节口径一致
- `git check-ignore` 确认 `.specify/memory/constitution.md` 与 `.specify/templates/*` **不再被忽略**
