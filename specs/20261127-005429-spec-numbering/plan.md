# Implementation Plan: Spec 编号与命名规则 v2（协作版）

**Branch**: `[20261127-005429-spec-numbering]` | **Date**: 2026-11-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/[20261127-005429-spec-numbering]/spec.md`

## Summary

把「spec 目录用什么命名」从**本地串行计数器**换成**时间戳 + 主题**，把对外引用号
（GitHub issue / PR）从「与内部编号纠缠」改成「只写在 spec 头部」。

核心技术判断：**编号需要分配，分配需要全局视野，多作者协作下不存在全局视野。**
因此本方案不做「更好的编号」，而是**取消编号的分配动作**——时间戳由时钟给出，天然唯一、天然有序。

## 改动清单

### 一、规则本体（进版本控制）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `.specify/memory/constitution.md` | §开发流程第 1 条改为 `specs/<YYYYMMDD-HHMMSS>-<topic>/spec.md`；新增「编号与命名」节（N1–N7）；版本 1.0.0 → 1.1.0（MINOR：新增约束） | 规则本体此前不在 git 里（`.gitignore` 忽略整个 `.specify/`），改了别人看不到、换机器要重做 |
| `.specify/templates/spec-template.md` | 占位符 `[###-feature-name]` → `[<YYYYMMDD-HHMMSS>-<topic>]`；新增 `GitHub Issue / PR` 字段 | 脚本真读模板（`common.py:307`），改完提交才能保证各人 checkout 一致 |
| `.specify/templates/plan-template.md` / `tasks-template.md` | 同类占位符 | 同上 |
| `.gitignore` | `.specify/` → 精细化忽略（scripts/、feature.json、init-options.json、integration.json、integrations/、workflows/、.gitignore） | 只让「资产」进版本控制，「上游拷贝 + 机器态」继续留在本地 |
| `docs/SPEC_NUMBERING.md` | 新建——规则的 tracked 副本 | `.specify/` 被 ignore 时仍有一份可 review、可追溯的正文 |

### 二、对仓库其他人的入口

| 文件 | 改动 |
|---|---|
| `specs/README.md` | 顶部命名说明 + 新增「命名与编号（2026-11-27 起）」节（两种形态对照 + 指向规则全文） |
| `changelog.d/README.md` | 碎片命名从「建议带规格号」改为「`<时间戳>-<主题>`」 |
| `.github/pull_request_template.md` | 同一处提示改写 |
| `CONTRIBUTING.md` | 新建——两条路径（小改动直开 PR / 大功能先开 issue）、命名表、提交信息写法、交之前清单 |
| `.github/ISSUE_TEMPLATE/bug_report.md` / `feature_request.md` | 新建——双语模板 |

### 三、本次变更自己的三件套

`specs/20261127-005429-spec-numbering/` —— **第一份用新规则命名的 spec**，规则自证。

## 关键设计决定

- **为什么不用 GitHub 号做目录名**：号必须在目录名确定**之前**存在。外部贡献者若要先开
  issue 或先开 draft PR 才能建目录，等于加了一道前置门槛——而那正是劝退外部贡献者的门槛。
  号放在 spec 头部则零前置。
- **为什么不用纯主题名**：并行 PR 的 slug 会撞（同主题两次），而文件同名在合并时是硬冲突。
  时间戳前缀同时解决唯一性与排序，且不需要任何人协调。
- **为什么号不进文件名**：`#` 在 Markdown 链接里是 fragment 分隔符，目录名带 `#` 会让
  `[spec](specs/x-#3/spec.md)` 静默指向错误路径。
- **排序为什么不用改代码**：定长时间戳的字典序 = 时间序，`build.gradle.kts:351` 的
  `sortedBy { it.name }` 不动就正确——比「改成数值排序」更彻底，因为它不是「修到 1000 之前都正确」。

## 风险与对策

| 风险 | 对策 |
|---|---|
| 时间戳用本地时间（脚本 `datetime.now()`），跨时区排序可能错位 | 同一仓库协作者时区一致即可；规则写明「时间戳取立项时刻」，错位只影响排序观感，不影响唯一性 |
| 同秒开工撞名 | 规则写明加 `-2`/`-3` 后缀 |
| `specify init --force` 与已提交的 constitution/templates 打架 | constitution 有 sha256 指纹保护（`.specify/memory/.constitution-template.json`），定制版不会被覆盖；scripts/ 不跟踪，init 重建无冲突 |
| 合并到浏览器线时 `specs/README.md` 冲突（两边都改过） | 手工解：保留浏览器的 060/065/067 行 + 新的命名规则节；合并前用 `git merge-tree --write-tree` 干跑 |
| 外部贡献者不知道要开 issue | `CONTRIBUTING.md` 写清两条路径；issue 模板双语 |

## 合并去向

本分支基于 `main`。落地完成后按用户指定方向合回 `feat/in-app-browser`（浏览器线）。
合并前先干跑冲突；`specs/README.md` 是唯一预期冲突点。

## 验证

见 [tasks.md](./tasks.md) 末尾的验收条目。
