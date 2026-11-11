# 018 tasks

> 串行执行,顺序即编号。每条自带验证;web 单测 `npx vitest run`,e2e `npx playwright test`,Kotlin `./gradlew test`。

## US3 粘贴/拖拽识别收紧(T1–T3)

- [x] T1 识别逻辑抽到 `web/src/lib/clipboardRefs.ts`:导出 `looksLikePath`、`collectFileRefs(dt)`(file 项扫描)、`pathLikeTextRef(text)`(整段单行+无空白+像路径才返回引用)、`collectUriRefs(dt)`(uri-list 逐行 file://);Composer 的 `collectDroppedRefs` 改为组合这三者,text/plain 兜底走 `pathLikeTextRef` — 验证:vitest `clipboardRefs.test.ts` 覆盖多行 markdown 不成引用、单行路径成引用、uri-list 多行 file:// 全成引用、`user@example.com` 不成引用
- [x] T2 Composer drop/paste 全部走新路径(行为:多行 markdown 粘贴=纯文本插入光标;单行路径粘贴=引用)— 验证:e2e composer-refs 新增「粘贴多行 markdown 零 chip、文本原样入框」
- [x] T3 真机:粘贴含 `./gradlew` 行的 markdown 确认零误报 — 验证:真机冒烟脚本(smoke-018)+ e2e 覆盖;截图 build/smoke-018.png

## US1 行内引用 chip(T4–T9)

- [x] T4 `web/src/lib/inlineChips.ts`:token 化(`/(?:^|[^\w@])@([^\s@]+)/g`,复用 AT_QUERY_RE 边界语义)、`removeToken(text, range)` — 验证:vitest:CJK 前缀、email 不成 token、token 相邻
- [x] T5 Composer 镜像覆盖层 `.composer-mirror`:同字体/内边距/宽度/pre-wrap,渲染全文+token chip(不透明底盖原文),`pointer-events:none`、chip × 按钮 `auto`;滚动/高度同步 — 验证:e2e:输入 `@src` 补全选中后 chip 出现在文本流内(chip 边界几何断言),textarea 值仍含 `@path `
- [x] T6 chip × 删除 = 删除整个 token 并回焦;Backspace 在 token 右缘整删 — 验证:e2e 两条
- [x] T7 refs 状态、`mergeRefs`、首行拼装、ref-chips 行删除;拖拽/IDE 注入/粘贴文件 → 光标处插 token(注入追加尾部、每 token 后跟空格避免误开菜单);`dirCache` 保留目录图标;发送=原文 — 验证:e2e:IDE 注入 refs(kind:refs mock)→ 尾部出现 token;发送报文含 `@path`;composer-refs 原用例改写全绿
- [x] T8 样式:`.ref-token` 圆角胶囊/主题强调色/图标;亮暗主题两套 — 验证:e2e 计算样式断言 border-radius>0
- [x] T9 真机:拖拽项目树文件 → chip;中文 IME 混输 `看@src` — 验证:截图

## US2 图片缩略图卡(T10–T12)

- [x] T10 image-chip 升级缩略图卡:64px 圆角 `img`(dataURL)+ 文件名截断 + ×;hover 显示大小(由 base64 估算)— 验证:e2e:粘贴图片(mock)→ 缩略图渲染、尺寸≈64
- [x] T11 点击缩略图 → ImagePreview 模态:store 加 `composerPreview` 请求,模态支持外部图片列表(←/→ 切换/Esc/遮罩关)— 验证:e2e image-preview 新增 composer 入口用例
- [x] T12 真机:粘贴截图 → 缩略图 → 点开放大 — 验证:截图

## US4 表格弱边框(T13)

- [x] T13 `styles.css` 消息区表格:`border-collapse:collapse`、单元格 `1px solid var(--border)`、表头分隔 `var(--border-strong)` — 验证:e2e:含 markdown 表格的助手消息,td computed border-width=1px

## US5 模型组折叠(T14–T16)

- [x] T14 `buildPickerData` 支持 `collapsed: ReadonlySet<string>` → 产出可见条目序列(`visibleFlat`),查询非空强制全展开 — 验证:vitest modelGroups:折叠组不进 visibleFlat、查询时全量
- [x] T15 ModelPicker:组标题可点折叠(chevron/aria-expanded/计数保留),高亮/键盘/回车/locate 索引切 visibleFlat,打开时当前组被折叠则自动展开再定位;localStorage 记忆(键 `pi-agent.model-collapsed`,失败降级内存)— 验证:e2e model-picker 新增:折叠后 ArrowDown 跳过隐藏项、搜索展开、重开记忆保持
- [x] T16 真机:折叠/展开手感、当前组置顶×折叠组合 — 验证:截图

## US6 包管理(T17–T20)

- [x] T17 Kotlin:`PiManage.packageUpdateAll()` → `pi update --extensions`;`packageUpdateAllArgs` internal + 单测;BridgeService 路由 — 验证:gradlew test
- [x] T18 桥接四处同步:types.ts / manage.ts / BridgeService.kt / bridge/mock.ts — 验证:typecheck 0 错误
- [x] T19 PackagesPanel:「全部升级」按钮(FR-007 逐字输出+refresh);移除接 ConfirmDialog;硬编码英文收字典(package.empty/updateAll/updateNote/placeholder)— 验证:e2e manage:mock 下点全部升级调 RPC、移除先拦截后确认
- [ ] T20 真机:真 pi 环境全部升级一次 — **未执行**:真机 `pi list` 无已装扩展(按钮正确置灰),待用户装扩展后目验

## US7 fork 标题后缀(T21–T22)

- [x] T21 store:fork 成功后 `applyForkSuffix()`(syncAfterBranch 后取 sessionName,不以后缀结尾才追加,空名跳过,`renameSession(name,false)`);i18n `session.forkSuffix` en `(fork)` / zh `(分支)` — 验证:vitest mock fork 流程标题断言
- [x] T22 e2e message-fork:fork 后标题带后缀 — 验证:e2e

## 收尾(T23–T26)

- [x] T23 全量回归:vitest / playwright / gradlew test 三绿,基线差异逐条注明非回归
- [x] T24 MANUAL_TEST.md 增补 018 清单;CHANGELOG 0.5.7 条目
- [x] T25 buildPlugin + 安装到 IDEA(plugins 目录替换)
- [x] T26 真机冒烟:runIde 真沙箱 + 真 pi,smoke-018.mjs 13/13(含真模型往返 REAL_PI_OK),截图 build/smoke-018.png;run-report 归档
