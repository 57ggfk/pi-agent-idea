# 033 包管理完善 — 技术方案（plan）

> spec：[./spec.md](./spec.md)（Approved，Q1–Q9 已拍板）；证据：[./evidence/probe-033-packages.log](./evidence/probe-033-packages.log)（P1–P19）
> 编号：本文 task 用 **T1401+**（032 用到 T1309）。分支 `release/0.5.8-20261112`。

## 0. 取证结论 → 方案映射

| 取证（证据编号） | 方案决定 |
|---|---|
| `pi list` 输出 = 作用域标题+源行+路径行，无版本（P3/P18） | Kotlin 解析为结构化条目；版本从解析路径 `package.json` 读 |
| 路径行缺席 = 未安装/文件缺失（P13/P18） | `broken` 态纯本地判定，行内「重装」 |
| pi 1.5.0 `pi update <source>` 三种写法全坏（P8） | **删除 `manage.packageUpdate` RPC**；单包升级 = 检测 latest → `pi install npm:<name>@<latest>`（P10/P11 实证） |
| 重装同名是 no-op，lock 钉住（P9） | 升级必须带版本号；成功后校验物理版本已变（防假成功） |
| `PI_OFFLINE` 管不住包命令；断网 72s/144s（P4/P5/P7） | 插件自建预检（≤5s），失败不 spawn CLI；硬超时 300s 仅兜底 |
| 市场数据源 = npm search API `keywords:pi-package`（P15/P16） | Kotlin HTTP 直连；不爬 pi.dev |
| npmmirror 不认 `keywords:`、纯文本可用（P19） | 端点探测降级：keywords → 纯文本 → 不可用；按 registry 缓存 |
| `/name/latest` 在 Nexus hosted 有坑（#224）、缩身 packument 含 dist-tags（P19） | latest 主路径 `/name/latest`，404 兜底 packument（install-v1 Accept） |
| `PiEnvironment` 已有 registry 预设/校验/`npmConfiguredRegistry` | 全套复用；包管理 registry 设置 = 显式 URL > npm 配置 > 默认官方 |

## 1. 架构

```
web (PackagesPanel 重写 + MarketplacePanel 新增)
  │ bridge (四处同步: types.ts → manage.ts → BridgeService.kt → mock.ts)
  ▼
BridgeService (Dispatchers.IO, 阻塞安全)
  ├─ manage.packagesList   → PiManage.packagesList()      [重写: 结构化]
  ├─ manage.packageCheck   → PiManage.packageCheck(params) [新增]
  ├─ manage.marketSearch   → PiManage.marketSearch(params) [新增]
  ├─ manage.packageInstall → PiManage.packageInstall(params) [改: 预检 + registry env]
  ├─ manage.packageRemove  → 不变（本地操作，无预检）
  ├─ manage.packageUpdate  → ✂ 删除
  └─ manage.packageUpdateAll → [改: 预检 + registry env]
        ▼
PiPackages.kt (新对象, manage 包) — 纯函数为主, 可注入 fake HTTP/fetcher 便于单测
  ├─ parsePiList(stdout) → List<Entry>{source, scope, path?, broken}
  ├─ npmName(source) / encodeName(name)          // npm:name@ver → name；@a/b → @a%2Fb
  ├─ registryChain(explicit) → url               // explicit > npm config(缓存) > 官方
  ├─ preflight(url) → Reachable/Offline(≤5s)     // java.net.http, 共享 client
  ├─ latestVersion(registry, name) → String?     // /latest → packument dist-tags 兜底
  ├─ marketSearch(registry, query, page, size)   // 端点探测缓存 + 映射卡片字段
  └─ readInstalledVersion(path) → String?        // package.json 容错读
```

- **PiManage** 保持 CLI 编排层：install/updateAll 先 `PiPackages.preflightForInstall(registry)`，
  失败返回 `{ok:false, code:"offline", error:…}`，不 spawn；通过则
  `PiCliRunner.run(args, extraEnv = registryEnv(registry))`。
- **PiCliRunner.run** 加 `extraEnv: Map<String,String> = emptyMap()` 参数（现有调用零改动）。
- **registry 注入**：显式 override 时 env `NPM_CONFIG_REGISTRY=<url>`；跟随模式不注入。
  override 由 web 每次调用经 params 携带（`registry` 字段），Kotlin 经
  `PiEnvironment.normalizeCustomRegistry` 校验，非法值忽略（回退跟随）。
- **prefs**：`PiUserPrefs` 加 `registryOverride`（null=跟随）；`BridgeService.getPrefs/setPrefs`
  带上该键；web 面板经 `config.getPrefs/setPrefs` 读写（panel-local，无 store 改动）。
- **版本校验（FR-004）**：升级 = install pinned；完成后 `packagesList` 重读，
  web 比对 version 是否到位，不一致提示「升级未生效（详见输出）」。

## 2. 桥接契约（四处同步的形状）

```ts
interface PackageEntry { source: string; scope: "user"|"project";
  path?: string; version?: string|null; broken: boolean }
interface PackagesListResult extends CliOutcome { entries?: PackageEntry[] }

interface PackageCheckResult extends CliOutcome {
  source?: string; installed?: string|null; latest?: string|null;
  state?: "up-to-date"|"upgradable"|"unknown";
  reason?: ""|"offline"|"auth"|"git-ref"|"local"|"not-found";
}
interface MarketPackage { name; version; description; author; downloads;
  updated; badges: string[]; linkNpm; linkRepo }
interface MarketSearchResult extends CliOutcome { total?; page?; pageSize?;
  degraded?: boolean; packages?: MarketPackage[]; code?: "offline"|"unavailable"|"auth" }
```

- 错误码约定：网络/预检失败带 `code`（`offline` / `unavailable` / `auth`），
  文案由 web i18n 按 code 渲染人话；`error` 原文进「详情」折叠区。
- mock 旋钮（沿用 `?key=value` 惯例）：`?pkgbroken=1`（坏行）、`?pkgold=1`（可升级）、
  `?check=offline|auth`、`?market=offline|unavailable|empty|degraded`。

## 3. UI 形态

- **PackagesPanel 重写**（保留 data-testid 兼容面：`packages-panel`、`package-install`、
  `packages-update-all`、`packages-refresh`、`package-row`、`packages-empty`）：
  - 顶部：页签 `已安装 | 官方市场`（`packages-tab-installed` / `packages-tab-market`）
    + registry 选择行（`package-registry-*`，radio：跟随 npm / 官方 / 国内镜像 / 自定义）。
  - 已装列表：每行 = 源串(mono) + 版本 chip + 作用域 badge + 状态（正常/未安装/文件缺失）
    + 操作：检测版本（`package-check-i`，结果内联：已是最新/可升级 x→y/无法检测+原因）、
    升级（可升级时可用）、卸载（确认框，现状）、重装（仅 broken 行）。
    「全部升级」「刷新」保留。
  - CLI 输出展示：主文案人话 + `<details>`「详情」折叠原始输出（FR-014）。
- **MarketplacePanel**（新文件）：搜索框 + 卡片列表 + 分页（上一页/下一页/页码）；
  卡片 = 名称/版本/徽章/描述/作者/下载量(千分位)/最近发布/npm·仓库链接/安装或「已安装」。
  四态：loading / 空结果 / offline / unavailable（私服不支持检索）。

## 4. 触及文件

| 文件 | 变更 |
|---|---|
| `src/main/kotlin/dev/pi/agent/manage/PiPackages.kt` | **新增**（解析/registry/HTTP/映射） |
| `src/main/kotlin/dev/pi/agent/manage/PiManage.kt` | packagesList 重写、+packageCheck/+marketSearch、install/updateAll 预检+env、✂packageUpdate |
| `src/main/kotlin/dev/pi/agent/manage/PiCliRunner.kt` | +`extraEnv` 参数 |
| `src/main/kotlin/dev/pi/agent/process/PiUserPrefs.kt` | +registryOverride |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` | 分发表 ±3 行、getPrefs/setPrefs +registryOverride |
| `web/src/manage.ts` | 类型 ±、api ±（删 packageUpdate，+packageCheck/+marketSearch/+prefsGet/prefsSet） |
| `web/src/bridge/mock.ts` | 结构化 packages、market fixture、旋钮、删 packageUpdate case |
| `web/src/components/manage/PackagesPanel.tsx` | **重写** |
| `web/src/components/manage/MarketplacePanel.tsx` | **新增** |
| `web/src/i18n/locales/en.ts` / `zh.ts` | +约 35 键 |
| `web/src/styles.css` | 市场卡片/页签/registry 行样式 |
| `web/e2e/manage.spec.ts` | 改写 update 两条 + packages 018 组；新增市场/离线/降级组 |
| `src/test/kotlin/.../PiPackagesTest.kt` 等 | **新增**；`PiManageUpdateTest.kt` 相应调整 |
| `docs/MANUAL_TEST.md`、`specs/0.5.8-run-report.md`、`changelog.d/033-*.md` | 收尾 |

## 5. 阶段与顺序（串行，改同一批文件）

```
Phase 1 Kotlin 基础：parsePiList + 版本读取 + 单测                （T1401–T1403）
Phase 2 registry 链 + 预检 + HTTP 客户端 + 单测                    （T1404–T1406）
Phase 3 packageCheck + 升级通路 + ✂packageUpdate + 单测            （T1407–T1409）
Phase 4 marketSearch 适配器（探测降级/映射）+ 单测                  （T1410–T1412）
Phase 5 web 类型/api/mock + 已装清单 UI 重写 + vitest              （T1413–T1416）
Phase 6 市场 UI + registry 设置 UI + i18n + 样式                   （T1417–T1421）
Phase 7 e2e 改写 + 新增 + 全量回归                                  （T1422–T1425）
Phase 8 全量验证（gradle test/verifyPlugin/typecheck/vitest 多轮）
        + 真机（runIde + CDP + PI_CODING_AGENT_DIR 沙箱真 pi CLI）  （T1426–T1429）
Phase 9 收尾文档：run-report 033 节 / changelog 碎片 / MANUAL_TEST  （T1430–T1432）
```

不可颠倒：Phase 1→2→3 依次（后者的单测吃前者的纯函数）；Phase 5 的 UI 吃 Phase 3 的契约；
e2e 必须在 mock 契约定稿后写。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `pi list` 未来版本改输出格式 | 解析器容错：不认识的行忽略；解析失败降级为旧行为（原始行展示），不白屏 |
| 私服形态多样（Nexus/Verdaccio/Artifactory） | 只依赖三个标准端点（search/packument//latest），运行时探测降级，不按厂商硬编码 |
| packument 大包流量 | 主路径 `/latest`（KB 级）；packument 仅 404 兜底且带 install-v1 Accept |
| 升级假成功（lock no-op 教训） | 升级 URL 永带版本号；完成后重读清单校验版本 |
| e2e 依赖真实网络 | 市场数据全部 mock fixture；网络失败路径用旋钮模拟；真机网络项单独列 MANUAL_TEST |
| runIde 真机耗时长 | 放最后单独跑；失败不阻塞文档收尾，如实记 run-report |
