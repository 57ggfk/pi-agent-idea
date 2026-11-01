/**
 * Chat item model + pure event reducer.
 *
 * The reducer folds pi's RPC event stream (docs/json.md) into a flat list of
 * chat items. It is a pure function so it can be unit-tested without React.
 */

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
    timeoutMs: typeof event["timeout"] === "number" ? event["timeout"] : undefined,
    receivedAt: Date.now(),
  };
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
        // Optimistic copy already in place with the same text: nothing to do.
        if (tail && tail.role === "user" && messageTextBlockText(tail) === text) {
          return items;
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
    const role = rec["role"] as ChatItem["role"];
    if (role !== "user" && role !== "assistant") continue;
    const item = emptyItem(role, messageBlocks(rec));
    item.done = true;
    const usage = asRecord(rec["usage"]);
    if (usage) item.usage = usage as UsageInfo;
    items.push(item);
  }
  return items;
}
