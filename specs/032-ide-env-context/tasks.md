# Tasks: 032 自动读取 IDE 运行/构建环境并注入 pi

> 每个 task 带「— 验证」；task 绿即提交，当场勾选并补 run-report。

- [ ] T1301 plan.md + tasks.md 落盘，run-report 补 032 行与 task 清单 — 提交即证
- [x] T1302 快照纯函数：`PiEnvSnapshot.render`（时间戳+档位标注+构建工具命令建议）与
      `filterEnvVars`（白名单+黑名单双闸、值截断）+ `PiEnvSnapshotTest`
      （假档位渲染固定文本、GITHUB_TOKEN/DB_PASSWORD 不出现而 JAVA_HOME 保留、
      三档全空输出未检测到不抛异常）— `gradlew test --tests "*PiEnvSnapshot*"` 绿
- [x] T1303 采集与编排：`PiIdeEnv.collectTiers`（A 档 projectSdk+语言级别反射、B 档
      System.getenv、Node 反射档降级、PyCharm 由 A 档覆盖）+ `refreshSnapshot` 写盘 +
      `BridgeService.rpcRequest` prompt 拦截 + pi start 后台首采 —
      `gradlew test` 全量绿（PiIdeEnvTiersTest 10 用例）
- [x] T1304 env 差量补齐：`applyToProcess`（只增不改、PI_IDE_ENV_SNAPSHOT）+
      `PiProcessManager.start()` 接线 — `PiIdeEnvTiersTest` 覆盖（不覆盖已有值、
      黑名单剔除、PI_IDE_ 前缀断言）
- [x] T1305 扩展：`resources/pi-env/pi-env.js`（before_agent_start 追加、enabled/缺文件
      降级、string/array 两形状兼容）+ `PiIdeEnvExtension.ensureExtensionInstalled` +
      扩展列表接线 + web vitest import 资源断言行为 —
      `npx vitest run src/pi-env-extension.test.ts` 8/8 绿 + gradlew 全量绿
- [ ] T1306 设置开关：`PiAgentSettings.envContextEnabled`（默认 true）+ Configurable
      复选框 + Bundle 文案（en/zh_CN）+ 关闭时重写快照 — `gradlew test` 全量 SUCCESSFUL
- [ ] T1307 web 只读入口：`manage.envSnapshot` 桥接路由 + SettingsPanel「环境快照」
      只读块 + i18n en/zh + e2e（mock 固定文本→点击→pre 展示）—
      `npm run typecheck` + `npx vitest run` + `npx playwright test e2e/manage.spec.ts`
- [ ] T1308 收尾：三件套全量（gradlew test / vitest / e2e）+ `verifyPlugin` +
      `changelog.d/032-*.md` 两行碎片 + run-report 第 14 节 + spec 验证计划回填
- [ ] T1309（真机）r29 装包探针：快照文件存在且 collectedAt 随消息更新、pi 回复正常
      无扩展报错、WebStorm 缺 SDK 档降级（US5）、开关关闭后快照 enabled:false
      — probe-032-env.mjs verdict 入库
