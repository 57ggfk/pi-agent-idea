# 024 会话列表行内动作重排 — Tasks

> 每个 task 自带「— 验证」，绿了立刻提交。024 拥有 T6xx 编号段。

- [x] **T601** T001 探针：`pi --fork` 语义取证（产出物/退出行为/落盘目录/auth/名字继承），结论写进
  plan.md §0 并落一份证据文件 `specs/024-session-list-actions/fork-probe.json`。
  — 验证：`fork-probe.json` 存在且含 P1–P6 六项答案；方案 A 成立（探针 P2 显示 rpc+EOF 自退），
  不降级方案 B。

- [x] **T602** Kotlin：`PiSessionIndex.findNewFork(sourceFile, before)` + `forkArgs(file)` 纯函数 +
  路径在 root 内的校验；`BridgeService.dispatch` 增 `sessions.fork` 路由与 `sessionsFork`
  （30s 超时、stdinText=""、workingDir=project.basePath、响应 `{ok,file}`）。
  — 验证：`src/test/...` 新增 forkArgs 参数断言与 findNewFork 临时目录夹具两条，`./gradlew test --tests
  "*PiSessionFork*"`（或对应类）绿；全量 `./gradlew test` 无回归。

- [x] **T603** 桥接四处同步：`web/src/bridge/types.ts` 增 `"sessions.fork"`；mock.ts 实现（新行继承源
  名、`?forkfail=1` 失败旋钮）；`METHOD_SOURCE` 记账。
  — 验证：`npx vitest run mock.test.ts` 增一条「sessions.fork 生成新行且名字继承」绿；typecheck 0 错。

- [x] **T604** store：`copySessionInfo`（FR-001/002）+ `sessionsNotice` state（4s 自动清）。
  — 验证：store.test.ts 三行逐行 copy 断言 `copyText` 实收 `标题N\nIDN` 且互不相同；缺 id 用例只复制
  标题并出 notice；复制失败出 error notice。`npx vitest run store.test.ts` 绿。

- [x] **T605** store：`forkSessionFromList` 替换 `cloneSession`——当前会话走 `clone`（无 sessionPath）+
  `applyForkSuffix`；非当前会话走 `sessions.fork`（30s 超时）+ `sessions.rename` 后缀 + 刷新；单飞闸
  `forkingFile`；失败可见、busy 复位（FR-004/005/006/007）。
  — 验证：store.test.ts 四条绿——非当前行 fork 发出的命令序列（fork/rename，无 switch_session/clone）、
  当前行 fork 发 `clone` 且 params 无 sessionPath、单飞（跨行第二次出提示、同行连点只发一次）、
  失败路径（busy 复位、列表不变）；旧 clone 用例删除/改写后全绿。

- [x] **T606** UI：SessionsView 行内动作重排（session-copy / session-fork 两按钮 + busy spinner +
  其余行 busy 提示 title）+ `sessions-notice` 横条 + styles + i18n（zh/en：copyTitle/forkTitle/
  forkBusyOther/notice 文案）。
  — 验证：`npm run typecheck` 0 错；`npx vitest run` 全绿；组件行为由 T607 e2e 锁。

- [x] **T607** e2e：新增 `web/e2e/session-list-actions.spec.ts`（剪贴板 stub 收三段互异文本、行 fork
  后新行出现且当前会话未切走、fork 失败 notice、忙碌态与单飞提示）；改写 `sessions.spec.ts` 里所有
  `session-clone` 引用为 `session-fork`。
  — 验证：`npx playwright test session-list-actions sessions` 全绿；grep 全仓无残留 `session-clone`。

- [x] **T608** 收尾：全量三件套 + `./gradlew test`；写 `changelog.d/024-session-list-actions.fixed.md`
  （两行）；更新 run-report 第 1/2 节。
  — 验证：typecheck 0 错 + vitest 全绿 + playwright 全绿 + gradlew test 全绿；run-report 024 全 ✅。
