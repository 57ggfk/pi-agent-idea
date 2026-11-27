# Tasks: Spec 编号与命名规则 v2（协作版）

**Input**: Design documents from `/specs/[20261127-005429-spec-numbering]/`

**Prerequisites**: plan.md（required）, spec.md（required）

**Tests**: 本次是文档与规则变更，无自动化测试；验收靠口径核对与 CI 的 changelog job。

---

## 阶段 1：规则本体

- [ ] **T001** 宪法 §开发流程第 1 条改为 `specs/<YYYYMMDD-HHMMSS>-<topic>/spec.md`
  — 验证：`grep -n 'YYYYMMDD-HHMMSS' .specify/memory/constitution.md` 命中两处（开发流程 + 编号与命名节）
- [ ] **T002** 宪法新增「编号与命名」节（N1–N7 七条）
  — 验证：节内条目数 = 7，且含 N7「不协调取号」
- [ ] **T003** 宪法版本 1.0.0 → 1.1.0、Last Amended 改 2026-11-27
  — 验证：末行版本串含 `1.1.0`
- [ ] **T004** 三个模板的 `[###-feature-name]` 占位符改新格式；spec-template 增 `GitHub Issue / PR` 字段
  — 验证：`grep -rn '###-feature' .specify/templates/` 无命中
- [ ] **T005** `.gitignore` 精细化：放行 `.specify/memory/`、`.specify/templates/`，继续忽略 scripts/ 与机器态
  — 验证：`git check-ignore .specify/memory/constitution.md` 无输出（= 不再被忽略）；`git check-ignore .specify/scripts/python/create_new_feature.py` 有输出（= 仍被忽略）

## 阶段 2：仓库入口

- [ ] **T006** `docs/SPEC_NUMBERING.md`（规则的 tracked 副本，含 R1–R12 与迁移边界）
  — 验证：文件存在且 R1–R12 齐全；被 git 追踪（`git ls-files docs/SPEC_NUMBERING.md` 有输出）
- [ ] **T007** `specs/README.md` 顶部命名说明 + 「命名与编号（2026-11-27 起）」节
  — 验证：节内含新形态与存量形态两行对照；含指向 docs 副本与 constitution 的链接
- [ ] **T008** `changelog.d/README.md` 与 `.github/pull_request_template.md` 的碎片命名提示改写
  — 验证：两处都不再出现「建议带规格号」
- [ ] **T009** 新建 `CONTRIBUTING.md`
  — 验证：含两条路径表、命名表、提交信息示例、交之前清单
- [ ] **T010** 新建 `.github/ISSUE_TEMPLATE/bug_report.md` 与 `feature_request.md`
  — 验证：两文件存在且为双语

## 阶段 3：自证

- [ ] **T011** 本次变更自己的三件套（本目录）
  — 验证：目录名符合 `<8位>-<6位>-<slug>`；三件套齐备；`specs/README.md` 的命名节指向它

## 验收条目（合并前逐条核）

- [ ] **V1** `git ls-files specs | Sort-Object` 按立项时间序，无位宽断裂
- [ ] **V2** `Get-ChildItem changelog.d -File | Sort-Object Name` 同样按时间序
- [ ] **V3** CI 的 `changelog` job 绿（碎片名正则 + 正好两行 + 中英各就各位）——本地可跑 `./gradlew collectChangelog -PdryRun=true` 看汇总
- [ ] **V4** `git check-ignore` 确认 constitution 与 templates 不再被忽略、scripts/ 仍被忽略
- [ ] **V5** `docs/SPEC_NUMBERING.md` 与 constitution「编号与命名」节口径一致（逐条对读 R1–R12 / N1–N7）
- [ ] **V6** 合并前干跑：`git merge-tree --write-tree <目标分支> docs/spec-numbering-rule` 列出冲突（预期只有 `specs/README.md`）

## 不做

- 不迁移存量 spec 目录名（001–070）
- 不改写历史提交信息
- 不跟踪 `.specify/scripts/`
- 不写 changelog.d 碎片（流程变更，无用户可见影响）
