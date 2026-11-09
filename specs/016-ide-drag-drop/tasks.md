# 016 tasks

> 状态：实现完成并自测（web typecheck ✓ / vitest 262 ✓ / playwright 全量 246 ✓ / gradle test ✓ / buildPlugin ✓）。真机验收见「真机清单」。

## A. IDE 侧（真路径来源）

- [x] T1 `IdeFileDrop`：`record(paths)` / `take()`（一次性）+ TTL（默认 60s，时钟可注入）；空列表视为有效记录（让上一次文件记录失效）。
- [x] T2 `DropRefs`：从 `BridgeService.filesRelPath` 抽出的纯换算（项目内绝对 → 相对、`Files.isDirectory` 定目录标志、探不到时用调用方提示、非法路径返回 null），`files.relpath` 与新 RPC 共用一份实现。
- [x] T3 `BridgeService`：`ideFileDrop` 字段 + `files.takeDrop`（返回 `{refs:[{path,dir}]}`，一次性取走）。
- [x] T4 `PiAgentPanel`：注册 `CefDragHandler`，`onDragEnter` 读 `CefDragData.getFileNames()` 并 `record`（无文件记空）；`dispose` 时移除；任何异常吞掉并返回 `false`（不拦截 CEF 自己的 drop）。
- [x] T5 单测 `IdeFileDropTest` 9 例：一次性、空清空、TTL 过期、空白过滤、项目内相对化 + 目录标志、项目外绝对路径、路径不存在回退提示、相对路径按项目根 stat、null root / NUL 路径不抛。

## B. 前端（通道顺序 + 提示 + 文本）

- [x] T6 store：`takeDroppedRefs()` 调 `files.takeDrop`，复用 `toPendingRefs` 解析；失败返回空数组（旧 IDE 兼容）。
- [x] T7 Composer `handleDrop`：同步读 DataTransfer → 图片走图片 chip → 有非图片文件项时**先问 IDE**、为空再退回 `collectDroppedRefs` → 都没有但文本是路径时按路径处理 → 其余文本插到光标（`insertDroppedText`）。
- [x] T8 `collectDroppedRefs` 收紧：`webkitGetAsEntry().fullPath` 只有多段时才当路径（单段 `/name` 是虚拟根，不是磁盘路径）；裸文本 token 需形如 `/`、`C:\`、`~/`、`./`、`../`。
- [x] T9 拖拽提示：`dropActive` state + `.composer-drop` 覆盖层（虚线 + i18n 文案），`dragenter` 仅在 `types` 含 `Files` / `text/uri-list` 时亮起，`dragleave` 用 `relatedTarget` 判断真正离开。
- [x] T10 CSS `.composer { position: relative }` + `.composer-drop`（`pointer-events: none`，不打断拖拽）。
- [x] T11 i18n `composer.dropHint`（en / zh）。
- [x] T12 mock：`files.takeDrop` 读 `?drop=a,b`（尾斜杠=目录，项目内转相对），一次性消费。
- [x] T13 e2e：IDE 真路径优先（拖 `store.ts` 得到 `src/store/store.ts`）、目录拖拽保留 `data-dir`、拖文字插入文本；既有 9 例零回归。

## C. 文档

- [x] T14 README 功能清单、CHANGELOG（Unreleased 中英）、MANUAL_TEST 手工用例 3 条。
- [x] T15 本 spec + tasks。

## 验证记录

- `web`: typecheck ✓；vitest 262 ✓；playwright 全量 246 ✓（`composer-refs.spec.ts` 12 例，其中新增 3 例）。
- `gradlew test` BUILD SUCCESSFUL（含 `IdeFileDropTest` 10 例）；`gradlew buildPlugin` ✓。

## 真机清单

1. **项目树拖文件进输入框**：拖动时输入框出现虚线提示，松手得到相对路径 chip（若没有任何反应 → 说明 IDEA 的拖拽没被 CEF 收到，需要另做 `DnDNativeTarget` 方案，见 spec 非目标）。
2. **项目树拖目录**：chip 图标为文件夹、路径是目录相对路径。
3. **编辑器标签拖文件**、**资源管理器拖文件/目录**：同样得到 chip；项目外的保持绝对路径。
4. **拖一段选中的代码**：文本插到光标处，无 chip，输入框按内容增高。
5. 连拖两个文件到同一个输入框：两个 chip 都在，重复路径不重复添加；发送后只带 `@相对路径`。
