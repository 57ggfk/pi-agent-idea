# 022 滚轮边界 latch — 真机 verdict 存档

这两份 JSON 是 `web/probe-wheel-real.mjs` 在 **WebStorm 2026.2.1 + 真实 JCEF** 上跑出来的
原始 verdict，用来支撑 `spec.md` 与 `../0.5.8-run-report.md` 第 10 节里的数字。它们**不是**
e2e 结果，也不进 CI（原因见下）。

| 文件 | 构建 | 断言 | 消息列表 | 会话列表 |
|---|---|---|---|---|
| `probe-wheel-real-revert.json` | 同一构建，跑时注入 CSS 去掉修复 | 17 条：9 PASS / **2 FAIL** / 6 INFO | 3/3 轮卡死（0 位移、wheel 到 2 个、scroll 到 0 个） | 3/3 轮卡死 |
| `probe-wheel-real-after-fix.json` | 带修复的构建，不额外注入 | 16 条：11 PASS / **0 FAIL** / 5 INFO | 3/3 轮第一格即动 | 3/3 轮第一格即动 |

`revert` 少一条 INFO 是「复现：卡住样本」——只有真的卡住了才打印它。这条 INFO 的存在本身
就是复现成功的标志。

## 怎么读

- **`fix` 字段**是「探针额外注入了什么」，不是「这个构建有没有修复」。所以
  `after-fix.json` 里 `fix: "none"` 的意思是**不再需要注入**（构建自带），别读成"没修"。
- **`rounds`** 是消息列表的采样轮次，每轮 = 停到底部 → 多滚 5 格下 → 立刻上滑 1 格。
  看 `movedFirstUp`：`0` = 卡死，`>0` = 第一格就动了。
- **`stage2.rounds`** 是对会话列表（`.sessions-list`）做的同一手势，字段同构。
- **`checks`** 里 `ok: true/false/null` 分别对应 PASS / FAIL / INFO。INFO 是会话挑选、
  页面环境、`overscrollBehaviorY` 取值这类记录项，不判真假，别算进通过率。
- **`calib`** 记的是屏幕坐标 → 页面坐标的标定。OSR 没有子窗口，Win32 无法直接问页面在哪，
  所以靠移动真实光标再读页面自己的 `mousemove` 反解，`offset` 两次命中一致才算标定成功。

## 重跑

需要 IDE 带 `-Dide.browser.jcef.debug.port=9222` 且 pi 工具窗已打开（`-Dpi.agent.autoOpen=true`）：

```bash
cd web
npm run probe:wheel -- 9222 3                       # 修复后应当全 PASS
npm run probe:wheel -- 9222 3 --fix=revert          # 负向对照，应当复现 FAIL
```

`--fix` 可选 `none | revert | css | css-min | css-contain | js`。`revert` 用注入样式覆盖掉
`overscroll-behavior`，因此**同一个构建上**就能做 A/B，这是把「因果唯一」钉死的手段 ——
两组唯一差异就是那一条 CSS。

## 为什么留这两份、其余不留

`build/` 下还产生过 `css` / `css-min` / `css-contain` / `js` / `none` 五份，都是中途试方案时的
快照（当时探针只有消息列表一段，会话列表断言还不存在），结论已被最终这对覆盖；`none` 与
`after-fix` 是同一次运行的不同拷贝。留多了只会让后来人分不清哪份算数。

## 为什么不能进 CI

CI 里没有真实 IDE，也没有真实鼠标。CDP 注入的滚轮是**像素级 delta**，直接改偏移，不经过
Chromium「一格 → 约 100ms 滚动动画」那条路径 —— 而 latch 只发生在后者。所以无头环境天然
测不到这个 bug，写进 CI 只会是一条永远绿的假守卫。能进 CI 的只有样式存在性断言，那在
`web/e2e/scroll.spec.ts` 的 `scroll chaining` 两条里。

## 已知残留

`token=` 已在生成端（探针脚本）与入库端各脱敏一次，本目录两份文件中不含可用凭据；
工作区路径也已替换为 `<local>`。仓库里另外几个 `web/probe-*.mjs`（copy / fork / provider /
0.5.7-manual）仍会原样写 `page.url()`，它们的产物目前未入库，改动留到各自规格时处理。
