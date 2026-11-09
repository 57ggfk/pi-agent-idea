# 015 tasks

> 状态:2026-11-09 夜间批,全部完成并自测(web vitest 262 绿 / playwright 单文件 9 绿 + 全量 243 绿 / gradle test 252 绿 / buildPlugin 0.5.6.zip 成功)。真机验收留早间清单。

## A. Web(引用 chip + 修复)

- [x] T1 autosize:app 高度 0/NaN 回退绝对 cap;cap>0 才写 `--composer-max-h`(`autosize.ts`);补单测回归用例。
- [x] T2 store:`PendingRef`/`PendingPrompt.refs`;`ide` 事件 `kind:"refs"` 合并进现存 pendingPrompt(bump id),`kind:"prompt"` 解析 `files`;`resolveRefs()` 动作(`files.relpath`,失败原样返回)。
- [x] T3 Composer:`refs` state + `.ref-chip` 行(folder/file 图标 + 相对路径 + × 删除,按 path 去重);refs-only 推送不清草稿;`doSend` 组装 `@p1 @p2\n正文`,SendButton disabled 含 refs;`composerResetSeq` 清 refs。
- [x] T4 换行:replace/quote 注入文本规范化为恰好一个尾随 `\n`(restore/edit 不动)。
- [x] T5 DnD/粘贴:`collectDroppedRefs` 同步扫 DataTransfer(entry.fullPath → uri-list/plain → File.name 兜底;图片仍走图片 chip);粘贴复用同管线。
- [x] T6 Icon `folder`;CSS `.ref-chip/.ref-path`(省略号路径);i18n `composer.ref.remove`(en/zh)。
- [x] T7 mock:`files.relpath`(mock-project 内转相对);`window.__piMockIde` e2e 注入钩子。
- [x] T8 e2e `composer-refs.spec.ts` 9 例:chips 渲染/去重/删除、refs-only 发送、`@path` 首行组装、尾随换行、autosize 增长塌回、uri-list 拖拽转相对路径、zh 角标文案。
- [x] T9 陈旧断言修正:skill-reference T016(quote 现带尾随换行——本次有意变更);provider method-selector(014 真机反馈已把「暂未接入」角标反转为禁用段上的「No OAuth/不支持」,anthropic 账号段不再有角标)。

## B. Kotlin(动作精简 + i18n)

- [x] T10 `BridgeService.pushIdeRefs(refs)`(kind "refs");`pushIdePrompt(text, refs=)` 同事件带 files;RPC `files.relpath`(项目内绝对路径→相对,`Files.isDirectory` 核实目录,项目外原样)。
- [x] T11 `AddDirectoryToPi`:删除遍历(DirectoryListing.kt 连同测试一并删除),改推单个目录引用;不再需要 pooled thread。
- [x] T12 `SendFileToPi`:删除 `readFileCapped`,改推文件引用;矩阵放宽 Binary/Oversized 为可用(只传引用,不读内容)。
- [x] T13 `ExplainFileWithPi`:引用 chip + i18n 意图提示词(路径不上提示词;光标行号后缀保留,单事件原子送达)。
- [x] T14 选区三动作(Send/Explain/Fix):框架文案进 bundle({0}=`path:line`),代码块保留。
- [x] T15 bundle(en/zh):`prompt.explain.file/dir/caret`、`prompt.send/explain/fixSelection`、`availability.*` 五键;同步更新 AddDirectory/SendFile 的动作描述(清单/内容 → 引用)。
- [x] T16 测试:EditorPromptsTest 重写(bundle 文案、提示词无路径无代码块、`{0}` 插值);ActionAvailabilityTest 更新(Binary/Oversized 现可用);252 单测全绿。

## 验证记录

- `web`: typecheck ✓;vitest 262 ✓;playwright 单文件 9 ✓、全量 243 ✓(两处陈旧断言修正后)。
- `gradlew test` 252 ✓(2 skip 原有);`gradlew buildPlugin` ✓ → `build/distributions/pi-agent-idea-0.5.6.zip`。
- pi 1.5.0 实证:RPC prompt 中 `@path` 不展开、原文进消息 → 引用即路径提示,模型用 read/bash 自取(与 @ 补全同管线),目录引用无风险。

## 早间真机清单

1. IDEA 项目树拖文件/目录进工具窗输入框:实际 drag flavor 命中三路中的哪一路;若树内拖拽到不了 JCEF,评估 IDE 侧 `CustomDropTargetHandler`(独立小 spec)。
2. 右键三个动作真机走查:chip 出现、连加两个目录都保留、zh 界面下提示词/置灰气泡为中文。
3. 真会话发送 `@dir` 引用:确认模型行为符合预期(自行列目录/读文件)。
4. 工具窗刚打开即右键注入多行提示词:高度立即正确(autosize 回退路径)。
