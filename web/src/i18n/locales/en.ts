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
} as const;

/** Exact key set, free values — the shape every other locale must satisfy. */
export type Dict = Record<keyof typeof en, string>;

// Symmetry with the lazy locales: the glob loader reads a default export.
export default en;
