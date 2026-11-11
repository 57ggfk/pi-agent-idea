# Feature Specification: 在插件里新建自定义 Provider（API 格式 + URL + 思考/图片/思考级别）

**Feature Branch**: `release/0.5.8`

**Created**: 2026-11-12

**Status**: Draft

**Input**: 用户需求（2026-11-12）
> 自定义 Provider，选 API 格式，设置 URL，参考 cc-switch 的实现。

澄清（2026-11-12 追问的回答）
> 包括是否支持思考，是否支持图片，设置思考级别。参考 cc-switch 对 pi 的配置。

**难度定位**：中。纯「写一份 JSON」不难，难在**字段语义要与 pi 的 schema 逐字对齐**、
**不能覆盖内置 provider**、**密钥不出桥**，以及保存后要能立即用上（复用 017 的进程内 refresh）。

## 问题陈述

### 现状：能填 key，但没地方「定义」provider

- `manage.authSet` / `manage.providerSetKey`（`PiCredentials.kt:41,55`）只能写**已有** provider 的凭据；
  若 provider 不在 `models.json` 里，`providerSetKey` 直接报错「add it in the editor first」。
- `ProviderForm.tsx` 是 012 US5/US6 的产物，字段只有「provider 选择 + 账号登录 / API Key」，
  **Base URL、API 格式、模型列表一个都没有**。
- 用户当前的唯一办法是手改 `~/.pi/agent/models.json`——需要同时写对 provider 段和 models 数组，
  正是 cc-switch 要替用户省掉的那件事。

### pi 侧的 schema（已核对 `@earendil-works/pi-coding-agent@1.5.0`）

`models.json` 顶层 `providers` 是名字到 provider 的映射，每个 provider（`ProviderConfigSchema`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string? | 显示名 |
| `baseUrl` | string? | 端点根，例如 `https://api.deepseek.com` |
| `apiKey` | string? | 明文密钥（也可放 auth.json，见下） |
| `api` | string? | **API 格式**，provider 级默认值 |
| `headers` | {string:string}? | 额外请求头 |
| `compat` | object? | `thinkingFormat`（deepseek/qwen/zai/openai…）、`maxTokensField` 等兼容开关 |
| `models` | array? | 模型定义数组，每项必须有 `id` |

`models[]` 单项（`ModelDefinitionSchema`）关键字段：
`id`（必填）、`name`、`api`、`baseUrl`、`reasoning`（**是否支持思考**）、
`thinkingLevelMap`（**思考级别支持表**）、`input: ["text"|"image"]`（**是否支持图片**）、
`contextWindow`、`maxTokens`、`cost`、`headers`、`compat`。

**`api` 的实测枚举**（bundle 内出现频次 446/746/159/41）：
`anthropic-messages`、`openai-completions`、`openai-responses`、`google-generative-ai`。

**思考级别的语义**：`THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`（`virtual-models.js:6`），
`thinkingLevelMap[level]` 的值为「该级别要发给供应商的字符串」，**`null` = 该级别不支持**。
pi 自己的构造代码就是 `map[level] = levels.includes(level) ? level : null`（`virtual-models.js:67-77`），
所以 UI 只需要让用户勾「这个模型支持哪些级别」，映射表由插件生成。

**pi 不会自动拉取远端模型列表**（bundle 内无 `/models` 发现逻辑），模型 ID 必须由用户填写或批量粘贴。

### 与既有决策的关系

`specs/README.md` 的「未纳入本批」曾写「不做表单式编辑 models.json」。本条需求**明确推翻该决策**，
但推翻范围仅限「自定义 provider 的定义（provider 段 + 其 models 数组）」，
**仍然不做**通用 models.json 编辑器（不碰 pi 内置 provider 的模型目录 `models-store.json`）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 三步建好一个自定义 Provider (Priority: P1)

用户在 Auth 面板点「新建自定义 Provider」，填：名称 → 选 API 格式 → 填 Base URL / API Key → 填模型 ID（一行一个）。
点保存后：`models.json` 里出现该 provider；模型选择器**无需重启**立刻能看到这些模型；可以选中并发一条消息成功。

**Why this priority**: 这是需求本体，也是「换第三方中转站」这个高频场景的完整闭环。

**Independent Test**: 走完表单 → mock 记录 `manage.providerSave` 参数 → 断言写盘 JSON 与表单逐字段一致
→ 断言触发了 `/pi-agent-reload-models`（017 的通路）→ 断言 model picker 出现新模型。

### User Story 2 - 勾选「支持思考 / 支持图片 / 支持级别」写出正确的模型定义 (Priority: P1)

用户勾「支持思考」并只选 `low/medium/high`：写出的模型是 `reasoning: true`、
`thinkingLevelMap = {off:null, minimal:null, low:"low", medium:"medium", high:"high", xhigh:null, max:null}`。
勾「支持图片」→ `input: ["text","image"]`，不勾 → `["text"]`。
思考级别一个都不选（或只选 off）→ `reasoning: false`，不写空的映射表。

**Why this priority**: 这三个字段是用户这次点名的；写错会导致「模型能用但一开思考就报 400」这种难查的故障。

**Independent Test**: 三组勾选组合各保存一次，逐字断言写盘 JSON（纯函数 level→map 单测 + 一次集成）。

### User Story 3 - 不覆盖内置 Provider，不破坏已有配置 (Priority: P1)

用户在 `models.json` 里已手工配了别的 provider（含注释性字段、`compat`、`cost` 等插件不认识的东西）：
新建/编辑一个自定义 provider 后，**其余 provider 段逐字保留**（键序尽量保留），文件仍能通过 `pi` 的 JSON 解析。
若名称与 pi 内置 provider（如 `openai`、`anthropic`、`openrouter`）重名，默认**拒绝**并提示，除非用户显式确认覆盖。

**Why this priority**: 写坏 models.json 会一次性废掉用户全部模型配置，比功能缺失严重得多。

**Independent Test**: 预置一份含 3 个 provider 的 models.json（含未知字段）→ 新增第 4 个 → 断言前 3 个逐字未变；
重名用例断言被拒 + 文件未被改动。

### User Story 4 - 编辑与删除自定义 Provider (Priority: P2)

列表里自定义 provider 有编辑（回填表单，密钥显示为掩码/留空表示不改）与删除（走 007 的确认框）入口；
内置 provider 无删除入口。

**Independent Test**: 编辑时把 Base URL 改掉 → 其余字段不变、apiKey 未被写成空；
删除 → `providers.<name>` 消失、其它段不变、模型选择器里该 provider 消失。

### User Story 5 - 保存前后给一次可验证的反馈 (Priority: P2)

保存后给一条结果：写盘成功 / 写盘失败（含定位到行的错误）；「测试连通」可选地发一次最小请求，
成功显示状态码与耗时，失败显示错误原文（不吞、不伪装成功）。

**Independent Test**: 注入 401 与超时两种响应，断言分别显示为失败且文案不同。

## Requirements *(mandatory)*

- **FR-001** 表单字段 MUST 包含：provider 名（`[a-z0-9-_.]`，唯一，非空）、显示名（可选）、
  **API 格式**（4 选 1，必填）、Base URL（必填，校验 scheme）、API Key（password 输入）、
  模型列表（每个模型：ID 必填、显示名可选、`supportThinking`、`inputImage`、可选 `contextWindow`/`maxTokens`）。
- **FR-002** 「支持思考」勾选后 MUST 展开 7 个级别（off/minimal/low/medium/high/xhigh/max），
  默认勾 `low/medium/high`；生成的 `thinkingLevelMap` 按「勾=同名串，未勾=null」；
  仅 off 或全不勾 → `reasoning: false` 且**不写** `thinkingLevelMap`。
- **FR-003** `inputImage` MUST 决定 `input` 数组（`["text","image"]` / `["text"]`）。
- **FR-004** 写入 MUST 是「读-改-写」的原子操作：保留未知字段、保留其余 provider、写前备份（`models.json.bak-<ts>`）、
  写失败不留下半截文件。校验失败 MUST NOT 落盘。
- **FR-005** 名称与**内置 provider** 重名时 MUST 拒绝，除非用户二次确认（确认后仍需保留原 `models` 之外字段）。
- **FR-006** 保存成功后 MUST 触发 017 的模型热重载通路（`/pi-agent-reload-models`），使选择器立即可见；
  重载失败 MUST 提示「已保存，重启工具窗后生效」，不得回滚文件。
- **FR-007** 凭据 MUST NOT 回传 web：`manage.providerGet` 只回 `hasKey: true` 与掩码，编辑时不说清空就不动 `apiKey`；
  `manage.authOverview` 等既有脱敏口径不变。
- **FR-008** 新增桥接 MUST 四处同步（`bridge/types.ts` → `manage.ts` → `BridgeService.kt` 分发表 → `bridge/mock.ts`），
  暂定 `manage.providerGet` / `manage.providerSave` / `manage.providerDelete` / `manage.providerTest`。
- **FR-009** 表单与安装引导的 provider 步骤（012 US5）MUST 共用同一组件，不出现两套校验与两套文案。

## 验收口径

| 项 | 判据 |
|---|---|
| 写盘形状 | 4 种 api 格式各保存一次，JSON 里 `providers.<n>.api` 逐字一致；模型 `id/name/reasoning/input/thinkingLevelMap` 与勾选一一对应 |
| 思考映射 | 勾 `low/medium/high` → 三个值为同名串、其余为 `null`；单测覆盖 7 级 × 3 组合 |
| 不炸既有配置 | 预置含未知字段的 3 provider 文件，新增后前三段 `JSON.stringify` 逐字相同 |
| 重名保护 | 与 `openai` 重名 → 拒绝；文件 mtime 未变 |
| 立即生效 | 保存后 `--list-models` 等价的刷新被触发，picker 里出现新模型（mock） |
| 密钥不回传 | `providerGet` 响应、DOM、日志中无 `apiKey` 明文 |

## 非目标

- 不做通用 models.json 编辑器（不编辑 pi 内置 provider 的目录、不改 `models-store.json`）。
- 不做从远端 `/v1/models` 自动发现模型列表（pi 本身没有该能力，先按手填/批量粘贴）。
- 不做 OAuth（014 已覆盖账号登录；本条只处理 API Key 型第三方端点）。
- 不做「按模型分别设 cost/tiers/compat 的高级编辑」——高级字段仍可手改文件，表单只保证生成的 JSON 合法且不被覆盖。

## 待确认 / 已知风险

- **Q1「测试连通」怎么测**：pi 没有探活 RPC。建议插件侧直接对 `${baseUrl}/models` 发一次带 key 的 GET
  （4 种格式里 3 种有等价端点，`anthropic-messages` 用 `/v1/models`），失败不阻塞保存。
  若用户希望完全不发请求，则「测试连通」改为「保存并试发一条」的可选项。
- **Q2 `compat.thinkingFormat` 是否要暴露**：第三方中转站常见需要 `deepseek`/`qwen`/`zai` 之类，
  但用户这次没提；本轮默认**不暴露**，仅当 api 格式为 `openai-completions` 且勾了思考时，
  在高级折叠区提供一个下拉（默认空 = 不写）。
- 键序无法用 `kotlinx.serialization` 的 JsonObject 稳定保留（会保留但可能与原文不同）；若「逐字保留」在真机上不成立，
  验收口径降为「语义等价 + 未知字段不丢」。
