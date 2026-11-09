# 016 从 IDE 拖文件 / 目录进输入框

> 来源：0.5.6 真机反馈——「与 IDEA 的整合，希望支持拖动文件或目录到输入框」。0.5.6（spec 015）已经在前端实现了 DnD 三路解析，但真机从 IDEA 项目树拖进去要么没反应，要么只得到 `a.kt` 这种只有文件名的 chip（pi 解析不到）。
> 版本归属：0.5.7（Unreleased）。关联：spec 015（引用 chip / `files.relpath` / `@path` 不展开的实证）、spec 009（IDE 事件通道）。

## 调研结论（决定方案的关键事实）

1. **HTML5 `drop` 事件拿不到本地绝对路径**。Chromium 出于安全只给 `File.name`；`webkitGetAsEntry().fullPath` 对原生拖拽是 `/名字`（前导斜杠只是虚拟根），不是磁盘路径。所以 spec 015 注释里「fullPath 给绝对路径」的假设不成立——真机拖拽只能得到裸文件名。
2. **真路径只有 CEF 侧有**。`CefDragHandler.onDragEnter(browser, dragData, mask)` 的 `CefDragData.getFileNames(Vector<String>)` 返回这次拖拽携带的**绝对路径**（包括目录）。IDEA 的项目树 / 编辑器标签拖拽在 Windows 上经 AWT 折算成 `CF_HDROP`（拖到桌面能复制文件就是证据），所以 CEF 能收到同一批路径。
3. **通道顺序必须由 IDE 主导**：先问 IDE（`files.takeDrop`），拿不到才退回 DataTransfer 的 uri-list / 纯文本解析。反过来的话，原生拖拽永远命中「裸文件名」分支，chip 就是错的。
4. **一次性缓冲 + TTL**：`onDragEnter` 先于 `drop` 触发，中间没有「取消」回调。用户拖进来又拖走（没松手）时，缓冲必须过期，否则几秒后一次无关的 drop 会把上一批文件顺手带上。
5. **纯文本拖拽是另一条路**：`dragover` 上无条件 `preventDefault()` 才能收到 `drop`，代价是浏览器默认的「把文字插到光标处」被吞掉。0.5.6 的实现还把 `fun`、`main()` 这类代码 token 当成路径生成假引用——本次一并修正。

## User Stories

### US1 拖文件 / 目录进输入框 → 引用 chip

从 **IDEA 项目树**、**编辑器标签**、**系统文件管理器**拖文件或目录到输入框，松手后出现引用 chip（可删、按路径去重、发送只带 `@相对路径`）。
- IDE 侧：`PiAgentPanel` 注册 `CefDragHandler`，`onDragEnter` 把 `getFileNames()` 的路径（没有文件时记空列表，用于让上一次记录失效）写进 `BridgeService.ideFileDrop`。
- 前端 `drop` 里先调 `files.takeDrop`：Kotlin 侧把绝对路径按 spec 015 的规则换算（项目内 → 相对路径、`Files.isDirectory` 核实目录标志、项目外原样），一次性返回。RPC 不可用（旧版 IDE）时退回 DataTransfer 解析，行为与 0.5.6 一致。
- 图片仍走图片 chip，不生成引用。

### US2 拖拽时的视觉反馈

拖动文件/目录经过输入框时，输入框显示虚线高亮 +「松开即把这个文件 / 目录加为引用」（`composer.dropHint`，中英双份）；离开或松手即消失。`dataTransfer.types` 不含 `Files` / `text/uri-list`（例如拖文字）时不显示提示。

### US3 拖文字 → 插入文本，不生成假引用

纯文本拖拽（编辑器选中代码）在 `drop` 里插到光标处，并按文本高度重算输入框；不产生 chip。裸文本 token 只有形如 `/abs`、`C:\…`、`~/…`、`./…` 时才按路径处理。

## 非目标

- 拖到工具窗**其它区域**（消息区、顶栏）也落进输入框——本次只认输入框本身。
- 多选拖拽的数量上限 / 二次确认——按原样全部转成 chip（与右键动作一致）。
- 项目外路径的相对化（软链接、junction、跨盘符）——保持绝对路径，pi 能读。
- 从工具窗把图片/文件**拖出去**（拖到编辑器或桌面）。
- OSR（离屏渲染）兜底：若真机确认 IDEA 项目树拖拽根本没被 CEF 收到（即 `CF_HDROP` 不存在），需要另一套 `DnDNativeTarget` 方案，见「真机清单」。

## 验收

- 单测：`IdeFileDropTest`（缓冲一次性 / 空拖拽清空 / TTL 过期 / 相对化与目录标志 / 非法路径不抛异常）。
- e2e：`composer-refs.spec.ts` 新增 3 例（IDE 真路径优先于文件名、目录标志、拖文字插文本）；既有 9 例零回归。
- 真机（MANUAL_TEST「Chat」段）：项目树拖文件、拖目录、编辑器标签拖文件、资源管理器拖文件/目录、拖一段选中代码。
