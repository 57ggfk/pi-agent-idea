# 029 「回到底部」悬浮按钮 — 技术方案

> 依据 spec.md（2026-11-12）与 2026-11-12 代码复核（`lib/pin.ts`、`MessageList.tsx:150-280`）。

## 0. 复核结论

| spec 断言 | 复核结果 |
|---|---|
| `pinRef` 是 ref 不是 state | ✅（`MessageList.tsx:163`），`onScroll` 每次 `nextPin` 只写 ref |
| stick effect 直接改 `pinRef.current` | ✅（`:215-222`，程序化贴底后同步 lastTop/lastHeight） |
| `Icon.tsx` 已有 `chev-down` | ✅（`:65`） |
| `.message-list` 是滚动容器、`.app` 的 flex 子元素 | ✅（styles.css:2055 `flex:1; min-height:0; overflow-y:auto`） |
| e2e 长会话注入方式 | ✅ 022 用 `sendAndWait` 循环（mock 回复含 markdown/工具卡，4 条即超一屏） |

**几何约束的落点**：按钮不能进滚动容器（会改变 `scrollHeight`，spec 022 教训），也不能
`absolute` 定位在 `.message-list` 内部（滚动容器内的绝对定位子元素随内容滚动、且参与滚动溢出）。
方案：给 `.message-list` 套一个**定位兄弟容器** `.message-list-wrap`（占位属性从 `.message-list`
上移：`flex:1; min-height:0; min-width:0; display:flex`），按钮 `absolute; right:12px; bottom:12px`
挂在 wrap 上——几何上 wrap 与原 `.message-list` 完全同框，滚动几何零变化。
QueueBar/Composer 是 `.app` 里 wrap 之后的兄弟，按钮以 wrap 底部为基准天然不遮挡（FR-006），
队列条出现时按钮不随之移动也不重叠（不同层）。

## 1. 状态镜像（FR-001）

```ts
const uiPinnedRef = useRef(true);          // 与 pinRef.current.pinned 的 UI 镜像（比较基准）
const [jumpVisible, setJumpVisible] = useState(false);  // pinned===false 时按钮存在
const syncPinUi = (pinned: boolean) => {
  if (uiPinnedRef.current !== pinned) { uiPinnedRef.current = pinned; setJumpVisible(!pinned); }
};
```

接线点：`onScroll` 的 `nextPin` 之后、stick effect 写 `pinRef.current` 之后、jump 点击处置 true 时。
值变化才 setState（每格滚动零渲染）。

## 2. 按钮（FR-002/003/005/006/007）

```tsx
{jumpVisible ? (
  <button className="jump-bottom" data-testid="jump-bottom" aria-label={t("chat.jumpToBottom")}
    onClick={jumpToBottom}>
    <Icon name="chev-down" className="ic-sm" />
  </button>
) : null}
```

- 不渲染（不是 visibility 占位，FR-003）；`aria-label` 双语（FR-005）；`<button>` 原生键盘（US4）。
- `jumpToBottom`（FR-004）：**先** `pinRef.current = { pinned: true, lastTop: el.scrollTop,
  lastHeight: el.scrollHeight }` + `syncPinUi(true)`（按钮即隐），**后**
  `el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion ? "auto" : "smooth" })`。
  lastTop 取当前 scrollTop（向下滚 scrollTop 单调增 → nextPin 规则 4 保持 pinned，末帧规则 3 再钉），
  不会被程序化滚动误判为向上（US5）。
- FR-008：`unseenRef`（boolean ref）——stick effect 里 `!pinned && items 变化` 置 true、恢复 pinned 置
  false。本轮不渲染（spec 明确不加角标），US3 的可观测对应物（按钮仍在、不自动滚动）由 e2e 锁。

## 3. CSS

```css
.message-list-wrap { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; }
.jump-bottom { position: absolute; right: 12px; bottom: 12px; z-index: 5; …圆形按钮样式 }
```

`.message-list` 原样保留（`flex:1` 在 wrap 内语义不变，几何同框）。

## 4. 测试设计（web/e2e/jump-bottom.spec.ts，新文件）

| # | 用例 | 断言 |
|---|---|---|
| E1 | US1 出现/点击/消失 | seed 6 条 → `scrollTop=0` → `jump-bottom` 可见 → 记 scrollHeight → 点击 → 距底 ≤4px 且按钮 `toHaveCount(0)` 且 scrollHeight **不变** |
| E2 | US2 贴底不打扰 | 贴底 + 流式 1s 采样 → `jump-bottom` 全程 count 0 |
| E3 | US4 键盘 | unpinned → `focus()` + Enter → 距底 ≤4px；`aria-label` 非空（字典命中） |
| E4 | US5 不误判 | 点击 → 等动画 → 两次 rAF 后仍贴底 → `sendAndWait` 新消息 → 自动贴底保持 |
| E5 | US3 新内容暗示 | unpinned 时 `sendAndWait` → 按钮仍在（不自动滚） |
| E6 | 零回归 | scroll.spec（022 全部阈值）/layout-regressions 全绿 |

## 5. 触及文件

```
web/src/components/MessageList.tsx   wrap + 状态镜像 + 按钮 + unseenRef
web/src/styles.css                   .message-list-wrap / .jump-bottom
web/src/i18n/locales/{en,zh}.ts      chat.jumpToBottom
web/e2e/jump-bottom.spec.ts          新文件 E1–E5
```

## 6. 风险与边界

- smooth 在 OSR 下偏顿：先做 smooth（spec 默认），真机目验条目进 MANUAL_TEST；不达标降级 `auto`。
- `scrollTo` 在某些旧 WebView 不支持 options——JCEF 116+ 支持，不做降级。
- `.message-list` 双 CSS 块（257/2055）不动；wrap 只接管占位属性。
