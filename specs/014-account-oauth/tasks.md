# 014 tasks

- ☑ T1 `pi-login.mjs`：包根解析（realpath 上溯）、ModelRuntime 导入、JSON-lines 交互（prompt/notify/answer/cancel）、getDeviceId、agentName；stderr 转 log 行（真机 pi 1.5.0 冒烟通过）
- ☑ T2 Kotlin `PiLoginSupport`：资源解包、spawn（node 缺失→可读错误）、协议状态机（纯函数）、事件 push（auth_url/device_code 自动开浏览器）、start/answer/cancel、进程树清理
- ☑ T3 BridgeService：`manage.authLoginStart/Answer/Cancel` 三方法；types.ts/manage.ts/mock.ts 同步
- ☑ T4 store：`auth` 事件归约 → `authLogin` 切片；4 项单测
- ☑ T5 ProviderForm：账号路由主按钮 + 进度/链接/复制/取消 + 四型 prompt 渲染；摘「暂未接入」角标；指引卡保留为降级路径（mock 桥全流程实测：started→auth_url→manual_code→提交→done→徽标刷新）
- ☑ T6 i18n：zh/en 新 key；删 `auth.methodBadgeSoon`
- ☑ T7 Kotlin 单测 + web typecheck/260 测试全绿
- ☐ T8 runIde 真机验收（openrouter 全流程 + 取消 + 二次登录互斥）——沙箱已带 0.5.6 启动，待用户浏览器授权实测
- ☑ T9 CHANGELOG 0.5.6 小节 + 提交
