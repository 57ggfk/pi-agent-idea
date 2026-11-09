# 014 plan

## 结构决策

**三段式进程链**：UI ↔ (bridge) ↔ Kotlin 登录服务 ↔ (JSON-lines) ↔ `pi-login.mjs` ↔ (SDK import) ↔ 用户 pi。

- `.mjs` 放插件资源（仿 `PiApprovalSupport` 解包到 `~/Library/.../pi-agent/`），**不进 web bundle、不进 Gradle 依赖**——升级插件即升级脚本，重打包零成本。
- `.mjs` 自己从 `argv[2]`（pi 路径）realpath 向上找 `package.json`（name=@earendil-works/pi-coding-agent），拿到包根后 `import(pathToFileURL(root/dist/index.js))`——Windows .cmd shim、nvm、自定义路径统一覆盖，Kotlin 不猜包根。
- Kotlin 侧只做：解包、spawn（node + .mjs + piPath）、行收发、事件 push、浏览器打开、进程清理。协议状态机独立成纯函数（可测）。

## JSON-lines 协议

stdout（mjs → Kotlin）：
- `{"t":"ready"}` — SDK 导入成功，可接受 start
- `{"t":"event","ev":{...AuthEvent}}` — notify 镜像（info/auth_url/device_code/progress）
- `{"t":"prompt","id":N,"p":{...AuthPrompt}}` — interaction.prompt；回答前挂起
- `{"t":"done","ok":bool,"error"?}` — 终态，进程自行退出

stdin（Kotlin → mjs）：
- `{"t":"answer","id":N,"value":"..."}` 
- `{"t":"cancel"}` — mjs abort 内部 controller；Kotlin 同时保留进程树强杀兜底

桥事件名 `auth`（`BridgeEventName` 增一项），data=`{kind: started|event|prompt|done, ...}`。浏览器打开在 Kotlin 侧（`BrowserUtil.browse`），auth_url/device_code 事件即开，UI 同时给链接与复制。

## getDeviceId

`.mjs` 内实现：`getAgentDir()`（pi 导出）下 `settings.json` 的 `deviceId` 字段（uuid v4，缺则建）——与 pi SettingsManager 同位置，终端 /login 与插件登录共享同一设备 ID。

## agentName

`login(..., { agentName: "Pi Agent (JetBrains)" })`：OpenAI 动态客户端注册的 agent_name_hint 用它，与终端 pi 区分来源。

## 并发

`PiLoginSupport` 单例态：`AtomicReference<Session?>`；start 时已有 session → 返回错误（US4）。Session 持 Process/BufferedWriter/pending prompts；done 或 cancel 后清引用。IDE 退出靠 Disposable? 子进程随 IDE 进程组销毁（destroyProcessTree 复用 OsProcess 既有能力）。

## 前端状态

store 增 `authLogin` 切片（idle/starting/running/done + prompt + 最近事件），ProviderForm 订阅渲染；answer/cancel 走 manageApi。表单卸载不清状态（切 tab 回来仍在，US4）。

## 测试

- Kotlin：协议行分类纯函数（ready/event/prompt/done/坏行）单测；资源存在性。
- Web：store 的 auth 事件归约（running→prompt→done）单测；mock 桥补 authLogin* 三方法（可演示）。
- 真机：runIde + 真 pi，openrouter（OAuth、无固定端口依赖）走通全流程。
