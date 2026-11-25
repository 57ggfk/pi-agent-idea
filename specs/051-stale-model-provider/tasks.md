# Tasks: provider 被删后 pi 起不来

**Feature Branch**: `release/0.5.10`
**Spec**: [./spec.md](./spec.md)　**Plan**: [./plan.md](./plan.md)
**Created**: 2026-11-25

## 任务清单

### T501 - 判定器：provider 还在吗

新增 `src/main/kotlin/dev/pi/agent/process/PiModelPreflight.kt`：
`Verdict { USABLE, GONE, UNKNOWN }` + `probe()`（跑 `pi auth check --provider X --json
--no-refresh`，结果缓存 5 分钟）+ 纯函数 `classify(output)`。

**— 验证**：`PiModelPreflightTest` 5 条 —— `provider_not_found` → GONE；
`credentials_not_configured` → USABLE；`ready` → USABLE；输出读不懂（空串 /
非 JSON / node 报错）→ UNKNOWN；JSON 前后有噪声仍能读出判定。
先 RED（`Unresolved reference 'PiModelPreflight'`）后 GREEN。

### T502 - 启动前校验

`PiProcessManager.start()`：记住的 provider 被判定 GONE 时，启动**不带**
`--provider/--model`，并把 `PiNotice("staleModel", provider, model)` 挂到
`PiConnectionState.Running` 上。

`PiModelPreferences` 新增内存态的 `blockedProvider()` / `blockProvider()`
（5 分钟失效；`set()` 会清掉）——**存储里的偏好一律不删**。

**— 验证**：`./gradlew test` 绿；真机：把 `models.json` 里的 provider 删掉后重启，
面板直接起来并显示提示条，`workspace.xml` 里的 `lastProvider` 仍在（偏好没被销毁）。

### T503 - 兜底自愈

`PiProcessManager.onClosed`：stderr 里读出被拒的 provider（`unknownProviderInStderr`）
且本槽位还没恢复过 → 封禁该 provider → 去掉模型覆盖重启一次。
闸门 `slot.modelRecoveryAttempted` 防循环；重启走独立线程（`onClosed` 是 RPC 读线程）。

**— 验证**：`ExitCauseTest` 断言 provider 名能从 stderr 里读出；真机：校验与启动之间
删掉 provider（或让探针失败），面板应当自己起来，不出现第二块退出横幅。

### T504 - 病因提取

新增 `src/main/kotlin/dev/pi/agent/process/PiExitDiagnostics.kt`：
`exitCause(stderr)`（第一行 `Error:` 的正文）与 `unknownProviderInStderr(stderr)`。
`PiConnectionState.Exited` 增加 `cause` 字段。

**— 验证**：`ExitCauseTest` 6 条 —— 首行错误成为病因；调用栈不成为病因；
没有错误行时为 null；从 stderr 里读出 provider 名；别的错误读不出 provider。

### T505 - 通知通道与提示条

桥接 `pi-state` 事件多带 `cause` 与 `notice`；前端 store 存 `piNotice`、
标题改用 `cause || message`；`StatusBar.tsx` 渲染 `.notice-banner`（提示色，非错误色）。

**— 验证**：`web/src/store/pi-state.test.ts` 5 条（病因优先、无病因退回壳话、
notice 传递、后来的状态没有 notice 时清空、初始为 null）；
`web/e2e/stale-model-provider.spec.ts` 5 条（标题是病因、提示条含 provider 与模型名、
中文界面、无提示时不渲染提示条、真实 pi-state 事件通路）。

### T506 - 文案本地化

`status.staleModel`（zh/en 各一条）——写明是哪个 provider、哪个模型，
并说清「已改用默认模型启动」，避免用户以为模型被插件弄丢了。

**— 验证**：e2e 中文用例断言提示条含 `ds`、不含 `staleModel` 这类内部标识。

### T507 - changelog 碎片

`changelog.d/051-stale-model-provider.fixed.md`（两行：中文 + 英文，无中文进第二行）。

**— 验证**：CI 的 changelog 校验规则（文件名形如 `<slug>.fixed.md`、
正好两行非空、第一行含中文、第二行不含中文）。

### T508 - 全量基线

**— 验证**：`./gradlew test`（Kotlin 全绿）、`npx vitest run`（前端全绿）、
`npm run typecheck`（0 错）、`npx playwright test`（e2e 全绿）。

## 实现记录（2026-11-25）

- **判据的选择是本题的核心**：`pi --list-models` 与 `models.json` 都分不开
  「provider 没了」与「provider 在但没登录」，只有 `pi auth check` 能分
  （`provider_not_found` vs `credentials_not_configured`）。详见 plan 第一节。
- **偏好不销毁**：provider 没了只是不再传给 pi，存储里那份留着；
  被拒的 provider 记在内存里（`PiModelPreferences.blockedProvider`，5 分钟失效），
  用户把它加回 `models.json` 后会自动用回去。
- **fail open**：探针失败一律按「还在」处理 —— 宁可让 pi 自己报错，
  也不能因为一次探针失败就替用户改掉模型选择。
- **兜底线程**：`onClosed` 是 pi 的 RPC 读线程回调，`start()` 拿 manager 与 slot
  两把锁，从回调里重入等于自己等自己 —— 恢复跑在独立线程上，且死掉的 client
  必须在 `synchronized(slot)` 里清（第一次 `start()` 可能还没把 client 装上去）。
- **缓存失效**：插件自己的 provider 保存/删除会写 `models.json`，目录变了 →
  `PiModelPreflight.invalidate()` 清掉缓存（否则最长 5 分钟内还在用旧判定）。
- **mock 同步**：`?pistate=notice` / `?pistate=exited` 两个新夹具让 e2e 走
  真实事件通路（桥接事件 → store → 屏幕），而不只是直接改 store 状态。
