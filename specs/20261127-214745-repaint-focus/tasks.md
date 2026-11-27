# 任务清单：自动编辑后不闪、不夺走输入焦点

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214745` · **Issue**: #9

## T1 取证（阻塞项，先做）

- [ ] T1.1 composer textarea 挂 focus/blur 监听，把焦点变化打进 idea.log
      （走插件已有的 JCEF console → idea.log 通道）
- [ ] T1.2 真机复现「pi 改文件」，判定是 webview 内失焦还是 IDE 层失焦
      —— 验证：idea.log 里有明确的 focus/blur 记录
- [ ] T1.3 判定「闪」的来源：VFS 刷新（IDE 层）还是 React 重渲染（webview 层）

## T2 按取证结果修

- [ ] T2.1 「pi 改文件」路径上多余的 `requestRepaint()` → 去掉（FR-003）
- [ ] T2.2 必要时：输入框有焦点时不发重绘请求 —— 验证：vitest 断言
- [ ] T2.3 若属 IDE 层失焦：调整 `flushVfsRefresh` 的时机（延后到失焦后/settled 后）
- [ ] T2.4 视图级重绘**保留**（FR-004）—— 切 tab / 切会话仍整帧重绘

## T3 焦点保持（仅在 T1 判定需要时）

- [ ] T3.1 重绘前记 `activeElement` + 光标位置，重绘后恢复（FR-005）
- [ ] T3.2 焦点记录/恢复抽成纯函数 + 单测

## T4 真机验收

- [ ] T4.1 打字中 pi 改文件 → 焦点仍在、字没丢、光标没动
- [ ] T4.2 切 tab / 切会话 → 无残影（OSR bug 没回来）
- [ ] T4.3 大消息插入 → 画面正确

## T5 收尾

- [ ] T5.1 `changelog.d/` 碎片（正好两行）
- [ ] T5.2 `./gradlew build` + `cd web && npm test` 全绿
- [ ] T5.3 提交
