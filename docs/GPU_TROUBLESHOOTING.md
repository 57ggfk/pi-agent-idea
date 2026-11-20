# 内嵌浏览器空白：JCEF GPU 崩溃的排查与处置

> 适用版本：0.5.10 起（052 批次）。
> 症状：DevTools 弹窗、HTML 预览页或 Pi Agent 面板打开后一片空白；DevTools 窗口甚至会在几十秒后自己消失。

## 一句话结论

空白大多不是插件的 bug，而是本机 GPU 进程在反复崩溃：GPU 一死，合成层拿不到 command buffer，
窗口就只剩白底；崩溃次数超过平台阈值后，IDE 会销毁整个 CEF 进程树，DevTools 窗口随之消失。

## 怎么确认

1. `Help → Show Log in Explorer` 打开 `idea.log`。
2. 看 JCEF 的 Chromium 日志 `log/jcef_chromium_<pid>.log`（默认是空的——平台
   默认把日志级别设成 `disable`；插件会在你没设过级别时自动抬到 `error`，
   自己看的话在 VM 参数里加一行 `-Dide.browser.jcef.log.level=error`）：
   - `GPU process exited unexpectedly: exit_code=…` —— GPU 进程崩溃；
   - `Failed to send GpuControl.CreateCommandBuffer` —— 合成层拿不到画面。
3. 看进程树：IDE 的 JCEF 服务进程下面挂着 `cef_server.exe --type=gpu-process`，
   PID 每隔几秒就换一次 —— 那就是在反复重启。

## 插件现在会做什么（052）

插件读 JCEF 的 Chromium 日志（IDE 日志目录下的 `jcef_chromium_<pid>.log`；2024.3 默认落在
用户主目录），盯每一次 GPU 崩溃记录（`GPU process exited unexpectedly`）：

- 60 秒内记到 3 次 GPU 崩溃 → 弹一次通知；
- 通知带「**禁用 GPU 并重启 IDE**」一键按钮：翻转平台自己的注册表键
  `ide.browser.jcef.gpu.disable=true` 并重启 IDE——用户不需要改任何配置文件；
- 另附「**手动怎么修**」按钮，列出下面两种手动办法；
- 一次 IDE 运行最多提醒一次，正常路径零打扰。
- 为了让日志里真的有东西，插件在**你没设过日志级别**时把 JCEF 日志级别抬到 `error`
  （只留错误级，文件很小：实测 3 次 GPU 崩溃共 381 字节）。你若自己设过级别
  （`ide.browser.jcef.log.level`），插件一律不动它。

> 日志级别在**第一个浏览器创建时**就被冻结。若那时已有别的组件建过浏览器，插件就改不动
> 级别，这次会话可能看不到提示——插件会在 `idea.log` 里留一行 WARN 说明这一点。
> 想每次都生效，用 VM 参数 `-Dide.browser.jcef.log.level=error` 固定下来。

平台的原生阈值是 GPU 进程启动 10 次（`ide.browser.jcef.gpu.infinitecrash.internallimit`，
默认 10），到点后 IDE 会销毁整个 CEF 进程树。插件的阈值更早（3 次崩溃 / 60 秒），
目的是在 IDE 自己拆掉浏览器栈之前先把原因和修法交到用户手上。

> 平台自己的通知（`Too many restarts of the GPU process (JCEF)`）在 233–263 都有；
> 插件这条是**更早、更贴场景**的补充，说的也是同一件事。

## 手动处置（两种办法，都需要重启 IDE）

1. **注册表**：`Help → Find Action → Registry`，搜索 `ide.browser.jcef.gpu.disable`，设为 `true`。
   平台在 GPU 反复崩溃时走的就是这条路径。
2. **VM 参数**：`Help → Edit Custom VM Options`，加一行

   ```text
   -Dide.browser.jcef.gpu.disable=true
   ```

   注意：Windows 上真正生效的可能是 `IDEA_VM_OPTIONS` 指向的 vmoptions 文件，
   `%APPDATA%\JetBrains\<IDE>\idea64.exe.vmoptions` 不一定被读取。

代价：IDE 内所有 JCEF 内嵌浏览器（Pi Agent 面板、HTML 预览、Markdown 预览、DevTools……）
都改用软件渲染，滚动和动画会慢一些，但不再白屏。

## 容易混淆但不同的现象

- **面板整体空白 + IDE 弹「IDE Internal Errors」**：那是 050/051 批次的浏览器失活与崩溃保护，
  与 GPU 无关，见 README「排障」。
- **DevTools 里看不到任何内容但窗口有 UI**：先看是不是上面这条 GPU 问题；
  JCEF 的 DevTools 走 GPU 合成，而 OSR 的预览页走软渲染，所以**只有 DevTools 白**是 GPU 崩溃的典型指纹。
- **CDP / 外部 DevTools**：`ide.browser.jcef.debug.port` 默认 `-1`（关闭），
  插件不依赖它；只有想用外部 DevTools 前端时才需要手动开。
