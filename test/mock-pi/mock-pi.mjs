#!/usr/bin/env node
/**
 * Mock pi CLI speaking the pi RPC protocol (docs/rpc.md, docs/json.md).
 *
 * Used by the IDE e2e (Gradle runIde with PI_AGENT_EXECUTABLE pointing here)
 * and by the Kotlin RPC client unit tests. Implements a deterministic scenario:
 * prompt → thinking + text streaming + one bash tool call + final text.
 *
 * Env knobs:
 *   MOCK_PI_FAIL=1    exit immediately with code 3 after responding to get_state
 *   MOCK_PI_VERSION   version string to report (default "1.4.0-mock")
 *   MOCK_PI_SPEED     multiplier on event delays (default 1, lower = faster)
 */
import readline from "node:readline";

const VERSION = process.env["MOCK_PI_VERSION"] ?? "1.4.0-mock";
const SPEED = Number(process.env["MOCK_PI_SPEED"] ?? "1");
const FAIL = process.env["MOCK_PI_FAIL"] === "1";

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const MODE_RPC = process.argv.includes("--mode") && process.argv.includes("rpc");

const state = {
  model: {
    id: "mock-model-pro",
    name: "Mock Model Pro",
    api: "openai-completions",
    provider: "mock",
    baseUrl: "https://mock.local",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 8192,
  },
  thinkingLevel: "medium",
  isStreaming: false,
  sessionId: "mock-session-0001",
  sessionFile: "/tmp/mock-session-0001.jsonl",
  messageCount: 0,
};

function out(record) {
  process.stdout.write(JSON.stringify(record) + "\n");
}

function respond(id, command, success, data, error) {
  const record = { id, type: "response", command, success };
  if (data !== undefined) record["data"] = data;
  if (error !== undefined) record["error"] = error;
  out(record);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));

let aborted = false;

function chunkWords(text) {
  return text.match(/\S+\s*/g) ?? [text];
}

async function runPrompt(id, message) {
  state.isStreaming = true;
  aborted = false;

  const emit = (record) => {
    if (aborted && record["type"] !== "agent_settled") return;
    out(record);
  };

  await sleep(20);
  emit({ type: "agent_start" });
  emit({ type: "turn_start" });
  emit({ type: "message_start", message: { role: "user", content: message, timestamp: Date.now() } });
  emit({ type: "message_end", message: { role: "user", content: message, timestamp: Date.now() } });
  emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });

  const thinking = "Mock reasoning about: " + message.slice(0, 80);
  emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
  for (const w of chunkWords(thinking)) {
    if (aborted) break;
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: w } });
    await sleep(25);
  }
  emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking } });

  const text = `You asked: **${message}**\n\nRunning a quick check now.`;
  emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
  for (const w of chunkWords(text)) {
    if (aborted) break;
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: w } });
    await sleep(25);
  }
  emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 1, content: text } });

  if (!aborted) {
    emit({
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call_mock_1", toolName: "bash" },
    });
    emit({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { id: "call_mock_1", name: "bash", arguments: { command: "echo hello from mock pi" } },
      },
    });
  }

  const assistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text },
      ...(aborted
        ? []
        : [{ type: "toolCall", id: "call_mock_1", name: "bash", arguments: { command: "echo hello from mock pi" } }]),
    ],
    stopReason: aborted ? "aborted" : "toolUse",
    usage: { input: 900, output: 150, cacheRead: 0, cacheWrite: 0, totalTokens: 1050 },
    timestamp: Date.now(),
  };
  emit({ type: "message_end", message: assistant });
  emit({ type: "turn_end", message: assistant, toolResults: [] });

  if (!aborted) {
    emit({ type: "tool_execution_start", toolCallId: "call_mock_1", toolName: "bash", args: { command: "echo hello from mock pi" } });
    await sleep(60);
    emit({
      type: "tool_execution_update",
      toolCallId: "call_mock_1",
      toolName: "bash",
      args: { command: "echo hello from mock pi" },
      partialResult: { content: [{ type: "text", text: "hello from " }] },
    });
    await sleep(40);
    emit({
      type: "tool_execution_end",
      toolCallId: "call_mock_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hello from mock pi" }] },
      isError: false,
      durationMs: 15,
    });

    emit({ type: "turn_start" });
    emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
    const final = "The command printed `hello from mock pi`. Done ✅";
    for (const w of chunkWords(final)) {
      if (aborted) break;
      emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: w } });
      await sleep(25);
    }
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: final }],
      stopReason: aborted ? "aborted" : "endTurn",
      usage: { input: 1200, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 1260 },
      timestamp: Date.now(),
    };
    emit({ type: "message_end", message: finalMessage });
    emit({ type: "turn_end", message: finalMessage, toolResults: [] });
    emit({ type: "agent_end", messages: [finalMessage], willRetry: false });
    state.messageCount += 2;
  }

  emit({ type: "agent_settled", aborted });
  state.isStreaming = false;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    respond(undefined, "parse", false, undefined, "Failed to parse command");
    return;
  }
  const id = cmd["id"];
  const type = cmd["type"];

  switch (type) {
    case "get_state":
      respond(id, type, true, { ...state });
      if (FAIL) {
        setTimeout(() => process.exit(3), 50);
      }
      break;
    case "get_available_models":
      respond(id, type, true, {
        models: [
          state.model,
          { ...state.model, id: "mock-model-mini", name: "Mock Model Mini", reasoning: false, contextWindow: 128000 },
        ],
      });
      break;
    case "get_available_thinking_levels":
      respond(id, type, true, { levels: ["off", "minimal", "low", "medium", "high"] });
      break;
    case "get_session_stats":
      respond(id, type, true, {
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        userMessages: Math.ceil(state.messageCount / 2),
        assistantMessages: Math.floor(state.messageCount / 2),
        toolCalls: state.messageCount > 0 ? 1 : 0,
        totalMessages: state.messageCount,
        tokens: { input: 1200, output: 300, cacheRead: 500, cacheWrite: 100, total: 2100 },
        cost: 0.0123,
        contextUsage: { tokens: 2100, contextWindow: 200000, percent: 1 },
      });
      break;
    case "get_commands":
      respond(id, type, true, {
        commands: [
          { name: "skill:mock-skill", description: "A mock skill", source: "skill" },
          { name: "mock-cmd", description: "A mock command", source: "prompt" },
        ],
      });
      break;
    case "get_messages":
      respond(id, type, true, { messages: [] });
      break;
    case "prompt": {
      const message = String(cmd["message"] ?? "");
      if (state.isStreaming && !cmd["streamingBehavior"]) {
        respond(id, type, false, undefined, "agent is streaming; specify streamingBehavior");
        break;
      }
      if (state.isStreaming) {
        respond(id, type, true, { disposition: "queued" });
        emitQueue(cmd["message"]);
        break;
      }
      respond(id, type, true, { disposition: "started" });
      void runPrompt(id, message);
      break;
    }
    case "abort":
      aborted = true;
      respond(id, type, true);
      break;
    case "new_session":
      state.messageCount = 0;
      state.sessionId = "mock-session-" + Math.random().toString(36).slice(2, 8);
      respond(id, type, true, { cancelled: false });
      break;
    case "switch_session":
      // C8 gap: lets the IDE e2e harness exercise session switching.
      state.messageCount = 0;
      state.sessionId =
        String(cmd["sessionPath"] ?? "").replace(/.*[/\\]/, "").replace(/\.jsonl$/, "") ||
        "mock-session-switched";
      respond(id, type, true, { cancelled: false });
      break;
    case "fork":
    case "clone": {
      state.messageCount = 0;
      state.sessionId = "mock-session-" + Math.random().toString(36).slice(2, 8);
      respond(id, type, true, {
        sessionId: state.sessionId,
        sessionPath: "/tmp/mock-sessions/" + state.sessionId + ".jsonl",
      });
      break;
    }
    case "export_html":
      respond(id, type, true, { path: "/tmp/mock-export/session.html" });
      break;
    case "set_model": {
      const found =
        cmd["modelId"] === "mock-model-mini"
          ? { ...state.model, id: "mock-model-mini", name: "Mock Model Mini", reasoning: false, contextWindow: 128000 }
          : cmd["modelId"] === "mock-model-pro"
            ? state.model
            : null;
      if (!found) {
        respond(id, type, false, undefined, "Model not found: " + cmd["provider"] + "/" + cmd["modelId"]);
      } else {
        state.model = found;
        respond(id, type, true, found);
      }
      break;
    }
    case "set_thinking_level":
      state.thinkingLevel = String(cmd["level"] ?? "off");
      out({ type: "thinking_level_changed", level: state.thinkingLevel });
      respond(id, type, true);
      break;
    case "set_session_name":
      respond(id, type, true);
      break;
    case "compact":
      respond(id, type, true, {
        summary: "mock summary",
        firstKeptEntryId: "e1",
        tokensBefore: 5000,
        estimatedTokensAfter: 800,
      });
      break;
    default:
      respond(id, type, false, undefined, "mock pi: unsupported command " + type);
  }
});

function emitQueue(message) {
  out({ type: "queue_update", steering: [String(message ?? "")], followUp: [] });
}

function shutdown() {
  process.exit(0);
}

process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (!MODE_RPC) {
  // Invoked without --mode rpc (should not happen in tests): behave like --version.
  console.log(VERSION);
}
