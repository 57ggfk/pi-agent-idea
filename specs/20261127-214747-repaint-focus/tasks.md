# 任务清单：自动编辑后不闪、不夺走输入焦点

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **编号**: `20261127-214747` · **Issue**: #9

## T1 取证（阻塞项，先做）

- [x] T1.1 composer textarea 挂 focus/blur 监听，把焦点变化打进 idea.log
      （走插件已有的 JCEF console → idea.log 通道）
- [x] T1.2 真机复现「pi 改文件」，判定是 webview 内失焦还是 IDE 层失焦
      —— 验证：idea.log 里有明确的 focus/blur 记录
- [x] T1.3 判定「闪」的来源：VFS 刷新（IDE 层）还是 React 重渲染（webview 层）

## T2 按取证结果修

- [ ] T2.1 「pi 改文件」路径上多余的 `requestRepaint()` → 去掉（FR-003）
      —— 不适用：取证表明「pi 改文件」这条路径上**没有**多余的 requestRepaint —— 前端 5 个调用点全是视图级（切 tab / 进管理页 / 切子页 / 新会话 / 切会话），没有改文件相关的
- [ ] T2.2 必要时：输入框有焦点时不发重绘请求 —— 验证：vitest 断言
      —— 不适用：同上（没有重绘请求可拦）
- [x] T2.3 若属 IDE 层失焦：调整 `flushVfsRefresh` 的时机（延后到失焦后/settled 后）
- [x] T2.4 视图级重绘**保留**（FR-004）—— 切 tab / 切会话仍整帧重绘

## T3 焦点保持（仅在 T1 判定需要时）

- [ ] T3.1 重绘前记 `activeElement` + 光标位置，重绘后恢复（FR-005）
      —— 不适用：焦点根本没丢（webview 侧焦点、草稿、光标全程不变），无需恢复
- [ ] T3.2 焦点记录/恢复抽成纯函数 + 单测
      —— 不适用：同上

## T4 真机验收

- [x] T4.1 打字中 pi 改文件 → 焦点仍在、字没丢、光标没动
- [x] T4.2 切 tab / 切会话 → 无残影（OSR bug 没回来）
      —— 视图级重绘未动（代码层面），既有 e2e 全绿；**真机目视未做**
- [x] T4.3 大消息插入 → 画面正确

## T5 收尾

- [x] T5.1 `changelog.d/` 碎片（正好两行）
- [x] T5.2 `./gradlew build` + `cd web && npm test` 全绿
- [x] T5.3 提交

## 实现记录（2026-11-28）

- **提交**：`4210643`（主修）+ `e78b921`（复查修的高并发退化）；issue #9 已关闭。
- **取证结论**（真机 CDP + idea.log）：webview 侧焦点始终在 `TEXTAREA[composer-input]`、无 focusout、
  草稿完整保留、无页面 reload → **不是前端丢焦点**；真因在 IDE 侧 —— `flushVfsRefresh` 在每次
  `agent_settled` 时对整个项目树做 `refreshIoFiles(recursive)`，把用户正在编辑的文档一并重载。
- **修法**：按 pi 真正碰过的路径精确刷新；只有「工具给不出文件名」（bash/powershell）才保留
  整项目刷新这条逃生通道；整项目刷新时把当前焦点编辑器的文件从刷新目标里排除。
- **一个必须知道的细节**：pi 只在 `tool_execution_start` 带 `args`，`tool_execution_end` 只有
  `result` —— 所以要按 `toolCallId` 记住调用参数、结束时配对取。**这条通路在 pi 1.6.1 源码里核对过。**
- **复查修的退化**：记参数的容器原是 `HashMap`，淘汰取 `keys.first()`（哈希序而非插入序），
  会淘汰**任意一个还在飞行**的调用 → 那个调用的 end 找不到参数 → 那一次编辑被升级回整项目刷新
  （#9 要消掉的那种闪）。改成先进先出（`VfsRefresh.InFlightToolArgs`），淘汰顺序可单测。
- **测试**：`Issue9VfsRefreshPlanTest` 11 例 + `Issue9ToolArgsTrackerTest` 6 例。
  RED：换回 `HashMap` 后 6 例里 3 例变红。
- **真机**：pi 用 `edit` 工具改文件 → `vfs-refresh: whole=false paths=1`（改前每轮都是
  `whole=true paths=0`）；同时输入框草稿完整保留、焦点仍在 composer、光标位置不变。
- **未做**：T4.2 的目视核验（OSR 残影是 0.5.4 引入的既有机制，视图级重绘未动；既有 e2e 全绿）。
