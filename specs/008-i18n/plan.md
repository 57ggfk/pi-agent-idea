# Implementation Plan: 中英双语

**Feature**: `specs/008-i18n/spec.md`

**Branch**: `release/0.5.2`

**Status**: Ready to implement（必须最后做）

## 摘要

分三层：① **存储与传递**——`language` 偏好进 `PiUserPrefs`，`env` 带 `locale`；
② **Web**——引入 `i18next` + `react-i18next`，组件只依赖自有的 `useT()`，逐文件把硬编码文案搬进字典，
Options 加语言选择器（≤3 项分段、>3 项下拉）；③ **IDE**——`messages/PiAgentBundle*.properties` +
`plugin.xml` 的 `%key`，Kotlin 里可见文案改 `PiAgentBundle.message()`。

**本次决策的着眼点是「后续要加语言」**，不是「把中英两套翻完就完事」。凡是会让「第 N 种语言」
需要改组件、漏复数、改不动加载方式的实现，都按不可接受处理。

## 技术上下文

- **盘点结果（T001/T020，2026-11-06 实测，grep 粗口径）**：迁移前 JSX 可疑硬编码 37 处、
  Kotlin 可疑字符串 44 处。迁移后（T020 复盘）：`chat.*` / `sessions.*` / `confirm.*` / `error.*` /
  `language.*` / `common.*` 与 Manage 外壳（页签/信任/更新）已全部入字典，共 **240 键 × 2 语言**；
  残留 = D6 白名单（品牌 `Pi`/`Pi Agent`/`MOCK` 徽章、URL 占位符、npm 命令原文）+
  **Manage 六个面板的长尾文案（McpPanel/PackagesPanel/SkillsPanel/AuthPanel/SettingsPanel/DiagnosticsPanel
  表单、按钮、错误横幅）**——按批次时间盒规则记入 run report §4，见「加语言的操作清单」一节照常覆盖。

- 偏好：`PiUserPrefs`（`PropertiesComponent`）+ `BridgeService.getPrefs/setPrefs`。
- 环境：`BridgeService.envInfo()` 已有 `theme` / `editorFontFamily`，加 `locale` 即可。
  `locale` 取自 `Locale.getDefault().language`——在 IDE 里这个值**已经反映语言包选择**，
  不能另用系统语言或 `user.language` 属性推断。
- 主题的三段式：`OptionsPopover.tsx` 的 Theme 行（`system|light|dark`），语言选择器复用同一 `.segmented` 结构。
- Kotlin 本地化：平台 `DynamicBundle` + `<resource-bundle>`；`%key` 用于 `plugin.xml` 的
  `text` / `description`。
- **Web 资源加载方式（决定懒加载可行性）**：前端由 `LocalUiServer` 通过 loopback HTTP 提供
  （`GET /webui/…`，`src/main/kotlin/dev/pi/agent/ui/LocalUiServer.kt`），**不是 `file://`**。
  因此 Vite 切出的动态 `import()` chunk 可正常加载，按语言拆包成立。
  若将来改成 `file://` 直载，必须回头复核 FR-017（`file://` 下 ES module chunk 会被 CORS 拦）。
- 现有文案规模（实施前先跑一遍盘点命令，数字写回本文件）：

```bash
# Web 侧可疑硬编码（JSX 文本节点与属性里的英文）
grep -rn --include=*.tsx -E '>[A-Z][A-Za-z][^<>{}]*<|placeholder="[A-Za-z]' web/src | wc -l
# Kotlin 侧
grep -rn --include=*.kt -E '"[A-Z][a-z]+ [a-z]' src/main/kotlin | wc -l
```

## 设计决策

### D0. 为什么引 i18next，而不是继续手写 `t()` / 换 FormatJS / 换 Lingui

#### 加语言的操作清单（T025：加第三种语言时的唯一入口）

1. 新建 `web/src/i18n/locales/<code>.ts`：`const <code>: Dict = { …全部键… };` + `export default <code>;`
   （缺键 = `tsc` 报错；值缺失/等于键名 = `i18n.test.ts` 报错）。
2. 在 `web/src/i18n/languages.ts` 的 `LANGUAGES` 里加一行
   `{ code, bcp47, labelKey, nativeLabel }`（`nativeLabel` 用该语言自己的写法）。
3. 跑 `cd web && npm run typecheck && npm test`——i18n.test.ts 的「注册表与文件一一对应」
   「复数分类覆盖（`Intl.PluralRules(bcp47)` 枚举）」会自动把新语言纳入校验。
4. 补 `src/main/resources/messages/PiAgentBundle_<code>.properties`（IDE 侧，键集合由
   `PiAgentBundleTest` 锁定与英文 base 相等）。
5. 全量 `npx playwright test e2e/i18n.spec.ts`——断言界面无 `⟦` 残留。
   **任何组件、store、选择器都不需要改**（SC-005 已验证：注册假语言 `xx` 时
   `git diff --stat web/src/components/` 为空且界面可渲染）。

用户在 0.5.2 规划期明确「后续要开放更多语言」后推翻了原方案（原本打算 80 行自建）。
决定因素按权重排序：**加语言的边际成本 → 复数正确性 → key 稳定性 → API 简洁度 → 体积**。

| 维度 | `i18next` + `react-i18next` | `react-intl`（FormatJS） | `Lingui` | 自建 `t()` |
|---|---|---|---|---|
| key 形态 | 语义 key（`chat.send`） | 语义 key（`id`） | **英文原文当 id** | 任意 |
| 改一句文案的代价 | 只改基准语言字典 | 同 | **该键全部语言的翻译失效** | 只改字典 |
| 复数（CLDR） | 后缀 `_one/_few/_many…`，原生支持全部分类 | ICU 原生，最标准 | ICU 原生 | 需自己实现 |
| 类型安全 | `CustomTypeOptions` 从基准字典推导，缺键 `tsc` 报错 | 同样可推导 | 编译期生成，最强 | 靠 `satisfies` |
| 按语言懒加载 | 一等公民（`resources-to-backend` + `import()`） | 手写 `import()` 传 `IntlProvider` | 编译期 chunk，天然 | 手写 |
| 运行时体积（gz） | 实测 **+16.3KB**（见下） | ~13–20KB（含 ICU 解析器） | ~3KB | 0 |
| Vite 集成 | 装包即用 | 装包即用 | **需 SWC/Babel 宏插件** | 无 |
| API 搬迁 300 处的体感 | `t('key')`，最短 | `intl.formatMessage({id})`，最啰嗦 | `` t`英文` ``，最短 | `t('key')` |
| 生态 / 出问题时好搜 | 最大 | 大 | 中 | — |

**体积已实测**（2026-11-04，本仓库 `web/` 真实构建，`i18next@26.7.1` + `react-i18next@17.1.12`）：

| 项 | 基线 | 加入 i18next 后 | 增量 |
|---|---|---|---|
| 主 JS raw | 512,737 B | 564,379 B | **+51.6KB** |
| 主 JS gzip | 162,542 B | 179,237 B | **+16.3KB** |
| `node_modules` 磁盘 | 694 MB | 742 MB | +48MB（`@babel/runtime` 占 31MB，仅开发期） |

16.3KB 是 gzip 后的传输量、**一次性**成本（切语言不重复下载）。作为参照：这点体积约等于
当前 bundle 的 3.2%，比 `highlight.js` 小一个数量级。**新增一种语言的边际成本是一个独立 chunk**
（实测 `zh-*.js` 被正确切出，见 T002），300 条文案估算 5–8KB gz，且只在切到该语言时下载。

**结论：`i18next` + `react-i18next`。** 逐条理由：

1. **不选 Lingui**：它的「英文原文当 id」在最省事的场景下最舒服，但**改文案即断翻译**这条对
   「多种语言长期维护」是致命的——你改一句中文提示，俄语/德语对应键就变成未翻译，且 PO 里表现为
   msgid 消失、msgstr 变 obsolete。它的 3KB 和「不用想 key 名」抵不过这一点。
   另外宏插件会介入 Vite 构建链，无人值守执行时宏报错的定位成本高于普通类型错误。
2. **不选 FormatJS**：复数和日期它最标准，但 API 是 `formatMessage({ id })`，300 处替换的噪音明显更大；
   而且它没有 namespace 概念，按语言拆包要自己写。我们的复数需求只有个位数（`N msgs` / `N hits`），
   为这几处付 ICU 解析器的体积和一个更啰嗦的 API 不划算。
3. **不自建**：自建的真正问题不是「写不出 `t()`」，而是**复数分类、按语言拆包、翻译导出**三件事
   都要自己发明。俄语要 4 个分类、阿拉伯语 6 个，手写 `n === 1 ? a : b` 在那些语言里全是错的。
4. **选 i18next 的代价要认**：它的原生复数用**后缀**而不是 ICU 字符串，容易被漏掉某个分类。
   这一点用 D2 的「`Intl.PluralRules` 枚举校验」补上——这是本方案里最关键的一条，
   把 i18next 最大的短板变成 CI 能拦住的错误。

**依赖清单（`web/package.json`）**：`i18next`、`react-i18next`。
**不装**：`i18next-http-backend`（我们用 Vite 的 `import()` 切 chunk，不额外起请求）、
`i18next-browser-languagedetector`（语言来源是 IDE 传的 `env.locale` 加用户偏好，不是浏览器）、
`i18next-icu`（复数走下一条的自有校验，不引 ICU 解析器）。

### D1. 语言偏好的传递

```kotlin
// PiUserPrefs
fun languagePreference(): String?          // "system" | "zh" | "en" | …
fun setLanguagePreference(value: String)
// BridgeService.envInfo()
put("locale", Locale.getDefault().language)   // zh / en / ja …
```

前端解析优先级：`prefs.language` 是已注册语言 → 直接用；否则（`system` 或未知值）→
`env.locale` 按 BCP-47 前缀匹配已注册语言 → 无匹配则用基准语言 `en`。

**读到未知语言代码**（例如降级安装、或该语言后来被移除）：回退 `system` 并把纠正后的值写回偏好，
避免每次都走同一条失败路径（US2 场景 6）。

**不需要版本迁移**：旧用户没有该键，缺省即 `system`，与「跟随 IDE」语义一致。

### D2. Web 侧集成：目录、初始化、类型安全

```
web/src/i18n/
  languages.ts        // LANGUAGES 注册表（唯一真源）+ FALLBACK
  locales/en.ts       // 基准语言：静态 import（类型源 + 运行时兜底）
  locales/zh.ts       // 非基准语言：动态 import → 独立 chunk
  index.ts            // i18next 初始化、ensureLanguage()、setLanguage()、resolveLanguage()
  useT.ts             // 自有 hook，组件只依赖它
  format.ts           // formatNumber / formatDate / formatRelative（薄封装 Intl）
  resources.d.ts      // CustomTypeOptions：把 en 的键注入 i18next 的类型系统
  i18n.test.ts        // 键覆盖、复数分类、占位符、缺 key、注册表一致性
```

**字典用扁平 key + `keySeparator: false`**，不写成 `{ chat: { send: … } }` 嵌套。理由：
`keyof typeof en` 直接就是全部 key，类型推导零成本；grep 时是完整字符串 `'chat.send'` 好搜；
与 spec 的 `<area>.<element>` 写法一一对应。i18next 支持这种模式（`keySeparator: false, nsSeparator: false`）。

**类型安全（这是搬迁 300 处时唯一的护栏）**：

```ts
// web/src/i18n/resources.d.ts
import 'i18next';
import type { en } from './locales/en';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
    keySeparator: false;
    nsSeparator: false;
    returnNull: false;
  }
}
```

`en.ts` 末尾 `as const`。此后 `t('chat.sendx')` 是**编译错误**，`zh.ts` 少一个键也是编译错误
（用 `satisfies Record<keyof typeof en, string>`）。300 处搬迁里漏一个键，`npm run typecheck` 立刻红，
不依赖人眼。

**初始化（`index.ts`）**：

```ts
i18n.use(initReactI18next).init({
  lng: resolveLanguage(pref, env.locale),
  fallbackLng: FALLBACK,                        // 'en'
  resources: { [FALLBACK]: { translation: en } }, // 基准语言随主包，同步可用
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },        // React 已转义，避免 &amp;
  returnNull: false,
  parseMissingKeyHandler: (key) => `⟦${key}⟧`,   // FR-009
  saveMissing: false,
  react: { useSuspense: false },                // 关键：避免 chunk 未就绪时闪白/挂起
});

// 非基准语言按需加载，Vite 静态分析切 chunk
const loaders = import.meta.glob<{ default: Dict }>('./locales/*.ts');

export async function ensureLanguage(code: string) {
  if (code === FALLBACK || i18n.hasResourceBundle(code, 'translation')) return;
  const mod = await loaders[`./locales/${code}.ts`]?.();
  if (mod) i18n.addResourceBundle(code, 'translation', mod.default, true, true);
}
```

三个容易踩的点，实现时必须遵守：

- **`useSuspense: false` 不能省**。开着它时，`zh` 的 chunk 未加载完会让整棵树挂起；我们用的是
  「先 `ensureLanguage` 再渲染」的策略，不需要 Suspense。开 false 后即使 chunk 慢，界面也先是
  英文（fallback）而不是空白。
- **必须用 `import.meta.glob` 而不是 `` import(`./locales/${code}.ts`) ``**。后者的动态表达式在
  Vite 里会打警告且边界不可控；glob 是显式声明，加语言时无需改任何加载代码（FR-016）。
- **`escapeValue: false`**。否则文案里的 `'` 会变成 `&#39;`，React 已经转义过一次。

**`useT()` 是组件唯一入口**（FR-002 的「可替换的一层」）：

```ts
// useT.ts —— 全项目只有这一个文件 import react-i18next
export function useT() {
  const { t } = useTranslation();
  const language = useStore(s => s.language);
  return useMemo(() => ({
    t: (key: TKey, params?: Record<string, unknown>) => t(key, params),
    language,
  }), [t, language]);
}
```

组件里 `const { t } = useT()`。将来换库只改 `useT.ts` 与 `index.ts` 两个文件，20 个组件的
`t('key')` 调用一行都不用动。这条是本次选型的兜底——如果 i18next 将来出问题，迁移成本被压到最小。

### D3. 复数：用 `Intl.PluralRules` 校验覆盖，而不是靠人记得

i18next 的复数是**后缀**方案：`t('sessions.msgCount', { count: 3 })` 会查 `sessions.msgCount_other`。
它支持 CLDR 全部分类，但「某个分类漏写了」不会报错，只会静默回退到基 key 或 key 名——这正是
i18next 最被诟病的点（也是我选它时必须自己补的洞）。

单测强制（对应 FR-015 / SC-006）：

```ts
const pluralCategories = (bcp47: string) =>
  new Intl.PluralRules(bcp47).resolvedOptions().pluralCategories; // zh → ['other']，en → ['one','other']

const pluralBases = Object.keys(en)
  .filter(k => /_(one|other|few|many|two|zero)$/.test(k))
  .map(k => k.replace(/_(one|other|few|many|two|zero)$/, ''));

describe.each(LANGUAGES)('$code 复数覆盖', ({ code, bcp47 }) => {
  const dict = dictOf(code);
  const cats = pluralCategories(bcp47);
  test.each(pluralBases)('%s', (base) => {
    for (const cat of cats) {
      expect(dict[`${base}_${cat}`], `${code} 缺 ${base}_${cat}`).toBeTruthy();
    }
  });
});
```

效果：中文只要求 `_other`（中文本来没有单复数变化，强迫写 `_one` 是噪音）；
英文要求 `_one` + `_other`；**将来加俄语，`Intl.PluralRules('ru')` 直接返回
`['one','few','many','other']`，字典少一个 `_few` 测试就红**。这条不需要任何额外维护——
新语言一注册就自动被覆盖。

**组件里禁止 `count === 1 ? … : …`**。数量一律 `t('sessions.msgCount', { count })`，
让字典决定语法。`count` 作为 i18next 的保留参数，同时可用于 `{{count}}` 插值。

### D4. 语言注册表与选择器自适应

```ts
// languages.ts —— 加语言只改这里 + 加字典文件
export interface LanguageEntry {
  code: string;      // 偏好里存的值
  bcp47: string;     // 给 Intl 用
  labelKey: string;  // 语言名本身的显示方式，见下
  fallback?: boolean;
}

export const LANGUAGES: LanguageEntry[] = [
  { code: 'en', bcp47: 'en',  labelKey: 'language.en', fallback: true },
  { code: 'zh', bcp47: 'zh-CN', labelKey: 'language.zh' },
];
export const FALLBACK = 'en';
export const isRegistered = (c: string) => LANGUAGES.some(l => l.code === c);
```

**语言名不翻译成「当前界面语言」是错的**——用户切到看不懂的语言后就找不回来了。
所以语言名用**它自己**的写法（`English` / `中文` / `日本語`），不经过 `t()`。
`labelKey` 只是给无障碍标签和 e2e 一个稳定标识，不用于渲染选项文字。

**选择器自适应**（US2 场景 5）：`OptionsPopover` 里算 `items = 1 + LANGUAGES.length`，
`items <= 3` 用 `.segmented`（与 Theme 行同结构），`> 3` 用原生 `<select>`。
两种形态共用同一个 `options` 数组，加语言不动组件代码（FR-016 / SC-005）。

**为什么不做成一直用下拉**：现在 3 项跟 Theme 行视觉对齐的价值大于便利性；改成分支后，
第 4 种语言到来时自动切换，不需要那时再改一次 UI。

### D5. 机械搬迁，不做「边写功能边翻译」

顺序固定为：**先盘点 → 建注册表与基准字典骨架 → 逐文件替换 → 跑盘点命令确认归零 → 人工过一遍中文语气**。
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
| `language.*` | 语言选择器的无障碍标签与说明 |

### D6. 不翻译的东西（写进代码注释，避免下次被「优化」）

- pi 的 stderr、命令输出、工具名、模型名、provider 名、文件路径。
- `Pi Agent`、`MCP`、`token`、`fork`、`steer`、`session`（作为技术名词时保留英文，首次出现可加括号注释）。
- `data-testid`、CSS 类名、日志文本（`LOG.warn` 保持英文，便于检索 issue）。

### D7. IDE 侧资源包

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
- **Web 字典与 properties 各自独立，不做共享或互相生成**（FR-018）。两侧语言来源不同：
  IDE 侧由语言包决定、不可应用内覆盖，Web 侧可覆盖；强行统一会引入一个没有真源的中间层。
  唯一需要对齐的是「同一概念的文案语气」，靠人工过一遍，不靠工具。

### D8. 验证策略

- 单测（`i18n.test.ts`）：键覆盖（每语言 vs 基准）、复数分类（D3）、占位符替换、缺 key 返回 `⟦key⟧`、
  `LANGUAGES` 与 `locales/` 目录文件一一对应、`resolveLanguage` 的四种输入（已注册 / `system`+zh /
  `system`+ja / 未知代码）。
- Kotlin 单测 `PiAgentBundleTest`：读两个 `.properties`，断言 key 集合相等、无空值、中文包确实与英文不同。
- e2e `web/e2e/i18n.spec.ts` —— `system + zh` 下 tabs 为中文；切到 `en` 后为英文；切语言后消息条数不变；
  英文态下 `manage` 面板无中文；界面无 `⟦` 字符；Language 行在 3 项时是 `.segmented`。
- **可扩展性 e2e/单测（SC-005）**：临时注册假语言 `xx` + 加一个 `locales/xx.ts`，断言
  `web/src/components/` 零改动即可渲染、Language 行自动变 `<select>`。验证完删除该临时语言。
- 真机：中文 IDE（语言包）与英文 IDE 各一次，截图 Chat/Sessions/Manage/右键菜单/通知。

## 触及文件

| 文件 | 改动 |
|---|---|
| `web/package.json` | **新增依赖** `i18next`、`react-i18next`（本版唯一允许新增的 npm 依赖） |
| `web/src/i18n/languages.ts` | **新增**：`LANGUAGES` 注册表、`FALLBACK`、`isRegistered` |
| `web/src/i18n/locales/en.ts` | **新增**：基准语言字典（`as const`，类型源） |
| `web/src/i18n/locales/zh.ts` | **新增**：中文字典（`satisfies Record<keyof typeof en, string>`） |
| `web/src/i18n/index.ts` | **新增**：i18next 初始化、`ensureLanguage`、`setLanguage`、`resolveLanguage` |
| `web/src/i18n/useT.ts` | **新增**：组件唯一入口（全项目唯一 import `react-i18next` 的地方） |
| `web/src/i18n/format.ts` | **新增**：`formatNumber` / `formatDate` / `formatRelative` 薄封装 |
| `web/src/i18n/resources.d.ts` | **新增**：`CustomTypeOptions` 类型注入 |
| `web/src/i18n/i18n.test.ts` | **新增**：键覆盖、复数分类、占位符、缺 key、注册表一致性 |
| `web/src/store/store.ts` | `language` / `languagePref`、`setLanguage`、`init()` 解析 locale |
| `web/src/components/OptionsPopover.tsx` | Language 行：≤3 项 `.segmented`、>3 项 `<select>` + 说明文案 |
| `web/src/**/*.tsx`（约 20 个） | 文案搬迁到 `useT()` |
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

1. 跑盘点命令，把「待翻译条目数」写回本文件；**先装依赖并验证 `import.meta.glob` 在
   `vite build` 后确实切出独立 chunk**（这条不通，懒加载方案要换成「全量同步打包」，
   属于架构级分叉，必须第一步验掉）。再建 `languages.ts` + `en.ts`/`zh.ts` 骨架
   （先只放 `common.*` 与 `chat.tabs.*`）+ `useT.ts` + `resources.d.ts`。
2. `env.locale` + 偏好读写 + Options 选择器（≤3 项分支先做）——打通链路，先让 tabs 会切。
3. 按 area 逐个搬：chat → sessions → manage → confirm/error/common；每搬完一个跑
   typecheck + 对应 e2e。复数文案在这一步落地，同时补 D3 的分类校验测试。
4. Kotlin：bundle + `PiAgentBundle.kt` + `plugin.xml` `%key` + 各处 `message()` 替换。
5. 单测（键覆盖 + 复数 + 注册表）+ e2e（切换、无残留、无 `⟦`）+ **假语言可扩展性验证（SC-005）**
   + 真机双语截图。
6. **收尾复核**：再跑一次盘点命令，残留数写回本文件；残留必须全部属于 D6 的「不翻译」白名单。

## 风险

| 风险 | 缓解 |
|---|---|
| 约 300 条文案一次性搬迁，中途 typecheck 大面积报错 | 按 area 分批，每批结束跑 typecheck；键类型从 `en.ts` 推导，报错即缺键 |
| **i18next 复数漏分类时静默回退**（不报错、界面显示基 key） | D3 的 `Intl.PluralRules` 枚举校验；e2e 断言界面无 `⟦` 字符。这是本方案唯一的「框架短板」，必须靠测试补 |
| **动态 `import()` 在构建后不切 chunk 或路径失效** | 第一步就用 `vite build` 验证产物里有 `zh-*.js`；用 `import.meta.glob` 而非模板字符串动态导入 |
| `useSuspense` 忘关 → 切语言时整棵树挂起、界面空白 | 初始化配置里显式 `react: { useSuspense: false }`；e2e 切语言后断言界面文本非空 |
| Manage 面板文案多、易漏 | 盘点命令 + e2e 断言「英文态 Manage 无中文」双向兜底 |
| 中文文案导致按钮变窄/变宽，破坏 360px 布局 | e2e 在中文态重跑 `layout-regressions.spec.ts` 的 360px 用例 |
| 用户以为「切了语言但右键菜单没变」 | Options 的 Language 行加说明：「IDE 菜单与通知跟随 IDE 语言包」 |
| `plugin.xml` 的 `%key` 写错导致菜单显示 `%key` 字面量 | 真机逐项检查两个右键菜单；`PiAgentBundleTest` 校验 key 都存在 |
| **将来加 RTL 语言（阿拉伯语/希伯来语）时布局错位** | 本版不处理：现有 CSS 大量 `margin-left` 等物理属性。作为已知债记录——加 RTL 语言的前置条件是先把这些改成逻辑属性（`margin-inline-start`），并设置 `document.documentElement.dir` |
| 无人值守执行时新增依赖被「顺手」加多 | 明确只允许 `i18next` + `react-i18next`；`i18next-http-backend` / `languagedetector` / `i18next-icu` 均不装（理由见 D0） |
