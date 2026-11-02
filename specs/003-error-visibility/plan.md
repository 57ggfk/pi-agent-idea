# Implementation Plan: 静默失败可见化

**Branch**: `003-error-visibility` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-error-visibility/spec.md`

## Summary

把散落在 `store.ts` 里的 12 处 `.catch(() => undefined)` / 空 `catch` 收敛成一个统一的数据源状态机，
让「为空 / 加载中 / 失败 / 不支持」在 UI 上可区分、可重试、可自动恢复。

不改桥接协议，不动后端；纯前端状态管理重构 + 一组空态组件 + 一个诊断视图。

## Technical Context

**Language/Version**: TypeScript 5 / React 18

**Primary Dependencies**: zustand（现有 store）、现有 `bridge.request` / `rpc` 包装

**Storage**: 内存状态；文件列表缓存加时间戳

**Testing**: Vitest（状态机纯函数）、Playwright（空态文案与重试行为）

**Target Platform**: JCEF（Chromium）

**Project Type**: 单仓双端的前端侧改动

**Performance Goals**: 重试不产生并发风暴；打开菜单不额外阻塞

**Constraints**: 不得让「失败」变成弹窗骚扰；mock 不支持的方法不能算失败

**Scale/Scope**: 约 8 个数据源，`store.ts` 约 800 行需局部重构

## Constitution Check

| 原则 | 落实方式 | 结论 |
|---|---|---|
| **I. 双端契约同步** | 不改协议；若状态字段需要持久化则不动后端 | PASS |
| **II. 断言含几何与行为** | 空态断言用文案 + `data-state` 属性；重试断言「点击→loading→ready」的状态序列，不只断言按钮存在 | PASS |
| **III. 不依赖环境假设** | 空态布局沿用已有 `.empty-*` 体系，不新增定位计算 | PASS |
| **IV. 写操作可回滚** | 本规格无写入 | N/A |
| **V. JCEF 走 bridge** | 无新增桥接方法（诊断视图复用已有调用） | PASS |
| **VI. 凭据零托管** | 诊断视图展示错误消息时需过滤凭据形态字符串 | PASS（见风险） |

无违反项。

## Project Structure

```text
web/src/
├── store/
│   ├── sources.ts                   # 新增：数据源状态机（纯函数，可单测）
│   ├── sources.test.ts              # 新增：状态迁移、去重、unsupported 判定
│   └── store.ts                     # 重构：12 处静默 catch → loadSource()
├── components/
│   ├── Composer.tsx                 # 菜单空态改为三态（loading/empty/failed + 重试）
│   ├── MessageList.tsx              # 无（空态已有）
│   └── manage/DiagnosticsPanel.tsx  # 新增：诊断视图
├── components/ManageView.tsx        # 新增第 6 个分区「诊断」
└── bridge/mock.ts                   # +?fail=<source> 开关，模拟单源失败

web/e2e/
└── diagnostics.spec.ts              # 新增：三态文案、重试、自动恢复
```

**Structure Decision**: 状态机单独成 `sources.ts` 纯函数模块，便于 Vitest 覆盖所有迁移路径；
`store.ts` 只保留胶水代码，避免这个 800 行文件继续膨胀。

## 关键技术决策

### 1. 数据源状态机的形状

```ts
type SourceStatus = "idle" | "loading" | "ready" | "failed" | "unsupported";

interface SourceState {
  status: SourceStatus;
  error?: string;        // 截断到 200 字符的摘要
  fullError?: string;    // 诊断视图展开用
  lastSuccessAt?: number;
  inflight?: boolean;
  retries: number;
}
```

`unsupported` 单独一档：mock 里不存在的方法、或后端明确返回 `not_implemented`，
都落到这里，**不计入失败**——否则 mock 环境会满屏红。

### 2. 统一入口 `loadSource(id, fetcher)`

替换现有所有 `try { ... } catch {}` 与 `.catch(() => undefined)`：

```ts
async function loadSource<T>(id: SourceId, fetcher: () => Promise<T>): Promise<T | undefined> {
  const cur = get().sources[id];
  if (cur?.inflight) return;          // in-flight 去重（FR-004）
  setSource(id, { status: "loading", inflight: true });
  try {
    const value = await fetcher();
    setSource(id, { status: "ready", inflight: false, error: undefined, lastSuccessAt: Date.now() });
    return value;
  } catch (e) {
    setSource(id, { status: classify(e), inflight: false, error: truncate(e), fullError: String(e), retries: cur.retries + 1 });
  }
}
```

`classify(e)`：消息含 `not_implemented` / `unsupported` → `unsupported`，否则 `failed`。

### 3. 空态三态渲染

`Composer` 的菜单分支从「有匹配就渲染」改成：

| 状态 | 渲染 |
|---|---|
| loading | 「正在加载…」 |
| ready + 无匹配 | 「没有匹配的文件」 |
| failed | 「文件列表加载失败：{摘要}」+ [重试] |
| unsupported | 不渲染该菜单（mock 场景） |

`/` 与 `@` 各自独立判定，互不影响。

### 4. 自动恢复

在现有 `pi-state` 变 `running` 的处理里（`refreshMeta` 已有雏形）扩展：
遍历 `sources`，对 `failed` 的源补拉一次。**不清空 `ready` 的源**，避免无谓请求。

### 5. 文件列表失效

- 前端持 `filesLoadedAt`，打开 `@` 菜单时若 `Date.now() - filesLoadedAt > 30_000` 则重拉；
- 用户手动点刷新（诊断视图或菜单里的刷新）→ 强制重拉并重置时间戳；
- 后端 `FILES_TTL_MS` 保持不变——两层缓存各自管各自，前端只负责「要不要再问一次」。

### 6. 诊断视图

放在 Manage 第 6 个分区（与 MCP / 包 / Skills / 认证 / 设置并列）。每行：数据源名、状态徽标、
最近错误摘要（可展开全文）、[重试] 按钮。全部 `ready` 时显示一行「全部正常」。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 错误消息里含路径/凭据形态字符串 | 诊断视图泄漏 | 展示前对 `sk-*`、`Bearer *`、`apiKey":"..."` 做掩码 |
| 重构 12 处 catch 引入回归 | 原有行为改变 | 逐源迁移，每迁移一源跑一次全量 e2e |
| `unsupported` 判定过宽，真失败被吞 | 又回到静默失败 | 只认明确的 `not_implemented` / `unsupported` 文案，不做模糊匹配 |
| pi 反复起停导致自动恢复风暴 | 请求风暴 | 自动恢复只对 `failed` 且 `retries < 5` 的源执行 |
