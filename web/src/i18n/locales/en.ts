/**
 * Base dictionary (English). Keys are FLAT semantic ids (`<area>.<element>`),
 * never English prose — rewording a message must not break other languages.
 * The `as const` object is the type source: a key missing here is a compile
 * error in `t()`, and a key missing in another locale fails typecheck too.
 */
export const en = {
  // -- common ---------------------------------------------------------------
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.copy": "Copy",
  "common.delete": "Delete",
  "common.retry": "Retry",
  "common.save": "Save",

  // -- chat shell -----------------------------------------------------------
  "chat.tabs.chat": "Chat",
  "chat.tabs.sessions": "Sessions",
  "chat.tabs.manage": "Manage",
  "chat.outline.label": "Message outline",
  "chat.outline.close": "Close outline",
  "chat.outline.title": "Messages",
  "chat.search.placeholder": "Search in session",
  "chat.search.label": "Search in session",
  "chat.search.prev": "Previous match",
  "chat.search.next": "Next match",
  "chat.search.close": "Close search",
  "chat.search.noMatches": "No matches",

  // -- language selector ----------------------------------------------------
  "language.label": "Language",
  "language.followIde": "Follow IDE",
  "language.hint": "IDE menus and notifications follow the IDE language pack.",
  "language.selector": "UI language",

  // -- composer -------------------------------------------------------------
  "composer.menu.loading": "Loading {{what}}…",
  "composer.menu.failed": "Failed to load {{what}}",
  "composer.menu.empty": "No matching {{what}}",
  "composer.menu.commands": "commands",
  "composer.menu.files": "files",
  "composer.retry": "Retry",
  "composer.retrying": "Retrying…",
  "composer.placeholder": "Message pi… (/ for commands, @ for files)",
  "composer.attach": "Attach images",
  "composer.stop": "Stop the current run",
  "composer.compact": "Compact the conversation context",
  "composer.forkTitle": "Fork the conversation at the last user message into a new session",
  "composer.newSession": "Start a new session",
  "composer.newSessionStreaming": "New session (the current run will be discarded)",
  "composer.options": "Agent options",
  "composer.optionsLabel": "Options",
  "composer.stopAria": "Stop",
  "composer.compactLabel": "Compact",
  "composer.forkLabel": "Fork",
  "composer.newLabel": "New",
  "composer.menu.refresh": "↻ Refresh",
  "composer.menu.refreshAria": "Refresh file list",
  "composer.menu.footerHint": "Files from the project index",
  "composer.image.remove": "Remove {{name}}",
  "composer.image.fallback": "image",
  "composer.editNote": "Editing message · sending replaces it and the reply below",
  "composer.editCancel": "Cancel editing",

  // -- send button & queue modes ---------------------------------------------
  "send.label": "Send",
  "send.queueMode": "Queue mode",
  "send.queueModeHint": "Queue modes apply while the agent is running",
  "send.mode.auto": "Send now",
  "send.mode.autoHint": "Immediate prompt",
  "send.mode.steer": "Steer",
  "send.mode.steerHint": "Deliver after the current tool round",
  "send.mode.followUp": "Follow-up",
  "send.mode.followUpHint": "Deliver when the run finishes",

  // -- message list & actions -------------------------------------------------
  "chat.retryBanner": "Retrying ({{attempt}}/{{max}}) in {{seconds}}s — {{error}}",
  "chat.empty.noModel": "No model selected",
  "chat.empty.mock": "mock mode",
  "chat.actions.copy": "Copy message",
  "chat.actions.quote": "Quote message",
  "chat.actions.fork": "Fork from this reply",
  "chat.actions.regenerate": "Regenerate reply",
  "chat.actions.edit": "Edit message",
  "chat.actions.copyTitle": "Copy",
  "chat.actions.quoteTitle": "Quote",
  "chat.actions.forkTitle": "Fork from here",
  "chat.actions.regenerateTitle": "Regenerate",
  "chat.actions.editTitle": "Edit",
  "chat.actions.copied": "Copied",
  "chat.actions.copyFailed": "Copy failed",
  "chat.actions.group": "Message actions",

  // -- tool cards ---------------------------------------------------------------
  "tool.showAll": "Show all ({{count}} lines)",
  "tool.noOutput": "(no output)",
  "tool.diff": "Diff",
  "tool.diffTitle": "Show this file's changes in the IDE diff viewer",
  "tool.images_one": "{{count}} image",
  "tool.images_other": "{{count}} images",

  // -- message queue ------------------------------------------------------------
  "queue.mode.steer": "Steer",
  "queue.mode.followUp": "Follow-up",
  "queue.imageOnly": "(image only)",
  "queue.moveUp": "Move up",
  "queue.moveDown": "Move down",
  "queue.moveUpAria": "Move item {{n}} up",
  "queue.moveDownAria": "Move item {{n}} down",
  "queue.takeBack": "Take back into the composer",
  "queue.editAria": "Edit item {{n}}",
  "queue.steerInto": "Steer into the current run",
  "queue.steerAria": "Steer item {{n}}",
  "queue.delete": "Delete",
  "queue.deleteAria": "Delete item {{n}}",
  "queue.confirmDelete": "Confirm delete",
  "queue.pausedAborted": "Run aborted; the queue is parked",
  "queue.pausedRestarted": "pi restarted; the queue is parked",
  "queue.paused": "The queue is paused",
  "queue.pausedHint": "Queued messages are not delivered while paused; resuming re-queues them in order.",
  "queue.resume": "Resume",
  "queue.clear": "Clear",
  "queue.drift": "The queue changed outside this window; rebuilt from pi",
  "queue.discard.new": "Starting a new session",
  "queue.discard.switch": "Switching sessions",
  "queue.discard.body": "{{action}} will discard {{count}} queued messages.",
  "queue.discard.yes.new": "Discard and start new",
  "queue.discard.yes.switch": "Discard and switch",
} as const;

/** Exact key set, free values — the shape every other locale must satisfy. */
export type Dict = Record<keyof typeof en, string>;

// Symmetry with the lazy locales: the glob loader reads a default export.
export default en;
