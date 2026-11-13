# 033 tasks（T1401+）

> 完成判据：每个 task 自带「— 验证：…」；无断言覆盖不得勾选。执行记录 → `specs/0.5.8-run-report.md` 033 段。

## Phase 1 Kotlin 清单基础

^- [x] **T1401** `PiPackages.parsePiList`：解析作用域标题/源行/路径行 → `Entry{source,scope,path,broken}`；容错（未知行忽略、空输出、`No packages installed.`）
  — 验证：PiPackagesTest 覆盖 user/project/混合/broken/空 五类样本（样本取自 probe P3/P13/P18 原文）
^- [x] **T1402** `readInstalledVersion(path)` + `npmName(source)` + `encodeName(name)`（scoped 转义）
  — 验证：单测覆盖正常/缺 package.json/坏 JSON/`npm:@a/b@1.2.3` 归一化
^- [x] **T1403** `PiManage.packagesList()` 重写为结构化 `entries`（含 version/broken）
  — 验证：PiManageTest 更新；手动对真机 `pi list` 输出断言结构

## Phase 2 registry 链 + 预检

^- [x] **T1404** `PiUserPrefs.registryOverride` + `BridgeService.getPrefs/setPrefs` 带键
  — 验证：PiUserPrefs 既有测试模式补断言（null 往返、URL 往返）
^- [x] **T1405** `PiPackages.registryChain`（显式 > `npm config get registry` 缓存 > 默认官方）+ `PiCliRunner.run(extraEnv)`
  — 验证：单测 fake `configuredRegistry` 断言三级解析；PiCliRunnerTest 断言 env 注入
^- [x] **T1406** `PiPackages.preflight`（共享 HttpClient，connect 4s/总 5s，成功 30s 缓存）+ `PiManage.packageInstall/UpdateAll` 接预检（失败 `{ok:false,code:"offline"}` 不 spawn）+ 显式 registry 时注入 `NPM_CONFIG_REGISTRY`
  — 验证：单测用 fake reachability 断言 offline 不调用 runner（runner 注入 spy）；真机断网探针补 run-report

## Phase 3 检测与升级

^- [x] **T1407** `PiManage.packageCheck({source})`：pi list 重解析 → installed；npm 走 `latestVersion`（`/latest` 404 → packument dist-tags 兜底；401→reason:"auth"；预检失败→reason:"offline"）；git/local → reason:"git-ref"/"local"
  — 验证：单测 fake fetcher 覆盖 up-to-date/upgradable/unknown×4 种 reason
^- [x] **T1408** ✂ 删除 `manage.packageUpdate` RPC 四处（BridgeService/PiManage/manage.ts/mock.ts）
  — 验证：全仓 grep `packageUpdate` 仅剩 `packageUpdateAll`；编译通过
^- [x] **T1409** 升级通路约定落档（web 用 `packageInstall({source:"npm:<name>@<latest>"})`）+ install 成功后校验契约（web 重读清单比对版本）
  — 验证：plan §1 已写；e2e T1425 断言版本变化与「未生效」提示路径

## Phase 4 市场适配器

^- [x] **T1410** `PiPackages.marketSearch`：search API 请求 + 映射卡片字段（badges 按 `pi-*` 关键词）+ 分页（size/from，50/页）
  — 验证：单测用 P15 真实样本 JSON 断言映射与 badges
^- [x] **T1411** 端点探测降级：`keywords:` 空且无词 → 纯文本 `pi-package`；404/401/超时 → `code:"unavailable"/"auth"/"offline"`；探测结论按 registry 缓存
  — 验证：单测 fake fetcher 断言降级顺序与缓存（第二次调用不再发 keywords 请求）
^- [x] **T1412** `BridgeService` 注册 `manage.marketSearch`/`manage.packageCheck`、`manage.ts` 类型与 api、mock 实现
  — 验证：typecheck 通过；mock.test.ts 补三方法行为断言

## Phase 5 已装清单 UI

^- [x] **T1413** PackagesPanel 重写：结构化行（源串/版本 chip/作用域/状态）+ 保留既有 testid 兼容面
  — 验证：typecheck；现有 packages e2e（安装/卸载/全部升级/空态）改写后全绿
^- [x] **T1414** 行内「检测版本」三态内联展示 + 「升级」（仅 upgradable 可用）+ broken 行「重装」
  — 验证：vitest（mock.test.ts）+ e2e：检测→升级→版本变化
^- [x] **T1415** CLI 输出「人话主文案 + 详情折叠」（FR-014）：offline/unavailable/auth 按码渲染，原始输出进 `<details>`
  — 验证：e2e 断言主文案无 npm error 原文、details 内有原文
^- [x] **T1416** 升级未生效提示（重读清单版本不一致时）
  — 验证：mock 旋钮模拟「install ok 但版本未变」→ 提示出现

## Phase 6 市场 UI + registry 设置

^- [x] **T1417** MarketplacePanel：搜索/分页/四态（loading/空/offline/unavailable）+ 已安装禁用
  — 验证：e2e：fixture 卡片字段、翻页、搜索过滤、已安装禁用
^- [x] **T1418** 市场安装确认框（展示完整 `npm:<name>` 源串）→ `packageInstall`
  — 验证：e2e：确认框出现、确认后 outcome 展示
^- [x] **T1419** registry 选择行（跟随/官方/国内镜像/自定义 + 校验失败提示）经 prefs 持久化
  — 验证：e2e：切换→重开面板保持；单测 registry 链已覆盖 Kotlin 侧
^- [x] **T1420** i18n 双语键（en/zh 同步，~35 键）+ 千分位下载量（复用 031 format）+ 相对时间格式化
  — 验证：i18n.test.ts 全绿；vitest 相对时间断言
^- [x] **T1421** styles.css：页签/卡片/registry 行/状态徽章样式
  — 验证：e2e 截图冒烟（market 卡片可见、无布局溢出）

## Phase 7 e2e + 全量回归

^- [x] **T1422** manage.spec.ts 改写：update 两条（检测→升级流、失败详情）+ packages 018 组适配结构化契约
  — 验证：manage.spec 全绿
^- [x] **T1423** 新增 e2e 组：市场（分页/搜索/已安装/四态）、离线快速失败、私服降级（unavailable/auth）、registry 持久化、broken+重装
  — 验证：playwright 新组全绿
^- [x] **T1424** mock.test.ts / jcef 相关 vitest 全绿；typecheck 0 错
  — 验证：`npm run typecheck && npm test`
^- [x] **T1425** 全量回归基线：`./gradlew test` + `npx playwright test`（全量 3xx 条）零非预期回归；基线变化逐条注明
  — 验证：run-report 033 节记录基线数字

## Phase 8 verifyPlugin + 真机

^- [x] **T1426** `./gradlew verifyPlugin`：无 internal API 命中
  — 验证：SUCCESSFUL 输出留档
^- [x] **T1427** 真机 CLI 链路（沙箱 `PI_CODING_AGENT_DIR`）：真实 pi list 解析→面板显示；检测→升级闭环；npmmirror registry 检测
  — 验证：探针脚本输出留 run-report
^- [x] **T1428** runIde + CDP 真机 e2e：包面板真机冒烟（真 pi、真 web、真 Kotlin 桥）
  — 验证：CDP 探针断言留 run-report；不可自动化的目视项列 MANUAL_TEST
^- [x] **T1429** 断网真机探针（离线预检 ≤5s、市场/安装/升级友好失败）
  — 验证：探针输出留 run-report

## Phase 9 收尾

^- [x] **T1430** changelog 碎片：`changelog.d/033-package-management.added.md`（市场/清单/registry）+ `.fixed.md`（单包升级对 pi 1.5.0 的修复）
  — 验证：collectChangelog / CI 碎片校验通过
^- [x] **T1431** MANUAL_TEST.md 增补「包管理 033」真机目视清单（含私服/断网条目）
  — 验证：文档入库
^- [x] **T1432** run-report 033 节定稿（取证/基线/真机/偏差），spec 验证计划表回填 ✅
  — 验证：文档入库
