# Plan: 自动读取 IDE 运行/构建环境并注入 pi（032）

> 依据 `spec.md`（Q1–Q6 已拍板）+ 真机 runtime（@earendil-works 1.5.0）bundle 取证。
> 与 spec 引用包名（@oh-my-pi 18.x）的差异已逐条核实——031 的教训：以真机 bundle 为准。

## 真机 runtime 取证（earendil 1.5.0，spec 引文为 @oh-my-pi 18.x，形状不同处以此为准）

| 事实 | 证据（dist/bundle/chunks/chunk-44DLKSKE.js） |
|---|---|
| `before_agent_start` 事件存在，扩展可注册 | `snapshotEventHandlers(this.extensions,"before_agent_start")`，事件带 `get systemPrompt(){return renderCurrentSystemPrompt()}` |
| **`event.systemPrompt` 是完整当前提示词字符串**（不是 18.x 的 string[]） | `renderCurrentSystemPrompt=()=>buildSystemPrompt(currentOptions)` → `getSystemMessageText({content,sections})` 拼接 content+全部 sections |
| handler 返回 `{systemPrompt: <string>}` → `forceSystemPrompt` **整体替换** | `result.systemPrompt!==void 0&&(currentOptions.forceSystemPrompt=result.systemPrompt)`；其余结果字段只有 `message` |
| 追加 = `event.systemPrompt + "\n\n" + 环境块` | 强制替换时丢失内置 sections，因此必须先带上原串 |
| `--append-system-prompt` 存在（静态兜底，Q3 本轮不用） | CLI 参数解析 + `promptSections.addendum=appendSystemPrompt` |
| 扩展注册 API `pi.on(name, handler)` | pi-approve.js:64 `pi.on("tool_call", …)` 先例 |
| 扩展报错不致命 | `emitError({extensionPath,event,error})` 后继续 |

## 架构

```
IDE 侧 (Kotlin)                          pi 侧 (JS 扩展)
─────────────────────────────           ─────────────────────────────
PiEnvSnapshot（纯函数，无 IDE 依赖）
  render(collectedAt, tiers, …)          pi-env.js  (resources/pi-env/)
  filterEnvVars(白名单+黑名单)              pi.on("before_agent_start"):
  suggestedCommands(标记文件)                读 process.env.PI_IDE_ENV_SNAPSHOT
                                             → 读快照 JSON（每轮重读，US4）
PiIdeEnv（编排，project 级缓存）              → enabled:false / 缺文件 ⇒ 不追加
  collectSections(project)                  → event.systemPrompt + "\n\n" + text
    A 档: ProjectRootManager.projectSdk
          + LanguageLevelProjectExtension   快照 JSON: { enabled, collectedAt,
    B 档: System.getenv 白名单过滤                text, sourceMarkers }
    Node 档: 反射 NodeJsInterpreterManager
          （WebStorm；IDEA 缺 JS 插件自动缺席，US5）
    Python 档: 由 A 档 projectSdk 覆盖
          （PyCharm 的 projectSdk 即解释器）
  refreshSnapshot(project)：重采集→写盘
    触发点：① pi start 后台一次
            ② BridgeService.rpcRequest 拦截 prompt（每轮，FR-009 无外部进程）
            ③ 设置开关切换时
  快照文件: agentDir()/pi-ide-env.json      （IDE config dir，绝不进项目仓库）
  applyWhitelistedEnv(env)（差量补齐）
    PI_IDE_ENV_SNAPSHOT=<快照路径>
    JAVA_HOME/VIRTUAL_ENV/… 只增不改

BridgeService: "manage.envSnapshot" → { ok, enabled, collectedAt, text }
Web SettingsPanel: 「环境快照」只读入口（Q6-b）
PiAgentSettings: envContextEnabled（默认 true，FR-010）
```

## 关键设计决定

1. **每轮新鲜度（US4）的实现**：扩展每轮重读快照文件；文件由 IDE 侧在每次 `prompt`
   RPC 转发前重写。重采集只做：ReadAction 读 SDK（毫秒级）+ `System.getenv`（零进程）+
   命中的缓存（node 路径/版本、login-shell PATH 首采缓存）——满足 FR-009「不启动外部进程」。
   不装 timer（spec 明令禁止）。
2. **PyCharm venv 不需要 Python 插件反射**：PyCharm 把项目解释器写进 projectSdk
   （name="Python 3.12 (.venv)"、homePath=venv python），A 档直接覆盖 US3。
3. **Node 档反射降级**：`com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager`
   按候选类名反射（公共 API、optional 插件，反射只为缺插件时不 NoClassDefFoundError，
   非 FR-008 禁止的 internal 绕过）；失败 → 档位缺席，快照标注「JS 插件缺席」。
   node 兜底路径用 `PiLocator.locateNode()`（PATH 扫描，无进程）；版本 `node -v` 仅首采一次并缓存。
4. **敏感过滤（FR-006/US6）双闸**：env 变量先按白名单名字（JAVA_HOME/GRADLE_HOME/
   MAVEN_HOME/VIRTUAL_ENV/ANDROID_HOME/NODE_ENV/NODE_OPTIONS/JAVA_TOOL_OPTIONS/MAVEN_OPTS/
   NVM_DIR/…）挑，再对名字过黑名单正则（token|secret|password|passwd|key|credential|auth），
   命中即弃；值截断 120 字符。快照/日志/发往模型的内容同一路径，无处旁路。
5. **命令建议（Q5-b）**：只看项目根标记文件存在性（pom.xml / build.gradle.kts /
   package.json / requirements.txt），映射到固定命令行，不解析构建工具模型（spec 禁令）。
6. **FR-010 开关**：关闭 = 重写快照文件 `{enabled:false}`；扩展读到即不追加，无需重启 pi
   ——比「卸载扩展」轻，且已运行的 pi 立即回到现状提示词。
7. **快照文本语言**：英文（给模型读的事实清单；前端按钮文案走 i18n）。

## 不做（照 spec）

- C 档 run config env：不反射、不给手填入口（已知缺口，等公共 API）。
- 不读 password safe；不解析构建工具内部模型；不轮询；快照不进项目仓库；
  不做 WSL/Docker/SSH 远端解释器探测。

## 验证映射

| spec 验证计划行 | 落点 |
|---|---|
| 单测：假 SDK 快照 + 敏感过滤 | PiEnvSnapshotTest（render/filterEnvVars 纯函数） |
| 单测：档位缺失 → 「未检测到」不抛异常 | PiEnvSnapshotTest |
| 单测：env 差量补齐 + PI_IDE_ 前缀 | PiIdeEnvWhitelistTest |
| 扩展行为（读文件/开关/追加不覆盖） | web vitest 直接 import pi-env.js 资源，喂假 pi 对象 |
| UI 只读入口 | e2e（mock manage.envSnapshot） |
| 真机 | 第 13 节同款流程装 r29：快照文件、collectedAt 随消息更新、pi 正常回复无扩展报错、WebStorm 缺 SDK 降级、开关关后提示词回到现状 |
