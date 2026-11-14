# 035 串行队列 — plan/tasks（合并，规模小）

## 实现

`web/src/lib/opQueue.ts`（新）——模块级单例串行队列：

```ts
export interface QueueSnapshot { active: string | null; waiting: string[] }
export function managementQueueRun<T>(key: string, run: () => Promise<T>): Promise<T>
export function managementQueueSnapshot(): QueueSnapshot   // useSyncExternalStore 友好
export function managementQueueSubscribe(cb: () => void): () => void
```

- FIFO：链式 promise；`active` = 正在执行的 key；`waiting` = 后续 keys（有序）。
- 一项失败/异常 → 记录后继续下一项（promise 链不中断）。
- 快照不可变对象 + 订阅通知（React `useSyncExternalStore`）。

## 面板接入

| 面板 | key 形态 | 入队操作 |
|---|---|---|
| PackagesPanel | `pkg:<source>`（行）/ `pkg:toolbar` | install/remove/upgrade/updateAll/reinstall |
| MarketplacePanel | `market:<name>` | 一键安装 |
| SkillsPanel | `skill:<path>` | setEnabled/toggleSoft/reinstall/外接开关 |

- 行内状态：`waiting` 含本行 key → 「排队中（第 N 位）」徽章；active → 现有进度线。
- 按钮：本行 key 在队列中（active/waiting）时禁用自身按钮；**其余行按钮保持可点**（可继续入队）。
- 结果横幅：最后一次完成的操作（现状保留）。

## tasks

- [x] **T1601** opQueue 实现 + 单测（FIFO 顺序/失败续跑/快照订阅/去重）
- [x] **T1602** 三面板接入 + 行内排队徽章 + 按钮禁用策略改造
- [x] **T1603** e2e：`?pkgspeed=slow` 双操作排队（A 进行中 B 排队 → 顺序完成）；断言更新（其他行 enabled=可入队；reload 条手动清）
- [x] **T1604** 真机：runIde CDP 沙箱实测（下节）
