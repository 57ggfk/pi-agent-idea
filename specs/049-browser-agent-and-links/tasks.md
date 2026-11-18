# Tasks: 049 内置浏览器 P1（agent 融合 + 链接多选项）

> 每 task 自带「— 验证：…」（宪法 II：无断言覆盖不得标记完成）。阶段顺序见 plan §实现顺序；每个 task 绿了立刻提交（纪律）。

## 阶段 A 链接多选项选择器

- [x] A1 `LinkRouting.linkOptions()`：纯函数返回 3 选项（SYSTEM_BROWSER / EMBEDDED / COPY，顺序锁 spec Q3）+ `LinkOption` 枚举（label 走 bundle 键、icon、执行语义注释）。
  — 验证：单测（数量=3、顺序、每项映射语义）；`gradlew test --tests "*LinkRouting*"` 绿。
- [x] A2 `PiAgentPanel` AskUser 分支换 JBPopup 选择器（D5：鼠标坐标显示、Esc 关闭无动作、复制项走 CopyPasteManager、SYSTEM/EMBEDDED 执行体逐字不动）+ 设置文案 D6 + 双语字典。
  — 验证：单测既有 `routeExternalLink` 回归不动；grep 双语键成对；真机清单 049-1/2/3 全过（真实点击）。
- [x] A3 真机提交点：ASK 选择器三选项逐项验证 + 默认态零变化回归（049 真机清单 1–3）。
  — 验证：截图入 run-report；默认态行为与 0.5.9 逐字一致。

## 阶段 B agent 融合

- [x] B1 `PiBrowserKernel.readPage`（D4）：currentTitle 缓存 + JBCefJSQuery 只读快照注入 + orTimeout(10s) + 文本清洗纯函数（控制字符/3000 截断）。
  — 验证：清洗纯函数单测（控制字符/截断/空 body）；无浏览器/CRASHED → 立即失败结果单测；`gradlew test` 绿。
- [x] B2 `LocalUiServer` `/agent-browser` 端点（D2）：per-project token 登记 + Origin/token 鉴权 + bridge-token URL 拒绝 + open 等待状态轮询（≤15s）+ 响应 JSON 形状 + 零日志。
  — 验证：单测（token 拒绝、bridge-token URL 拒绝全 action、未知 action、请求解析）；真机 curl：无 token 403 / 带 token open 一个 data: 或本地页返回 JSON（真机清单 049-8 辅助）。
- [x] B3 孵化接线（D3/D1）：`pi-browser.js` 扩展（registerTool + fetch + 防御旧版）+ `PiBrowserToolSupport.ensureExtensionInstalled` + `PiProcessManager` env 两枚 + `BrowserPanel`/`PiBrowserManager` 的 agentOpen/Read/Reload（D8）。
  — 验证：`node --check pi-browser.js` 绿；扩展提取后文件存在且内容含 `pi_browser`；Kotlin 侧单测全绿。
- [x] B4 pi rpc 离线冒烟：`pi --mode rpc` 真起进程（带新 env 与扩展），确认 `pi.getAllTools()` 含 `pi_browser` 且 execute 打到端点。
  — 验证：探针脚本输出工具名；端点收到请求（本地 curl 对照形状一致）；无 UI 环境下 fetch 失败返回明确文本。
- [x] B5 真机完整链路（spec US3/US4 验收）：真实键鼠在聊天输入验证指令 → AI 起 server → pi_browser open → 页签前台打开 → 读回 → 汇报；反向端口失败用例（真机清单 5/6）。
  — 验证：截图 + pi 工具调用记录入 run-report；浏览器页签加载 localhost 页与 AI 汇报一致。

## 阶段 C 收尾

- [x] C1 工具条「在系统浏览器打开」按钮（D7）+ tooltip 双语。
  — 验证：真机清单 049-4；`gradlew test` 全量绿。
- [x] C2 全量回归：`gradlew test` / `vitest` / `playwright` + `verifyPlugin`。
  — 验证：数字入 run-report（对照基线：e2e 405 / vitest 502）；基线变化逐条注明「非回归」。
- [x] C3 `MANUAL_TEST.md` 049 段逐条留痕 + `changelog.d/` 碎片（两行中英）+ run-report 段落。
  — 验证：清单逐条打勾或注明跳过原因；碎片格式合规。

## 交付边界

阶段 A = 用户可见的链接选择器（可独立发版价值）；阶段 B = agent 融合完整链路（本轮核心）；阶段 C = 收尾。B5 未真机走通不得勾 B5（实现完没做真机验证 = 没完成）。

> **执行留痕（2026-11-19）**：真机 A3 全项 PASS（选择器三选项/复制/Esc/默认态零变化，真实键鼠）；B5 正向 PASS（AI 自主 miniconda 起 8931 → pi_browser open → 读回 PI-BROWSER-PROBE-TITLE）；B5 反向抓出 open 竞态真 bug（误报 tool window unavailable）→ pollUntil 修复 + 3 单测，复验 PASS（读回 ERR_CONNECTION_REFUSED 错误页如实汇报）；顺手修窄工具窗地址栏塌缩（048 遗留）。C2：Kotlin 433/0、vitest 502/502、e2e 405/405、verifyPlugin 五版本 Compatible。分支改名 release/0.5.10-browser 并吸收 031 探索线 + 全部探针成果入库（用户指令）。
