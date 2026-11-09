# 015 文件/目录引用 chip——右键菜单精简 + 提示词 i18n + 输入框修复

> 来源:0.5.6 真机反馈四连——①「添加目录/文件」把 200 行目录清单、256KB 文件内容塞进提示词,太啰嗦;②提示词全是 Kotlin 硬编码英文;③插入提示词后光标贴在提示词尾部,要换行;④输入框自适应高度之前调了没完全调。追加需求:像主流 agent 一样以**引用 chip**(富文本标签,可删)呈现,并支持**拖拽文件/目录到输入框**。
> 版本归属:0.5.6。关联:spec 009(ide 事件/文件动作)、spec 010(autosize 单一策略)、spec 013(图片 chip)。

## 调研结论(决定方案的关键事实)

1. **pi 的 `@path` 是约定不是协议**:实测(`pi --mode rpc`,prompt message 含 `@tiny.txt`)RPC prompt **不展开** `@` 引用——原文进 user message,模型看到路径后用 read/bash 工具自取。所以引用 chip 发送时只需拼 `@相对路径` 文本,与输入框 @ 补全(`insertFile`)同一管线,目录引用同样成立且无「展开失败」风险。
2. 发送链路是纯文本 message(`{type:"prompt", message}`),无需新字段;`ide` 事件通道的 `pendingPrompt` 已有 `images` 字段先例。
3. 输入框是 JCEF 内 React 应用——chip/富文本全是现成 React 基建,IDE 侧不需要新 Swing 组件。
4. **autosize「没完全调」的根因**:`composerMaxHeight(0)` 在 app 未布局(工具窗刚激活、tab 刚切回)时返回 0,cap 塌缩到单行 34px——恰好发生在 IDE 注入多行提示词的时刻;且 `--composer-max-h` 被写成 `0px`。

## User Stories

### US1 右键 → 引用 chip

「添加目录到 Pi」= 一个目录引用 chip(不再遍历,`AddDirectoryToPi` 不再起 pooled thread);「发送文件到 Pi Agent」= 一个文件引用 chip(不再读内容,`readFileCapped` 删除;Binary/Oversized 因此可用,可用性矩阵放宽);「用 Pi 解释文件」= 引用 chip + 一句 i18n 意图提示词(路径在 chip 上,提示词不再重复路径;光标行号后缀保留)。
通道:`ide` 事件新增 `kind:"refs"`(连续右键两次 → 合并进同一个 pendingPrompt,支持连加两个目录);`kind:"prompt"` 事件可同时带 `files`(ExplainFile 单事件原子送达,避免两次事件竞态)。
Composer:chip 行复用图片 chip 样式(文件夹/文件图标 + 相对路径 + × 删除,按 path 去重);refs-only 推送不清空正在输入的草稿;发送时 refs 组装为消息首行 `@p1 @p2` + 换行 + 正文(仅 ref 无正文也可发送);发送后清空。

### US2 提示词跟随 IDE 语言

全部 composer 提示词文案进 `PiAgentBundle`(en + zh_CN,Kotlin MessageFormat `{0}` 插值;web 侧 `{{}}` 是另一套,不混用):`prompt.explain.file/dir/caret`、`prompt.sendSelection/explainSelection/fixSelection`(选区三动作只国际化框架文案,选区代码本身仍是内容)、置灰原因 `availability.*`(FR-004 气泡跟随 IDE 语言)。

### US3 换行 + 自适应高度

`pendingPrompt` 消费处,replace/quote 模式注入的文本规范化为**恰好一个尾随换行**(光标落新行;restore/edit 保真不动)。autosize:app 高度无效(0/NaN)时回退用绝对 cap 320(布局完成由 ResizeObserver 校正),且 cap>0 才写 CSS 变量。补纯函数单测 + e2e(注入多行提示词增高/发送后塌回单行)。

### US4 拖拽/粘贴 → 引用

Composer drop/paste 三路:①`webkitGetAsEntry()`(桌面拖入,Chromium `fullPath` 给绝对路径,能判目录;图片仍走图片 chip);②`text/uri-list`/`text/plain` 行(覆盖 IDEA 项目树拖拽与文件管理器复制,`file://` 解码,`#` 注释行跳过);③以上拿不到路径时的 File.name 兜底。绝对路径经新 RPC `files.relpath` 转项目相对路径并核实目录标志(项目外路径原样返回,pi 读绝对路径没问题);RPC 失败/旧版 IDE 侧 → 原样收下。回形针按钮保持只收图片(浏览器拿不到 picker 的绝对路径,引用无意义)。

## 非目标

- 生成提交信息(CommitMessageBuilder)的提示词国际化——headless 直发 pi 的另一条链路,改动影响生成行为,另行评估。
- IDEA 项目树拖拽进 JCEF 的实际 drag flavor 需真机确认(代码三路都实现;留早间清单)。
- 含空格路径的 `@token` 转义(pi 自身 @ 语法如此,与本插件无关)。
- ref 内容预读/大小校验——按需求就是「只给路径,agent 自己探索」。
