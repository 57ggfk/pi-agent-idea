# 014 账号登录真授权（浏览器 OAuth）

> 来源：013 US2 的遗留项——账号分段常驻「暂未接入」角标，指引卡只给终端命令。
> 版本归属：0.5.6。关联：88d3190（/login 式表单）、3b10a01（spec 013）、012 US5/US6（凭据）。
> 调研存档：pi SDK `ModelRuntime.login` 已在 1.4.0/1.5.0 双版本核实（T103 + 2026-11-08 复核）。

## 背景

终端 `/login` 的账号流程由 pi 驱动浏览器 OAuth；插件此前只能在指引卡里复制命令/开终端。pi 公开导出 `ModelRuntime`（`@earendil-works/pi-coding-agent/dist/index.js`），其 `login(providerId, "oauth", interaction, {getDeviceId})` 完整实现各 provider 的浏览器授权：起 loopback 回调服务（如 openai-codex 127.0.0.1:1455，仅登录期）、发 `auth_url`/`device_code` 事件、`manual_code` 粘贴兜底；凭证由 pi 按 proper-lockfile 写 auth.json（插件 `PiCredentials` 已复刻同款目录锁，天然共存）。

关键约束：**插件不打包 pi SDK**——运行时从用户已装的 pi 包根导入（`pathToFileURL` 自 pi 二进制 realpath 向上找 `package.json`），登录代码与 CLI 出自同一安装，零版本漂移。pi 未装/过老/导入失败 → 降级回现有指引卡。

## User Stories

### US1 一键浏览器授权

认证表单选 OAuth provider + 「账号登录」后，主按钮「通过浏览器登录」直接发起授权：Kotlin 解包资源 `pi-login/pi-login.mjs` 到配置目录，用 `PiLocator.nodeInterpreterFor` 找 node 起子进程，`.mjs` 内导入用户 pi 的 `ModelRuntime` 并调用 `login`。回调 URL 事件（`auth_url`）触发 IDE 侧自动打开系统浏览器，面板同步展示链接 + 说明 + 复制按钮；`device_code` 事件展示 userCode + verificationUri（同样自动开浏览器、可复制码）。

### US2 交互 prompt 面板内闭环

`interaction.prompt`（text/secret/select/manual_code 四型）经 JSON-lines 桥到面板内渲染：text→文本框、secret→密码框、select→选项按钮、manual_code→「粘贴最终回调 URL」输入框（placeholder 即回调地址）。提交经桥回填子进程 stdin，登录继续。整个流程不出面板；「取消」随时可停（stdin cancel + 进程树销毁）。

### US3 完成态与降级

成功：凭证由 pi 写入 auth.json（带锁），面板刷新 authOverview、行徽标变「账号」，表单走 onDone；失败（导入失败/用户取消/授权被拒/EADDRINUSE）：面板如实显示 pi 的错误文案（含「端口被占用，先取消那个登录」这类现成可读信息），指引卡保持可见作为降级路径。api_key 路径不动（仍走 `authSet` 直写）。

### US4 并发与生命周期

同一时刻仅允许一个登录会话：进行中再点开始 → 明确报错不叠进程。登录子进程独立于 pi 会话进程，IDE 关闭时随之销毁；面板切换 tab 不中断进行中的授权（事件进 store，回到表单仍在）。

## 非目标

- api_key 走 `rt.login("api_key")`（现直写路径已覆盖，ambient-only provider 会抛错）。
- 登录后 token 刷新的 UI 展示（pi 请求期自动刷新，插件不感知）。
- managed/oauth2 设备码轮询的自绘进度条（pi 事件即进度）。
- 未装 pi 时的引导安装（Manage → Environment 已有）。
