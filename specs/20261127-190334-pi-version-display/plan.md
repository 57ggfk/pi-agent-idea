# 技术方案：pi 版本双显（运行版 + 磁盘版）与更新按钮兜底

**Spec**: [spec.md](./spec.md) · **编号**: `20261127-190334`（时间戳规则 v2）
**Issues**: [#5 更新按钮兜底](https://github.com/57ggfk/pi-agent-idea/issues/5) · [#6 状态栏版本双显](https://github.com/57ggfk/pi-agent-idea/issues/6)

## 落点

- 分支：`release/0.5.11`（工作树 `D:\code\github\pi-agent-idea-wt\release-0.5.11`，
  远端 `origin/release/0.5.11`，HEAD `03bf794`）
- 该分支已包含 `origin/main`（merge-base = `27cb1ae`），是 0.5.11 的下一版发布线。

## 一、问题定位（读代码得到的事实）

### 1.1 两条取数路径

| 位置 | 链路 |
|---|---|
| 左下角状态栏 | `web/src/components/StatusBar.tsx` → store `piVersion` ← `pi-state` 事件 ← `BridgeService.pushStateEvent` → `PiConnectionState.Running.installation.version` ← `PiProcessManager.start()` → `PiLocator.locate()` |
| 诊断卡 | `web/src/components/manage/DiagnosticsPanel.tsx` → `api.environment()` → `PiManage.environment()` → `PiLocator.locate(forceRefresh = true)` → 现场 `pi --version` |

### 1.2 三处「钉住旧值」

1. `PiConnectionState.Running.installation` 是**启动快照**，进程不重启就不变。
2. `PiLocator.cached` 是**进程级缓存**，只有 `forceRefresh=true` 才刷新。
3. `PiLocator.locate()` 默认走缓存 → `PiProcessManager.start()` 拿到的可能也是旧版本。

### 1.3 「更新 pi」按钮为什么在这台机器上必然失败

`PiManage.envUpdate()` 跑 `pi update --self`（`envUpdateArgs()`）。pi 1.6.1 的自更新
判定链（读 `dist/bundle/chunks/chunk-36QC74V4.js` 确认）：

```
getSelfUpdateCommand(packageName, npmCommand, target)
  = getSelfUpdateCommandForMethod(detectInstallMethod(), ...)   // npm → 有命令
  && isManagedByGlobalPackageManager('npm', ...)                // ← 这里挂了
  && isSelfUpdatePathWritable()
```

`isManagedByGlobalPackageManager` 拿 `npm root -g` 的输出当基准，比对 pi 的包目录是否在其下。
本机 PATH 里的 npm 是 `C:\develop\nodejs\npm.cmd`（prefix `C:\develop\nodejs`），
`npm root -g` → `C:\develop\nodejs\node_modules`；而 pi 装在
`C:\Users\Administrator\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent`。
**不在其下 → 判定「不受全局包管理器管理」 → 打印 `cannot self-update this installation`。**

双 prefix 是根因：**装 pi 的 npm 与 PATH 首位的 npm 不是同一个**。

## 二、方案

### 2.1 磁盘版探测（Kotlin，新增 `PiDiskVersion.kt`）

新增 `dev.pi.agent.process.PiDiskVersion`：

```kotlin
object PiDiskVersion {
    /** 磁盘上那个 pi 的版本，带节流。 */
    fun current(forceRefresh: Boolean = false): String?
}
```

- **节流**：默认 `DISK_VERSION_TTL_MS = 60_000`。窗口内重复请求直接回缓存，不起子进程（FR-004）。
- **探测**：复用 `PiLocator.version(path)`（已有格式校验，node 冷启动约 1s）。
- **失效点**：`PiLocator.locate(forceRefresh=true)` 之后自动失效（外部更新、插件内更新、
  装完 pi 都会走到这条路径）。
- **纯函数**：节流与比对逻辑抽成可单测的纯函数（`shouldRefresh` / `describeMismatch`），
  探测本身注入。

### 2.2 双版本传递（Kotlin → web）

`PiConnectionState` 不动——它是运行态。**磁盘版单独走一条事件**，避免污染既有语义：

- 后端：`BridgeService` 新增 `pushDiskVersionEvent()`，事件名 `pi-disk-version`，
  载荷 `{ version, path }`。
- 触发点：
  1. pi 进程状态变化时（`pushStateEvent` 旁边一并推），
  2. 诊断卡读 `manage.environment` 时回推最新磁盘版，
  3. 插件内更新成功时（`envUpdate` 后）回推。
- 前端：`web/src/store/store.ts` 加 `piDiskVersion: string`，在事件分支里 set。

**双端契约同步**：字段名 `piDiskVersion` / `pi-disk-version` 两侧同一次改动里改（FR-008）。

### 2.3 状态栏呈现（web）

`web/src/components/StatusBar.tsx`：

- 磁盘版为空或与运行版一致 → 只显示 `pi 1.6.1`（FR-003）。
- 不一致 → `pi 1.6.1 → 1.6.2`，加 `title`：「磁盘上已是 1.6.2，重启 pi 后生效」（FR-002）。
- i18n：`web/src/i18n/locales/{zh,en}.ts` 加 `status.diskVersion` / `status.diskVersionTitle`。

### 2.4 更新兜底（Kotlin）

新增 `dev.pi.agent.manage.PiSelfUpdate`：

```kotlin
/** `pi update --self` 因「不受全局包管理器管理」而拒绝时，改走 npm。 */
fun fallbackNeeded(result: CliResult): Boolean
fun npmPrefixFor(piPath: String): String?
fun npmInstallArgs(npmPath: String, prefix: String, pkg: String): List<String>
```

- **识别失败**：pi 的拒绝文案是 `cannot self-update this installation`。匹配该子串才回退，
  其他失败（网络、权限）原样透出，不掩盖真因。
- **选对 prefix**：从 pi 的实际安装路径反推——
  `<prefix>/node_modules/@earendil-works/pi-coding-agent` → prefix = 去掉 `node_modules/...` 后的目录。
  pi 自己的 `getInferredNpmInstall()` 就是这个思路，本插件照做（FR-006）。
- **选对 npm**：`PiLocator.locateNpm()` 已有「用户指定的 node 旁边的 npm 优先」逻辑；
  本插件按 `npm --prefix <prefix> root -g` 的输出去校验候选 npm 确实管理这个 prefix，
  选第一个校验通过的。
- **命令**：`<npm> install -g --prefix <prefix> @earendil-works/pi-coding-agent@latest`。
  实测 `npm --prefix <dir> root -g` → `<dir>/node_modules`，即 `--prefix` 会重定向全局根（已验）。
- **失败**：找不到 npm / prefix 算不出 → 明确报错（FR-007）。

`PiManage.envUpdate()` 接上：`pi update --self` 失败且命中拒绝文案 → 走兜底；
兜底成功则 `refresh()` + 回报新版本，语义与「更新成功」一致。

## 三、测试计划

先补断言（红）→ 再改实现（绿）。

**Kotlin（`src/test/kotlin/dev/pi/agent/`）**
- `PiDiskVersionTest`：TTL 内不重复探测、过期后重探、forceRefresh 绕过 TTL。
- `PiSelfUpdateTest`：拒绝文案才回退、其他失败不回退、prefix 反推正确、
  命令拼装带 `--prefix`、找不到 npm 时明确报错。

**前端（`web/src/`）**
- `StatusBar` 组件测试：版本一致 → 单版本；不一致 → 双版本 + 提示。

## 四、真机验收（不可跳过）

1. 终端 `npm install -g @earendil-works/pi-coding-agent@<新版本>`（外部更新）。
2. 不重启 IDE → 看左下角：应出现「运行版 → 磁盘版」双版本 + 重启提示。
3. 重启 pi 进程 → 双版本应收敛为一个。
4. 点诊断卡「更新 pi」→ 走 npm 兜底，版本号真的变大。

## 五、风险

- **磁盘版探测起子进程**：TTL 60s 限流；探测放后台线程，不占 EDT。
- **prefix 反推依赖 npm 布局**：非 npm 安装（脚本装/pnpm/yarn/bun）反推不出来 →
  不回退，保留 pi 原始报错，不猜。
- **跨端字段漂移**：字段名改动同一次提交内完成，web 与 Kotlin 一起改。
