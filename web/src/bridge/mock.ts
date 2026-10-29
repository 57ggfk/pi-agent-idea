import type { Bridge, BridgeEventName } from "./types";

type Listener = (name: BridgeEventName, data: unknown) => void;

interface MockModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  reasoning: boolean;
}

/**
 * In-memory pi simulator used outside the IDE (vite dev server and Playwright
 * frontend e2e). Mirrors the subset of the RPC protocol the UI relies on so
 * the same React code runs with and without the IDE.
 */
export class MockBridge implements Bridge {
  readonly kind = "mock" as const;

  private seq = 0;
  private listeners: Listener[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];

  private isStreaming = false;
  private currentModel: MockModel = MOCK_MODELS[0];
  private thinkingLevel = "medium";
  private messageCount = 0;
  private aborted = false;
  private emittedForPrompt = false;

  request<T>(method: string, params?: unknown): Promise<T> {
    this.seq += 1;
    if (method === "ping") return Promise.resolve({ pong: true } as T);
    if (method === "env") {
      return Promise.resolve({
        projectName: "mock-project",
        projectPath: "/tmp/mock-project",
        theme: "light",
        editorFontFamily: "monospace",
      } as T);
    }
    if (method === "sessions.list") {
      const resp = this.handleCommand({ type: "sessions.list" }) as { success: boolean; data: T };
      return resp.success ? Promise.resolve(resp.data) : Promise.reject(new Error("sessions.list failed"));
    }
    if (method.startsWith("manage.")) {
      return Promise.resolve(this.handleManage(method) as T);
    }
    if (method !== "rpc.request") {
      return Promise.reject(new Error(`mock bridge: unsupported method ${method}`));
    }
    const command = (params as { command?: Record<string, unknown> })?.command ?? {};
    return Promise.resolve(this.handleCommand(command) as T);
  }

  private handleManage(method: string): unknown {
    switch (method) {
      case "manage.env":
        return {
          ok: true,
          found: true,
          path: "/usr/local/bin/pi",
          version: "1.4.0-mock",
          agentDir: "/tmp/mock-home/.pi/agent",
        };
      case "manage.mcpList":
        return {
          ok: true,
          raw: {
            servers: [
              { name: "filesystem", state: "connected", toolCount: 11, enabled: true },
              { name: "docs", state: "needs-login", enabled: true },
            ],
            errors: [],
          },
        };
      case "manage.mcpAdd":
      case "manage.mcpRemove":
      case "manage.mcpLogin":
      case "manage.mcpLogout":
      case "manage.packageInstall":
      case "manage.packageRemove":
      case "manage.skillCreate":
        return { ok: true, output: "mock: done" };
      case "manage.packagesList":
        return { ok: true, lines: ["npm:@example/pi-tools@1.0.0", "No packages installed."] };
      case "manage.skillsList":
        return {
          ok: true,
          skills: [
            {
              name: "pdf-tools",
              description: "Extract text and tables from PDF files.",
              path: "/tmp/mock-home/.pi/agent/skills/pdf-tools/SKILL.md",
              disableModelInvocation: false,
            },
          ],
        };
      case "manage.authOverview":
        return {
          ok: true,
          providers: ["mock-provider"],
          withCredentials: ["mock-provider"],
        };
      case "manage.authCheck":
        return { ok: true, status: "ready", detail: { provider: "mock-provider" } };
      case "manage.settingsRead":
        return { ok: true, path: "/tmp/mock-home/.pi/agent/settings.json", text: "{\n  \"theme\": \"dark\"\n}" };
      case "manage.settingsWrite":
        return { ok: true, output: "saved" };
      default:
        return { ok: false, error: `mock bridge: unsupported method ${method}` };
    }
  }

  private handleCommand(command: Record<string, unknown>): unknown {
    const type = command["type"] as string;
    switch (type) {
      case "get_state":
        return {
          success: true,
          data: {
            model: this.currentModel,
            thinkingLevel: this.thinkingLevel,
            isStreaming: this.isStreaming,
            sessionId: "mock-session-0001",
            sessionFile: "/tmp/mock-project/session.jsonl",
            autoCompactionEnabled: true,
            messageCount: this.messageCount,
            pendingMessageCount: 0,
          },
        };
      case "get_available_models":
        return { success: true, data: { models: MOCK_MODELS } };
      case "get_available_thinking_levels":
        return { success: true, data: { levels: ["off", "minimal", "low", "medium", "high"] } };
      case "get_session_stats":
        return {
          success: true,
          data: {
            sessionId: "mock-session-0001",
            userMessages: Math.max(1, Math.floor(this.messageCount / 2)),
            assistantMessages: Math.floor(this.messageCount / 2),
            toolCalls: 2,
            totalMessages: this.messageCount,
            tokens: { input: 4200, output: 980, cacheRead: 12000, cacheWrite: 900, total: 18080 },
            cost: 0.0421,
            contextUsage: { tokens: 18080, contextWindow: 200000, percent: 9 },
          },
        };
      case "get_commands":
        return {
          success: true,
          data: {
            commands: [
              { name: "skill:pdf-tools", description: "Extract text from PDFs", source: "skill" },
              { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
            ],
          },
        };
      case "sessions.list":
        return {
          success: true,
          data: {
            sessions: [
              {
                file: "/tmp/mock-sessions/2026-10-27T10-00-00_aaa.jsonl",
                id: "session-aaa",
                timestamp: "2026-10-27T10:00:00.000Z",
                name: "Refactor auth module",
                preview: "Please refactor the auth module to use middleware",
                modifiedAt: Date.now() - 3_600_000,
              },
              {
                file: "/tmp/mock-sessions/2026-10-28T08-00-00_bbb.jsonl",
                id: "session-bbb",
                timestamp: "2026-10-28T08:00:00.000Z",
                name: "",
                preview: "Fix the failing tests in CI",
                modifiedAt: Date.now(),
              },
            ],
          },
        };
      case "prompt": {
        const message = String(command["message"] ?? "");
        if (this.isStreaming && !command["streamingBehavior"]) {
          return { success: false, error: "agent is streaming; specify streamingBehavior" };
        }
        const disposition = this.isStreaming ? "queued" : "started";
        if (!this.isStreaming) {
          this.startRun(message);
        } else {
          this.emit("pi", { type: "queue_update", steering: [message], followUp: [] });
        }
        return { success: true, data: { disposition } };
      }
      case "abort": {
        this.aborted = true;
        return { success: true };
      }
      case "new_session":
        this.messageCount = 0;
        return { success: true, data: { cancelled: false } };
      case "switch_session":
        this.messageCount = 0;
        return { success: true, data: { cancelled: false } };
      case "set_session_name":
        return { success: true };
      case "set_model": {
        const found = MOCK_MODELS.find(
          (m) => m.provider === command["provider"] && m.id === command["modelId"],
        );
        if (!found) return { success: false, error: "Model not found" };
        this.currentModel = found;
        return { success: true, data: found };
      }
      case "set_thinking_level":
        this.thinkingLevel = String(command["level"]);
        this.emit("pi", { type: "thinking_level_changed", level: this.thinkingLevel });
        return { success: true };
      default:
        return { success: false, error: `mock bridge: unsupported command ${type}` };
    }
  }

  private startRun(prompt: string) {
    this.isStreaming = true;
    this.aborted = false;
    this.emittedForPrompt = false;
    const emit = (event: Record<string, unknown>, delay: number) => {
      this.timers.push(
        setTimeout(() => {
          if (this.aborted && !["agent_settled"].includes(String(event["type"]))) return;
          this.emit("pi", event);
        }, delay),
      );
    };

    let t = 30;
    emit({ type: "agent_start" }, t);
    emit({ type: "turn_start" }, (t += 20));
    emit(
      {
        type: "message_start",
        message: { role: "user", content: prompt, timestamp: Date.now() },
      },
      (t += 20),
    );
    emit(
      {
        type: "message_end",
        message: { role: "user", content: prompt, timestamp: Date.now() },
      },
      (t += 20),
    );
    emit(
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
      (t += 20),
    );

    // thinking block
    const thinking = "The user asked a question. Let me check the project first.";
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, (t += 30));
    for (const chunk of chunkWords(thinking)) {
      emit(
        { type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: chunk } },
        (t += 40),
      );
    }
    emit(
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking } },
      (t += 30),
    );

    // text block
    const text =
      `Here is my plan for **${prompt.slice(0, 60)}**:\n\n` +
      "1. Inspect the repository layout\n" +
      "2. Run a quick sanity check\n\n" +
      "Let me start with a shell command.";
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 1 } }, (t += 30));
    for (const chunk of chunkWords(text)) {
      emit(
        { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: chunk } },
        (t += 40),
      );
    }
    emit(
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 1, content: text } },
      (t += 30),
    );

    // tool call
    emit(
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call_mock_1", toolName: "bash" },
      },
      (t += 40),
    );
    const toolCall = { id: "call_mock_1", name: "bash", arguments: { command: "echo hello from mock pi" } };
    emit(
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall },
      },
      (t += 60),
    );

    // assistant message completes with all blocks
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
        { type: "toolCall", id: "call_mock_1", name: "bash", arguments: { command: "echo hello from mock pi" } },
      ],
      stopReason: "toolUse",
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 },
      timestamp: Date.now(),
    };
    emit({ type: "message_end", message: assistantMessage }, (t += 30));
    emit({ type: "turn_end", message: assistantMessage, toolResults: [] }, (t += 20));

    // tool execution
    emit(
      { type: "tool_execution_start", toolCallId: "call_mock_1", toolName: "bash", args: { command: "echo hello from mock pi" } },
      (t += 40),
    );
    emit(
      {
        type: "tool_execution_update",
        toolCallId: "call_mock_1",
        toolName: "bash",
        args: { command: "echo hello from mock pi" },
        partialResult: { content: [{ type: "text", text: "hello from mock " }] },
      },
      (t += 80),
    );
    emit(
      {
        type: "tool_execution_end",
        toolCallId: "call_mock_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hello from mock pi" }] },
        isError: false,
        durationMs: 15,
      },
      (t += 60),
    );

    // second turn: final text
    emit({ type: "turn_start" }, (t += 40));
    const finalText = "The command printed `hello from mock pi`. All good ✅";
    emit(
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } },
      (t += 20),
    );
    for (const chunk of chunkWords(finalText)) {
      emit(
        { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } },
        (t += 40),
      );
    }
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: finalText }],
      stopReason: "endTurn",
      usage: { input: 1400, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 1490 },
      timestamp: Date.now(),
    };
    emit({ type: "message_end", message: finalMessage }, (t += 30));
    emit({ type: "turn_end", message: finalMessage, toolResults: [] }, (t += 20));
    emit({ type: "agent_end", messages: [finalMessage], willRetry: false }, (t += 30));
    emit({ type: "agent_settled", aborted: false }, (t += 50));

    this.timers.push(
      setTimeout(() => {
        if (!this.emittedForPrompt) {
          this.emittedForPrompt = true;
          this.isStreaming = false;
          this.messageCount += 2;
          this.emit("pi", { type: "agent_settled", aborted: this.aborted });
        }
      }, t + 80),
    );
  }

  private emit(name: BridgeEventName, data: unknown) {
    this.listeners.forEach((l) => l(name, data));
  }

  onEvent(listener: Listener) {
    this.listeners.push(listener);
  }
}

const MOCK_MODELS: MockModel[] = [
  {
    id: "mock-model-pro",
    name: "Mock Model Pro",
    provider: "mock",
    contextWindow: 200000,
    reasoning: true,
  },
  {
    id: "mock-model-mini",
    name: "Mock Model Mini",
    provider: "mock",
    contextWindow: 128000,
    reasoning: false,
  },
];

function chunkWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}
