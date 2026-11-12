# Feature Specification: 自动读取 IDE 运行/构建环境并注入 pi

**Feature Branch**: `release/0.5.8-20261112`

**Created**: 2026-11-12

**Status**: Approved（Q1–Q4 已拍板；Q5/Q6 按推荐默认，可随时推翻）

**Input**: 用户提出（2026-11-12）
> 自动读取IDE环境，运行环境构建环境之类的。
> 这一条不知道好不好实现，反正就是通过JetBrains的什么接口，如果能获取环境变量相关的信息就好了主要就是软件构建运行的环境。
> 至少要支持 IDEA、WebStorm、PyCharm 这三种，其他的你看着能支持就支持，可能暂时没有条件验证。
> 环境信息，看是不是能注入命令行的环境变量，还有系统提示词。

**可行性结论（取证后）**：**可做**。pi 侧两条注入通道都已实证存在，
其中「扩展动态注入系统提示词」优于 `--system-prompt`——**改环境不用重启 pi**。
真正的风险只有一处：**运行配置里的环境变量没有统一的公共 API**，硬取会撞 internal 红线。

## 问题陈述

### 现状

pi 以 `pi --mode rpc` 子进程运行，工作目录 = 项目根。它知道的东西：

| pi 已知 | 来源 |
|---|---|
| 项目根目录 | `pb.directory(File(cwd))`（`PiProcessManager.kt:129`） |
| PATH（含 node/nvm） | `OsProcess.augmentPathEnv`（`PiProcessManager.kt:131-135`） |
| 审批策略与 UI 语言 | `PI_APPROVE_POLICY` / `PI_APPROVE_LANG`（`:137-139`） |
| 模型 | `--provider` / `--model` |

它**不知道**：项目用的是哪个 JDK、Java 语言级别、Node 解释器、Python 虚拟环境、
Gradle/Maven 的 JDK、run configuration 里配的 `SPRING_PROFILES_ACTIVE` 之类。
于是会出现「IDE 里能跑、pi 的 bash 里跑不了」以及「pi 写代码时按错版本的语言特性、按错构建工具猜命令」。

### pi 侧能力（已实证，非推测）

1. **静态**：`pi --help` 有 `--system-prompt <text>` 与
   `--append-system-prompt <text>`（可多次，支持 text **或文件内容**）。
   插件已有先例：`TitleGenerator.kt:71` 用的就是 `--system-prompt`。
2. **动态（关键）**：扩展钩子 `before_agent_start` 的事件带 `systemPrompt: string[]`，
   handler 可返回 `systemPrompt?: string[]`：

   > `src/extensibility/extensions/types.ts:1141-1145`
   > `/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */`
   > `systemPrompt?: string[];`

   即**每一轮 agent 启动前都能重新决定系统提示词**。插件已有「写 JS 扩展 + `--extension` 注入」
   的成熟先例（`PiApprovalSupport.ensureExtensionInstalled()`、`PiModelReload`）。

### 插件侧挂载点（现成）

| 需求 | 现成位置 |
|---|---|
| 注入环境变量 | `PiProcessManager.start()` 的 `pb.environment()[...] = ...`（`:137-139`）；`OsProcess.augmentPathEnv`（`:258`）已有「只增不改」的写法 |
| 追加启动参数 | `PiStartArgs.build()`（`PiProcessManager.kt:40-59`），目前只拼 `--mode rpc` / `--provider` / `--model` / `--extension` / `--approve` |
| 下发 IDE 侧信息给前端 | `BridgeService` 的 `xxx.yyy` dispatch 表（约 40 个 method），如 `manage.envDetect` |

### IDE 侧 API 可行性：三档，风险递增

| 档 | 能拿到什么 | API | 判断 |
|---|---|---|---|
| **A 稳** | 项目 SDK 名称/版本、Java 语言级别、模块 SDK | `ProjectRootManager.getInstance(project).projectSdk`、`Sdk`、`LanguageLevelProjectExtension` | platform 公共 API，三款 IDE 都有 |
| **B 较稳** | shell 环境、终端实际 env | `org.jetbrains.plugins.terminal`（**已 optional depends**） | 已有依赖先例，缺插件时降级 |
| **C 有风险** | 各 run configuration 里的 env（`SPRING_PROFILES_ACTIVE`、`NODE_ENV`…） | `RunManager.allConfigurationsList` 可枚举，但**取 env 无统一公共 API**：`EnvironmentVariablesData` / `EnvironmentVariablesComponent` 属 execution 实现层，且各 run config 的 editor 组件结构互不相同 | **唯一真风险**：`verifyPlugin` 把 `INTERNAL_API_USAGES` 设为硬拒（`build.gradle.kts:408-409`），只能反射或放弃 |

语言专属 SDK 需要 optional depends，插件已有两个先例可照抄：

```xml
<depends optional="true" config-file="jcef-features.xml">com.intellij.modules.jcef</depends>
<depends optional="true" config-file="terminal-features.xml">org.jetbrains.plugins.terminal</depends>
```

→ Node（`NodeJsInterpreter`）走 JS 插件、Python（`PythonSdkUtil`）走 Python 插件，同样 optional；
IDEA 未装 JS 插件时该档自动缺席，不报错。

### 安全红线（必须写进设计）

环境变量里常有 `AWS_SECRET_ACCESS_KEY`、`GITHUB_TOKEN`、`*_PASSWORD` 这类凭据。
**整包 dump 进系统提示词 = 把密钥发给模型厂商**。必须白名单 + 名字级黑名单双重过滤，
且路径类信息按需裁剪（避免把用户目录全路径结构吐给模型）。

## User Scenarios & Testing

### US1 - IDEA 里问「怎么构建」(P1)

打开 Java/Maven 项目，问 pi「这个项目怎么打包」。pi 的系统提示词里已有
「项目 SDK = Oracle JDK 21、语言级别 = 21、构建工具 = Maven」，
回答直接对齐，而不是让用户自己补充或猜 JDK 8。

### US2 - WebStorm 里跑测试 (P1)

pi 的 bash 工具继承到 IDE 同款 Node 路径与 `NODE_ENV`，`npm test` 一次成功，
不再出现「command not found: node」或版本不对。

### US3 - PyCharm 里用 venv (P1)

pi 知道项目解释器是 `.venv/Scripts/python.exe`，给出的命令用 venv 里的 python，
而不是系统 python 装不上包。

### US4 - 环境变了立即生效 (P1)

用户在 IDE 里把项目 SDK 从 17 换成 21，回到 pi 再发消息，
系统提示词里的版本已经是 21——**无需重启 pi、无需手动刷新**。

### US5 - 缺插件/缺权限时降级不报错 (P1)

在只有 platform 的 IDE（如装了本插件但无 JS 插件的 IDEA）里，Node 档自动缺席，
其余档照常工作，界面不出现异常提示。

### US6 - 敏感变量不外泄 (P0)

环境里存在 `GITHUB_TOKEN=ghp_xxx` 时，它**不得**出现在系统提示词、日志、
或发给模型的内容里。

## Requirements

- **FR-001** 环境采集 MUST 按档降级：任一档不可用（无插件、无 SDK、API 不可达）时跳过该档，不得抛出可见错误。
- **FR-002** 支持矩阵 MUST 覆盖 **IDEA / WebStorm / PyCharm**；其他 IDE 走同一降级逻辑，不做特判。
- **FR-003** 采集结果 MUST 归一化为一份**纯文本环境快照**（人类可读 + 模型可读），不直接把 IDE 对象序列化。
- **FR-004** 系统提示词注入 MUST 采用**扩展动态注入**（`before_agent_start` → `systemPrompt`），
  使环境变化**无需重启 pi**（US4）；`--append-system-prompt` 仅作扩展不可用时的静态兜底。
- **FR-005** 环境变量注入 MUST 走 `pb.environment()` 的**差量补齐**，不得整体替换；
  插件自有变量 MUST 带 `PI_IDE_` 前缀以免与用户变量撞名。
- **FR-006** 敏感信息 MUST 经「白名单变量名 + 黑名单模式（token/secret/password/key/credential）」双重过滤后才可进入提示词或日志（US6）。
- **FR-007** 环境快照 MUST 标注**采集时间与来源档位**，让模型能判断信息新旧。
- **FR-008** 采集 MUST NOT 使用 internal API——`verifyPlugin` 的 `INTERNAL_API_USAGES` 为硬拒项。
  若某档只能靠 internal 拿到，该档 MUST 放弃（而不是反射绕过）。
- **FR-009** 采集 MUST 在后台线程执行，不得阻塞 EDT；耗时应可预期（不启动外部进程做探测）。
- **FR-010** 用户 MUST 能在设置里整体关闭该能力，关闭后 pi 收到的提示词与现状完全一致。

## Decisions（已拍板）

| # | 问题 | 决定 |
|---|---|---|
| Q1 | 采集范围 | **A + B** — 项目 SDK + 语言级别 + shell/终端实际环境；C 档本轮不做 |
| Q2 | run config 的 env | **本轮完全不碰** — 不反射、也不给手填入口。该能力成为明确记录在案的已知缺口，等 JetBrains 出公共 API 再议 |
| Q3 | 提示词注入 | **扩展动态注入** — `pi-ide-env` 扩展在 `before_agent_start` 读快照并替换 `systemPrompt`；`--append-system-prompt` 不进本轮 |
| Q4 | env 注入 pi 子进程 | **只注入白名单变量** — `JAVA_HOME`/`NODE_ENV`/`VIRTUAL_ENV`/`GRADLE_HOME`/`MAVEN_HOME`/`PATH` 等构建相关项，差量补齐 |
| Q5 | 提示词粒度 | **a + b**（默认）— 技术栈事实 + 常用命令建议；不做项目结构摘要（pi 自己会读） |
| Q6 | UI 可见性 | **b**（默认）— 设置页开关 + 「查看当前环境快照」只读入口，便于排障 |

### 已知缺口（Q2 的直接后果）

run configuration 里配的 `SPRING_PROFILES_ACTIVE`、`NODE_ENV`、`PYTHONPATH` 这类**项目专属变量拿不到**。
影响面：项目依赖「某个 run config 才能跑起来」时，pi 的 bash 命令仍需用户自己补变量。
缓解（不在本轮）：等 JetBrains 提供公共 API，或改为读用户显式维护的配置文件。

## 不做的事

- **不做凭据托管**：不读取 IDE 的 password safe，不碰任何账号密码。
- **不碰 run configuration 的 env**（Q2）：不反射、不给手填入口；该缺口见上文「已知缺口」。
- **不解析构建工具内部模型**：不通过 Gradle/Maven 的 IDE 模型推导依赖树——pi 自己会读 `build.gradle.kts`。
- **不持续轮询**：靠「每轮 agent start 重读快照」保证新鲜度，不装 timer。
- **不污染用户仓库**：快照写系统临时目录或 pi agent 目录，绝不写进项目（不生成 `.pi/env.md`）。
- **不做远端/容器内环境探测**（WSL、Docker、SSH remote 解释器）——本轮明确不支持，遇到时降级。

## 验证计划

实现后填写。

| 层 | 用例 | 期望 |
|---|---|---|
| 单测 | 快照生成器吃「假 SDK + 假语言级别」 | 输出固定文本，敏感变量被过滤 |
| 单测 | 敏感过滤 | `GITHUB_TOKEN`/`DB_PASSWORD` 不出现；`JAVA_HOME` 保留 |
| 单测 | 档位缺失 | 三档全空时输出「未检测到」而非抛异常 |
| 单测 | env 差量补齐 | 已有 PATH 不被覆盖，`PI_IDE_*` 前缀生效 |
| 真机 | IDEA：切项目 SDK 17→21 后发消息 | 提示词随之变化，pi 未重启 |
| 真机 | WebStorm：Node 解释器 | 提示词含 node 路径与版本 |
| 真机 | PyCharm：venv | 提示词含解释器路径 |
| 真机 | 三款 IDE 各 `verifyPlugin` | 无 internal API 命中，`sinceBuild=233` 兼容 |
