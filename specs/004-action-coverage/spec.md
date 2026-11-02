# Feature Specification: IDE 侧动作的自动化覆盖

**Feature Branch**: `004-action-coverage`

**Created**: 2026-11-02

**Status**: Draft

**Input**: 用户需求：「还有哪些需要实现的功能」→ 两处明确承认的覆盖空洞：
① UI_ISSUES 第 8 条修完后写着「IDE 内的手工验收需装插件后确认——**这一条没有自动化测试覆盖**」；
② TASK_PLAN Phase 7 / Phase 8 的「真机验收」连续两次被标记「用户决定跳过」。
而 CHANGELOG 里记着一次代价极大的事故：`<actions>` 误置于 `<extensions>` 内，
导致 v0.1.0–v0.4.0 的**全部编辑器与 VCS 动作在真机上不可见**，一直没被发现。

## 问题陈述

IDE 侧的动作（编辑器右键、项目树右键、VCS 提交面板按钮）目前只有三层保障：

| 层 | 现状 | 能发现什么 |
|---|---|---|
| `compileKotlin` | 通过 | 只证明能编译 |
| `verifyPlugin` | 通过 | 只检查 API 兼容性与描述符合法性，**不检查动作是否挂在正确的节上** |
| 真机手点 | 已连续跳过两版 | 只能靠人记得点 |

CHANGELOG 记载的那次事故，三层全部通过——因为 `<actions>` 放错节时描述符解析器**静默忽略**，
既不报错也不告警。同类问题还能以另一种形态复发：动作注册对了，但 `update()` 的 enabled 条件
只认 `CommonDataKeys.VIRTUAL_FILE`，而项目树在某些场景只给 `VIRTUAL_FILE_ARRAY`，
结果菜单项恒灰——这也是真实发生过、且至今无测试覆盖的。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 动作注册错了要能被测试拦住 (Priority: P1)

维护者修改 `plugin.xml`（新增动作、调整菜单分组）后，希望在没有真机的情况下就知道动作是否真的注册成功。

**Why this priority**: 这是历史上唯一造成「整个版本功能全部不可见」的缺陷类型，
且现有三层保障全部拦不住。防御价值最高。

**Independent Test**: 故意把某个 `<action>` 移回 `<extensions>` 内 → 运行测试 → 测试失败并明确指出该动作未注册。

**Acceptance Scenarios**:

1. **Given** `plugin.xml` 中某动作定义在 `<actions>` 之外，**When** 运行注册测试，**Then** 测试失败，
   错误信息包含该动作的 id。
2. **Given** 动作定义正确，**When** 运行测试，**Then** 所有预期 id 都能被 `ActionManager` 查到。
3. **Given** 新增了一个动作但忘了写进测试清单，**When** 运行测试，**Then** 测试以「清单漂移」失败
   （读取描述符里的动作 id 集合，与断言清单比对），避免清单长期失修。
4. **Given** 菜单分组 id 写错（如 `ProjectViewPopupMenu` 拼错），**When** 运行测试，**Then** 测试失败。

---

### User Story 2 - 动作的可用性条件有覆盖 (Priority: P1)

维护者修改某个动作的 `update()` 逻辑后，希望确认「该亮的时候亮、该灰的时候灰」，
而不是装到 IDE 里一个个右键试。

**Why this priority**: 与 US1 同级——注册对但恒灰，用户体验等同于没注册，且更难排查。

**Independent Test**: 用不同的 DataContext 组合（有 editor / 只有 VIRTUAL_FILE / 只有 VIRTUAL_FILE_ARRAY / 目录 / 二进制 / 超大文件）
驱动 `update()`，断言 enabled 状态符合预期。

**Acceptance Scenarios**:

1. **Given** DataContext 只有 `VIRTUAL_FILE_ARRAY`，**When** 项目树右键动作 `update()`，**Then** 动作可用
   （这是曾经导致恒灰的真实场景）。
2. **Given** 选中的是目录，**When** `update()`，**Then** 动作不可用，且 `presentation.description` 说明了原因。
3. **Given** 选中的是二进制文件或超过大小上限的文件，**When** `update()`，**Then** 不可用且有原因说明。
4. **Given** 没有 editor 但有可读文件，**When** `ExplainFileWithPi.update()`，**Then** 可用（不得强制要求 editor）。
5. **Given** DataContext 为空（无 project），**When** `update()`，**Then** 不可用且不抛异常。

---

### User Story 3 - 动作执行结果有覆盖 (Priority: P2)

用户点「Send File to Pi」后，文件内容应该真的进到输入框/会话里，而不只是按钮能点。

**Why this priority**: 价值真实，但涉及 IDE 服务较多、成本高于前两条，排第三。

**Independent Test**: 在平台测试夹具中执行动作，断言目标位置（composer 上下文 / 桥接调用）收到了预期的文件与行号。

**Acceptance Scenarios**:

1. **Given** 项目树选中一个文本文件，**When** 执行 Send File 动作，**Then** 传给 pi 的内容包含该文件的相对路径。
2. **Given** 编辑器中有选区且光标在第 N 行，**When** 执行 Explain 动作，**Then** 传入的上下文包含 `file:line` 形式的位置。
3. **Given** 无 editor、直接对文件执行 Explain，**When** 执行动作，**Then** 传入整个文件内容且不附带伪造的行号。

---

### User Story 4 - IDE 冒烟清单固化 (Priority: P2)

维护者发布前需要一份「必须真机确认」的最小清单，而不是依赖记忆。

**Why this priority**: 兜底。前面三条能覆盖大部分，但图标渲染、菜单真实外观等领域仍需真机。

**Independent Test**: 按清单在 runIde 中逐项确认，每项有明确的通过判据。

**Acceptance Scenarios**:

1. **Given** 一份冒烟清单，**When** 发布前执行，**Then** 每项都有可判定的结果（不是「看着正常」）。
2. **Given** 某版本跳过了真机验收，**When** 下一版发布，**Then** 流程要求先补上一版跳过的项（对应宪法第 4 条）。

---

### Edge Cases

- **平台测试夹具需要下载 IDE 依赖**：CI 上必须能在无网/慢网下跳过而非失败；本地首次运行会较慢。
- **`ActionManager` 在测试中未初始化**：需要平台测试基类，不能用普通 JUnit。
- **动作 id 重命名**：测试清单必须随之更新，否则会误报——用「描述符集合 ↔ 断言集合」双向比对而非单向包含。
- **多 product 差异**（IDEA / WebStorm / PyCharm）：VCS 相关动作在社区版可用性不同，测试需明确目标产品。
- **图标渲染问题**（New UI 的 `toStrokeIcon`）无法用断言覆盖：只能进冒烟清单，明确标注「无法自动化」。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 项目 MUST 能运行 IntelliJ 平台测试（需要平台测试框架依赖），不得只依赖纯 JUnit。
- **FR-002**: 测试 MUST 断言 `plugin.xml` 中每个预期动作都能被 `ActionManager` 解析到。
- **FR-003**: 测试 MUST 双向比对「描述符内的动作 id 集合」与「测试断言集合」，发现新增未登记的动作。
- **FR-004**: 测试 MUST 断言菜单分组 id 正确（动作挂在预期 group 下）。
- **FR-005**: 每个动作的 `update()` MUST 在下列 DataContext 下被测试：有 editor、仅 VIRTUAL_FILE、
  仅 VIRTUAL_FILE_ARRAY、目录、二进制、超限、空上下文。
- **FR-006**: 禁用态 MUST 断言 `presentation.description` 给出原因，不能只断言 disabled。
- **FR-007**: 至少一份动作的执行路径 MUST 有覆盖（Send File 的内容拼装）。
- **FR-008**: MUST 提供一份真机冒烟清单，每项含「操作」与「通过判据」两列。
- **FR-009**: 平台测试 MUST 在缺少 IDE 依赖时可跳过（CI 友好），且跳过原因可见。
- **FR-010**: 无法自动化的项（图标渲染、菜单观感）MUST 在冒烟清单中显式标注。

### Key Entities

- **动作清单**：动作 id、所属分组、预期 enabled 条件矩阵、是否已被测试覆盖。
- **冒烟项**：操作步骤、通过判据、是否可自动化、上次确认版本。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 把 `<action>` 移回错误节点后，`./gradlew test` 必定失败——此类事故不再可能静默发布。
- **SC-002**: 动作 enabled 条件的组合场景，从「0 个自动化覆盖」提升到 100% 覆盖
  （当前 `PiEditorActions` 的 4 个动作 × 7 种 DataContext）。
- **SC-003**: 发布前的真机工作量从「凭记忆逐项点」降为一份固定清单（项数 ≤ 10）。
- **SC-004**: 新增动作时若忘记登记测试，测试以明确信息失败，而不是静默通过。

## Assumptions

- 当前 `build.gradle.kts` 未显式声明 `testFramework(TestFrameworkType.Platform)`；
  若 `BasePlatformTestCase` 不可解析，需先补该依赖（IPG 2.19.0 支持）。
- 平台测试的目标产品固定为编译基准（IntelliJ IDEA Community 2024.3.1），不追求全产品矩阵。
- 图标渲染（stripe 的 `toStrokeIcon` 行为）无法通过断言覆盖，接受其留在冒烟清单里。
- 本规格不引入 UI 自动化框架（如 robot），只做平台测试 + 既有 CDP e2e。
