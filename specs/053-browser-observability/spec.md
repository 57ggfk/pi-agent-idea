# Feature Specification: 053 pi_browser 观测面强化（scroll / selector 摘录 / console 回读落盘）

**Feature Branch**: `release/0.5.10-browser-build`

**Created**: 2026-11-21

**Status**: Implemented（本批 TDD 交付；真机清单见 §七，随 0.5.10 发版验证轮执行）

**Input**: 竞品矩阵 `docs/BROWSER_COMPETITORS.md` §三（Cursor 7 子动作、console 落盘可 grep）与本地候选清单 ★1/★2——本批一次协议演进交付两功能：① scroll 子动作 + read 结构化扩展（selector 元素摘录 outerHTML/innerText）；② console 日志按需回读（单调序号 + dropped 计数，返回行数 + 有界预览省 token，附 JSONL 落盘供 grep）。051/052 遗留不并入本批。

## 一、定位

`pi_browser` 现有 open/read/reload 只回 3000 字 innerText 摘录 + 最近 5 条 console 错误：长页看不到滚动后内容、DOM 结构只能靠文字猜、console 超过 5 条即丢失且不能按需翻。本批把「观测面」补齐到 Cursor 同水位的最小闭环：视口滚动、元素级摘录、console 全量按需回读 + 落盘 grep。click/type/截图（候选 #9/#10）留待下一批（M 级，需页面级裸 CDP 管道）。

## 二、User Stories

- **US1 scroll**：agent 对长页调 `scroll`（direction down/up，amount px 钳制 1..10000，默认 down/800px）→ 视口移动，返回与 open/read 同格式的快照（`scrollY` 附在 text 之后）——「验证我构建的 web UI」时滚动后内容可达。
- **US2 selector 摘录**：`read` 带 `selector`（CSS，≤200 字符）→ `document.querySelector` 命中元素按 `format`（html=outerHTML / text=innerText，默认 text）摘录，经既有 cleanText 剥控制字符并封顶 3000 字符；未命中返回 error 字段折为 failure 快照（reason 带选择器原文）。
- **US3 console 回读**：`console`（since/limit）→ `{ok,total,dropped,count,lines,file}`：total/dropped 为内核级单调计数（clear 不归零、仅环形驱逐计 dropped），count 为 since 之后可用行数，lines 为有界预览（默认 20，钳 1..200，每行 `[index] text`）；file 为 JSONL 路径，更早的行由 agent grep。
- **US4 协议可纠错**：未知参数名、非法 direction/format/非数值 amount/limit/since 降级为 model 可读 Invalid（endpoint 200 + `{ok:false,reason}`），模型下轮可自纠；无新参数的请求解析逐字节不变（测试锁定）。

## 三、验收口径（单测已锁定）

- codec：scroll/console/selector 各参数 Valid、钳制与 Invalid 文案（`AgentBrowserRequestCodecTest`）。
- 脚本：`buildReadScript` 无 selector 时与 049 版逐字节一致；selector 分支 querySelector + 转义内嵌 + 未命中 error；`buildScrollScript` 仅 `window.scrollBy`（不写 DOM、不含 token/bridge）、up 为负位移、构造端钳制（`PageSnapshotSanitizerTest`/`PageScrollTest`）。
- 缓冲：单调序号 total、环形驱逐 dropped、since 窗口、容量 300、sink 锁外回调、severity 过滤与 LogSafe 截断不变（`BrowserConsoleBufferTest`）。
- 落盘：JSONL 每行 `{ts,seq,index,text}`、空白行不写、超 maxFileBytes 轮转、keepRotated 封顶且最新行总在主文件（`ConsoleLogFileTest`）。
- 响应：快照 049 字段序不变（scrollY 插 text 后、selector 回显 url 后）；console 响应 ok/total/dropped/count/lines/file 与空 buffer ok:true+reason（`AgentBrowserToolResponseTest`、`AgentBrowserToolPollTest` 失败文案）。
- 全量：`gradlew test` 537 tests / 0 failures / 0 errors（2026-11-21 本机实跑）。

## 四、Non-goals（本批不做）

- click/type/对话框处理与截图回流（候选 #9/#10，M 级，下一批）。
- network 请求记录（需 CDP Network 域，另算）。
- console **全部**级别（info/debug）进缓冲——保持 error/warning 过滤（模型要的是「哪里错了」）。
- 跨 IDE 重启的 console 历史（文件随 IDE system 目录生命周期，不迁移）。
- per-tab console 文件隔离（单 IDE 运行一个滚动文件；行内 index 为页内序号，grep 按文本）。

## 五、硬约束与隐私边界

1. **单 JS bridge 不破（049 D4 措辞演进）**：D4 由「唯一 JS bridge 只读快照」演进为「只读 DOM + 视口滚动」——同一 `JBCefJSQuery` 通道承载 read 快照 / console+dialog tap / scroll 结果（`kind` 分发），`window.scrollBy` 是该通道唯一允许的变更动作；不引入第二个 bridge，无 token、无 BridgeService 关联（`PiBrowserKernel` 类注释同步改写）。
2. **F-201 口径：console 行含 URL 的隐私边界**（对应 048 spec §四 F-201「需先做 URL 隐私决策」的处理方式）：console 行（尤其资源加载失败）常携带页面 URL 与 query。落盘决策：只写 IDE system 目录（`PathManager.getSystemPath()/pi-agent/browser-console/`，机器本地、不随仓库/会话导出）、只存 `LogSafe.truncate` 后的行（≤200 字符、单行化、severity 过滤在前）、超限轮转封顶磁盘、**绝不写 idea.log**（048 硬规则 8，`ConsoleLogFile` 全类不调用日志 API）；文件属用户私有材料，用户可整目录删除。与 idea.log 的 URL 脱敏（`LogSafe.url`）不同，文件面向模型消费（F-103 口径：模型而非日志文件读取），保留原文以保 grep 价值。
3. **只在 LOADED 后注入**：scroll/read 与 tap 同在 LoadEnd 后的通道之上执行；无页/崩溃/启动中/单飞冲突一律即时失败快照（model 可读 reason），不悬挂。
4. **尽力而为落盘**：磁盘满/锁定静默忽略，内存缓冲始终权威——落盘故障绝不影响页签或工具响应。
5. **前向兼容**：pi-browser.js 与插件同版本分发（schema 与 codec 同批演进）；旧 pi 进程拿到旧 schema 也只少用新参数，不报错。

## 六、实现位（文件索引）

| 关注点 | 文件 |
|---|---|
| 协议解析/钳制/Invalid 文案 | `src/main/kotlin/dev/pi/agent/browser/AgentBrowserRequest.kt` |
| read selector 脚本 + JS 字符串转义 | `src/main/kotlin/dev/pi/agent/browser/PageSnapshot.kt` |
| scroll 脚本 + ScrollResult 解析 | `src/main/kotlin/dev/pi/agent/browser/PageScroll.kt` |
| 缓冲单调序号/dropped/since/sink | `src/main/kotlin/dev/pi/agent/browser/BrowserConsoleBuffer.kt` |
| JSONL 落盘/轮转/F-201 边界 | `src/main/kotlin/dev/pi/agent/browser/ConsoleLogFile.kt` |
| kernel scrollPage/consoleWindow/sink | `src/main/kotlin/dev/pi/agent/browser/PiBrowserKernel.kt` |
| tool scroll/console 分支 + 纯响应映射 | `src/main/kotlin/dev/pi/agent/browser/AgentBrowserTool.kt` |
| pi 侧 schema/formatConsole | `src/main/resources/pi-browser/pi-browser.js` |
| 测试位 | `src/test/kotlin/dev/pi/agent/browser/{AgentBrowserRequestCodecTest, PageSnapshotSanitizerTest, PageScrollTest, BrowserConsoleBufferTest, ConsoleLogFileTest, AgentBrowserToolResponseTest, AgentBrowserToolPollTest}.kt` |

## 七、真机清单（Windows IDE + pi 会话；本批未执行，随 0.5.10 发版验证轮回归）

- [ ] 长页 `scroll` down/up：scrollY 变化、返回快照 text 反映滚动后内容、up 到顶后 scrollY=0 不为负。
- [ ] `read` selector 命中（html/text 两格式）与未命中（reason 含选择器原文）两路。
- [ ] 制造 >5 条 console 错误：`console` 回读 total/dropped/lines 与 ride-along 尾部一致性；file 路径可 grep（含被 300 容量驱逐的旧行）。
- [ ] `read` 无参数行为与 049 一致（响应字段序逐字节回归）。
- [ ] limit/since 分页：since=last index 翻页至 count=0，reason 文案可读。
- [ ] 048 硬规则 8 复核：idea.log 无 console 行/无落盘路径明文。
