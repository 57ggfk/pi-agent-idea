# 034 skills 管理完善 — 技术方案（plan）

> spec：[./spec.md](./spec.md)（Approved：Q1=b 项目禁用写 project settings、Q2=ab 预设+自定义外接、
> Q3=b 软开关可切换、Q4=a 提示条+一键 reload）。取证：evidence/probe-034-skills.json + 探针脚本
> `scripts/probe-034-skills.mjs`。task 编号 **T1501+**。

## 数据模型

`manage.skillsList` 重写，返回六类来源分组条目 + 外接来源清单：

```ts
interface SkillInfo {
  name; description; path;            // path = SKILL.md 所在目录（沿用）
  scope: "user" | "project";
  source: "user-pi" | "user-agents" | "project-pi" | "project-agents" | "package" | "external";
  disableModelInvocation: boolean;    // frontmatter 软开关（只读+可切换，Q3-b）
  enabled: boolean;                   // settings 排除条目未命中 = true（硬开关）
  duplicate: boolean;                 // 同名，首次发现的生效（FR-002）
}
interface SkillsListResult extends CliOutcome {
  skills: SkillInfo[];
  externalSources: string[];          // user settings skills 数组里的正向目录条目
  externalPresets: { claude: string; codex: string };   // user.home 推导
  projectBasePath?: string;
}
```

### 来源扫描（FR-001）

| source | 目录 | 备注 |
|---|---|---|
| user-pi | `<agent>/skills` | 现状 |
| user-agents | `~/.agents/skills`（真实 user.home，**不受 agent-dir 重定向影响**，探针实证） | 新增 |
| project-pi | `<base>/.pi/skills` | 现状 |
| project-agents | `<base>/.agents/skills` + **祖先上溯**（每级有则收录，遇 `.git` 止，上限 10 级） | 新增 |
| package | settings `packages` 数组：`npm:name` → `<agent>/npm/node_modules/<name>`（剥 @ver，复用 npmName 逻辑）；本地路径源直用；git 源跳过；walkTopDown 限深 4 | 新增 |
| external | user settings `skills` 数组正向目录条目 | 新增 |

同名去重（canonicalPath）沿用；`duplicate` = 同名（effective name）出现多次时，首个之外的条目置位。

### enabled 计算（FR-003）

收集 user + project 两份 settings 的 `skills` 数组排除条目（`-exact` / `!glob`），
条目命中 SKILL.md 路径 → `enabled=false`。glob → regex：`**`→`.*`、`*`→`[^/]*`、其余转义，
Windows 大小写不敏感。两级排除都是全局效果（pi 两级都加载）。

### 写路径（FR-003/005，Q1-b）

| RPC | 参数 | 行为 |
|---|---|---|
| `manage.skillSetEnabled` | `{path, enabled, scope, trusted}` | 排除条目增删：写 **user** settings（scope=user/external/package）；写 **project** `.pi/settings.json`（scope=project，未信任 → `code:"untrusted"` 拒绝）。enabled=true 时移除所有命中该路径的排除条目（精确相等或 glob 命中）。条目形式 `-<正斜杠绝对路径>/SKILL.md`。读改写 JSON 保留未知键（kotlinx JsonObject 保序） |
| `manage.skillSetSourceEnabled` | `{dir, enabled}` | 外接目录条目增删（user settings `skills` 数组，正向裸目录） |
| `manage.skillToggleModelInvocation` | `{path, disable}` | SKILL.md frontmatter 行级增删 `disable-model-invocation: true`；无 frontmatter → `code:"no-frontmatter"` 拒绝 |

## UI（SkillsPanel 重写）

- 来源分组头（六组，徽章 + 路径说明），组内行沿用 `skill-row`
- 行内：启用开关（硬）、「仅手动调用」小开关（软，Q3-b）、徽章（全局/项目/仅手动调用/已禁用/重名/未信任惰性）
- 外接来源区：两个预设开关（`~/.claude/skills`、`~/.codex/skills`，Q2）+ 自定义目录输入
- reload 提示条（Q4-a）：任一切换后出现「重启 pi 进程生效」+ 一键 reload（restartPiProcess），点后清除
- 项目组沿用 trusted 惰性标注

## 触及文件

| 文件 | 变更 |
|---|---|
| `PiManage.kt` | skillsList 重写 + skillSetEnabled/skillSetSourceEnabled/skillToggleModelInvocation + 排除匹配/glob/settings 读写工具 |
| `BridgeService.kt` | 注册 3 个新 RPC（带 trusted 注入） |
| `manage.ts` / `bridge/types.ts` / `mock.ts` | 类型 ±、api ±、mock 状态机 |
| `SkillsPanel.tsx` | 重写 |
| i18n en/zh | ~18 键 |
| styles.css | 分组/开关样式 |
| 测试 | PiManageSkillsTest（新）、PiPackagesTest 不动、mock.test 补、manage.spec 改写+新增 |

## 阶段

1. T1501 skillsList 重写（来源/分组/duplicate/enabled）+ 单测
2. T1502 排除匹配工具 + settings 读改写 + 三个写 RPC + 单测
3. T1503 桥接注册 + 类型 + mock
4. T1504 SkillsPanel 重写（分组/开关/外接区/reload 条）+ i18n + 样式
5. T1505 e2e 改写 + 新增；全量回归
6. T1506 真机探针复验（probe-034 扩展：切开关后 get_commands 变化）+ 构建 r35 安装
