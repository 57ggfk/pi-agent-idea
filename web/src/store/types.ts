/**
 * Chat item model + pure event reducer.
 *
 * The reducer folds pi's RPC event stream (docs/json.md) into a flat list of
 * chat items. It is a pure function so it can be unit-tested without React.
 */

import { displaySkillText } from "../lib/skillDisplay";

export type ContentBlock =
  | { kind: "text"; text: string; done: boolean }
  | { kind: "thinking"; text: string; done: boolean }
  /** Attached image; `data` is base64 without the data: URL prefix. */
  | { kind: "image"; data: string; mimeType: string }
  | {
      kind: "toolcall";
      id: string;
      toolName: string;
      argsJson: string;
      done: boolean;
      result?: ToolResult;
    };

export interface ToolResult {
  output: string;
  isError: boolean;
  durationMs?: number;
}

export interface ChatItem {
  id: number;
  role: "user" | "assistant" | "system";
  blocks: ContentBlock[];
  done: boolean;
  isError?: boolean;
  usage?: UsageInfo;
  /**
   * Fire-and-trace item (spec 005 US5): a steer fired into the running turn.
   * pi will record the real user message itself, so ephemeral items are
   * dropped on every replay — the transcript is the only source of truth.
   */
  ephemeral?: boolean;
  /** Renders the「插话」badge on an ephemeral steer item. */
  steer?: boolean;
}

// -- Message queue (spec 005) ----------------------------------------------
//
// pi is the source of truth for queue content and order (`queue_update`
// carries the FULL steering/followUp text arrays; `clear_queue` returns them
// all). pi has no ids and no images, so the plugin keeps a mirror with both
// and aligns it by text, item by item.

export type QueueMode = "steer" | "followUp";

export interface QueueImage {
  /** Base64 without the data: URL prefix (same shape as prompt images). */
  data: string;
  mimeType: string;
}

export interface QueueItem {
  /** Plugin-generated (`q-<n>`); pi has no ids, the mirror needs them. */
  id: string;
  mode: QueueMode;
  text: string;
  /** Mirror-only: `queue_update` / `clear_queue` never report images. */
  images: QueueImage[];
  status: "queued" | "failed";
  /** Raw error text when status is "failed" (US5-4). */
  error?: string;
  /** Stable secondary sort key for identical texts. */
  createdAt: number;
}

export type QueuePauseReason = "aborted" | "pi-restarted" | "manual";

/** Full queue snapshot pushed on every change (Kotlin → web, event name "queue"). */
export interface QueueState {
  items: QueueItem[];
  paused: boolean;
  pauseReason?: QueuePauseReason | null;
  /** Mirror and pi queue disagreed; the mirror was rebuilt from pi. */
  drift: boolean;
}

export interface QueueStateEvent extends QueueState {
  type: "queue_state";
}

export interface UsageInfo {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export interface CommandInfo {
  name: string;
  description?: string;
  source: string;
}

export interface SessionStats {
  totalMessages?: number;
  cost?: number;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

// ---------------------------------------------------------------------------
// Tool-approval requests (pi extension UI forwarded over RPC)
// ---------------------------------------------------------------------------

export type ApprovalMethod = "confirm" | "select" | "input" | "editor";

/** One pending extension_ui_request the user must answer before pi proceeds. */
export interface PendingApproval {
  id: string;
  method: ApprovalMethod;
  title: string;
  message: string;
  options?: string[];
  /** `input` only: pi's placeholder text for the free-form field. */
  placeholder?: string;
  /** `editor` only: multiline content pi wants edited. */
  prefill?: string;
  timeoutMs?: number;
  receivedAt: number;
}

const DIALOG_METHODS: readonly string[] = ["confirm", "select", "input", "editor"];

/**
 * Parses an `extension_ui_request` event into a PendingApproval, or returns
 * null for fire-and-forget methods (notify/setStatus/setWidget/…), which
 * carry no dialog the user has to answer.
 */
export function approvalFromEvent(event: AnyRecord): PendingApproval | null {
  if (event["type"] !== "extension_ui_request") return null;
  const method = String(event["method"] ?? "");
  if (!DIALOG_METHODS.includes(method)) return null;
  const id = String(event["id"] ?? "");
  if (!id) return null;
  return {
    id,
    method: method as ApprovalMethod,
    title: String(event["title"] ?? ""),
    message: String(event["message"] ?? ""),
    options: Array.isArray(event["options"]) ? event["options"].map(String) : undefined,
    placeholder: typeof event["placeholder"] === "string" ? event["placeholder"] : undefined,
    prefill: typeof event["prefill"] === "string" ? event["prefill"] : undefined,
    timeoutMs: typeof event["timeout"] === "number" ? event["timeout"] : undefined,
    receivedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// App-internal confirmation dialog (spec 007 US3)
// ---------------------------------------------------------------------------

/**
 * One pending confirmation. The App renders a single instance from the store,
 * so every destructive entry point (New / Fork / delete) goes through the same
 * component instead of `window.confirm` — native dialogs are unstyleable and
 * untranslatable inside JCEF.
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** Primary action text — always a verb ("Fork session", "Start new"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** Paints the primary button in the danger colour. */
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

let nextItemId = 1;

/** Resets the item id counter (tests). */
export function resetItemIds() {
  nextItemId = 1;
}

export function emptyItem(role: ChatItem["role"], blocks: ContentBlock[] = []): ChatItem {
  return { id: nextItemId++, role, blocks, done: false };
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | undefined {
  return v && typeof v === "object" ? (v as AnyRecord) : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .map((b) => {
      const rec = asRecord(b);
      if (!rec) return "";
      if (rec["type"] === "text") return String(rec["text"] ?? "");
      return "";
    })
    .join("");
}

function messageBlocks(message: AnyRecord): ContentBlock[] {
  const content = message["content"];
  if (typeof content === "string") {
    return [{ kind: "text", text: content, done: true }];
  }
  const blocks = Array.isArray(content) ? content : [];
  return blocks.map((b): ContentBlock => {
    const rec = asRecord(b) ?? {};
    if (rec["type"] === "thinking") {
      return { kind: "thinking", text: String(rec["thinking"] ?? ""), done: true };
    }
    if (rec["type"] === "image") {
      // Real pi uses the Anthropic wire shape {source:{type:"base64",mediaType,data}};
      // the prompt command path sends {data,mimeType}. Accept both.
      const source = asRecord(rec["source"]);
      const raw = String(source?.["data"] ?? rec["data"] ?? "");
      const mimeType = String(source?.["mediaType"] ?? rec["mimeType"] ?? rec["mediaType"] ?? "image/png");
      return {
        kind: "image",
        data: raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw,
        mimeType,
      };
    }
    if (rec["type"] === "toolCall" || rec["type"] === "toolUse" || rec["type"] === "tool_call") {
      return {
        kind: "toolcall",
        id: String(rec["id"] ?? ""),
        toolName: String(rec["name"] ?? rec["toolName"] ?? "tool"),
        argsJson: JSON.stringify(rec["arguments"] ?? rec["input"] ?? {}),
        done: true,
      };
    }
    return { kind: "text", text: String(rec["text"] ?? ""), done: true };
  });
}

function lastIndexOfRole(items: ChatItem[], role: ChatItem["role"]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].role === role) return i;
  }
  return -1;
}

function findToolBlock(
  items: ChatItem[],
  toolCallId: string,
): { itemIndex: number; blockIndex: number } | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const blocks = items[i].blocks;
    for (let j = blocks.length - 1; j >= 0; j--) {
      if (blocks[j].kind === "toolcall" && (blocks[j] as { id: string }).id === toolCallId) {
        return { itemIndex: i, blockIndex: j };
      }
    }
  }
  return undefined;
}

function resultText(result: unknown): string {
  const rec = asRecord(result);
  if (!rec) return result == null ? "" : String(result);
  if (typeof rec["text"] === "string") return rec["text"];
  const content = rec["content"];
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const cr = asRecord(c);
        return cr && cr["type"] === "text" ? String(cr["text"] ?? "") : "";
      })
      .join("\n");
  }
  return JSON.stringify(rec, null, 2);
}

function updateBlock(
  items: ChatItem[],
  toolCallId: string,
  update: (block: Extract<ContentBlock, { kind: "toolcall" }>) => ContentBlock,
): ChatItem[] {
  const loc = findToolBlock(items, toolCallId);
  if (!loc) return items;
  const next = items.slice();
  const item = { ...next[loc.itemIndex] };
  const blocks = item.blocks.slice();
  const block = blocks[loc.blockIndex] as Extract<ContentBlock, { kind: "toolcall" }>;
  blocks[loc.blockIndex] = update(block);
  item.blocks = blocks;
  next[loc.itemIndex] = item;
  return next;
}

/**
 * Folds one pi session event into the item list.
 * Returns a new list; never mutates the input.
 */
export function applyEvent(items: ChatItem[], event: AnyRecord): ChatItem[] {
  const type = event["type"] as string | undefined;
  if (!type) return items;

  switch (type) {
    case "message_start": {
      const message = asRecord(event["message"]);
      if (!message) return items;
      const role = message["role"] as ChatItem["role"];
      if (role === "assistant") {
        // Defensive: ignore duplicate assistant starts (event replay guards).
        const tail = items[items.length - 1];
        if (tail && tail.role === "assistant" && !tail.done && tail.blocks.length === 0) {
          return items;
        }
        return [...items, emptyItem("assistant")];
      }
      // user: pi emits message_start with empty content before the prompt is
      // finalized — ignore it entirely and let message_end (authoritative)
      // dedupe against the optimistic item.
      return items;
    }

    case "message_update": {
      const ev = asRecord(event["assistantMessageEvent"]);
      if (!ev) return items;
      // Provider stream errors (e.g. 401/404/5xx from the API) arrive as
      // assistantMessageEvent {type:"error"} — surface them and stop the spin.
      if (ev["type"] === "error") {
        const text = `⚠ ${String(ev["reason"] ?? "error")}: ${String(ev["error"] ?? "unknown provider error")}`;
        const idx = lastIndexOfRole(items, "assistant");
        if (idx >= 0) {
          const next = items.slice();
          next[idx] = { ...next[idx], done: true, isError: true, blocks: [{ kind: "text", text, done: true }] };
          return next;
        }
        const item = emptyItem("system", [{ kind: "text", text, done: true }]);
        item.done = true;
        item.isError = true;
        return [...items, item];
      }
      const idx = lastIndexOfRole(items, "assistant");
      if (idx < 0) return items;
      const next = items.slice();
      const item = { ...next[idx] };
      const blocks = item.blocks.slice();
      const contentIndex = typeof ev["contentIndex"] === "number" ? ev["contentIndex"] : 0;
      while (blocks.length <= contentIndex) {
        blocks.push({ kind: "text", text: "", done: false });
      }
      const evType = ev["type"] as string;
      const existing = blocks[contentIndex];

      if (evType === "text_start" || evType === "thinking_start") {
        if (existing.kind === "text" && existing.text === "" && !existing.done) {
          blocks[contentIndex] =
            evType === "text_start"
              ? { kind: "text", text: "", done: false }
              : { kind: "thinking", text: "", done: false };
        } else if (evType === "thinking_start") {
          blocks[contentIndex] = { kind: "thinking", text: "", done: false };
        }
      } else if (evType === "text_delta" || evType === "thinking_delta") {
        const delta = String(ev["delta"] ?? "");
        if (existing.kind === "text") {
          blocks[contentIndex] = { ...existing, text: existing.text + delta };
        } else if (existing.kind === "thinking") {
          blocks[contentIndex] = { ...existing, text: existing.text + delta };
        }
      } else if (evType === "text_end" || evType === "thinking_end") {
        const content = String(ev["content"] ?? "");
        blocks[contentIndex] =
          evType === "text_end"
            ? { kind: "text", text: content, done: true }
            : { kind: "thinking", text: content, done: true };
      } else if (evType === "toolcall_start") {
        blocks[contentIndex] = {
          kind: "toolcall",
          id: String(ev["id"] ?? ""),
          toolName: String(ev["toolName"] ?? "tool"),
          argsJson: "",
          done: false,
        };
      } else if (evType === "toolcall_delta") {
        if (existing.kind === "toolcall") {
          blocks[contentIndex] = { ...existing, argsJson: existing.argsJson + String(ev["delta"] ?? "") };
        }
      } else if (evType === "toolcall_end") {
        const tc = asRecord(ev["toolCall"]) ?? {};
        const existingId = existing.kind === "toolcall" ? existing.id : "";
        blocks[contentIndex] = {
          kind: "toolcall",
          id: String(tc["id"] ?? ev["id"] ?? existingId),
          toolName: String(tc["name"] ?? "tool"),
          argsJson: JSON.stringify(tc["arguments"] ?? {}),
          done: true,
        };
      }

      item.blocks = blocks;
      const usage = asRecord(event["usage"]);
      if (usage && usage["totalTokens"]) item.usage = usage as UsageInfo;
      next[idx] = item;
      return next;
    }

    case "message_end": {
      const message = asRecord(event["message"]);
      if (!message) return items;
      const role = message["role"] as ChatItem["role"];
      if (role === "user") {
        const text = messageText(message["content"]);
        const tail = items[items.length - 1];
        const item = emptyItem("user", [{ kind: "text", text, done: true }]);
        item.done = true;
        const tailText = tail && tail.role === "user" ? messageTextBlockText(tail) : "";
        // Optimistic copy already in place with the same text: nothing to do.
        if (tail && tail.role === "user" && tailText === text) {
          return items;
        }
        // Display-equal but raw-different (011 US4): the optimistic entry
        // holds the raw `/skill:` command while pi's authoritative message_end
        // carries the expanded body — same message, but the data layer keeps
        // pi's text (search and export read it), so replace.
        if (
          tail &&
          tail.role === "user" &&
          displaySkillText(tailText) === displaySkillText(text)
        ) {
          const next = items.slice();
          next[next.length - 1] = item;
          return next;
        }
        // pi finalizes the user message in message_end; an empty placeholder
        // tail (older event shape) is replaced instead of appended after.
        if (tail && tail.role === "user" && messageTextBlockText(tail).trim() === "" && text.trim() !== "") {
          const next = items.slice();
          next[next.length - 1] = item;
          return next;
        }
        return [...items, item];
      }
      if (role !== "assistant") return items;
      const idx = lastIndexOfRole(items, "assistant");
      const item = emptyItem("assistant", messageBlocks(message));
      item.done = true;
      const errorMessage = message["errorMessage"];
      if (typeof errorMessage === "string" && errorMessage) {
        item.isError = true;
        const hasVisibleText = item.blocks.some(
          (b) => (b.kind === "text" || b.kind === "thinking") && b.text.trim().length > 0,
        );
        if (!hasVisibleText) {
          item.blocks = [{ kind: "text", text: `⚠ ${errorMessage}`, done: true }];
        }
      }
      const usage = asRecord(message["usage"]);
      if (usage) item.usage = usage as UsageInfo;
      if (idx >= 0) {
        const next = items.slice();
        next[idx] = item;
        return next;
      }
      return [...items, item];
    }

    case "tool_execution_start": {
      const toolCallId = String(event["toolCallId"] ?? "");
      const existing = findToolBlock(items, toolCallId);
      if (existing) {
        return updateBlock(items, toolCallId, (b) => ({
          ...b,
          result: { output: "", isError: false },
        }));
      }
      // Tool result without a streamed toolcall block (restored sessions etc.)
      const item = emptyItem("assistant", [
        {
          kind: "toolcall",
          id: toolCallId,
          toolName: String(event["toolName"] ?? "tool"),
          argsJson: JSON.stringify(asRecord(event["args"]) ?? {}),
          done: false,
          result: { output: "", isError: false },
        },
      ]);
      return [...items, item];
    }

    case "tool_execution_update": {
      const toolCallId = String(event["toolCallId"] ?? "");
      const partial = resultText(asRecord(event["partialResult"]));
      return updateBlock(items, toolCallId, (b) => ({
        ...b,
        result: { output: (b.result?.output ?? "") + partial, isError: false },
      }));
    }

    case "tool_execution_end": {
      const toolCallId = String(event["toolCallId"] ?? "");
      const isError = Boolean(event["isError"]);
      const durationMs = typeof event["durationMs"] === "number" ? event["durationMs"] : undefined;
      return updateBlock(items, toolCallId, (b) => ({
        ...b,
        done: true,
        result: { output: resultText(asRecord(event["result"])), isError, durationMs },
      }));
    }

    case "compaction_start": {
      const item = emptyItem("system", [
        { kind: "text", text: `Compacting context (reason: ${String(event["reason"] ?? "manual")})…`, done: true },
      ]);
      item.done = true;
      return [...items, item];
    }

    case "compaction_end": {
      const result = asRecord(event["result"]);
      const before = result ? result["tokensBefore"] : undefined;
      const after = result ? result["estimatedTokensAfter"] : undefined;
      const aborted = Boolean(event["aborted"]);
      const text = aborted
        ? "Compaction aborted."
        : `Context compacted: ${before ?? "?"} → ${after ?? "?"} tokens.`;
      const item = emptyItem("system", [{ kind: "text", text, done: true }]);
      item.done = true;
      return [...items, item];
    }

    default:
      return items;
  }
}

function messageTextBlockText(item: ChatItem): string {
  return item.blocks
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join("");
}

/** Restores chat items from get_messages response (session replay). */
export function itemsFromMessages(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const m of messages) {
    const rec = asRecord(m);
    if (!rec) continue;
    const role = rec["role"] as ChatItem["role"] | "toolResult";
    // pi records every tool result as its own `toolResult` message. Skipping it
    // left a restored session's tool card with no result at all: the card could
    // not be expanded and the command output was simply gone.
    if (role === "toolResult") {
      const toolCallId = String(rec["toolCallId"] ?? "");
      const output = resultText(rec);
      const isError = Boolean(rec["isError"]);
      const loc = toolCallId ? findToolBlock(items, toolCallId) : undefined;
      if (loc) {
        const item = { ...items[loc.itemIndex] };
        const blocks = item.blocks.slice();
        const block = blocks[loc.blockIndex] as Extract<ContentBlock, { kind: "toolcall" }>;
        blocks[loc.blockIndex] = { ...block, done: true, result: { output, isError } };
        item.blocks = blocks;
        items[loc.itemIndex] = item;
      } else {
        // Result without a stored call (trimmed transcript): keep it visible as
        // its own card instead of dropping the output.
        const item = emptyItem("assistant", [
          {
            kind: "toolcall",
            id: toolCallId,
            toolName: String(rec["toolName"] ?? "tool"),
            argsJson: "{}",
            done: true,
            result: { output, isError },
          },
        ]);
        item.done = true;
        items.push(item);
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const item = emptyItem(role, messageBlocks(rec));
    item.done = true;
    const usage = asRecord(rec["usage"]);
    if (usage) item.usage = usage as UsageInfo;
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Message-level actions (copy / quote / regenerate / edit)
// ---------------------------------------------------------------------------

export type MessageAction = "copy" | "quote" | "fork" | "regenerate" | "edit";

/** Everything about the *conversation* that decides which actions apply. */
export interface ActionContext {
  /** This item is the last user message in the transcript. */
  isLastUser: boolean;
  /** This item is the last assistant message in the transcript. */
  isLastAssistant: boolean;
  /**
   * A user message exists above this item, so there is something to branch at
   * (spec 007 FR-001 / edge case「没有任何用户消息」).
   */
  hasPrecedingUser: boolean;
  /**
   * 023 FR-001: the last pi reply of its round — nothing but this reply sits
   * between it and the next user message. `fork {entryId}` always cuts at a
   * *user* entry, so every reply inside one round produces the same branch;
   * offering Fork on each of them claimed a precision pi does not have (and
   * the "content after this reply is dropped" copy was simply false for the
   * middle ones). System notices do not end a round.
   */
  isRoundEnd: boolean;
  /** A run is in flight (or a history-rewriting action already started). */
  sessionBusy: boolean;
  /** An edit-and-resend is in progress; it owns the composer. */
  editing: boolean;
}

/** True when the item carries copyable text (a pure-image item does not). */
export function itemHasText(item: ChatItem): boolean {
  return item.blocks.some((b) => b.kind === "text" && b.text.trim().length > 0);
}

/**
 * The text a message-level copy should put on the clipboard.
 *
 * User messages: the text they were sent with (one text block).
 * Pi messages: the Markdown source — text blocks joined in order, so fenced
 * code keeps its ``` markers and lists keep their `-`. Thinking blocks, tool
 * cards and image data are deliberately excluded (spec FR-003).
 *
 * Returns null when there is nothing to copy (pure-image message), which is
 * what hides the copy/quote buttons instead of rendering dead ones (FR-007).
 *
 * Skill-expanded messages (011 US4) come out folded: the body pi spliced into
 * the message stays in the data layer, while copy / quote / edit hand the
 * `/skill:<name> <question>` marker onward instead of the SKILL.md text.
 */
export function itemToMarkdownSource(item: ChatItem): string | null {
  const parts = item.blocks
    .filter((b): b is Extract<ContentBlock, { kind: "text" }> => b.kind === "text")
    .filter((b) => b.text.trim().length > 0)
    .map((b) => displaySkillText(b.text));
  if (parts.length === 0) return null;
  // Join so separate text blocks keep their paragraph break; a single block is
  // returned verbatim (no trim) so a user message copies back character-exact.
  return parts.join("\n\n");
}

/**
 * The text a quote drops into the composer: the message source as a Markdown
 * blockquote, one `> ` per line.
 *
 * Fenced code inside the quote is left unescaped — the composer is a plain
 * textarea, so a ``` inside a blockquote has no rendering semantics there; pi
 * parses it back out after sending. Blank lines keep their `>` so the quote
 * stays one block instead of collapsing into paragraphs.
 */
export function quoteMarkdownSource(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * The action matrix — the single source of truth for "which buttons does this
 * message get". Both the toolbar and its tests call this, so the two can never
 * drift apart.
 *
 * Precedence and exclusions, mapped to the spec:
 *  - FR-001: a still-streaming assistant message has no toolbar at all.
 *  - FR-001/FR-013: ordinary system notices have none either, but error items
 *    (item-error) stay copyable — copying an error into a bug report is the
 *    most common reason to touch one.
 *  - FR-007: copy/quote need text; a pure-image message hides them.
 *  - FR-008: regenerate only on the last assistant message while idle.
 *  - FR-009: edit only on the last user message while idle.
 *  - FR-010: regenerate and edit never both apply — `sessionBusy` covers a run
 *    in flight, `editing` covers an edit that already owns the composer.
 *
 * `hasText` is derived from the item rather than passed in: a second source of
 * truth for the same fact is exactly how button logic starts to drift.
 */
export function actionsForItem(item: ChatItem, ctx: ActionContext): MessageAction[] {
  const hasText = itemHasText(item);

  if (item.role === "assistant" && !item.done) return [];
  if (item.role === "system") return item.isError && hasText ? ["copy"] : [];

  const idle = !ctx.sessionBusy && !ctx.editing;
  // FR-001/FR-002: only pi replies get Fork, only while idle, only when there
  // is a user message above to branch at, and only on the last reply of the
  // round (023: "one round = one branch point"). Copy/quote stay untouched.
  const canFork = item.role === "assistant" && idle && ctx.hasPrecedingUser && ctx.isRoundEnd;

  if (!hasText) {
    // Nothing to copy or quote, but the last answer can still be regenerated.
    const actions: MessageAction[] = [];
    if (canFork) actions.push("fork");
    if (item.role === "assistant" && ctx.isLastAssistant && idle) actions.push("regenerate");
    return actions;
  }

  const actions: MessageAction[] = ["copy", "quote"];
  if (canFork) actions.push("fork");
  if (item.role === "assistant" && ctx.isLastAssistant && idle) {
    actions.push("regenerate");
  }
  if (item.role === "user" && ctx.isLastUser && idle) {
    actions.push("edit");
  }
  return actions;
}
