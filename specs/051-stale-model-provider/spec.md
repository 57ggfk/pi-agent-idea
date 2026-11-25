# Feature Specification: provider 被删后 pi 起不来（校验 + 兜底 + 病因上屏）

**Feature Branch**: `release/0.5.10`

**Created**: 2026-11-25

**Status**: 已实现（2026-11-25；T501–T508 见 [./tasks.md](./tasks.md)）

**Input**: 用户报障（2026-11-25）
> pi 已退出：pi process closed stdout (exit code 1)
> ```plaintext
> Error: Unknown provider "ds". Use --list-models to see available providers/models.
> ```
> 主机：LAPTOP-6GBMLO5GThinkBook 14 G6 IRL　项目：D:\code\fis\cmfc-fis

## 一、意图与边界

插件按项目记住上次用的 provider/model，启动时原样拼进 pi 的命令行
（`--provider X --model Y`）。provider 一旦从 `~/.pi/agent/models.json` 里被删掉，
这条记忆就变成陈旧的：pi 直接拒绝启动，面板对该项目彻底瘫痪。

期望：**pi 起不来时面板要说清病因、并且能自己爬起来**。

本规格锁四条边界：

1. **不改用户的模型选择**。provider 没了，只是不再把它传给 pi；存储里的偏好原样保留，provider 加回来就自动用回去。
2. **不误伤「存在但没登录」的 provider**。`openrouter` 没凭据时同样不在 `pi --list-models` 里，但它是**存在**的——按本地配置文件猜会悄悄改掉用户的模型选择。
3. **判定不出就不动**。探针失败（命令跑不起来、输出不是 JSON）一律按「还在」处理：宁可让 pi 自己报错，也不能因为一次探针失败就丢掉用户的模型。
4. **不改 pi 自身的行为**，只改插件怎么启动它、怎么把结果告诉用户。

## 二、根因与现状（读码 + 真机核实）

**根因**：`D:\code\fis\cmfc-fis\.idea\workspace.xml` 里存着
`dev.pi.agent.lastProvider = "ds"` / `lastModel = "deepseek-flash"`；
而 `~/.pi/agent/models.json` 现在的 provider 只有 `9router` 与 `api0-cn`
（`pi --list-models` 实测：`9router` / `api0-cn` / `ovo23`）。
`ds` 曾存在（备份 `models.json.bak-20261116-113251`：`baseUrl=https://api.deepseek.com/v1`、
唯一模型 `deepseek-flash`），11-16 11:32 起被删。偏好里的模型名与被删 provider 的
唯一模型逐字吻合 —— 这确实是那条 provider 的记忆。

**放大问题的三个缺口**（全部在插件侧）：

| # | 缺口 | 位置 | 后果 |
|---|---|---|---|
| 1 | 持久化偏好被当作可信输入，启动路径上从不做目录校验 | `PiProcessManager.kt:185` → `PiStartArgs.build` | provider 被改名/删除 → pi 拒绝启动 |
| 2 | 没有兜底：pi 拒绝启动 = 结束 | `PiProcessManager.kt` `onClosed` | 面板对该项目彻底瘫痪 |
| 3 | 面板只显示症状不显示病因 | 退出横幅只有「pi process closed stdout (exit code 1)」，真因折在「查看详情」里 | 用户得展开才知道自己该做什么 |

**用户无法自救**（真机截图核实）：

- 点「重启」→ `rpc.restart` → `PiProcessManager.restart()` → **用同一份陈旧偏好重新拼参数** → 再次失败；
- 面板内改不了偏好：写偏好的入口 `config.setLastModel` 只在 `setModel()` 里被调用，而 `setModel()` 要求 RPC 成功；
- 模型列表来自活着的 pi（`get_available_models`），pi 死了 → 选择器是空的。

于是最终变成一个只能报给开发者的 bug。

**连带症状**（同一次截图）：「会话切换失败」红条。目标会话文件是好的
（`~/.pi/agent/sessions/--D--code-fis-cmfc-fis--` 有 5 个会话），
失败原因是会话切换必须由活着的 pi 应答（`switch_session` RPC）——是派生症状，不是独立缺陷。

## 三、User Scenarios & Testing

### US1 - 启动前校验 (P1)

项目记住的 provider 已被删除时，pi 启动**不带** `--provider/--model`，面板正常起来，
并明确告诉用户「上次用的 provider 没了，已改用默认模型」。

### US2 - 不误伤没登录的 provider (P1)

provider 还在、只是没配凭据时，插件**照旧**把它传给 pi，让 pi 自己去报「没登录」——
用户的选择不被插件悄悄改掉。

### US3 - 兜底自愈 (P1)

校验与启动之间 provider 被删（竞态），或探针本身失败导致校验没拦住时，
pi 以 `Unknown provider` 退出 —— 插件自动去掉模型覆盖重启一次，面板不出现死循环。

### US4 - 病因上屏 (P1)

pi 以任何原因退出时，退出横幅的标题是 pi 自己的错误行（`Unknown provider "ds". …`），
而不是壳话「pi process closed stdout (exit code 1)」。

### US5 - 病因上屏不误伤 (P2)

stderr 里没有 `Error:` 行时，横幅维持原样（壳话 + 退出码），不显示空白。

### US6 - 告知要看得见 (P1)

「已改用默认模型」是一条**说明**而不是错误：pi 正常跑着，界面用提示色显示，
并写明是哪个 provider、哪个模型。

## 四、验收口径

| 项 | 判据 |
|---|---|
| provider 已删 | 启动不带 `--provider/--model`；面板出现提示条，含 provider 名与模型名 |
| provider 存在但没凭据 | 仍然带 `--provider/--model` 启动（偏好不被改） |
| 探针失败 | 仍然带 `--provider/--model` 启动（fail open） |
| pi 拒绝 provider | 自动重启一次（不带模型覆盖）；不出现第二块退出横幅 |
| 其它退出原因 | 横幅标题含 pi 的错误行；stderr 仍在折叠详情里 |
| 偏好不被销毁 | provider 加回来后，下次启动自动用回原模型 |

## 五、非目标

- **不改 pi 自身的启动参数语义**（`--provider/--model` 的含义不变）。
- **不做 provider 目录管理界面**：删除 provider 由用户自己在 `models.json` 里做，插件只负责不把它当成故障。
- **不自动迁移/猜测 provider**：不猜「`ds` 是不是 `deepseek` 官方那个」。
- **不把 `credentials_not_configured` 也当成故障**：那属于凭据问题，用户要去登录，不是插件能修的。
