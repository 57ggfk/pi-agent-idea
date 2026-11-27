# Spec 编号与命名规则 v2（协作版）

> 状态：**待落地**（2026-11-27 定案：时间戳 + 主题）
> 变更记录：[`specs/20261127-005429-spec-numbering/`](../specs/20261127-005429-spec-numbering/spec.md)（本次规则变更自己的三件套）
> 适用范围：`specs/` 目录名、`changelog.d/` 碎片名、分支名、提交信息
> 前身：三位批号（001–070），存量边界见 §7
> **本文档是规则的版本控制副本**——`.specify/` 被 `.gitignore` 忽略（见 §2.5），宪法本体不在 git 里，改了别人看不到，所以规则必须在这里留一份。

## 1. 一句话

新工作的 spec 目录名 = `<时间戳>-<主题>`；对外引用号（GitHub issue / PR）只写在 spec 头部与提交信息里，**不进任何文件名**；三位批号冻结（目录到 067、碎片到 070），只读不再新增。

## 2. 为什么改（四条真实故障，不是审美偏好）

### 2.1 撞号——已经发生过 3 次

两条工作线共用一个本地计数器，号必然撞：`048-code-block-header` 与 `048-in-app-browser-p0`、`050-csv-tsv-table` 与 `050-address-bar-ime`、`051-stale-model-provider` 与 `051-error-card-retry`。

证据：提交 `50c9d51` 把浏览器线整体平移到 060–070，就是为了消这三处撞号。现在 `specs/` 下 55 个目录里只剩 `005×2`（`005-message-copy-actions` / `005-message-queue`）一个历史重号。

### 2.2 外部贡献者会卡在 CI

`changelog.d/README.md:9` 要求「建议带规格号，如 `024-session-rename.added.md`」，而 `.github/workflows/build.yml:98` 强校验碎片名正则。外部贡献者不知道内部批号 → 只能瞎编 → CI 直接挡下。

这不是假设：仓库已有外部贡献者提交（`git shortlog -sne --all` → `wangji` 6 commits）。

### 2.3 位宽断裂会打乱发布说明顺序

`build.gradle.kts:351` 是 `sortedBy { it.name }`（纯字符串序），它决定 `CHANGELOG.md`「新增/变更/修复」小节内的条目顺序。实测（PowerShell `Sort-Object`）：

```
070-b → 1000-a → 999-z
```

三位号用尽后，`1000` 会排到 `999` 前面，发布说明顺序错乱。

### 2.4 取号机制本身是单作者产物

`.specify/scripts/python/create_new_feature.py:209` 的 `_get_highest_from_specs()`（匹配正则在 `:218`）靠**扫本地目录取最大号**分配编号。两个贡献者同时开 PR，各取各的最大号 → 必撞；而且 `.specify/` 在 `.gitignore` 里，外部贡献者根本跑不到这个脚本。

**结论：编号需要「分配」，分配需要全局视野，多作者下不存在全局视野 → 本地计数器在协作场景天然不成立。**

### 2.5 规则本体不在版本控制里

`.gitignore` 含 `.specify/`，`constitution.md:100` 的「`specs/NNN-name/spec.md`」规则没有 git 副本。规则改了别人看不到 → 必须有一份 tracked 副本（本文档）。

## 3. 规则条文

| 编号 | 规则 |
|---|---|
| **R1** | 新 spec 目录名 = `<时间戳>-<主题 slug>`；时间戳格式 `YYYYMMDD-HHMMSS`。Speckit 建目录与分支时用 `--timestamp` |
| **R2** | 主题 slug = 小写英文字母 + 连字符，2–3 个词，与 `spec.md` 的功能名一致；由 `create_new_feature.py` 的 `_clean_branch_name()` 生成，必要时手工 `--short-name` |
| **R3** | 同秒冲突 → 加 `-2` / `-3` 后缀，不改时间戳本体 |
| **R4** | 时间戳语义 = **立项时刻**（spec 目录首次创建时刻），不是需求提出或完成时刻；跨天开工的在 `spec.md` 里补记完成日期 |
| **R5** | 对外引用号取自**上游仓库** `57ggfk/pi-agent-idea`：issue 号或 PR 号均可（两者共用一个计数器，GitHub 的 issues 端点对 PR 同样返回该号，已实测 `#4` 是 PR 且 `/issues/4` 可取） |
| **R6** | 主号 = 该工作**先落地**的那个引用号；需求单 issue 优先于 PR。另一个号记在 `spec.md` 正文，不进目录名 |
| **R7** | 号一律写**裸数字不带 `#`**——`#` 在 Markdown 链接里会被当 fragment，`[spec](specs/x-#3/spec.md)` 会静默指向错误路径 |
| **R8** | 引用必须写明是上游仓库的号——fork 的 issue 计数从 1 重排，fork 里的 `#3` ≠ 上游 `#3` |
| **R9** | `changelog.d/` 碎片名 = `<时间戳>-<主题>.<added\|changed\|fixed>.md`；**文件名不进发布说明**（`build.gradle.kts:365` 只取「类型 + 两行文案」），所以长度不影响用户可见内容 |
| **R10** | 提交信息不带号：`feat(<范围>): <描述>`；引用 issue 用 GitHub 原生 `(#N)` |
| **R11** | 三位批号**冻结**（存量目录到 067、碎片到 070）：存量目录名只读、不再新增、不再扩展 |
| **R12** | 编号不参与「分配」：任何情况下都不需要与任何人协调取号 |

## 4. 文件名最终形态

| 场景 | spec 目录 | changelog 碎片 | 提交信息 | 贡献者前置动作 |
|---|---|---|---|---|
| 存量（001–067 目录；068–070 只有碎片） | `specs/050-csv-tsv-table/` | `changelog.d/050-csv-tsv-table.added.md`（已消费） | `feat(048 browser): …` | — |
| 新工作（维护者） | `specs/20261127-003012-csv-table/` | `changelog.d/20261127-003012-csv-table.added.md` | `feat(web): CSV 表格 (#3)` | 无 |
| 新工作（外部贡献者） | 同上 | 同上 | 同上 | **无**（不必先开 issue） |

目录内部的文件名不变：`spec.md` / `plan.md` / `tasks.md` / `evidence/*`。

长度：现有目录名平均 **21.1** 字符（最长 25）；时间戳前缀 15 字符，比三位号前缀（4 字符）**多 11 字符**。

## 5. 排序：四层同时消失

| 层 | 位置 | 现状 | 新规则下 |
|---|---|---|---|
| 1 | `build.gradle.kts:351` `sortedBy { it.name }` → CHANGELOG 小节内顺序 | 字符串序；1000 排到 999 前（实测） | 定长时间戳 → **字符串序 = 时间序**，零改动、永远正确 |
| 2 | 目录列举（`git ls-files` / 排序工具） | 1000 排 999 前 | 定长 → 任何排序器都正确 |
| 3 | `create_new_feature.py:209` `_get_highest_from_specs()` | 扫本地目录取最大号 → 并行 PR 必撞 | 走 `--timestamp` 分支，取号逻辑不参与（脚本已内置排除 `^[0-9]{8}-[0-9]{6}-`） |
| 4 | 位宽 | 三位用尽即断 | 不存在 |

实测（定长时间戳，字典序 = 时间序）：

```
20261126-235959 < 20261127-000000 < 20261127-001234 < 20270101-000000
```

## 6. 边界与例外

| 情形 | 处理 |
|---|---|
| 同一秒内建两个目录 | 第二个加 `-2` 后缀（`-3`、`-4` 依次） |
| 跨时区贡献者 | 脚本用**本地时间**（`datetime.datetime.now()`，非 UTC）→ 极端情况下时间轴不严格对齐；规则接受这个误差（同仓库协作者的时区一致即可） |
| 本地时钟不准 | 顺序可能错位；影响仅限排序观感，不影响唯一性 |
| 一 spec 拆多个 PR（stacked） | 目录用**最早**那个 PR 号，其余在正文写「承接 #N」 |
| 一个 PR 含多个 spec | 目录用主题区分，号可以相同 |
| 没有 issue 的直投 PR | 用 PR 号作主号；目录名不受影响（R9 的时间戳与号无关） |
| 主题 slug 撞名 | 时间戳前缀已保证目录唯一；slug 相同不冲突 |

## 7. 存量边界与迁移

- **001–067 的 55 个目录名不动**，只读（068–070 无目录，只有碎片与真机留痕）。
- **历史提交不动**：`git log --grep 048` 仍命中历史提交；历史 commit message 里的批号不改写。
- **旧号 → 新号映射**（提交 `50c9d51`）：`048→060`、`049→061`、`050→062`、`051→063`、`052→064`、`053→065`、`054→066`、`055→067`、`056→068`、`057→069`、`058→070`。
- **唯一残留重号**：`005×2`（`005-message-copy-actions` / `005-message-queue`），历史遗留，不再新增。
- **有碎片无目录是合法的**：`061` `062` `063` `064` `066` `068` `069` `070` 只有 changelog 碎片与真机留痕，没有 spec 三件套——规则不要求每个批号都有目录。
- **旧碎片不删**。

## 8. 落地清单（执行步骤见 `specs/20261127-005429-spec-numbering/tasks.md`）

| # | 文件:位置 | 改动 |
|---|---|---|
| 1 | `.specify/memory/constitution.md:100` | 「`specs/NNN-name/spec.md`」→「`specs/<YYYYMMDD-HHMMSS>-<topic>/spec.md`」，并追加 R1–R12（本地生效，不进 git） |
| 2 | `docs/SPEC_NUMBERING.md`（本文档） | 新建——规则的唯一 tracked 副本 |
| 3 | `specs/README.md:6` | 「本目录下每个 `NNN-*`」→ 说明两种形态并存（存量 NNN / 新增时间戳）；表格加「立项时刻」列；补 §7 映射表；补「有碎片无目录」的 8 个号说明 |
| 4 | `changelog.d/README.md:9` | 「建议带规格号，如 `024-session-rename.added.md`」→「用 `<时间戳>-<主题>`，例 `20261127-003012-session-rename.added.md`」 |
| 5 | `.github/pull_request_template.md:9` | 同 4 改写 |
| 6 | `.specify/templates/spec-template.md:3`、`plan-template.md:3/5/50`、`tasks-template.md:8` | 占位符 `[###-feature-name]` → `[<YYYYMMDD-HHMMSS>-<topic>]` |
| 7 | `.specify/scripts/python/create_new_feature.py` | 把 `--timestamp` 设为默认（`--number` 保留为显式选项），避免维护者忘传参数退回取号逻辑 |
| 8 | `.github/ISSUE_TEMPLATE/`（新建 bug / feature，双语）、`CONTRIBUTING.md`（新建） | 贡献入口——比编号更卡的门槛 |
| 9 | `specs/0.5.11-run-report.md` | 确认与新规则无冲突（浏览器线留痕已按 060–070 组织） |

## 9. 接受的后果

- **「第 N 批」语义消失**：GitHub 号会被 PR 吃掉（现仓库 4 个号里 3 个是 PR），`#57` 不等于第 57 批。历史索引靠 `git log` + §7 映射表。
- **目录名变长**：平均 21.1 → 约 32 字符。
- **跨时区严格排序在极端情况错位**（脚本用本地时间）。
- **规则必须维护 tracked 副本**（本文档），否则改了别人看不到。
- **时间戳记的是立项时刻**，不是需求提出或完成时刻——语义要靠 R4 约定。

## 10. 怎么验证规则被遵守

```powershell
# 1) 新目录按时间序
git ls-files specs | Sort-Object

# 2) 碎片按时间序（定长时间戳 → 字符串序 = 时间序）
Get-ChildItem changelog.d -File | Select-Object -ExpandProperty Name | Sort-Object

# 3) 抽查任一新 spec：目录名符合 <8位>-<6位>-<slug>；spec.md 头部有 GitHub 号字段（若有）；
#    对应 changelog 碎片名前缀 = 目录前缀
```

CI 的 changelog job 已校验碎片名正则与「正好两行、中英各就各位」，**无需改动**。