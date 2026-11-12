# 027 自定义 Provider — 技术方案

> 依据 spec.md（2026-11-12）与 2026-11-12 代码复核。

## 0. 复核结论

| 事实 | 复核结果 |
|---|---|
| `models.json` 路径/读取 | `PiCliRunner.agentDir()/models.json`；`PiManage.modelsReadProvider` 已有 sanitize 与 parse 定位 |
| `providerSetKey` 拒绝未定义 provider | ✅（PiCredentials.kt）——本 spec 的 Save 取代「先去编辑器」路径 |
| 017 热重载通路 | `BridgeService.reloadModels()`（suspend，/pi-agent-reload-models + get_available_models），Save 后内部调用即可 |
| authOverview 已合并 models.json customs | ✅（`providers = creds ∪ models.json keys`，`modelsState` 字段） |
| 内置 provider 名单 | web 侧 `KNOWN_PROVIDERS`（012 生成）；Kotlin 写盘侧需同名单（写入 PiModels 常量） |
| models-store.json | 顶层 `providers: []`（本机）——不动它（非目标） |
| 真机 models.json | 不存在（auth.json 路线）——Save 必须处理「文件缺失=新建」 |

## 1. Kotlin：新文件 `manage/PiModels.kt`

四个入口（BridgeService 分发，见 §2），`agentDir` 参数默认 `PiCliRunner.agentDir()`：

- **`providerGet({name})`**：读 models.json → `providers[name]` → 表单形状：
  `{ok, exists, provider:{name, displayName, baseUrl, api, models:[{id,name,reasoning,inputImage,thinkingLevels[]}], hasKey, keyMasked}}`；
  `thinkingLevels` = `thinkingLevelMap` 中值非 null 的键（保持 pi 的级别顺序）；
  `apiKey` 永不出桥（FR-007），掩码 = 前 3 后 2、中间 `…`；缺失文件 → `exists:false`。
- **`providerSave({provider, overwrite})`**：
  1. 校验（失败不落盘）：name `[a-z0-9-_.]{1,64}`；`api ∈ {anthropic-messages, openai-completions, openai-responses, google-generative-ai}`；baseUrl `^https?://`；每模型 `id` 非空且唯一；displayName→`name`。
  2. **重名保护**（FR-005）：`name ∈ BUILTIN_PROVIDERS` 或（`providers` 已有同名且请求没带 `overwrite`）
     → `{ok:false, code:"builtin"|"exists", error}`，**不写文件**；`overwrite=true` 时继续。
  3. **合并**（FR-004）：读原文（缺失= `{}`）；顶层未知字段逐字保留；`providers[name]` =
     既有条目为底、表单字段覆盖——表单不拥有的字段（`headers`/`compat`/模型条目里未知的键）按
     **模型 id 合并保留**（保留 id 的既有未知键，删除的 id 连键一起消失）；
     `apiKey`：表单带了新 key → 覆盖；空 + `hasKey` → 保留原值（FR-007）。
  4. `thinkingLevelMap`：**纯函数** `buildThinkingLevelMap(levels)`（级别顺序 = pi 的
     `THINKING_LEVELS`），勾=同名串、未勾=null；勾含 off 之外任一 → `reasoning:true` 且写映射表；
     仅 off 或全不勾 → `reasoning:false`、**不写**映射表（FR-002）。
  5. `input`：`inputImage ? ["text","image"] : ["text"]`（FR-003）。
  6. 写前备份 `models.json.bak-<yyyyMMdd-HHmmss>`；临时文件 + `Files.move(ATOMIC_MOVE)`；
     解析失败的原文件**原样报错**，绝不覆盖（沿用 PiCredentials 口径）。
  7. 响应 `{ok:true, name, path, reloaded}`——`reloaded` 由 BridgeService 层附上（§2）。
- **`providerDelete({name})`**：内置名单拒绝；`providers` 里删除该键；备份 + 原子写；`{ok}`。
- **`providerTest({baseUrl, api, apiKey?})`**：`open-simple` HTTP 客户端 GET
  `${baseUrl}/models`（anthropic-messages → `/v1/models`），10s 超时；
  头：`Authorization: Bearer <key>`（anthropic 用 `x-api-key`）；响应 `{ok, status, ms, error?}`，
  **不回传 key、日志只记状态码与耗时**（FR-007/Q1）。失败形态=非 2xx/异常，不阻塞保存。

`BUILTIN_PROVIDERS`：与 web `KNOWN_PROVIDERS` 同源名单（amazon-bedrock, anthropic, openai,
openai-codex, openrouter, google, xai, groq, deepseek, zai, minimax, moonshot, …以 knownProviders.ts 为准抄录）。

## 2. BridgeService

```kotlin
"manage.providerGet" -> dev.pi.agent.manage.PiModels.providerGet(params)
"manage.providerSave" -> providerSaveWithReload(params)
"manage.providerDelete" -> dev.pi.agent.manage.PiModels.providerDelete(params)
"manage.providerTest" -> dev.pi.agent.manage.PiModels.providerTest(params)
```

`providerSaveWithReload`：`PiModels.providerSave(params)` 成功后 `try { reloadModels() → reloaded=true
} catch { reloaded=false, reloadError=msg }`（FR-006：重载失败提示但**不回滚文件**）。
`providerTest` 是阻塞 HTTP —— 放 `Dispatchers.IO`（dispatch 外壳已异步，照 `sessions.exportHtml` 的形态）。

## 3. Web

### 3.1 桥接四处同步（FR-008）

`types.ts` 4 个方法名；`manage.ts` 4 个函数与响应类型；`mock.ts`：
- `providerGet`：从 `mockCustomProviders` 读（掩码 `sk-…`）；`providerSave/Delete`：改内存表并
  **把 models 注入 `get_available_models` 的返回**（models.reload 的 017 mock 已有，合并即可），
  使「picker 出现新模型」可断言；`providerTest` 受 `?providertest=401|timeout` 旋钮控制（US5 两形态）。
- 内置名单拒绝与 Kotlin 同口径。

### 3.2 纯函数（lib/customProvider.ts + 单测）

- `THINKING_LEVELS`（7 级，与 pi 同序）；`DEFAULT_THINKING_LEVELS = ["low","medium","high"]`。
- `buildThinkingLevelsPayload(levels)` → 去序去重后的合法级别数组。
- `validateCustomProvider(form)` → 错误键或 null（名称正则、api 4 选 1、baseUrl scheme、模型 id 非空/唯一）——与 Kotlin 校验**同规则双保险**，文案复用 i18n。

### 3.3 `CustomProviderForm.tsx`（新组件，FR-009 的「同一组件」）

Props：`{api, editing?: string（回填）, onDone}`。字段（FR-001）：
provider 名（文本，正则校验）、显示名（可选）、API 格式（4 选 1 下拉）、Base URL、API Key（password，
编辑时占位符=掩码、留空不改）、模型列表（可增删行：ID、显示名、支持思考（勾选展开 7 级，
默认 low/medium/high）、支持图片、contextWindow/maxTokens 可选数字）、
「测试连通」按钮（显示状态码+耗时或错误原文，US5）、保存/取消。
高级折叠区：`api==="openai-completions" && 支持思考` 时给 `compat.thinkingFormat` 下拉
（deepseek/qwen/zai/openai，默认空=不写；Q2 口径）。
重名/内置拒绝：`code==="builtin"|"exists"` → 渲染确认条（二次确认后带 `overwrite:true` 重发）。

### 3.4 AuthPanel + ProviderSetupCard（FR-009）

- AuthPanel：`provider.addCustom` 按钮 → 展开 `CustomProviderForm`（新建）；
  自定义行（`provider.custom` 且不在 KNOWN_PROVIDERS）增「编辑 / 删除」小按钮——编辑回填
  `providerGet`，删除走 007 确认框后 `providerDelete`。
- ProviderSetupCard（012 US5 步骤）：底部「自定义 Provider…」折叠开关，展开渲染**同一个**
  `CustomProviderForm`（共享校验/文案/写盘路径）。

## 4. 测试设计

| 层 | 用例 | 断言 |
|---|---|---|
| Kotlin PiModelsTest | buildThinkingLevelMap | low/medium/high → 3 实 4 null；全不勾/off → null 表不写；7 级全勾 → 全实 |
| Kotlin | providerSave 新建 | 文件缺失→新建；JSON 逐字段；备份存在 |
| Kotlin | providerSave 合并 | 预置 3 provider（含未知字段 compat/cost）→ 新增第 4 个 → 前 3 段逐字保留；重名/内置 → 拒绝且 mtime 不变 |
| Kotlin | providerSave 编辑 | 空 key + hasKey → 原 apiKey 保留；模型 id 未知键保留 |
| Kotlin | providerDelete | 删目标、余段不动、内置拒绝 |
| vitest mock | 4 方法 | save→picker 出现新模型；test 两形态；掩码不出明文 |
| vitest lib | 校验/级别 | validateCustomProvider 4 类错误；默认级别 |
| e2e custom-provider.spec.ts | 全流程 | 表单保存→providerGet 掩码→picker 出现模型→发送消息；重名拒绝二次确认；编辑不改 key；删除消失；测试连通 401/超时文案不同；DOM/响应无明文 key |

## 5. 触及文件

```
src/main/kotlin/dev/pi/agent/manage/PiModels.kt            新增
src/test/kotlin/dev/pi/agent/manage/PiModelsTest.kt        新增
src/main/kotlin/dev/pi/agent/bridge/BridgeService.kt       4 路由 + save 后重载
web/src/bridge/types.ts web/src/manage.ts web/src/bridge/mock.ts
web/src/lib/customProvider.ts + test
web/src/components/manage/CustomProviderForm.tsx           新增
web/src/components/manage/AuthPanel.tsx
web/src/components/ProviderSetupCard.tsx
web/e2e/custom-provider.spec.ts                            新增
```
