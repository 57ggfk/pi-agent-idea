# Contributing · 贡献指南

> 感谢你愿意给 Pi Agent for JetBrains 提 PR。这份文档只讲两件事：**怎么开始**、**交之前要过什么**。
> 规则全文见 [docs/SPEC_NUMBERING.md](docs/SPEC_NUMBERING.md)，约束基准见 [`.specify/memory/constitution.md`](.specify/memory/constitution.md)。

## 两条路径 · Two paths

| 你要做的事 | 走哪条 | 需要准备 |
|---|---|---|
| 修 bug、加一个小功能 | **直接开 PR** | 一条 changelog 碎片 + 测试。**不需要**写 spec，**不需要**抢编号 |
| 有设计取舍的大功能 | **先开 issue 讨论** | issue →（需要时）spec 三件套 → PR |

> Small fixes go straight to a PR — one changelog fragment plus tests. No spec, no number to claim.
> Big features start with an issue, so the design can be agreed on before anyone writes code.

## 开工前 · Before you start

1. **先搜 issue** —— 可能已经有人在做，避免重复劳动。
2. **不要抢编号**：spec 目录名用 `<时间戳>-<主题>`，例如 `20261127-005429-csv-table`。
   时间戳就是你开工的时刻，**不需要问任何人要号**。
3. **改动放自己的分支**：`feat/<主题>` 或 `fix/<主题>`。

## 目录与文件名 · Naming

| 你要建的 | 命名 | 例 |
|---|---|---|
| spec 目录 | `<YYYYMMDD-HHMMSS>-<主题 slug>` | `specs/20261127-005429-csv-table/` |
| 主题 slug | 小写英文 + 连字符，2–3 个词 | `csv-table` |
| changelog 碎片 | `<时间戳>-<主题>.<added\|changed\|fixed>.md` | `changelog.d/20261127-005429-csv-table.added.md` |
| 分支 | `feat/<主题>` / `fix/<主题>` | `feat/csv-table` |

- **编号不进任何文件名。** GitHub issue / PR 号写在 spec 头部的 `GitHub Issue:` 字段里，
  正文按 GitHub 原生写法写 `#N` —— 文件名里连 `#` 都不能带（Markdown 会把它当 fragment，链接会静默失效）。
- 引用的是**上游仓库** `57ggfk/pi-agent-idea` 的号：fork 的 issue 计数会重排，fork 里的 #3 不是上游的 #3。

## 提交信息 · Commit messages

```
feat(web): 渲染 CSV/TSV 为表格 (#42)
fix: provider 被删后面板不再瘫痪 (#43)
```

不带内部编号；引用 issue 用 GitHub 原生 `(#N)`，合并时自动 close。

## 交之前 · Before you push

- [ ] `./gradlew build` 通过
- [ ] 前端改动：`cd web && npm test`、`npx playwright test` 通过
- [ ] 交互改动补了**真点击**的 e2e（`toHaveCount` / `toBeVisible` 抓不到裁切类回归）
- [ ] 有用户可见变化 → 在 `changelog.d/` 建了碎片（文件名见上表；**正好两行**，中文在前英文在后）
- [ ] 没有用户可见变化 → 在 PR 里写明「无用户可见变化」及原因

## 什么时候才需要写 spec

只有**有设计取舍**的功能才需要 spec 三件套（`spec.md` / `plan.md` / `tasks.md`）。
小改动请不要为了凑格式写文档 —— 你的时间比格式值钱。

## 真机验收 · Real-machine verification

IDE 侧扩展点注册、右键菜单可用性、JCEF 渲染差异**只能真机确认**，自动化断言覆盖不到。
维护者会安排真机验证轮；你手边有环境的话，欢迎在 PR 里附上验证记录（机器、IDE 版本、截图）。
