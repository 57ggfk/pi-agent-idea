/**
 * Chinese dictionary. `satisfies` forces every key of the base dictionary to
 * exist here (SC-002) — a missing key is a `tsc` error, not a runtime blank.
 * Technical nouns (MCP, token, fork, steer) stay English per spec D6.
 */
import type { Dict } from "./en";

export const zh: Dict = {
  // -- common ---------------------------------------------------------------
  "common.cancel": "取消",
  "common.close": "关闭",
  "common.copy": "复制",
  "common.delete": "删除",
  "common.retry": "重试",
  "common.save": "保存",

  // -- chat shell -----------------------------------------------------------
  "chat.tabs.chat": "聊天",
  "chat.tabs.sessions": "会话",
  "chat.tabs.manage": "管理",
  "chat.outline.label": "消息目录",
  "chat.outline.close": "关闭目录",
  "chat.outline.title": "消息",
  "chat.search.placeholder": "在会话中搜索",
  "chat.search.label": "在会话中搜索",
  "chat.search.prev": "上一个匹配",
  "chat.search.next": "下一个匹配",
  "chat.search.close": "关闭搜索",
  "chat.search.noMatches": "无匹配",

  // -- language selector ----------------------------------------------------
  "language.label": "语言",
  "language.followIde": "跟随 IDE",
  "language.hint": "IDE 菜单与通知跟随 IDE 语言包。",
  "language.selector": "界面语言",

  // -- composer -------------------------------------------------------------
  "composer.menu.loading": "正在加载{{what}}…",
  "composer.menu.failed": "{{what}}加载失败",
  "composer.menu.empty": "没有匹配的{{what}}",
  "composer.menu.commands": "命令",
  "composer.menu.files": "文件",
  "composer.retry": "重试",
  "composer.retrying": "正在重试…",
  "composer.placeholder": "给 pi 发消息…（/ 命令，@ 文件）",
  "composer.attach": "添加图片",
  "composer.stop": "停止当前运行",
  "composer.compact": "压缩会话上下文",
  "composer.forkTitle": "从最后一条用户消息分叉新会话",
  "composer.newSession": "新建会话",
  "composer.newSessionStreaming": "新建会话（将放弃当前运行）",
  "composer.options": "代理选项",
  "composer.optionsLabel": "选项",
  "composer.stopAria": "停止",
  "composer.compactLabel": "压缩",
  "composer.forkLabel": "分叉",
  "composer.newLabel": "新建",
  "composer.menu.refresh": "↻ 刷新",
  "composer.menu.refreshAria": "刷新文件列表",
  "composer.menu.footerHint": "文件来自项目索引",
  "composer.image.remove": "移除 {{name}}",
  "composer.image.fallback": "图片",
  "composer.editNote": "正在编辑消息 · 发送将替换它及其下方的回复",
  "composer.editCancel": "取消编辑",

  // -- send button & queue modes ---------------------------------------------
  "send.label": "发送",
  "send.queueMode": "队列模式",
  "send.queueModeHint": "队列模式仅在代理运行时生效",
  "send.mode.auto": "立即发送",
  "send.mode.autoHint": "立即发送提示词",
  "send.mode.steer": "插话",
  "send.mode.steerHint": "当前工具轮次结束后送出",
  "send.mode.followUp": "追加",
  "send.mode.followUpHint": "运行结束后送出",

  // -- message list & actions -------------------------------------------------
  "chat.retryBanner": "{{seconds}} 秒后重试（{{attempt}}/{{max}}）— {{error}}",
  "chat.empty.noModel": "未选择模型",
  "chat.empty.mock": "mock 模式",
  "chat.actions.copy": "复制消息",
  "chat.actions.quote": "引用消息",
  "chat.actions.fork": "从此回复分叉",
  "chat.actions.regenerate": "重新生成回复",
  "chat.actions.edit": "编辑消息",
  "chat.actions.copyTitle": "复制",
  "chat.actions.quoteTitle": "引用",
  "chat.actions.forkTitle": "从此处分叉",
  "chat.actions.regenerateTitle": "重新生成",
  "chat.actions.editTitle": "编辑",
  "chat.actions.copied": "已复制",
  "chat.actions.copyFailed": "复制失败",
  "chat.actions.group": "消息操作",

  // -- tool cards ---------------------------------------------------------------
  "tool.showAll": "显示全部（{{count}} 行）",
  "tool.noOutput": "（无输出）",
  "tool.diff": "对比",
  "tool.diffTitle": "在 IDE 对比查看器中查看此文件的改动",
  "tool.images_one": "{{count}} 张图片",
  "tool.images_other": "{{count}} 张图片",

  // -- message queue ------------------------------------------------------------
  "queue.mode.steer": "插话",
  "queue.mode.followUp": "追加",
  "queue.imageOnly": "（仅图片）",
  "queue.moveUp": "上移",
  "queue.moveDown": "下移",
  "queue.moveUpAria": "上移第 {{n}} 条",
  "queue.moveDownAria": "下移第 {{n}} 条",
  "queue.takeBack": "取回输入框",
  "queue.editAria": "编辑第 {{n}} 条",
  "queue.steerInto": "插话进当前运行",
  "queue.steerAria": "插话第 {{n}} 条",
  "queue.delete": "删除",
  "queue.deleteAria": "删除第 {{n}} 条",
  "queue.confirmDelete": "确认删除",
  "queue.pausedAborted": "运行已中断，队列暂挂",
  "queue.pausedRestarted": "pi 已重启，队列暂挂",
  "queue.paused": "队列已暂停",
  "queue.pausedHint": "暂停期间的消息不会自动补发；继续将按原序重新排队。",
  "queue.resume": "继续",
  "queue.clear": "清空",
  "queue.drift": "队列已被外部修改，已按 pi 重建",
  "queue.discard.new": "新建会话",
  "queue.discard.switch": "切换会话",
  "queue.discard.body": "{{action}}将丢弃 {{count}} 条排队消息。",
  "queue.discard.yes.new": "仍要新建",
  "queue.discard.yes.switch": "仍要切换",
};

// The lazy loader reads the default export (import.meta.glob<{ default: Dict }>).
export default zh;
