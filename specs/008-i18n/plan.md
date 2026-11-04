# Implementation Plan: 中英双语

**Feature**: `specs/008-i18n/spec.md`

**Branch**: `release/0.5.2`

**Status**: Ready to implement（必须最后做）

## 摘要

分三层：① **存储与传递**——`language` 偏好进 `PiUserPrefs`，`env` 带 `locale`；
② **Web**——`src/i18n/` 字典 + `t()`，逐文件把硬编码文案搬进字典，Options 加三段式 Language；
③ **IDE**——`messages/PiAgentBundle*.properties` + `plugin.xml` 的 `%key`，Kotlin 里可见文案改 `PiAgentBundle.message()`。

## 技术上下文

- 偏好：`PiUserPrefs`（`PropertiesComponent`）+ `BridgeService.getPrefs/setPrefs`。
- 环境：`BridgeService.envInfo()` 已有 `theme` / `editorFontFamily`，加 `locale` 即可。
- 主题的三段式：`OptionsPopover.tsx` 的 Theme 行（`system|light|dark`），Language 复用同一 `.segmented` 结构。
- Kotlin 本地化：平台 `DynamicBundle` + `<resource-bundle>`；`%key` 用于 `plugin.xml` 的
  `text` / `description`。
- 现有文案规模（实施前先跑一遍盘点命令，数字写回本文件）：

```bash
# Web 侧可疑硬编码（JSX 文本节点与属性里的英文）
grep -rn --include=*.tsx -E '>[A-Z][A-Za-z][^<>{}]*<|placeholder="[A-Za-z]' web/src | wc -l
# Kotlin 侧
grep -rn --include=*.kt -E '"[A-Z][a-z]+ [a-z]' src/main/kotlin | wc -l
```

## 设计决策

### D1. 语言偏好的传递

```kotlin
// PiUserPrefs
fun languagePreference(): String?          // "system" | "zh" | "en"
fun setLanguagePreference(value: String)
// BridgeService.envInfo()
put("locale", Locale.getDefault().language)   // zh / en / ja …
```

前端解析优先级：`prefs.language`（`zh`/`en`）→ `env.locale` 以 `zh` 开头取 `zh` → 其余 `en`。

**不需要版本迁移**：旧用户没有该键，缺省即 `system`，与「跟随 IDE」语义一致；不写迁移代码，
避免为了一个可选键引入迁移分支。

### D2. Web 字典与 `t()`

```
web/src/i18n/
  index.ts      // createI18n(lang), t(key, params), useT() hook, setLanguage()
  zh.ts         // export const zh = { ... } satisfies Dict
  en.ts         // export const en = { ... } satisfies Dict; type Dict = typeof en
  index.test.ts // 键集合一致、无空值、无「值 === key」
```

- 单一真源是 `en.ts`，`zh.ts` 用 `satisfies Record<keyof typeof en, string>`；
  少一个键会**编译报错**，不必靠测试兜（测试只兜「空值 / 未翻译」）。
- `t()` 支持 `{name}` 占位符与简单复数：`t("sessions.msgCount", { n, plural: n === 1 ? "one" : "other" })`。
  复数规则写在字典里（`en` 提供 `_one` 变体，`zh` 只有一个形态），不引入 `Intl.PluralRules` 的复杂度。
- 语言状态存在 store：`language: "zh" | "en"`（解析后的**生效值**）+ `languagePref`（原始偏好）。
  `setLanguage` 同时写 prefs（`config.setPrefs`）与 store，组件通过 `useT()` 重渲染。
- 缺 key：`t()` 返回 `⟦key⟧` 并 `console.warn` 一次（去重，避免刷屏）。

### D3. 机械搬迁，不做「边写功能边翻译」

顺序固定为：**先盘点 → 建字典骨架（按 area 分组）→ 逐文件替换 → 跑盘点命令确认归零 → 人工过一遍中文语气**。
每替换完一个组件就跑 `npm run typecheck && npx playwright test <相关 spec>`，避免一次性大改后难定位。

area 划分与文件对应：

| area | 文件 |
|---|---|
| `chat.*` | `App.tsx`（tabs）、`Composer.tsx`、`SendButton.tsx`、`MessageList.tsx`、`MessageActions.tsx`、`ToolCard.tsx`、`QueueBar.tsx`、`ApprovalCard.tsx`、`StatusBar.tsx`、`SetupCard.tsx`、`ModelPicker.tsx`、`ThinkingPicker.tsx`、`OptionsPopover.tsx`、`Markdown.tsx`（Copy 按钮） |
| `sessions.*` | `SessionsView.tsx` |
| `manage.*` | `ManageView.tsx`、`manage/*.tsx`（6 个面板） |
| `confirm.*` | `ConfirmDialog.tsx` 的四个调用点 |
| `error.*` | `store.ts` 的 `appendError` 文案、系统条目文案 |
| `common.*` | 复制/取消/保存/重试等通用词 |

### D4. 不翻译的东西（写进代码注释，避免下次被「优化」）

- pi 的 stderr、命令输出、工具名、模型名、provider 名、文件路径。
- `Pi Agent`、`MCP`、`token`、`fork`、`steer`、`session`（作为技术名词时保留英文，首次出现可加括号注释）。
- `data-testid`、CSS 类名、日志文本（`LOG.warn` 保持英文，便于检索 issue）。

### D5. IDE 侧资源包

```
src/main/resources/messages/PiAgentBundle.properties         # English（base）
src/main/resources/messages/PiAgentBundle_zh_CN.properties   # 中文
```

```kotlin
// dev/pi/agent/PiAgentBundle.kt
object PiAgentBundle : DynamicBundle("messages.PiAgentBundle") {
    @JvmStatic fun message(key: String, vararg params: Any): String = getMessage(key, *params)
}
```

`plugin.xml` 顶部加 `<resource-bundle>messages.PiAgentBundle</resource-bundle>`，
两个 group 与全部 action 的 `text` / `description` 改 `%` key；`projectView` 分组图标不受影响。

替换点（Kotlin 侧盘点）：

| 位置 | 现状 |
|---|---|
| `plugin.xml` group/action `text`、`description`（2 组 5 个 action + 1 个 commit action） | 硬编码英文 |
| `BridgeService.notifyIfSettledInBackground` 通知标题/正文/按钮 | 硬编码 |
| `BridgeService.sessionsExportHtml` 的 `FileSaverDescriptor` 标题/描述 | 硬编码 |
| `PiAgentSettingsConfigurable` 的 `displayName`（plugin.xml 属性）与表单标签 | 硬编码 |
| `PiStatusBarWidget` 的 tooltip | 硬编码 |
| `PiCliRunner`/`PiEnvironment` 的用户可见错误 | 硬编码（仅包裹文案，原始输出不译） |

- 工具窗 `id="Pi Agent"` 与 action id **不改**（代码里按字符串查找，改了会断）。
- `plugin.xml` 的属性值可以写 `%key`，平台按语言包解析；`displayName="%settings.displayName"` 同理。

### D6. 验证策略

- 单测：`i18n/index.test.ts`（键一致、无空值、`t()` 占位符替换、缺 key 返回 `⟦key⟧`）。
- Kotlin 单测：`PiAgentBundleTest` 读两个 `.properties`，断言 key 集合相等、无空值、中文包确实与英文不同。
- e2e：`web/e2e/i18n.spec.ts` —— 断言 `system + zh` 下 tabs 为中文；切到 `en` 后为英文；
  切语言后消息条数不变；英文态下 `manage` 面板无中文。
- 真机：中文 IDE（语言包）与英文 IDE 各一次，截图 Chat/Sessions/Manage/右键菜单/通知。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/src/i18n/{index,zh,en,index.test}.ts` | **新增** |
| `web/src/store/store.ts` | `language` / `languagePref`、`setLanguage`、`init()` 解析 locale |
| `web/src/components/OptionsPopover.tsx` | Language 三段式 + 说明文案 |
| `web/src/**/*.tsx`（约 20 个） | 文案搬迁到 `t()` |
| `web/src/bridge/types.ts` | `EnvInfo.locale`、`Prefs.language` |
| `web/src/bridge/mock.ts` | 提供 `locale`、持久化 `language` |
| `src/main/kotlin/dev/pi/agent/process/PiUserPrefs.kt` | `languagePreference` 读写 |
| `src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt` | `env.locale`、prefs 读写、通知与导出对话框文案 |
| `src/main/kotlin/dev/pi/agent/PiAgentBundle.kt` | **新增** |
| `src/main/resources/messages/PiAgentBundle*.properties` | **新增** |
| `src/main/resources/META-INF/plugin.xml` | `<resource-bundle>` + `%key` |
| `src/test/kotlin/dev/pi/agent/PiAgentBundleTest.kt` | **新增** |
| `web/e2e/i18n.spec.ts` | **新增** |

## 顺序

1. 跑盘点命令，把「待翻译条目数」写回本文件；建 `i18n` 骨架 + `zh`/`en` 字典（先只放 tabs 与 composer 的键）。
2. `env.locale` + 偏好读写 + Options 三段式（打通链路，先让 tabs 会切）。
3. 按 area 逐个搬：chat → sessions → manage → confirm/error/common；每搬完一个跑 typecheck + 对应 e2e。
4. Kotlin：bundle + `PiAgentBundle.kt` + `plugin.xml` `%key` + 各处 `message()` 替换。
5. 单测（两套键一致）+ e2e（切换、无残留）+ 真机双语截图。
6. **收尾复核**：再跑一次盘点命令，残留数写回本文件；残留必须全部属于 D4 的「不翻译」白名单。

## 风险

| 风险 | 缓解 |
|---|---|
| 约 300 条文案一次性搬迁，中途 typecheck 大面积报错 | 按 area 分批，每批结束跑 typecheck；字典键用 `en.ts` 推导类型，报错即缺键 |
| Manage 面板文案多、易漏 | 盘点命令 + e2e 断言「英文态 Manage 无中文」双向兜底 |
| 中文文案导致按钮变窄/变宽，破坏 360px 布局 | e2e 在中文态重跑 `layout-regressions.spec.ts` 的 360px 用例 |
| 用户以为「切了语言但右键菜单没变」 | Options 的 Language 行加说明：「IDE 菜单与通知跟随 IDE 语言包」 |
| `plugin.xml` 的 `%key` 写错导致菜单显示 `%key` 字面量 | 真机逐项检查两个右键菜单；`PiAgentBundleTest` 校验 key 都存在 |
