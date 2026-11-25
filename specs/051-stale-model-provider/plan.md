# Implementation Plan: provider 被删后 pi 起不来

**Feature Branch**: `release/0.5.10`
**Spec**: [./spec.md](./spec.md)
**Created**: 2026-11-25

## 一、判据从哪来（本题的关键）

要判断「上次记住的 provider 还在吗」，有三个候选口径：

| 口径 | 能不能区分「provider 没了」与「provider 在但没登录」 | 判定 |
|---|---|---|
| 读 `~/.pi/agent/models.json` 的 providers 键 | **不能**。内置 provider（anthropic/openai/openrouter/deepseek/xiaomi…）根本不在这个文件里 | ✗ |
| `pi --list-models` | **不能**。它只列「当前可用」的 provider：实测本机只列出 `9router`/`api0-cn`/`ovo23`，而没凭据的 `openrouter`/`deepseek` 不在其中 | ✗ |
| `pi auth check --provider X --json` | **能**。见下 | ✓ |

`pi auth check` 的三种回答（实测，pi 1.6.0）：

```json
{"status":"ready","provider":"9router","authType":"api_key"}                    exit 0
{"status":"not_ready","provider":"ds","reason":"provider_not_found"}            exit 1
{"status":"not_ready","provider":"openrouter","reason":"credentials_not_configured"} exit 1
```

于是口径定死：

- `provider_not_found` → **GONE**：provider 没了 → 不带它启动；
- `credentials_not_configured` → **USABLE**：provider 还在，只是没登录 → **照旧传**；
- `ready` → **USABLE**；
- 探针失败 / 输出读不懂 → **UNKNOWN**：按「还在」处理（fail open）。

实测开销：`pi auth check` 约 850ms（node 启动开销），`pi --list-models` 约 1.5s。
所以选 `auth check`，并给结果加 5 分钟缓存。

## 二、改动落点

### 1. 校验（Kotlin，新增 `PiModelPreflight.kt`）

```kotlin
internal object PiModelPreflight {
    enum class Verdict { USABLE, GONE, UNKNOWN }
    fun probe(provider: String): Verdict        // 跑 pi auth check，带 5 分钟缓存
    internal fun classify(output: String): Verdict   // 纯函数，可单测
}
```

`classify` 从 pi 的输出里**抠出** JSON 再解析（pi 可能在前后打印别的东西）；
读不出来一律 `UNKNOWN`。

### 2. 启动路径（`PiProcessManager.start()`）

```kotlin
val stored = prefs.get()
var model = stored
var notice: PiNotice? = null
if (stored != null) {
    when {
        prefs.blockedProvider() == stored.first -> { model = null; notice = … }
        PiModelPreflight.probe(stored.first) == GONE -> {
            prefs.blockProvider(stored.first); model = null; notice = …
        }
        else -> Unit
    }
}
```

**偏好不删**：`PiModelPreferences` 里存的那份原样留着，插件只是不再把它传给 pi。
被拒过的 provider 记在 `PiModelPreferences.blockedProvider`（**内存态**，不落盘），
5 分钟后自动失效 —— provider 加回来就会被认回去。

`PiModelPreferences.set()`（用户自己选模型）会清掉这个封禁。

### 3. 兜底（`PiProcessManager.onClosed`）

pi 退出时从 stderr 里读 provider 名（`unknownProviderInStderr`）：
读到且本槽位还没恢复过 → 封禁该 provider → **去掉模型覆盖重启一次**。

- 闸门 `slot.modelRecoveryAttempted`：没有它，pi 会「退出 → 被拉起 → 再退出」地循环；
- 重启跑在独立线程上：`onClosed` 是 pi 的 RPC 读线程回调，`start()` 会拿 manager
  与 slot 两把锁，从回调里重入等于自己等自己；
- 清死掉的 client 必须在 `synchronized(slot)` 里做：第一次 `start()` 可能还没把
  client 装上去，清早了等于什么都没清。

### 4. 病因上屏（`PiExitDiagnostics.kt` + 桥接 + 前端）

- Kotlin：从 stderr 里取第一行 `Error:` 的正文（`exitCause`），随
  `PiConnectionState.Exited.cause` 走；
- 桥接：`pi-state` 事件多带 `cause` 与 `notice` 两个字段；
- 前端：标题用 `cause || message`（病因优先，壳话退居其次）；`notice` 渲染成
  状态栏上方的**提示条**（`--warning-*` 配色，不是错误红）。

## 三、为什么不选别的做法

| 备选 | 不选的原因 |
|---|---|
| 启动前直接删掉失效的偏好 | 用户把 provider 加回来后要重新选一次模型；规格 US1 要求「偏好不销毁」 |
| 用 `pi --list-models` 当判据 | 列的是「当前可用」的 provider，没凭据的内置 provider 会被误判成没了（见第一节） |
| 只做兜底、不做校验 | 校验能把「失败一次再恢复」变成「一次就起来」，用户看不到中间态 |
| 校验失败就删偏好 | 探针失败 ≠ provider 没了；删掉就是替用户改设置 |
| 把 provider 名翻译成中文再显示 | provider 名是用户要去 `models.json` 里查的字面量，翻译反而让他找不到 |

## 四、风险与已知代价

1. **首次启动多一次 node 进程**（约 850ms）：只在「项目记住了模型」时发生，
   且结果缓存 5 分钟。判定为可接受 —— 比让面板起不来便宜得多。
2. **`pi auth check` 在旧版 pi 上不存在**：探针失败 → `UNKNOWN` → fail open，
   行为与今天一致（由兜底接手）。`pi auth check` 自 pi 1.x 起存在。
3. **`pi-state` 协议多了两个字段**：前端按可选字段处理，旧前端收到新字段会忽略；
   新前端收到旧桥接（无 `cause`）时退回壳话，行为与今天一致。
4. **记忆体状态**：`blockedProvider` 不落盘，重启 IDE 后要重新判定一次（~850ms）。

## 五、验证方式

- Kotlin 单测：`PiModelPreflightTest`（五种判定）、`ExitCauseTest`（病因与 provider 名提取）；
- 前端单测：`web/src/store/pi-state.test.ts`（病因优先、notice 传递与清除）；
- e2e：`web/e2e/stale-model-provider.spec.ts`（横幅标题、提示条、中文界面）；
- 真机：装包后在 cmfc-fis 上复现原故障——把 `models.json` 里的 provider 临时删掉，
  面板应当直接起来并显示提示条。
