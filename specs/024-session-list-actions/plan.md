# 024 会话列表行内动作重排 — 技术方案

> 依据 spec.md（2026-11-12）与 2026-11-12 代码复核 + T001 探针实测。

## 0. T001 探针结论（2026-11-12 凌晨，pi 1.5.0，本机实测）

三组探针（隔离输出目录 + 旧探针会话做源，auth.json md5 前后对比）：

| # | 问题 | 答案 | 证据 |
|---|---|---|---|
| P1 | `pi --fork <path>` 产出什么 | 新 jsonl：完整复制源条目、新 id、首行带 `parentSession` 指回源文件、`cwd`=**进程 cwd** | `/tmp/pi-fork-out/*.jsonl` 6 行→6 行逐条复制 |
| P2 | 进程会不会自己退出 | **`--mode rpc` + stdin EOF → fork 完成后自行退出（exit 0）**，无 TUI、无模型调用；直接 `pi --fork` 会进 TUI 且 stdin EOF 时触发一次模型调用（402 错误、不写入文件） | `/tmp/pi-fork-rpc.log` 空、exit=0 |
| P3 | 落到哪个目录 | 尊重 `PI_CODING_AGENT_SESSION_DIR` / `--session-dir`（精确目录，不按 cwd 编码）；不给则按进程 cwd 的编码目录 | 探针 B/C 落盘位置 |
| P4 | 是否碰 auth 锁 | **不碰**：auth.json md5 前后一致 | md5 对比 |
| P5 | 名字继承 | 父会话的 `session_info` 条目**原样复制**进新文件（含 name） | 探针 C：`Probe Parent Name` 出现在 fork 产物 |
| P6 | 与插件列表的关系 | 插件 `sessions.list` 是**递归扫 sessions root + 按 header.cwd 过滤**（`PiSessionIndex.list`），不看子目录名 → 进程 cwd 设为项目根即可出现在列表 | `PiSessionIndex.kt:71-90` |

**方案 A 成立**，且比 spec 预想的更干净：spawn 形态固定为
`pi --mode rpc --fork <file>`（stdin 立即 EOF，进程 fork 完自己退），**无需 poll/kill**，
30s 超时兜底仍保留（FR-006）。

## 1. Kotlin 侧：新桥接 `sessions.fork`（四处同步之一）

- `BridgeService.dispatch` 增 `"sessions.fork" -> sessionsFork(params)`（紧挨 sessions.rename）。
- `sessionsFork(params: JsonObject)`：
  1. `file` 必填；路径必须在 sessions root 内（复用 `deleteSessionFile` 的「refusing to touch」口径，
     新增 `PiSessionIndex.requireInsideRoot(path)` 或复用现有私有校验的公开包装）。
  2. 记录 fork 前 root 下全部 jsonl 文件名集合（`root.walkTopDown()`，与 list 同源）。
  3. `PiCliRunner.run(args = ["--mode", "rpc", "--fork", file], timeoutSeconds = 30, stdinText = "",
     workingDir = File(project.basePath))`——stdinText 传空串使 `stream.use{}` 关流 → EOF → 进程自行退出
     （探针 P2）；workingDir=项目根决定 header.cwd（P1/P6）。
  4. 结果扫描 `PiSessionIndex.findNewFork(sourceFile, before)`：root 递归找 `!before.contains(path)` 且
     `header.parentSession == sourceFile` 的文件（header 解析复用现有私有 `header()`，同文件内新增公开函数）。
     找不到 → 抛 `IllegalStateException("pi --fork produced no session (exit=<n>): <stderr 摘要>")`。
  5. 响应 `{ ok: true, file: <新文件> }`——**不回传任何凭据**（FR-008；本响应天然只有路径）。
- 可测性拆分：args 构造为纯函数 `forkArgs(file)`（Kotlin 单测断言参数含 `--mode rpc --fork <file>`）；
  `findNewFork` 用临时目录造 before/after 夹具直测；进程链路由真机冒烟覆盖。

## 2. Web 侧

### 2.1 store.ts

- **`copySessionInfo(file)`（US1，新 action）**：行数据 `s = sessions.find(f => f.file === file)`；
  `title = s.name || s.preview?.slice(0,60) || s.id || "Untitled"`（与行内显示同源，FR-001）；
  文本 = `s.id ? `${title}\n${s.id}` : title`；`copyText()`（FR-002）成功 → `sessionsNotice(info, "已复制标题和 ID")`；
  缺 id → 复制仅标题 + notice(error,「该会话没有 ID」)；复制失败 → notice(error)。
- **`sessionsNotice: { text: string; kind: "info" | "error" } | null`**（新 state）：会话列表页的瞬时提示
  （聊天区 error 条目在 sessions 页签不可见——026 同款教训）；store 内 `setTimeout(4000)` 自动清空。
- **`forkSessionFromList(file)`（US2/US3，替换 `cloneSession`）**：
  - 单飞闸（FR-007）：`forkingFile: string | null` 新 state。已存在时：同 file 点击直接吞掉；
    不同 file 点击 → notice(error,「另一个 fork 正在进行」) 并 return（按钮不禁用）。
  - **当前会话**（`file === sessions.find(s => s.id === sessionId)?.file`）：RPC `clone`
    **不带 `sessionPath`**（FR-004，无效参数是错行根因）→ `syncAfterBranch()` → `applyForkSuffix()`
    （018 规则补齐——旧列表 clone 从不打后缀）。
  - **非当前会话**：`bridge.request("sessions.fork", { file }, 30_000)`（显式桥接超时，FR-006）→
    响应 `newFile` → 若源行 `s.name` 非空：`bridge.request("sessions.rename", { file: newFile,
    name: `${s.name}${t("session.forkSuffix")}` })`（018 后缀规则；pi 自身已继承父名，rename 追加后缀）→
    `refreshSessions()`。**全程不发 `switch_session`**，当前会话/草稿/流式零影响（FR-005）。
  - 失败：notice(error, msg)、`forkingFile = null`、`refreshSessions()`（列表条数不变，US3）。
- 删除 `cloneSession` action 与 `sessions.cloneTitle` 相关文案（e2e 同步改名，不留别名）。

### 2.2 SessionsView.tsx

- 行内动作变为 5 个：重命名、**复制**（`data-testid="session-copy"`、copy 图标、
  `sessions.copyTitle`）、**Fork**（`data-testid="session-fork"`、fork 图标、`sessions.forkTitle`、
  busy 时 `aria-busy` + 行内 spinner 类）、导出、删除（重排仅此一处，其余不动）。
- `sessionsNotice` 横条渲染在 toolbar 下（`data-testid="sessions-notice"`，kind 决定配色）。
- fork 进行中：该行 fork 按钮 `aria-busy=true`；其余行 fork 按钮的 `title` 换成
  `sessions.forkBusyOther`（提示但不禁用，FR-007）。

### 2.3 mock.ts

- `sessions.fork`：按源行造新行（新 file/id/name 继承源 name，messageCount/preview 复制），
  计入 `mockSessions`；`?forkfail=1` 旋钮 → reject（US3）。响应 `{ ok: true, file }`。
- `sessions.rename` 已有（012），直接复用。
- `METHOD_SOURCE`/`BridgeMethod` 同步 `"sessions.fork"`。

## 3. 测试设计

| 层 | 用例 | 断言 |
|---|---|---|
| Kotlin | `forkArgs` 参数 | 含 `--mode`/`rpc`/`--fork`/file，timeout 30 |
| Kotlin | `findNewFork` 临时目录夹具 | before 集合外的 parentSession 匹配文件被选中；无新文件返回 null |
| vitest store | 三行逐行 copy | `copyText` 收到 `标题N\nIDN`，三次互不相同（US1 独立测试） |
| vitest store | 缺 id | 文本仅标题 + notice error |
| vitest store | 非当前行 fork | `sessions.fork` 收到该行 file；无 `switch_session`/`clone`；`sessions.rename` 带 `标题(fork 后缀)`；列表刷新 |
| vitest store | 当前行 fork | 走 RPC `clone` 且 **params 无 sessionPath**；后缀落上 |
| vitest store | 单飞 | 连点 2 行：第二次 notice 提示、只发一次 `sessions.fork`；同行连点 3 次只发 1 次 |
| vitest store | 失败 | `?forkfail` reject → notice error、busy 复位、列表条数不变 |
| e2e | 三行 copy | 剪贴板 stub 数组收到三段互异文本 |
| e2e | 行 fork（mock） | 新行出现、名字 = 源名+后缀、当前会话未切走（状态栏/内容不变） |
| e2e | fork 失败 | notice error 可见、行数不变 |
| e2e | 忙碌态 | fork 中该行 `aria-busy`、其余行点击出提示 |

剪贴板断言方式：e2e 用 `addInitScript` 把 `navigator.clipboard.writeText` 换成记录到
`window.__copied` 的 stub（JCEF 无 async clipboard，copyText 本就有 fallback，stub 只需拦住第一条路径）。

## 4. 触及文件

```
src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt     dispatch + sessionsFork
src/main/kotlin/dev/pi/agent/session/PiSessionIndex.kt   findNewFork / 路径校验复用
src/main/kotlin/dev/pi/agent/manage/PiCliRunner.kt       不改（复用 run；forkArgs 放 BridgeService 或新 PiSessionFork）
src/test/kotlin/dev/pi/agent/session/…                   forkArgs / findNewFork 用例
web/src/bridge/types.ts                                  "sessions.fork"
web/src/bridge/mock.ts                                   sessions.fork + ?forkfail
web/src/store/store.ts                                   copySessionInfo / forkSessionFromList / sessionsNotice / forkingFile
web/src/components/SessionsView.tsx                      copy/fork 按钮、notice 横条
web/src/styles.css                                       notice / busy spinner
web/src/i18n/locales/{en,zh}.ts                          copyTitle / forkTitle / forkBusyOther / notice 文案
web/src/store/store.test.ts                              US1–US3 store 层
web/e2e/sessions.spec.ts                                 既有 clone 用例改 fork/copy
web/e2e/session-list-actions.spec.ts                     新增
changelog.d/024-session-list-actions.fixed.md            收尾
```

## 5. 风险与边界

- **冷启动顿一下**（spec 已预期）：按钮即时 `aria-busy` + spinner；不做后台队列。
- `pi --fork` 对**同名多次 fork**：新文件按时间戳+新 id 命名，天然幂等不冲突。
- fork 源是**当前会话文件**但用户已切走（stale file）→ 走非当前通路也安全（fork 按磁盘文件干活，不看活动会话）。
- `--mode rpc` 的 stdout 在 fork 场景为空（探针 P2），不解析 stdout，只扫文件系统——协议改动免疫。
