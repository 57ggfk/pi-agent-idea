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
};
