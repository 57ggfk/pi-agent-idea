# 027 自定义 Provider — Tasks

> 027 拥有 T9xx 编号段。

- [x] **T901** Kotlin `manage/PiModels.kt`：providerGet（掩码不出明文）/providerSave（校验、内置与
  重名拒绝、读-改-写合并保留未知字段、备份、原子写）/providerDelete/providerTest + 纯函数
  `buildThinkingLevelMap` + `BUILTIN_PROVIDERS` 常量。
  — 验证：新增 `PiModelsTest`（级别映射 3 组合、新建/合并/重名拒绝/编辑保 key/删除），
  `./gradlew test --tests "*PiModels*"` 绿。

- [x] **T902** `BridgeService.kt`：4 路由 + `providerSaveWithReload`（成功后 reloadModels，失败附
  `reloaded:false, reloadError`，不回滚文件）。
  — 验证：`./gradlew test` 全量绿；typecheck（web）在 T903 后一并绿。

- [x] **T903** 桥接四处同步：`types.ts` 4 方法、`manage.ts` 函数与类型、`mock.ts` 实现
  （`?providertest=401|timeout` 旋钮、save/delete 改内存表并注入 picker 模型、掩码口径）。
  — 验证：`mock.test.ts` 新增（save→get_available_models 出现新模型；test 两形态；响应无明文 key）
  绿；typecheck 0 错。

- [x] **T904** `lib/customProvider.ts`（级别常量/默认、validateCustomProvider）+ 单测；
  `CustomProviderForm.tsx`（FR-001 全字段 + 思考级别勾选展开 + 高级 thinkingFormat 折叠 +
  测试连通 + 编辑回填掩码 + 重名二次确认条）。
  — 验证：`npx vitest run customProvider` 绿；typecheck 0 错；组件行为由 T906 e2e 锁。

- [x] **T905** AuthPanel 入口（新建按钮 + 自定义行编辑/删除，删除走确认框）；
  ProviderSetupCard 折叠「自定义 Provider…」复用**同一**组件（FR-009）。
  — 验证：`npx vitest run` 全绿；`npx playwright test provider` 既有用例零回归。

- [ ] **T906** e2e：新增 `web/e2e/custom-provider.spec.ts`（全流程保存→picker 出现→掩码回填→
  重名二次确认→编辑不改 key→删除→测试连通两形态→无明文 key）。
  — 验证：`npx playwright test custom-provider` 全绿；`npx playwright test provider setup` 零回归。

- [ ] **T907** 收尾：全量三件套 + `./gradlew test`；`changelog.d/027-custom-provider.added.md`（两行）；
  run-report 更新。
  — 验证：全部绿；run-report 027 全 ✅。
