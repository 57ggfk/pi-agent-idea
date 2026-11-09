# Changelog

## Unreleased

**新增**
- 拖拽文件/目录到输入框（spec 016）：从 **IDEA 项目树**、编辑器标签或系统文件管理器把文件、目录拖进输入框，松手即变成可删的引用 chip（发送时只带 `@相对路径`）；拖动过程中输入框显示虚线高亮与「松开即把这个文件 / 目录加为引用」。路径取自 IDE 侧 CEF 真正看到的绝对路径（HTML5 drop 出于安全只给文件名）并换算成项目相对路径——项目树拖拽不再得到 `a.kt` 这种 pi 无法解析的引用；项目外路径保持绝对路径。

**修复**
- Windows 上 pi 拿到的 PATH 可能只有启动它的那个 shell 的几条（实测 6 条，而这台机器完整 PATH 有 44 条），于是 `powershell`、`where`、甚至 Java / Maven / Go / WSL 在 agent 里全都"莫名找不到"。现在子进程的 PATH 直接按**终端里的那份**重建：以注册表 Machine + User PATH 为准（展开 `%VAR%`、大小写不敏感去重），只在最前面补上插件解析出的 node 目录；IDE 继承来、注册表里没有的条目（例如 Git Bash 的 `mingw64\bin`）补在最后。这样同一个命令在面板里和在终端里解析到的是同一个可执行文件。注册表读不到时退回"系统基础目录 + 继承 PATH"，保证 `system32`、`WindowsApps`（Store 版 `pwsh`、`winget` 的别名）仍然可用。
- 启动时若工具窗被自动恢复，`idea.log` 不再出现一条 `Plugin to blame: Pi Agent` 的 SEVERE：平台 `JBCefApp` 的静态初始化里会读代理设置，从类初始化中请求 `HttpConfigurable`/`ProxyMigrationService`，触发 IDEA 自己的“类初始化不得依赖服务”自查——而插件是启动阶段第一个使用 JCEF 的调用方，于是被记成责任方。现在创建浏览器前先把该服务初始化好，自查走不到那条慢路径；功能与之前完全一致，只是启动日志干净了。
- 工具窗挂着不动几个小时之后"卡住"（画面正常、点什么都没反应）不再需要重开 IDE：根因是内嵌浏览器的渲染进程已经退出/僵死，而 Swing 仍在重绘最后一帧，看起来完全正常。面板现在把前端的 20 秒长轮询当作存活信号——可见状态下静默超过 90 秒就自动重建浏览器（60 秒内最多 2 次，避免崩溃循环，超过则停在带原因的错误卡片）；前端长轮询补上了 35 秒请求超时与 90 秒看门狗，断链后会自己重连/重载，不再永久停在 await 上。另外补上了这条链路的诊断痕迹——页面被加载、前端看门狗决定重载、IDE 侧重建浏览器都会写进 `idea.log`（平台把 CEF 自身日志关了，此前崩溃在日志里连一行都没有）。
- 拖入一段文字（例如编辑器里选中的代码）不再被当成路径生成引用 chip：按浏览器默认插到光标处。此前它既没插入文本，还会生成以 `fun`、`main()` 之类为名的假引用。
- Windows 上"自动重命名会话标题"的模型精炼从未生效（macOS 正常），而表面上毫无提示：pi 在 Windows 是 `.cmd` 垫片，启动必须经 `cmd.exe /d /c`，而 cmd 是解析器——命令行遇到第一个换行就被截断。这里两段参数天然多行（`--system-prompt` 常量，以及固定的 `User:/Assistant:` 摘录），于是摘录整段丢失、pi 收到空提示后正常退出（exit 0）并输出空内容，前端按设计静默保留"首条消息截断"的标题；这条降级路径不打日志，`idea.log` 里查不到任何线索。现在动态内容不再进命令行：固定提示词压成单行且不含双引号与 `%`（避开 cmd 的引号重切分与环境变量展开），对话摘录改由 stdin 交给 `pi -p`；同时给这个一次性进程补上与主会话一致的 PATH 合并（`pi.cmd` 自己要找 `node`，GUI 拉起的 IDE 未必有）。Windows 侧新增一条走真实 `cmd /d /c` 链路的用例，此前所有端到端用例在该平台被跳过。
- 扩展提问时只会弹一张"允许 / 拒绝"的英文卡片：pi 的对话框有四种（`confirm` / `select` / `input` / `editor`），而卡片只实现了 confirm —— 选择题看不到选项、填空题没有输入框，点哪颗按钮都只是"取消"，扩展拿到 `undefined`；文案还全部硬编码英文（`Allow` / `Deny` / `+N queued`），中文 IDE 里也一样。现在四种对话框分别渲染（选项按钮 / 单行输入 / 多行编辑器 / 是否确认），回答按 pi 的协议回 `value` 或 `confirmed`，取消统一回 `cancelled`；卡片文案进入 i18n（中英齐备），输入为空时提交按钮禁用。审批标题也不再是英文：插件把 IDE 语言作为 `PI_APPROVE_LANG` 传给随包扩展，中文环境下显示"允许执行 bash？"。
- 多选问题在面板里只剩一个"手打编号"的输入框：pi 的 RPC 协议没有 multiSelect，需要多选的扩展（如 rpiv-ask-user-question）只能降级成 `ui.input`，把「1. 标签 — 说明」整段写进标题、让用户自己敲 `1,3`。现在这些编号行会被抽出来渲染成可点条目，点一下就把编号写进同一个输入框（随时可手改），提交仍按扩展期待的纯文本回传；只在"从 1 开始连续、至少两条"时才启用，认不出就退回原样——误判的代价只是多一排可忽略的条目，手打路径始终不受影响。输入框顺带补了自动聚焦，以及中文输入法保护（组词时的回车不再被当成提交）。

**Added**
- Drag a file or folder into the composer (spec 016): drop it from the **IDEA Project View**, an editor tab or the system file manager and it becomes a removable reference chip (the message only carries `@relative/path`); the composer shows a dashed highlight with "Release to reference this file or folder" while dragging. Paths come from the IDE side — CEF is the only place a native drag exposes real absolute paths (the HTML5 drop event is limited to bare file names) — and are converted to project-relative ones, so a Project View drag no longer yields an `a.kt` reference pi cannot resolve; out-of-project paths stay absolute.

**Fixed**
- On Windows, pi could inherit only the handful of PATH entries belonging to whatever launched the IDE (six on a real machine, against 44 in the machine's own PATH), so `powershell`, `where` — and Java, Maven, Go, WSL — were all "not found" for the agent. Child PATH is now rebuilt to match **what a terminal sees**: the registry's machine + user values (`%VAR%` expanded, de-duplicated case-insensitively) with the plugin's resolved node directory prepended, and only the inherited entries the registry does not know about (a shell-specific `mingw64\bin`) appended at the end — so a command resolves to the same executable in the panel as in a terminal. When the registry cannot be read it falls back to the base system directories plus the inherited PATH, which still covers `system32` and `WindowsApps` (the aliases of the Store `pwsh`/`winget`).
- Restoring the tool window at startup no longer logs a `Plugin to blame: Pi Agent` SEVERE: the platform's `JBCefApp` static initializer reads proxy settings and requests `HttpConfigurable`/`ProxyMigrationService` from inside a class initializer, tripping IDEA's own "class initialization must not depend on services" check — and the plugin, being the first JCEF user during startup, gets recorded as the culprit. The service is now created before the browser, so the check never reaches its slow path; behaviour is unchanged, the startup log is just clean.
- The tool window freezing after hours of idling (picture intact, every click ignored) no longer needs an IDE restart: the embedded browser's renderer process had exited or wedged while Swing kept repainting its last frame, so the panel looked perfectly healthy. The panel now treats the frontend's 20s long-poll as a liveness signal — silence for 90s while the panel is on screen rebuilds the browser automatically (at most twice a minute, then it parks on an error card naming the reason); the long-poll itself gained a 35s request timeout and a 90s watchdog, so a broken link reconnects/reloads instead of parking on an await forever. The chain is now traceable in `idea.log` too: serving the page, the frontend watchdog deciding to reload, and the IDE-side rebuild each leave a line (the platform runs CEF with its own logging disabled, so before this a crash left no trace at all).
- Dropping plain text (e.g. code selected in an editor) no longer turns into reference chips: it is inserted at the caret like the browser default. Before, it neither inserted the text nor avoided bogus chips named `fun` or `main()`.
- On Windows, the model-refined session title never worked (macOS was fine) and said nothing about it: pi ships as a `.cmd` shim there, so every spawn goes through `cmd.exe /d /c`, and cmd is a parser — the command line ends at the first newline. Both payloads are multi-line by nature (the `--system-prompt` constant and the fixed `User:/Assistant:` excerpt), so the excerpt was dropped entirely and pi, left with no prompt, exited cleanly (exit 0) with empty output; the frontend then kept the "first message truncated" title exactly as designed, and that fallback path logs nothing, leaving `idea.log` without a single clue. Dynamic content no longer rides on the command line: the system prompt is one quote- and percent-free line (cmd would otherwise re-split arguments and expand `%NAME%`), and the excerpt is handed to `pi -p` on stdin; the one-shot also gets the same PATH merge as the live session (`pi.cmd` resolves `node` itself, and a GUI-launched IDE need not have it). A Windows-only test now exercises the real `cmd /d /c` path, where every end-to-end case used to be skipped.
- An extension asking a question only ever produced an English "Allow / Deny" card: pi has four dialog methods (`confirm` / `select` / `input` / `editor`) and the card implemented just one — a choice question showed no options, a free-form question had no field, and whichever button you pressed sent a cancellation, so the extension received `undefined`; all copy was hardcoded English (`Allow` / `Deny` / `+N queued`) even in a Chinese IDE. Each method now renders its own body (option buttons / single-line field / multiline editor / yes-no), answers go back as `value` or `confirmed` per pi's protocol with `cancelled` for dismissal, the copy is translated (both languages), and submit stays disabled while the field is empty. Approval titles are no longer English either: the plugin passes the IDE language as `PI_APPROVE_LANG` to its bundled extension, so a Chinese IDE asks "允许执行 bash？".
- A multi-select question left you with nothing but a "type the numbers" field: pi's RPC protocol has no multi-select, so extensions that need one (rpiv-ask-user-question and friends) degrade to `ui.input`, writing "1. label — description" lines into the title and asking for `1,3`. Those numbered lines are now lifted out as clickable entries that write their numbers into the same field (still freely editable), and the field text is what goes back to the extension; detection only kicks in for two or more options numbered consecutively from 1 and falls back to the plain field otherwise, so a mis-detected list costs nothing — typing always works. The field also gained autofocus and an IME guard (Enter no longer submits while a Chinese input method is composing).

## 0.5.6 — 2026-11-08

**新增**
- 账号登录接入真浏览器 OAuth（spec 014）：认证表单选 OAuth provider 后点「通过浏览器登录」即可在面板内完成授权——授权页自动在系统浏览器打开（链接与说明同步展示、可复制），设备码类流程展示验证码与验证地址；pi 的交互式 prompt（文本 / 密钥 / 选项 / 粘贴回调 URL）直接在表单内应答；凭证由 pi 按带锁协议写入 auth.json，行徽标即时更新。pi SDK 不打包，运行时从用户已装的 pi（≥1.4.0）导入，与终端 /login 共享同一凭证存储与设备 ID；pi 未装或过旧时自动降级回终端指引卡。同一时刻仅允许一个登录会话，可随时取消。

**变更**
- 顶栏图标按钮（目录 / 搜索 / 新建）悬停显示气泡提示，工具窗拉宽（≥560px）后展开为「图标+文字」（大纲 / 搜索 / 新建），窄面板保持纯图标；中英文案齐备。

**修复**
- 新增认证后聊天页的模型选择器仍是旧列表，必须重启 pi 或重开工具窗才能选到新模型（spec 017）：现在保存 API key、完成浏览器 OAuth、删除凭据都会立刻重读模型目录，选择器即时可见。pi 会自己重读 auth.json；models.json 里的自定义 provider 由随插件加载的扩展在进程内触发刷新——不重启进程、不打断当前会话。打开选择器时若数据超过 15 秒也会后台重读，覆盖在终端 `/login` 或手改 models.json 的情况；内部刷新命令不出现在斜杠补全里。

**Added**
- Real browser OAuth lands in the auth panel (spec 014): pick an OAuth-capable provider and press "Sign in via browser" — the authorization page opens in the system browser automatically (with the URL, instructions and copy fallback mirrored in the panel), device-code flows show the verification code and URI, and pi's interactive prompts (text / secret / select / paste-the-callback-URL) are answered right in the form; credentials are written by pi into auth.json under its own lock and row badges update immediately. The pi SDK is not bundled — it is imported at runtime from the user's installed pi (≥1.4.0), sharing the same credential store and device id as terminal `/login`; when pi is missing or too old the panel degrades to the existing terminal guide. One login at a time, cancellable at any point.

**Changed**
- Top-bar icon buttons (outline / search / new session) show hover tooltips and expand to icon+text once the tool window is wide enough (≥560px); narrow panels keep bare icons. Both languages covered.

**Fixed**
- The chat tab's model picker kept the startup list after a new credential, so the new models only appeared after restarting pi or reopening the tool window (spec 017). Saving an API key, completing browser OAuth, or deleting a credential now re-reads the catalog immediately and the picker reflects it. pi re-reads auth.json itself; a custom provider added through models.json is refreshed in-process by an extension shipped with the plugin — no restart, no interrupted session. Opening the picker also re-reads once the data is older than 15 seconds, covering a terminal `/login` or a hand-edited models.json; the internal refresh command stays out of slash completion.

## 0.5.5 — 2026-11-08

**新增**
- 认证表单对齐终端 `/login`：Provider 改为下拉选择（内置 pi 1.4.0 全部 42 个 provider，models.json 自定义与已存凭据动态并入，附「账号 / API key」状态徽标），认证方式分「账号登录（OAuth）」与「API key」两档——仅 OAuth provider 可选账号；本版选账号时展示终端 `/login <provider>` 指引卡（一键复制命令），浏览器 OAuth 授权将在下个版本接入；API key 写入路径不变。
- 真机验收缺陷批（spec 013）：Provider 下拉可搜索（空格=AND 关键词、键盘导航、自定义项钉底）；「账号登录」分段常驻「暂未接入」角标，指引卡新增「在 IDE 终端打开」——IDEA 终端自动输入并执行 pi（终端不可用时自动降级为激活终端+复制命令+气泡提示）；认证行展开三角换成旋转 chevron 图标；models.json 详情中数组改为格式化 JSON 块（限高滚动 + 自动换行切换），key 列不再被挤压；修复点「设置 key」无反应（编辑表单误嵌在详情展开块内，现直接渲染在行下）。

**变更**
- 「新建会话」按钮迁至顶栏放大镜右侧，底部工具栏同步移除——新会话入口固定在最高层级。

**修复**
- 中文界面下确认弹窗的取消按钮不再显示硬编码「Cancel」：翻译缺失时回退通用文案。
- 会话标题的 LLM 精炼在真机上从未生效：`pi -p` 在非 TTY stdin 下会等 stdin 关闭，而 GUI 拉起的 IDEA 没有 TTY，子进程继承了永不 EOF 的管道，读取永久阻塞直至超时——0.5.4 的每次精炼都以超时降级告终。现把一次性调用的 stdin 重定向到空临时文件（给 pi 它想要的 EOF），stdout 落盘、超时清理整棵进程树，真机上精炼正常返回。

**Added**
- The auth form mirrors the terminal `/login`: the provider is now a dropdown (all 42 pi 1.4.0 builtins, dynamically merged with models.json customs and stored credentials, each badged account/API key), and the method selector offers Account (OAuth) vs API key — the account route is enabled only for OAuth-capable providers and, in this iteration, shows a copyable terminal `/login <provider>` guide (real browser OAuth lands next version); the API-key write path is unchanged.
- Real-machine acceptance defect batch (spec 013): the provider dropdown is searchable (space=AND keywords, keyboard navigation, pinned custom entry); the Account segment carries a standing "not wired yet" badge and its guide card gains "Open IDE terminal" — the IDE terminal auto-types and runs pi (graceful fallback to activating the terminal with the command copied + a balloon); the expand triangle is now a rotating chevron icon; arrays in the models.json detail render as formatted JSON blocks (height-capped scroll + wrap toggle) instead of squeezing the key column; and "Set key" actually opens the edit form, which used to render inside the collapsed detail block.

**Changed**
- The New-session button moves to the top bar, right of the magnifier, and leaves the bottom toolbar — one entry pinned at the top level.

**Fixed**
- Confirm dialogs no longer show a hardcoded "Cancel" in the Chinese UI: a missing translation falls back to the common label.
- Stage-B LLM title refinement never worked on a real machine: `pi -p` with a non-TTY stdin waits for stdin to close, but a GUI-launched IDE has no TTY and its children inherit a pipe that never reaches EOF, so the read blocked until the timeout — every refinement in 0.5.4 ended in the fallback. One-shot calls now redirect stdin to an empty temp file (giving pi the EOF it wants), write stdout to a file and clean up the whole process tree on timeout; refinement now returns on a real machine.

## 0.5.4 — 2026-11-07

**新增**
- 模型选择器重构：按 provider 分组（当前组置顶）、打开时自动定位并高亮当前模型、点外部/Esc 关闭；列表保持 200 条上限。
- 会话标题自动接管：第一条消息自动生成标题（skill 引用折叠为 `/skill:名称` 标记 + 原问题），状态栏与 Sessions 行内均可点击改名，手动标题优先于后续自动命名。
- 会话标题 LLM 精炼（B 阶段）：首轮回答结束后异步调一次性 pi 进程（同当前 provider/model，`--no-session --no-tools`）生成更贴切的标题，成功则覆盖首条消息截断；失败、超时、被杀或期间手动改名都保留 A 阶段结果——每个新会话至多一次轻量调用，skill 展开消息先折叠出原问题再进摘录。
- 全应用统一悬浮提示：图标按钮、窄窗折叠后的模型/思考级别 chip 都有应用内浮层（hover/focus 触发、视口内翻转夹取、不吞点击）。
- Manage 新增 AGENTS.md 页签：按 pi 的实际加载顺序列出 全局 / 项目根 / 子目录 的上下文文件，可在 IDE 编辑器打开或一键创建模板。
- 首次安装全程独占引导：缺 pi 时工具窗只显示安装界面（无可跳过入口），安装成功后进入「配置 provider」步骤（可跳过且记忆跳过）；检测失败不锁界面，显示错误与重试。
- Auth 页签升级为 provider 管理：新增 / 设置 key / 删除（应用内确认框），凭据明文不过桥、不进日志；自定义 provider 直接写 models.json 的 apiKey，内置 provider 按 pi 的锁协议写 auth.json。
- 图片点击弹出预览模态框：`当前/总数` 切换、滚轮与按钮缩放（25%–600%）、拖拽平移、另存为（IDE 保存对话框）与复制到系统剪贴板——失败与取消都有可见提示，绝不假装成功。

**变更**
- 管理顶栏瘦身：pi 环境信息（版本、二进制路径、更新按钮）迁入「诊断」页签首卡片，窄工具窗下不再互相挤压；管理根页只留信任状态。

**修复**
- 引用 skill 时不再把 SKILL.md 全文打印进会话：气泡、复制、引用一律显示 `/skill:名称` 标记 + 原问题，pi 的原文仅保留在数据层（搜索与导出仍可找到全文）。
- Windows 上「更新 pi」与其它 CLI 结果的中文不再乱码：进程输出按字节读取、严格 UTF-8 失败回退本地代码页（与 0.5.2 修复的「检测 pi 找不到中文路径」同一根因的最后一块），并剥离 ANSI 转义与进度条残影、按字符安全截断。
- 中文 IDE 里右键菜单的「Pi Agent」子菜单把 `%action.addDirectory.text` 这样的 key 原样显示出来了。平台的 `<action text="%key">` 不会展开 `%`，菜单文案只有按 action id 命名（`action.PiAgent.AddDirectory.text`、`action.PiAgent.SendFile.text`……）才会从资源包解析。现已改为 id 约定，并加了一致性测试卡住「plugin.xml 的 id / group」与「资源包 key」的对应关系，改名漏改会直接测试失败。
- 状态栏的 pi 版本号不再被 `env: node: No such file or directory` 污染：GUI 拉起的 IDE 里子进程 PATH 缺 node，shebang 报错文本曾被当作版本号展示（纯显示层，0.5.3 起既有）；现改经 node 解释器解析并对结果做合理性校验。
- 切换管理页签后界面残留旧帧、上下两截：JCEF OSR 帧滞后（DOM 已切页、屏幕停在旧帧）——页签切换（含 Manage 子页签）后强制全量重绘；管理子页签同时持久化，重进管理不回默认页、也不重复环境检测。

**Added**
- The model picker groups by provider with the current group pinned, locates and highlights the current model on open, and closes on outside click / Esc; the 200-entry cap stays.
- Session titles are now owned by the plugin: the first message names the session (skill references fold to a `/skill:name` marker plus the question), the status bar and the Sessions row share one inline editor, and a hand-set title wins over later pi events.
- Stage-B title refinement: once the first assistant reply is in, a one-shot pi process (same provider/model, `--no-session --no-tools`) proposes a better title; it overwrites the first-message truncation only on success — failures, timeouts, kills and a hand rename in flight all keep the heuristic result (at most one lightweight model call per new session; skill-expanded messages fold to the question before the excerpt).
- One consistent tooltip layer for icon buttons and density-collapsed chips (hover/focus, viewport flipping, never swallowing clicks).
- Manage gains an AGENTS.md tab listing global/root/subdirectory context files in pi's real load order, with open-in-editor and template creation.
- First-run setup is exclusive while pi is missing (no tabs, no chat, no escape hatch), flows into a skippable provider-config step after install, and a failed detection never locks the UI.
- The Auth tab becomes provider management: add / set key / delete behind the in-app confirm dialog; credentials never cross the bridge as plaintext — built-in providers go to auth.json under pi's own lock protocol, custom providers write models.json directly.
- Clicking an image opens a preview modal with a counter, arrow navigation, wheel/button zoom (25%–600%), drag panning, save-as via the IDE dialog and copy to the system clipboard — failures and cancellations are always visible.

**Changed**
- The Manage header slims down: pi environment info (version, binary path, update button) moves into a first card in the Diagnostics tab, so narrow tool windows stop squeezing it; the Manage root keeps only the trust state.

**Fixed**
- Referencing a skill no longer dumps the whole SKILL.md into the transcript: bubbles, copy and quote all show the `/skill:name` marker plus the question; the raw text stays in the data layer for search and export.
- Chinese output from `pi update` and other CLI commands no longer turns into `????` on Windows: process output is decoded from bytes (strict UTF-8 with a native-code-page fallback — the last piece of the same root cause fixed for pi detection in 0.5.2), with ANSI escapes and progress frames stripped and code-point-safe truncation.
- The right-click "Pi Agent" submenu rendered raw `%action.addDirectory.text` keys in a Chinese IDE. The platform never expands `%` inside `<action text>`; menu labels only resolve when the keys are named after the action id (`action.PiAgent.AddDirectory.text`, `action.PiAgent.SendFile.text`, …). Switched to the id convention and added a consistency test pinning plugin.xml ids/groups to their bundle keys, so a rename that misses the bundle now fails the build.
- The status-bar pi version no longer shows `env: node: No such file or directory`: in a GUI-launched IDE the child PATH lacks node and the shebang error text was displayed as a version (display-only, existed since 0.5.3); detection now goes through the node interpreter and sanity-checks the result.
- Switching tabs could leave a stale frame on screen — a half-old/half-new image from JCEF OSR frame lag (the DOM had already switched, the screen had not). Tab switches (Manage sub-tabs included) now force a full repaint, and the last Manage sub-tab is remembered, so re-entering Manage neither resets the tab nor re-runs environment detection.

## 0.5.3 — 2026-11-06

**新增**
- 右键目录新增「添加目录到 Pi」：把目录的文件清单（自动跳过 build、node_modules、.git 等）填进输入框，一句话就能让 pi 通读整个模块，不用再逐个 `@` 文件。
- 会话支持「消息目录」与「会话内搜索」：点顶栏目录按钮列出自己问过的每一条、点击即跳转并短暂高亮；`Ctrl+F` 或放大镜按钮搜本会话正文（含命令输出），计数循环导航、命中高亮。
- Sessions 页的搜索框现在能搜全部历史会话的正文：命中会话排最前、显示片段和命中数，点片段直接切到那条消息。
- 界面支持中文：默认跟随 IDE 语言，也可在 Options 里固定中/英文；右键菜单、通知、设置页与状态栏提示同步本地化。

**变更**
- 项目树右键「Pi Agent」子菜单不再整片灰：目录右键有可用项，禁用的动作会写明原因（如「文件夹请用添加目录」「二进制文件请用解释」），「解释文件」对目录和二进制也可用。
- pi 写过的文件（含命令改动）约一秒内自动出现在项目树和编辑器里，不再需要手动 Reload from Disk；`@` 文件补全同步看到新文件。
- 右键「Pi Agent」分组有了 π 图标，与相邻系统分组观感一致。

**Added**
- Right-click a folder → "Add Directory to Pi": drops the folder's file listing (skipping build, node_modules, .git and friends) into the composer, so pi can read a whole module from one prompt instead of `@`-ing files one by one.
- Session outline and in-session search: the outline button lists every question you asked, one click jumps there with a brief highlight; `Ctrl+F` or the magnifier searches the session body (command output included) with a counter, looping navigation and highlights.
- The Sessions search box now scans the bodies of all past sessions: matches rank first with snippets and hit counts, and clicking one lands on that exact message.
- The UI speaks Chinese: it follows the IDE language by default, or pin 中文/English in Options; context menus, notifications, the settings page and the status bar follow along.

**Changed**
- The project-tree "Pi Agent" submenu is no longer all grey: folders always have an enabled action, and disabled ones explain why ("use Add Directory for folders", "binary files: use Explain"), while Explain File now also accepts folders and binaries.
- Files pi wrote (including via commands) appear in the project tree and editor within about a second — no more manual Reload from Disk — and `@` completion sees new files right away.
- The "Pi Agent" popup group now has its π icon, matching the neighbouring system groups.

## 0.5.2 — 2026-11-05

**新增**
- 每条 pi 回复的悬停条上新增 Fork：从那句回复岔开新会话，后面的内容不进新会话；对最后一条回复 Fork 等于整段复制。旧会话照旧留在 Sessions。
- New / Fork / 删除会话都先弹确认框，写清会发生什么、旧会话是否保留；Esc 取消，误触不再直接切走视图。

**变更**
- 用户消息气泡更紧凑：单行消息高度约少一半，行距和字号不变，同样长的对话一屏能多看几条。
- 底部控制栏的 Fork 按钮收起来了（能力保留，改一行可恢复），Fork 统一在消息悬停条上。

**修复**
- 在 2023.3–2024.2 的 IDE 上打开插件设置页会报 `NoSuchMethodError`（该问题由 0.5.1 引入），现在能正常打开。
- 新会话的 π 图标原来贴在顶部，图标、标题和模型名现在整块居中在对话区，拉伸工具窗也不跑偏。
- 把内容塞进输入框后输入框不跟着长高（右键「Explain with Pi」、引用长回复、`@` 文件都这样），只能看两三行；现在按内容长高，到上限后在框内滚动、消息区仍留够高度，发送后立刻回落到一行。

**Added**
- Fork on every pi reply: branch a new session right after that answer, leaving what came later behind; forking the last reply copies the whole conversation. The session you branched from stays in Sessions.
- New, Fork and Delete now ask first, in a dialog that says what will happen and whether the old session is kept; Esc cancels, so a mis-click no longer switches the view.

**Changed**
- User message bubbles are tighter: a single-line message is about half its previous height with the same font size and line spacing, so more of the conversation fits on one screen.
- The Fork button is gone from the bottom bar (the capability is kept, one line to restore); Fork lives on the message toolbar now.

**Fixed**
- Opening the plugin settings page on 2023.3–2024.2 IDEs threw a `NoSuchMethodError` (introduced in 0.5.1); it opens normally now.
- The empty-state π mark sat against the top of the pane; the icon, title and model line are now centered as one block, and stay centered while the tool window is resized.
- The composer ignored text pushed into it (Explain with Pi, quoting a long reply, `@` file completion) and showed only two or three lines. It now grows with its content, scrolls inside at the cap while the message area keeps its height, and collapses back to one line after sending.

## 0.5.1 — 2026-11-04

**新增**
- **首次使用引导**：打开工具窗先检测 Node.js、npm 与 pi，缺哪个说哪个；可一键安装 pi，装的时候默认沿用本机 npm 已配置的源（公司私服、代理都不用改），也可选官方 npm、国内镜像，或直接粘贴自己的源地址；安装不设时限、随时可停，装不上时还能指向已有的 pi。
- **MCP 服务器可临时停用**：在 Manage 面板一键关掉某个服务器再打开，命令、参数、环境变量全部原地保留，不必删了重填。
- **消息悬停操作条**：复制（Pi 回复为 Markdown 源码，自己的消息为原文）、引用到输入框、重新生成、编辑重发；后两者以该消息为界新开会话分支，旧会话可在 Sessions 里切回。
- **消息排队**：pi 工作时新消息进入输入框上方的队列条，可排序、取回编辑、插话、暂停；执行顺序由 pi 负责，暂停期间的消息不会自动补发。
- **Manage 面板新增 Diagnostics**：列出文件、命令、模型等数据源各自的状态与最近错误，可逐个重试。
- **扩展包与 pi 本体一键更新**：Packages 页签对已装扩展包点「更新」，环境区可更新 pi 本体；失败时显示原始错误输出与退出码。
- **自定义 Provider 配置可查看**：认证面板展开 provider 看 base URL、模型清单等配置，密钥只显示是否已配置，并可一键在编辑器打开 models.json。

**变更**
- MCP 列表现已标出每个服务器来自用户配置还是本项目；停用只影响新会话，当前会话保持已建立的连接。

**修复**
- 输入 `@` 或 `/` 时列表是空的，不再一律显示「没有匹配」：加载失败会写明原因并可原地重试，加载中也会单独提示。
- 文件列表改为 30 秒过期并在打开菜单时自动重读，菜单底部可手动刷新，新建或删除的文件不必重开工具窗即可看到。
- Fork 之后界面还停在旧消息上：pi 1.4.0 不再返回会话路径，消息列表与新分支不同步。
- 工具窗不再白屏：内嵌浏览器不可用、本地 UI 服务起不来、页面加载失败时，面板直接写明原因与地址，可重试或在系统浏览器打开。
- 前端起不来时页面自己报错：脚本没下载到或一执行就失败，会显示失败原因与资源地址，而不是一块白板。
- 修复中文路径下找不到 pi：Windows `where` 输出改按本地代码页解码，`D:\软件\…` 不再变成 `????` 导致「Cannot run program」。
- 修复 IPv6 优先的 JVM 上 UI 服务绑到 `[::1]`、页面却访问 `127.0.0.1` 导致连不上。
- 重新打开历史会话后，命令卡片展不开、看不到当时的执行结果：现在点开即有输出。
- 修复 Windows 上 pi 起不来、报 `CreateProcess error=193`：启动 pi 改用系统命令解释器的绝对路径，不再让 IDE 进程的 `PATH` 去猜 `cmd` 是哪个文件。

**Added**
- **First-run setup**: the tool window checks for Node.js, npm and pi before anything else and names what is missing. Installing pi uses whatever registry npm is already configured with — a company proxy or private mirror needs no changes — and can equally be pinned to the official registry, the China mirror, or a URL you paste in. The install has no time limit and can be stopped at any point; pointing at an existing binary is always an option too.
- **MCP servers can be switched off without deleting them**: turn one off in the Manage panel and back on later; command, args and env stay exactly where they were.
- **Hover actions on any message**: copy (Markdown source for Pi replies, verbatim text for your own), quote into the composer, regenerate, and edit-and-resend; the last two branch the conversation into a new session you can switch back to.
- **Message queue**: while pi is working, new messages line up in a bar above the composer — reorder, take back to edit, steer into the running turn, or pause. Pi owns the execution order; paused messages are never sent automatically.
- **Diagnostics tab in Manage**: every data source lists its own status and last error, with a per-source retry.
- **One-click updates for packages and pi itself**: update an installed extension from the Packages tab, or update pi from the Manage header; failures show the raw error output and exit code.
- **Custom provider configuration, visible at last**: expand a provider in the Auth tab to see its type, base URL and models; secrets show only whether they are configured, and models.json opens in the editor in one click.

**Changed**
- The MCP list now says whether a server comes from your own config or from this project, and a disabled server keeps the current session connected until the next one starts.

**Fixed**
- An empty `@` or `/` menu no longer always claims "no match": a failed load now says what went wrong and offers a retry, and a load in progress says so.
- The file list expires after 30 seconds and is re-read when the menu opens; a refresh button picks up files created or deleted without reopening the tool window.
- Fork left the UI on the old transcript: pi 1.4.0 no longer returns a session path, so the message list did not follow the new branch.
- The tool window no longer stays blank: when the embedded browser is unavailable, the local UI service fails to start, or the page fails to load, the panel names the reason and the address, with retry and open-in-browser actions.
- The web UI reports its own boot failure: a bundle that never arrives or throws on execution now shows the reason and the asset address instead of a white rectangle.
- pi is found again under Chinese install paths: `where` output on Windows is decoded with the local code page, so `D:\软件\…` no longer becomes `????` and fails with "Cannot run program".
- The UI server no longer binds `[::1]` while the page requests `127.0.0.1` on JVMs that prefer IPv6.
- Command cards in a reopened session could not be expanded, so the output was lost; they now open with what was captured at the time.
- pi no longer fails to start on Windows with `CreateProcess error=193`: the batch shim is launched through the system command interpreter by its absolute path, so the IDE's own `PATH` no longer decides which `cmd` gets used.

## 0.5.0 — 2026-11-03

**新增**
- **项目信任模型**：Manage 面板可查看 / 授予 / 撤销本项目的 pi 信任，未信任时列出会被忽略的项目级 skills、MCP 与设置。

**变更**
- **工具调用默认自动批准**，旧配置启动时自动迁移；需要人工把关时在 Options 里关掉即回到询问模式。
- **控制栏按实测宽度分级折叠**，360–900px 保持单行，长模型名与流式 Stop 按钮都算在内。

**修复**
- 多窗口下，项目级 skills 会列出别的项目的条目。
- `/` 与 `@` 菜单不显示、Options 菜单被裁、Sessions 卡片被切。
- 深色主题下工具窗口图标显示为白块；窄窗口出现横向滚动条。

**Added**
- **Project trust model**: view, grant or revoke trust for the current project in the Manage panel; untrusted projects list the project-level skills, MCP servers and settings that pi will ignore.

**Changed**
- **Tool calls are auto-approved by default** (existing configs migrate on startup); toggle it off in Options to go back to ask mode.
- **Composer toolbar collapses in measured tiers** — stays on one line from 360–900px, long model names and the streaming Stop button included.

**Fixed**
- Project-level skills listing entries from the wrong project in multi-window sessions.
- Missing `/` and `@` menus, a clipped Options menu, and cut-off Sessions cards.
- White tool-window icons on dark themes; horizontal scrollbars in narrow windows.

## 0.4.0 — 2026-11-02

**工具调用审批**（随插件内置 pi 扩展，经 extension_ui 通路在 IDE 内批准/拒绝）
与基础体验补全（自动压缩/自动重试开关、上下文用量进度条、CI 加厚）。

### 新增
- **布局重构：全窗体响应式自适应**——工具窗口拉大拉小布局跟随：
  窄窗（≤480px）工具栏按钮自动降级为纯图标、状态栏隐藏次要信息（成本/消息数）、
  选择器截断省略；宽窗（≥720px）聊天列居中限宽（860px 可读行宽）、
  会话列表变卡片网格、间距流式缩放（clamp()）；⚙ Options 弹层支持 Escape 关闭，
  开关控件重构为纯按钮（修复 label 包裹导致的点击吞没）
- **工具调用审批**：pi 本体无权限系统，插件现在内置 `pi-approve` 扩展
  （`pi --extension` 加载，不影响终端 pi）：read-only 工具（按工具自带
  `readOnlyHint`/`destructiveHint` annotations 判定）直接放行，改动/命令类
  工具在聊天流中弹出审批卡片（工具名 + 参数摘要），**Allow / Deny**；
  拒绝以错误结果返回给模型；5 分钟无响应自动拒绝；无 UI 场景 fail-closed。
  ⚙ Options 菜单一键切 **Ask / Yolo**（策略文件每次 tool_call 重读，无需
  重启 pi）
- **⚙ Options 弹层**（底部工具栏）：自动压缩（`set_auto_compaction`）、
  自动重试（`set_auto_retry`，跨重启持久化）、工具审批模式，三开关集中管理
- 状态栏 **ctx 进度条**（绿 → 70% 琥珀 → 90% 红），不再只有干巴巴的百分比
- CI：`verifyPlugin`（Marketplace 拒收标准检查）进 Linux 腿；新增 `web` job
  （Vitest + Playwright chromium）

### 修复
- **编辑器右键菜单自首个版本起从未注册（重大修复）**：`<group>`/`<action>` 声明
  一直写在 `<extensions>` 内——插件描述符解析器会静默忽略该非法位置的动作，
  必须放在顶层 `<actions>` 节。v0.1.0–v0.4.0 的 Explain/Fix/Send Selection、
  Send File、Generate Commit Message 在真机上均不可见（真机验收被跳过所以
  一直没暴露）；已用内置电脑操作在 WebStorm 2026.2 上自动验证注册成功
- **审批响应必须裸发（真机联调发现）**：`extension_ui_response` 是 extension
  UI 子协议的**通知**——pi 按记录内的 id 解析挂起的对话框且从不回包；经
  `rpc.request` 关联发送会被包一层请求 id，pi 无法解析导致对话框死等。
  现走 fire-and-forget 通路（对齐官方 rpc-extension-ui 示例客户端的裸写
  stdin 行为）；真机验证 Allow 执行写入并续轮、Deny 阻断并告知原因

### 实现
- `process/PiApprovalSupport`：扩展每次启动从插件资源解压到
  `<IDE config>/pi-agent/`（升级即生效），策略 JSON 读写
- 桥接新方法：`approval.getPolicy` / `approval.setPolicy`、
  `config.getPrefs` / `config.setPrefs`
- 前端：`extension_ui_request` 解析（`approvalFromEvent` 纯函数）→ 审批卡片
  → `extension_ui_response`；`agent_settled`/abort 清空过期卡片；
  fire-and-forget 方法（notify/setStatus/…）忽略
- Mock：mock-pi.mjs（`MOCK_PI_APPROVAL=1`）与 MockBridge（`?approval=1`）
  脚本化审批轮次，前端 e2e 全覆盖

### 测试
- Vitest 23（+4 审批解析）、Playwright 24（+3 审批 e2e：批准/拒绝/yolo）

## 0.3.1 — 2026-11-01

VCS 集成：用 Pi 生成 Commit Message（不进聊天会话），加验证收尾修复。
（0.3.0 未单独发布，其内容随本版本一同发出。）

### 新增
- **VCS 集成：用 Pi 生成 Commit Message**（提交工具窗 + 模态提交对话框）：
  提交面板「Generate Commit Message with Pi」（Alt+Shift+C）把**已勾选变更的
  unified diff**（`IdeaTextPatchBuilder` 构建、96KB 截断、二进制文件降级为注释行）
  交给一次性无头 pi（`pi --print --no-session --no-tools --no-mcp -ne -ns -np -nc`，
  prompt 经 stdin 管道传入，300s 超时），要求 Conventional Commits 格式，
  结果清洗代码围栏后写入提交信息框；不进聊天会话、不改 agent 上下文；
  失败（pi 缺失/超时/空输出）走「Pi Agent」通知
- PiCliRunner 支持 stdin 管道（写入线程 + 超时关闭，超时按进程树清理）

### 修复
- CLI 子进程超时清理整个进程树：shell 可能 fork（而非 exec）尾部命令，
  只强杀直接子进程会留下持有 stdout 管道的孤儿孙进程，排水线程在 Linux 上
  等不到 EOF；现在连同 `ProcessHandle.descendants()` 一起清理，管道闭合、
  读线程正常退出
- **思考等级选择器改为自定义弹层**：原生 select 弹层会被工具窗边缘裁剪，
  靠近窗口底部时改为向上弹开
- **verifyPlugin 真正跑起来且通过**：补 `pluginVerification.ides`（此前
  "No IDEs Found" 直接失败）；`PiAgentToolWindowFactory` 改为 Java 实现 ——
  Kotlin 实现带默认方法的 `ToolWindowFactory`（上游以 jvm-default=all 编译）
  会生成 getIcon/getAnchor/manage 转发器，被 verifier 计为 6 处 @Internal API
  用法（verifier 的 ignore 机制只覆盖 problem 不覆盖 usage，无法豁免）；
  转为 Java 后继承接口默认值，verifier 结果从 "6 internal API" 降到 0

### 测试
- Commit Message 生成 8 例单测：unified diff 拼装（修改/新增/删除/行数推导/
  截断/二进制）、prompt、回复清洗
- 测试执行器超时路径关闭进程流、静默进程用例在测试体内销毁进程，
  修掉 ThreadLeakTracker 顺序导致的线程泄漏误报

## 0.3.0 — 2026-11-01

跨平台：源码 / 构建 / 运行全面兼容 macOS、Windows 与 Linux（含 WSL 边界说明）；
环境约束对标 cc gui 重定；设置页与会话生命周期补全。

### 破坏性变更（环境约束）
- **支持区间改为 2023.3–2026.3**（`sinceBuild=233` / `untilBuild=263.*`，
  对标 cc gui），不再只支持 2026.2
- **编译目标固定为远程 IntelliJ IDEA Community 2024.3.1**（最低支持线）——
  每次构建都在最低线上验证全区间二进制兼容；`ideaPath` 属性仅用于把
  runIde/e2e 指向本地真实 IDE，构建不再依赖本地安装的 IDEA
- 工具链对齐：bytecode 17（原 21）、Gradle 8.14.4（原 9.8.2）、
  IPG 2.10.5（原 2.19.0）；接入 `pluginVerifier`（COMPATIBILITY_PROBLEMS +
  INTERNAL_API_USAGES，对齐 Marketplace 拒收标准）
- JCEF 依赖改为 optional depends（2026.2+ 走模块，2023.3–2026.1 走平台类路径），
  插件在无 JCEF 模块的旧版上也能加载

### 修复
- **Windows 上无法定位/启动 pi**：PiLocator 支持 `where pi` 与 Windows 候选路径
  （`%APPDATA%\npm\pi.cmd`、scoop、chocolatey）、`node.exe` 解析；`.cmd` shim
  经 `cmd /c` 启动；子进程 PATH 用平台分隔符拼接（原先固定 `:`，Windows 必坏）
- 构建脚本两处 macOS 专属问题：`ensureWebUiDeps` 的 inputs 相对路径解析到
  项目根目录（应为 `web/`）；npm 硬编码 `/bin/zsh -lic`（Linux 无 zsh 即挂）→
  按存在性挑 shell（`$SHELL` → zsh → bash → sh）
- 测试在 Windows 硬失败/整组跳过：PiCliRunnerTest 换用跨平台子进程命令，
  PiRpcClientTest 的 node 探测支持 Windows，kotlin test 显式钉 JUnit5 变体
  （Gradle 8.14 下默认解析到 JUnit4 会崩 worker）—— 全部用例在 Windows 真实执行
- Windows 下会话列表静默为空：cwd 匹配前做分隔符/大小写归一化
- Markdown 文件链接识别 Windows 路径（`C:\...`、`C:/...`、`~/...`），
  `~\` 开头路径在 IDE 侧正确展开

### 新增
- **设置页**（Settings → Tools → Pi Agent）：自定义 pi 路径（发现失败时的
  图形化逃生门，保存后自动重启运行中的 pi）+ 项目启动自动打开工具窗开关
- **会话生命周期补全**：会话列表显示消息数；行内操作 克隆 / 导出 HTML /
  删除（根目录校验防误删）；聊天工具栏 **Fork**（从最后一条 user 消息分叉）；
  会话导出为免脚本内联样式的独立 HTML 文件
- `Explain File with Pi` 动作接入右键菜单（已实现但从未注册）
- CI：GitHub Actions 三系统矩阵（ubuntu/windows/macos）跑 `build` + `test`
- Windows IDE-e2e 脚本 `scripts/e2e-ide.ps1`（mock / `-Real` 均可）；
  e2e-ide*.sh 的 JAVA_HOME 探测支持 Linux；node-env.sh 不再钉死 Node 版本
- mock（web MockBridge 与 test/mock-pi.mjs）补 `fork`/`clone`/
  `export_html`/`switch_session`，会话链路可被 e2e 全覆盖

## 0.2.1 — 2026-10-31

编辑器/文件整合深化：文件右键发送、原生 Diff 视图、路径点击回显。

### 新增
- **项目文件树 / 编辑器标签页右键 → Pi Agent → Send File to Pi Agent**：
  整个文件（带路径上下文）发送给 pi（二进制 / 超过 256KB 自动置灰）
- **pi 修改的文件 → 原生 JetBrains Diff 窗口**：pi 开始改文件时自动捕获
  "改前"基线，工具卡片的 **Diff** 按钮用平台 DiffManager 弹出 Before/After
  对比窗口；无基线时回退 git HEAD 版本，仍无则直接打开文件
  （新 bridge 方法 `ide.showFileDiff`）
- 工具卡片的**文件路径可点击**（edit/write/bash 等带 path 参数的工具），
  点击直接在编辑器打开

### 兼容性
- 全程只依赖 platform + JCEF 模块（无 IDEA 专属 API），编辑器动作、
  文件动作、Diff 窗口在全部 JetBrains IDE（WebStorm/PyCharm/GoLand/…，262.*）
  通用

### 测试
- Playwright e2e 19 例（新增 edit 卡片文件链接 + Diff 按钮用例）
- 全量：Kotlin 31、Vitest 19、Playwright 19 全绿

## 0.2.0 — 2026-10-31

IDE 深度集成与体验打磨：编辑器动作、通知、状态栏、多窗口隔离、渲染完整性。

### 新增
- **编辑器动作**：右键 **Pi Agent** 菜单（选中代码时可用）
  — *Explain with Pi* / *Fix with Pi* / *Send Selection to Pi*，自动携带
  `file:line` 与选区上下文注入输入框（可编辑后发送），并激活工具窗
- **后台完成通知**：任务结束时若工具窗不可见，弹气泡通知，点击直达工具窗
- **状态栏 widget**：π 徽标显示 pi 状态（运行中=版本、崩溃=⚠），点击打开工具窗
- **file:line 跳转**：消息里的 `path/file.ext:12` 引用可点击，直接打开编辑器对应行
- **diff 视图**：edit / write 工具调用显示红绿增删行（write 为全新增），
  超 500 行折叠
- **图片回显**：发送的图片在自己的消息气泡与会话回放中显示（缩略图）
- **@ 文件引用补全**：输入 `@` 弹出项目文件浮层（关键词过滤、↑↓/Enter 选择）
- **拖拽图片**：拖入图片文件与粘贴等效
- **代码块 Copy 按钮**：一键复制代码，✓ 反馈
- markdown 链接一律用**系统浏览器**打开（JCEF 拦截导航，不再劫持工具窗）
- React **ErrorBoundary**：前端渲染异常显示错误 + Reload，不再白屏
- **多窗口完全隔离**：每个项目窗口独立 token、独立事件流、独立 pi 进程，
  不再串话；新 bridge 方法 `files.list` / `ide.openFile`，新事件 `ide`

### 修复
- 断连期间长轮询缓冲溢出丢事件无感知：poll 响应带 `oldest` 序号，
  前端检测缺口立即补救（`isStreaming` 不再因此卡死）
- `ensureWired` 并发竞态可重复注册事件监听（加锁）
- 流式进行中切换会话先 abort 再切换
- 斜杠菜单打开时 Escape 只关菜单不清空已输入文本；图片读取失败不再产生
  unhandled rejection
- 管理命令尊重 pi 的 `PI_CODING_AGENT_DIR` 自定义安装目录（此前仅 sessions
  目录尊重环境变量）；登录 shell PATH 探测加 60s 缓存（每条管理命令不再
  重复 spawn 一次 zsh）
- 桥日志不再记录信封内容（可能含用户代码），只记长度

### 测试
- Kotlin 31 例（含 RPC 超时、CLI 大输出、桥鉴权等）
- Vitest 19 例（新增图片块双形状解析、乐观图片去重保留）
- Playwright e2e 18 例（新增 @ 补全、Copy、diff 视图、file:line 链接等 6 例）
- verifyPlugin 通过（含新增 notificationGroup / statusBarWidgetFactory /
  编辑器 action 注册）

## 0.1.2 — 2026-10-31

稳定性热修：资源泄漏、挂死、管道死锁与本地桥安全加固。

### 修复
- **JCEF browser 资源泄漏**：面板未挂入 Disposer 树导致 `dispose()` 永不执行，
  反复开关工具窗会累积 Chromium 实例（现随 content 释放）
- **RPC 请求无超时可能永久挂死**：`pi` 不回包时请求协程与前端双双挂住；
  现在默认 120s 超时（`rpc.request` 可用 `timeoutMs` 覆盖），超时后清理
  pending 表项，迟到响应不会完成已被放弃的请求
- **PiCliRunner 管道死锁**：原先先 `waitFor` 再读输出，子进程输出超过
  ~64KB 管道缓冲时永远无法退出 → 必然超时误报失败（`packageInstall`
  尤其容易触发）；现在并发排水 stdout/stderr，超时路径保留部分输出
- **管理命令不再占用 Default 协程池**：阻塞型 CLI 调用改走 `Dispatchers.IO`

### 安全
- **本地 HTTP 桥加鉴权**：`/bridge` 与 `/bridge/poll` 现在要求随机 token
  （启动时生成，经加载 URL 交给前端）+ 同源 Origin 校验（拦截网页对
  loopback 的 CSRF）；`/bridge/health` 保持开放（无副作用）
- POST /bridge 请求体上限 16MB（防异常请求打爆内存）
- 桥日志不再记录信封内容（可能含用户对话文本），只记长度

### 测试
- Kotlin 31 例（+14）：RPC 超时两条、CLI 大输出/超时/非零退出四条、
  桥鉴权五条、token 生成一条等
- Vitest 收集排除 Playwright spec（此前 `npm test` 误收 e2e 文件报红）
- 全量：Kotlin 31、Vitest 17、Playwright e2e 12 全绿

## 0.1.1 — 2026-10-31

真实 pi 可用性修复与交互打磨。

### 修复
- **GUI 启动的 IDE 中 pi 无法启动（核心修复）**：pi 是 node 脚本，IDE 子进程 PATH
  缺 node 导致 `env: node: No such file or directory` 秒退。现在自动从 pi 的
  安装布局解析 node 解释器并直接以 `[node, pi]` 启动，同时把 node 目录注入
  子进程 PATH（pi 的 MCP 服务器也需要）
- 模型选择器对带 `/` 的模型 ID（如 `openrouter/free`）解析错误
- 真实 pi 的用户消息重复渲染（`message_start` 空 content 去重）
- 上下文占用百分比显示浮点数
- 进程启动不再禁用扩展（`--no-extensions` 移除，MCP/扩展恢复可用）

### 新增
- 模型选择持久化：切换模型后下次启动自动恢复（`--provider/--model`）
- provider 错误可视化：401/404/5xx 直接显示为错误条目，不再静默卡住
- pi 进程崩溃横幅带 **↻ Restart** 一键重启
- **Send 分体按钮**：Steer / Follow-up 队列模式移到按钮下拉上，
  不可用时置灰而非隐藏；运行中 Enter 仍按所选模式排队
- 模型/思考等级选择移至底部工具栏；模型选择器带检索框（空格 = AND 多关键词）

### 测试
- 前端 e2e 12 例、Vitest 18 例、Kotlin 17 例全绿
- 新增真实 pi 全链路 e2e（openrouter/free，`scripts/e2e-ide-real.sh`）

## 0.1.0 — 2026-10-30

首个可用版本（M1–M3 里程碑 + 真机验证）。

### Chat
- `pi --mode rpc` 子进程会话（每项目一个，随项目关闭终止，崩溃展示 stderr 与恢复路径）
- 流式 markdown 回复（marked + DOMPurify + highlight.js，明暗主题跟随 IDE）
- thinking 折叠块、工具调用卡片（参数摘要/可展开输出/耗时/错误标记）
- 运行中 steer / follow-up 排队（含 queue_update 同步与排队提示）
- 自动重试倒计时、compaction 事件条目、手动 Compact
- 斜杠命令补全（扩展命令 / prompt 模板 / skills）
- 图片发送（粘贴或文件选择）
- 会话统计：上下文占用百分比、成本、消息数

### Sessions
- 按项目列出历史会话（解析 session header 的 cwd，兼容 pi 版本演进）
- 一键切换并回放完整历史；重命名当前会话；新建会话

### Manage
- MCP 服务器：列表、新增（stdio/HTTP）、删除、OAuth 登录/登出
- 扩展包：pi list / install / remove
- Skills：扫描三级目录、创建模板
- 认证：provider 汇总 + 逐个 `pi auth check`
- Settings：`~/.pi/agent/settings.json` 内嵌编辑（JSON 校验 + .bak 备份）
- 环境自检：pi 定位（登录 shell PATH）、版本显示、未安装引导

### 工程
- 三层自动化：Kotlin 单测/集成（14）、Vitest 归约器（10）、Playwright 前端 e2e（11）
- 真实 IDEA JCEF e2e：`scripts/e2e-ide.sh`（CDP :9222 + mock pi）
- `verifyPlugin` 通过；目标平台 IntelliJ IDEA 2026.2（262.*）