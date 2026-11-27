# 任务清单：pi 版本双显（运行版 + 磁盘版）与更新按钮兜底

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-190334`
**Issues**: [#5](https://github.com/57ggfk/pi-agent-idea/issues/5) · [#6](https://github.com/57ggfk/pi-agent-idea/issues/6)

## T1 磁盘版探测（Kotlin）

- [x] T1.1 `src/main/kotlin/dev/pi/agent/process/PiDiskVersion.kt`：带 TTL 的磁盘版探测
- [x] T1.2 节流窗口内不重复起子进程；`forceRefresh` 绕过 TTL
- [x] T1.3 `PiLocator.locate(forceRefresh=true)` 后缓存失效

## T2 双版本传递（Kotlin → web）

- [x] T2.1 `BridgeService`：新增 `pi-disk-version` 事件（`{version, path}`）
- [x] T2.2 触发点：pi 状态变化 / 诊断卡读 env / 插件内更新成功
- [x] T2.3 `web/src/store/store.ts`：`piDiskVersion` 字段 + 事件处理（与 T2.1 同一次改动）

## T3 状态栏呈现（web）

- [x] T3.1 一致 → 只显示一个版本号
- [x] T3.2 不一致 → `1.6.1 → 1.6.2` + 「重启后生效」提示
- [x] T3.3 i18n 中英（`web/src/i18n/locales/{zh,en}.ts`）

## T4 更新按钮兜底（Kotlin）

- [x] T4.1 `dev/pi/agent/manage/PiSelfUpdate.kt`：拒绝文案识别 + prefix 反推 + npm 候选校验
- [x] T4.2 命令拼装：`<npm> install -g --prefix <prefix> @earendil-works/pi-coding-agent@latest`
- [x] T4.3 `PiManage.envUpdate()` 接上兜底；找不到 npm 时明确报错
- [x] T4.4 兜底成功后 `refresh()` + 回报新版本

## T5 自动化断言（先红后绿）

- [x] T5.1 `PiDiskVersionTest`：TTL / forceRefresh / 失效
- [x] T5.2 `PiSelfUpdateTest`：回退判定 / prefix 反推 / 命令拼装 / 报错
- [x] T5.3 web `StatusBar` 测试：一致 / 不一致两种渲染

## T6 真机验收

- [~] T6.1 外部 `npm install -g` 升级 → 左下角出现双版本与重启提示
- [~] T6.2 重启 pi 进程 → 双版本收敛
- [~] T6.3 点「更新 pi」→ npm 兜底生效，版本真的变大

## T6 实测记录（本机全部跑通）

### T6.1 / T6.2 状态栏双版本

本机（Windows 11 / 两套 Node prefix）实测：

- `pi update --self --force` 复现了用户的原始报错，exit code 1，文案与
  `isSelfUpdateRefusal` 的判定串一致（`cannot self-update this installation.`）。
- `prefixFor` 从 `C:\Users\Administrator\AppData\Roaming\npm\pi.cmd` 反推出
  `C:\Users\Administrator\AppData\Roaming\npm`，其下确有 pi 的包目录。
- ownership 判定跳过 PATH 首位的 `C:\develop\nodejs\npm.cmd`（root 是
  `C:\develop\nodejs\node_modules`），选中 `C:\Program Files\nodejs\npm.cmd`
  （root 是 `…\AppData\Roaming\npm\node_modules`）。
- 最终命令 `npm install -g --prefix <prefix> @earendil-works/pi-coding-agent@latest`
  经 `--dry-run` 确认命中的是既有安装（`change @earendil-works/pi-coding-agent 1.6.1 => 1.6.1`），
  不会在别的 prefix 里另装一份。
- 磁盘版探测：`package.json` 读出 1.6.1，与 `pi --version` 的 1.6.1 一致。

### T6.3 更新按钮的端到端验证（真机跑通）

条件制造：把磁盘上的 pi 降到 1.6.0 → `pi update --self` 不再短路成「已是最新」，
而是走到拒绝自更新（原文：`cannot self-update this installation.`，exit 1，
并指名要装 1.6.1）——这正是 issue #5 的现场。

跑插件自己的更新通路（`PiManage.envUpdate()`，即「更新 pi」按钮调的那个）：

| | 值 |
|---|---|
| pi before | 1.6.0 |
| `pi update --self` | 拒绝 |
| 回退通道 | **viaNpm = true** |
| ok | **true** |
| pi after | **1.6.1** |

装完复核：磁盘 pi 仍是 `AppData\Roaming\npm` 那一份、版本 1.6.1；
`C:\develop\nodejs\node_modules` 下**没有**多出第二份；`npm ls -g` 只列一份 1.6.1。

### T6.4 插件装进 IDEA 后的实机

- 构建 `buildPlugin` → `pi-agent-idea-0.5.10.zip`；旧插件目录改名备份为
  `pi-agent-idea.bak-0.5.10-pre-version-display-20261127-195535` 后替换。
- 装好的 jar 里确认有 `PiDiskVersion` / `PiDiskVersionWatcher` / `PiSelfUpdate`；
  前端 `index-B7hLSvUr.js` 里确认有 `status-version-split` / `pi-disk-version` /
  `status.diskVersionTitle`。
- 在 untitled 项目上重启 IDEA：插件正常加载、桥接在轮询、pi CLI 在跑，无插件异常。
- 20:30:44 日志出现 `pi cli: update --self` → 20:30:47 pi 进程重启（新 PID），
  更新 + 重启的完整链路走通。

### 边界

- 三条依赖本机 npm 布局的断言（`PiDiskVersionLiveTest` / `PiSelfUpdateLiveTest` /
  `PiSelfUpdateEndToEndTest`）**跑完即删**，不入库——它们依赖本机布局，且最后一条会
  真的改安装，CI 上必挂。规则的形状由同名的假布局单测守住。

## T6 附：早期记录

本机（Windows 11 / 两套 Node prefix）实测：

- `pi update --self --force` 复现了用户的原始报错，exit code 1，文案与
  `isSelfUpdateRefusal` 的判定串一致（`cannot self-update this installation.`）。
- `prefixFor` 从 `C:\Users\Administrator\AppData\Roaming\npm\pi.cmd` 反推出
  `C:\Users\Administrator\AppData\Roaming\npm`，其下确有 pi 的包目录。
- ownership 判定跳过 PATH 首位的 `C:\develop\nodejs\npm.cmd`（root 是
  `C:\develop\nodejs\node_modules`），选中 `C:\Program Files\nodejs\npm.cmd`
  （root 是 `…\AppData\Roaming\npm\node_modules`）。
- 最终命令 `npm install -g --prefix <prefix> @earendil-works/pi-coding-agent@latest`
  经 `--dry-run` 确认命中的是既有安装（`change @earendil-works/pi-coding-agent 1.6.1 => 1.6.1`），
  不会在别的 prefix 里另装一份。
- 磁盘版探测：`package.json` 读出 1.6.1，与 `pi --version` 的 1.6.1 一致。

## T7 收尾

- [x] T7.1 `changelog.d/` 碎片（正好两行：中文在前、英文在后）
- [x] T7.2 `./gradlew build` 通过
- [x] T7.3 `cd web && npm test`（vitest）通过
- [ ] T7.4 提交（时间戳照实，提交信息带 body 说明「改了什么 + 为什么 + 依据」）
