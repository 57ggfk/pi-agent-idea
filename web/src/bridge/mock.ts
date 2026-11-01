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
  private sessionSeq = 0;
  private autoCompactionEnabled = true;
  private autoRetryEnabled: boolean | null = null;
  private approvalMode: "ask" | "yolo" = "ask";
  /** Resolver of the currently pending approval dialog, if any. */
  private approvalResolve: ((confirmed: boolean) => void) | null = null;
  // Approval gating for the bash tool call, enabled via ?approval=1 so the
  // existing specs keep the ungated timing.
  private readonly approvalScenario =
    typeof location !== "undefined" && new URLSearchParams(location.search).has("approval");
  private mockSessions = [
    {
      file: "/tmp/mock-sessions/2026-10-27T10-00-00_aaa.jsonl",
      id: "session-aaa",
      timestamp: "2026-10-27T10:00:00.000Z",
      name: "Refactor auth module",
      preview: "Please refactor the auth module to use middleware",
      modifiedAt: Date.now() - 3_600_000,
      messageCount: 12,
    },
    {
      file: "/tmp/mock-sessions/2026-10-28T08-00-00_bbb.jsonl",
      id: "session-bbb",
      timestamp: "2026-10-28T08:00:00.000Z",
      name: "",
      preview: "Fix the failing tests in CI",
      modifiedAt: Date.now(),
      messageCount: 4,
    },
  ];

  request<T>(method: string, params?: unknown): Promise<T> {
    this.seq += 1;
    if (method === "ping") return Promise.resolve({ pong: true } as T);
    if (method === "files.list") {
      return Promise.resolve({ files: MOCK_FILES } as T);
    }
    if (method === "ide.openFile") {
      return Promise.resolve({ ok: true } as T);
    }
    if (method === "ide.showFileDiff") {
      return Promise.resolve({ ok: true } as T);
    }
    if (method === "sessions.delete") {
      const file = (params as { file?: string })?.file;
      this.mockSessions = this.mockSessions.filter((s) => s.file !== file);
      return Promise.resolve({ ok: true } as T);
    }
    if (method === "sessions.exportHtml") {
      const file = (params as { file?: string })?.file ?? "";
      return Promise.resolve({ ok: true, path: file.replace(/\.jsonl$/, ".html") } as T);
    }
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
    if (method === "config.getLastModel") {
      return Promise.resolve({ provider: "mock", model: "mock-model-pro" } as T);
    }
    if (method === "config.setLastModel") {
      return Promise.resolve({ ok: true } as T);
    }
    if (method === "config.getPrefs") {
      return Promise.resolve(
        (this.autoRetryEnabled == null ? {} : { autoRetry: this.autoRetryEnabled }) as T,
      );
    }
    if (method === "config.setPrefs") {
      const autoRetry = (params as { autoRetry?: boolean })?.autoRetry;
      if (typeof autoRetry === "boolean") this.autoRetryEnabled = autoRetry;
      return Promise.resolve({ ok: true } as T);
    }
    if (method === "approval.getPolicy") {
      return Promise.resolve({ mode: this.approvalMode, allow: [] } as T);
    }
    if (method === "approval.setPolicy") {
      const mode = (params as { mode?: string })?.mode;
      if (mode === "ask" || mode === "yolo") this.approvalMode = mode;
      return Promise.resolve({ ok: true } as T);
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
            autoCompactionEnabled: this.autoCompactionEnabled,
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
        return { success: true, data: { sessions: this.mockSessions } };
      case "prompt": {
        const message = String(command["message"] ?? "");
        if (this.isStreaming && !command["streamingBehavior"]) {
          return { success: false, error: "agent is streaming; specify streamingBehavior" };
        }
        const disposition = this.isStreaming ? "queued" : "started";
        if (!this.isStreaming) {
          void this.startRun(message);
        } else {
          this.emit("pi", { type: "queue_update", steering: [message], followUp: [] });
        }
        return { success: true, data: { disposition } };
      }
      case "abort": {
        this.aborted = true;
        // An aborted run unwinds a pending approval dialog (denied).
        this.approvalResolve?.(false);
        this.approvalResolve = null;
        return { success: true };
      }
      case "new_session":
        this.messageCount = 0;
        return { success: true, data: { cancelled: false } };
      case "switch_session":
        this.messageCount = 0;
        return { success: true, data: { cancelled: false } };
      case "fork":
      case "clone": {
        // Branch semantics only mocked: a new empty session entry is created
        // and returned so the UI can exercise the switch/refresh flow.
        this.sessionSeq += 1;
        const kind = String(command["type"]);
        const id = `session-${kind}-${this.sessionSeq}`;
        const session = {
          file: `/tmp/mock-sessions/2026-10-29T09-00-00_${id}.jsonl`,
          id,
          timestamp: new Date().toISOString(),
          name: kind === "clone" ? "Cloned session" : "Forked session",
          preview: "Branched conversation",
          modifiedAt: Date.now(),
          messageCount: this.messageCount,
        };
        this.mockSessions = [session, ...this.mockSessions];
        return { success: true, data: { sessionId: session.id, sessionPath: session.file } };
      }
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
      case "extension_ui_response": {
        const resolve = this.approvalResolve;
        this.approvalResolve = null;
        resolve?.(command["confirmed"] === true);
        return { success: true };
      }
      case "set_auto_compaction":
        this.autoCompactionEnabled = command["enabled"] !== false;
        return { success: true };
      case "set_auto_retry":
        return { success: true };
      default:
        return { success: false, error: `mock bridge: unsupported command ${type}` };
    }
  }

  /**
   * Emits a confirm dialog and waits for extension_ui_response (or abort),
   * mirroring the extension_ui round-trip of the real pi-approve extension.
   */
  private requestApproval(id: string, title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvalResolve = (confirmed) => {
        this.approvalResolve = null;
        resolve(confirmed);
      };
      this.emit("pi", { type: "extension_ui_request", id, method: "confirm", title, message, timeout: 300000 });
    });
  }

  private async startRun(prompt: string) {
    this.isStreaming = true;
    this.aborted = false;
    this.emittedForPrompt = false;
    const sleep = (ms: number) => new Promise<void>((r) => this.timers.push(setTimeout(r, ms)));
    const emit = (event: Record<string, unknown>) => {
      if (this.aborted && String(event["type"]) !== "agent_settled") return;
      this.emit("pi", event);
    };

    await sleep(30);
    emit({ type: "agent_start" });
    await sleep(20);
    emit({ type: "turn_start" });
    await sleep(20);
    emit({
      type: "message_start",
      message: { role: "user", content: prompt, timestamp: Date.now() },
    });
    await sleep(20);
    emit({
      type: "message_end",
      message: { role: "user", content: prompt, timestamp: Date.now() },
    });
    await sleep(20);
    emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });

    // thinking block
    const thinking = "The user asked a question. Let me check the project first.";
    await sleep(30);
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
    for (const chunk of chunkWords(thinking)) {
      await sleep(40);
      emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: chunk } });
    }
    await sleep(30);
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking } });

    // text block
    const text =
      `Here is my plan for **${prompt.slice(0, 60)}**:\n\n` +
      "1. Inspect the repository layout\n" +
      "2. Run a quick sanity check\n\n" +
      "Let me start with a shell command.";
    await sleep(30);
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
    for (const chunk of chunkWords(text)) {
      await sleep(40);
      emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: chunk } });
    }
    await sleep(30);
    emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 1, content: text } });

    // tool call
    await sleep(40);
    emit({
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call_mock_1", toolName: "bash" },
    });
    await sleep(60);
    const toolCall = { id: "call_mock_1", name: "bash", arguments: { command: "echo hello from mock pi" } };
    emit({
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall },
    });

    // second (edit) tool call — exercises the diff view in ToolCard
    const editArgs = {
      path: "src/main.tsx",
      old_string: 'createRoot(document.getElementById("root")!).render(\n  <App />\n);',
      new_string: 'createRoot(document.getElementById("root")!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);',
    };
    await sleep(40);
    emit({
      type: "message_update",
      usage: {},
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, id: "call_mock_2", toolName: "edit" },
    });
    await sleep(60);
    emit({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 3,
        toolCall: { id: "call_mock_2", name: "edit", arguments: editArgs },
      },
    });

    // assistant message completes with all blocks
    const assistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text },
        { type: "toolCall", id: "call_mock_1", name: "bash", arguments: { command: "echo hello from mock pi" } },
        { type: "toolCall", id: "call_mock_2", name: "edit", arguments: editArgs },
      ],
      stopReason: "toolUse",
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 },
      timestamp: Date.now(),
    };
    await sleep(30);
    emit({ type: "message_end", message: assistantMessage });
    await sleep(20);
    emit({ type: "turn_end", message: assistantMessage, toolResults: [] });

    // tool execution
    await sleep(40);
    emit({ type: "tool_execution_start", toolCallId: "call_mock_1", toolName: "bash", args: { command: "echo hello from mock pi" } });
    let bashApproved = true;
    if (this.approvalScenario && this.approvalMode === "ask") {
      bashApproved = await this.requestApproval(
        "ui-approval-1",
        "Allow bash?",
        JSON.stringify({ command: "echo hello from mock pi" }, null, 2),
      );
    }
    if (bashApproved) {
      await sleep(80);
      emit({
        type: "tool_execution_update",
        toolCallId: "call_mock_1",
        toolName: "bash",
        args: { command: "echo hello from mock pi" },
        partialResult: { content: [{ type: "text", text: "hello from mock " }] },
      });
      await sleep(60);
      emit({
        type: "tool_execution_end",
        toolCallId: "call_mock_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hello from mock pi" }] },
        isError: false,
        durationMs: 15,
      });
    } else {
      // Blocked by the approval gate: error result, nothing executed.
      await sleep(30);
      emit({
        type: "tool_execution_end",
        toolCallId: "call_mock_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "bash was not approved" }] },
        isError: true,
        durationMs: 0,
      });
    }
    await sleep(40);
    emit({ type: "tool_execution_start", toolCallId: "call_mock_2", toolName: "edit", args: editArgs });
    await sleep(60);
    emit({
      type: "tool_execution_end",
      toolCallId: "call_mock_2",
      toolName: "edit",
      result: { content: [{ type: "text", text: "Patch applied to src/main.tsx" }] },
      isError: false,
      durationMs: 8,
    });

    // second turn: final text (with a fenced code block for the copy button)
    await sleep(40);
    emit({ type: "turn_start" });
    const finalText =
      "The command printed `hello from mock pi`. All good ✅\n\n" +
      "```bash\necho hello from mock pi\n```\n\n" +
      "Also see src/main.tsx and src/store/store.ts:1 for details.";
    await sleep(20);
    emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
    for (const chunk of chunkWords(finalText)) {
      await sleep(40);
      emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
    }
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: finalText }],
      stopReason: "endTurn",
      usage: { input: 1400, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 1490 },
      timestamp: Date.now(),
    };
    await sleep(30);
    emit({ type: "message_end", message: finalMessage });
    await sleep(20);
    emit({ type: "turn_end", message: finalMessage, toolResults: [] });
    await sleep(30);
    emit({ type: "agent_end", messages: [finalMessage], willRetry: false });
    await sleep(50);

    if (!this.emittedForPrompt) {
      this.emittedForPrompt = true;
      this.isStreaming = false;
      this.messageCount += 2;
      emit({ type: "agent_settled", aborted: this.aborted });
    }
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

// Sample project-relative paths served for the `files.list` bridge method
// (drives the Composer's @ file completion).
const MOCK_FILES: string[] = [
  "src/App.tsx",
  "src/main.tsx",
  "src/store/store.ts",
  "package.json",
  "README.md",
  "web/src/components/Markdown.tsx",
  "web/src/components/Composer.tsx",
  "web/e2e/chat.spec.ts",
];

function chunkWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}
