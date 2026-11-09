# 014 tasks

- ☑ T1 `pi-login.mjs`：包根解析（realpath 上溯）、ModelRuntime 导入、JSON-lines 交互（prompt/notify/answer/cancel）、getDeviceId、agentName；stderr 转 log 行（真机 pi 1.5.0 冒烟通过）
- ☑ T2 Kotlin `PiLoginSupport`：资源解包、spawn（node 缺失→可读错误）、协议状态机（纯函数）、事件 push（auth_url/device_code 自动开浏览器）、start/answer/cancel、进程树清理
- ☑ T3 BridgeService：`manage.authLoginStart/Answer/Cancel` 三方法；types.ts/manage.ts/mock.ts 同步
- ☑ T4 store：`auth` 事件归约 → `authLogin` 切片；4 项单测
- ☑ T5 ProviderForm：账号路由主按钮 + 进度/链接/复制/取消 + 四型 prompt 渲染；摘「暂未接入」角标；指引卡保留为降级路径（mock 桥全流程实测：started→auth_url→manual_code→提交→done→徽标刷新）
- ☑ T6 i18n：zh/en 新 key；删 `auth.methodBadgeSoon`
- ☑ T7 Kotlin 单测 + web typecheck/260 测试全绿
- ☐ T8 runIde 真机验收（openrouter 全流程 + 取消 + 二次登录互斥）——首轮验收缺陷已修：**登录中折叠表单再展开像卡死**（running 态禁用 picker/开始键，而「取消登录」藏在指引块里）。修复：表单显式收起/切换（收起表单、编辑切换）即取消运行中登录（tab 切换仍不中断，US4）；方法分段运行中锁定（取消按钮始终可见）；运行行带 provider 名（「正在等待 {{provider}} 的浏览器授权…」）。mock 桥复验：折叠→取消→再展开全可操作。待复验真授权。
- ☑ T9 CHANGELOG 0.5.6 小节 + 提交
