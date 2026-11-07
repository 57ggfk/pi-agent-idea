import type { Bridge, BridgeEventName } from "./types";

type Listener = (name: BridgeEventName, data: unknown) => void;

/** Query-string knobs for e2e; null outside a browser (vitest). */
function query(): URLSearchParams | null {
  return typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
}

/**
 * `?fail=<name>[:<count>][,<name>[:<count>]...]` — makes the first `count`
 * requests for that name fail (default 1). Names are the spec-003 source ids
 * (`files`, `commands`, `models`, `thinkingLevels`, `policy`, `prefs`,
 * `sessions`, `stats`) plus `prompt`.
 *
 * A *finite* failure budget is the point: "fail once, then work" is what makes
 * "Retry recovers in place" testable, and it keeps a multi-step test honest
 * about how many attempts it really made.
 */
/** Registry per install source; `default` deliberately has none. */
const MOCK_REGISTRIES: Record<string, string> = {
  official: "https://registry.npmjs.org",
  china: "https://registry.npmmirror.com",
};

function mockSources() {
  return [
    { id: "default", registry: "" },
    { id: "official", registry: MOCK_REGISTRIES.official },
    { id: "china", registry: MOCK_REGISTRIES.china },
  ];
}

/**
 * `?setup=missing|nonode` turns the mock machine into one the setup card has to
 * deal with, so the card (and its registry options) can be driven through the
 * real UI instead of only unit-tested. `?npmregistry=<url>` stands in for a
 * corporate `npm config get registry`.
 */
function mockSetup(state: string, npmRegistry: string) {
  const hasNode = state !== "nonode";
  return {
    ok: true,
    node: hasNode
      ? { found: true, path: "/usr/local/bin/node", version: "v22.0.0" }
      : { found: false, path: "", version: "" },
    npm: hasNode
      ? { found: true, path: "/usr/local/bin/npm", version: "10.0.0" }
      : { found: false, path: "", version: "" },
    pi: { found: false, path: "", version: "" },
    nodeMajor: hasNode ? 22 : null,
    nodeOk: hasNode,
    minNodeMajor: 18,
    canInstall: hasNode,
    piPackage: "@earendil-works/pi-coding-agent",
    agentDir: "/tmp/mock-home/.pi/agent",
    customPath: "",
    sources: mockSources(),
    defaultSource: "default",
    customSource: "custom",
    npmRegistry,
    needsSetup: true,
  };
}

function parseFailPlan(raw: string | null | undefined): Map<string, number> {
  const plan = new Map<string, number>();
  if (!raw) return plan;
  for (const entry of raw.split(",")) {
    const [name, count] = entry.split(":");
    if (!name) continue;
    const n = count === undefined ? 1 : Number(count);
    plan.set(name.trim(), Number.isFinite(n) && n > 0 ? n : 1);
  }
  return plan;
}

/**
 * `?slow=files:800` delays the first request for that name by 800 ms. The
 * "loading" state is otherwise a single microtask and impossible to assert.
 */
function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** bridge method / rpc command → the source id it feeds (spec 003). */
const METHOD_SOURCE: Record<string, string> = {
  "files.list": "files",
  "sessions.list": "sessions",
  "approval.getPolicy": "policy",
  "config.getPrefs": "prefs",
};

const COMMAND_SOURCE: Record<string, string> = {
  get_commands: "commands",
  get_available_models: "models",
  get_available_thinking_levels: "thinkingLevels",
  get_session_stats: "stats",
};

const MOCK_PROJECT_PATH = "/tmp/mock-project";
const MOCK_TRUST_STORE = "/tmp/mock-home/.pi/agent/trust.json";

/** The four project-local categories pi gates on trust. */
const MOCK_TRUST_RESOURCES = [
  { type: "skills", label: "Project skills", path: `${MOCK_PROJECT_PATH}/.pi/skills` },
  { type: "mcp", label: "MCP servers", path: `${MOCK_PROJECT_PATH}/.pi/mcp.json` },
  { type: "settings", label: "Project settings", path: `${MOCK_PROJECT_PATH}/.pi/settings.json` },
  { type: "extensions", label: "Extensions", path: `${MOCK_PROJECT_PATH}/.pi/extensions` },
] as const;

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
  private themePreference: "system" | "light" | "dark" = "system";
  /** Language preference mirror (spec 008 FR-001); persisted via setPrefs. */
  private languagePreference: string = (() => {
    try {
      // Same key the store writes: survives reloads in standalone runs the
      // way PiUserPrefs does inside the IDE.
      return localStorage.getItem("pi-agent.language-preference") ?? "system";
    } catch {
      return "system";
    }
  })();
  // Project trust. Defaults to trusted so the standalone UI looks like a
  // normal working project; `?trusted=0` exercises the untrusted banner and
  // `?trust=broken` the unreadable-store path.
  private projectTrusted = query()?.get("trusted") !== "0";
  private readonly trustBroken = query()?.get("trust") === "broken";
  // Mirrors the plugin default (auto-approve). ?approval=1 starts in "ask" so
  // the gated approval-card specs still see a dialog.
  private approvalMode: "ask" | "yolo" =
    typeof location !== "undefined" && new URLSearchParams(location.search).has("approval")
      ? "ask"
      : "yolo";
  /** Resolver of the currently pending approval dialog, if any. */
  private approvalResolve: ((confirmed: boolean) => void) | null = null;
  // Approval gating for the bash tool call, enabled via ?approval=1 so the
  // existing specs keep the ungated timing.
  private readonly approvalScenario =
    typeof location !== "undefined" && new URLSearchParams(location.search).has("approval");
  // Transcript of the current branch. Kept so get_messages / fork behave like
  // pi 1.5.0 (measured, see specs/007-message-fork/fork-semantics.json): a fork
  // branches *before* the chosen user entry, so that entry and everything after
  // it belong to the abandoned side of the tree.
  private history: Array<{ role: "user" | "assistant"; content: unknown; entryId?: string }> = [];
  private forkEntries: Array<{ entryId: string; text: string }> = [];
  private entrySeq = 0;
  /** `?cancelfork=1` — a pi extension cancels the branch (007 US1-7). */
  private readonly cancelFork = query()?.get("cancelfork") === "1";
  /** The session file the live transcript belongs to (fork / switch target). */
  private currentFile: string | null = null;
  /** Saved transcripts per session file, so switching back restores them. */
  private snapshots = new Map<
    string,
    {
      history: Array<{ role: "user" | "assistant"; content: unknown; entryId?: string }>;
      forkEntries: Array<{ entryId: string; text: string }>;
    }
  >();
  /** Prompt → times sent. Drives the "regenerated answer differs" scenario. */
  private promptCounts = new Map<string, number>();
  // `?fail=prompt` rejects the first prompt so the error-visibility path (spec
  // 003) has an item-error to render; nothing else can produce one in the UI.
  private readonly failPlan = parseFailPlan(query()?.get("fail"));
  /** How many failures each name has already served. */
  private failServed = new Map<string, number>();
  /** `?slow=files:800` — first request for that name is held back (loading state). */
  private readonly slowPlan = parseFailPlan(query()?.get("slow"));
  private slowServed = new Map<string, number>();
  /** `?unsupported=policy` — that source answers `not_implemented` (FR-009). */
  private readonly unsupported = new Set(
    (query()?.get("unsupported") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  /** `?files=volatile` — the file list loses one entry after the first read. */
  private readonly volatileFiles = query()?.get("files") === "volatile";
  private fileReads = 0;
  /** `?install=hang` — the in-flight install, resolvable only by a cancel. */
  private pendingInstall: { output: string; resolve?: (cancelled: boolean) => void } | null = null;
  /** `?pistate=1` — report starting → running, so auto-recovery can be observed. */
  private readonly reportPiState = query()?.get("pistate") === "1";
  /** `?longerror=1` — pad bridge errors past the 200-char summary limit (FR-011). */
  private readonly longErrors = query()?.get("longerror") === "1";
  // MCP servers as `pi mcp list --json` reports them: a disabled entry stays in
  // the list with `state: "disabled"` and `enabled: false` (checked against pi
  // 1.4.0), which is what lets the panel offer a switch instead of a re-add form.
  private mcpServers: Array<Record<string, unknown>> = [
    { name: "filesystem", state: "connected", toolCount: 11, enabled: true, scope: "global" },
    { name: "docs", state: "needs-login", enabled: true, scope: "global" },
    { name: "internal-tools", state: "disabled", enabled: false, scope: "project" },
  ];
  /** `?mcpoverride=1` — the write lands but another layer still decides the value. */
  private readonly mcpOverride = query()?.get("mcpoverride") === "1";
  /** Reported by manage.env; bumped by a successful manage.envUpdate. */
  private piVersion = "1.4.0-mock";
  /** Installed packages as `pi list` lines; packageUpdate bumps the version. */
  private packages = ["npm:@example/pi-tools@1.0.0"];
  /** `?models=broken|missing` — the models.json world the Auth panel must explain. */
  private readonly modelsKnob = query()?.get("models");
  /**
   * `?picker=g12|ep|long` — model-picker group fixtures (011 T005): g12 = 3
   * providers × 12 models with the current model in the last provider; ep =
   * one empty-provider entry; long = 205 models with the current at index 180.
   */
  private readonly pickerKnob = query()?.get("picker");
  /** `?skillref=1` — emulate pi's `/skill:` expansion on prompt (011 T017). */
  private readonly skillrefKnob = query()?.get("skillref") === "1";
  /**
   * `?update=garbled|failgarbled` — update-result banners (011 T022). The
   * fixture text is what the Kotlin pipeline (drainThread decode →
   * CliText.sanitize → safeTruncate) hands the UI on a Chinese Windows host:
   * the code-page output came out readable, no `\uFFFD`/`Ã`/ANSI left.
   */
  private readonly updateKnob = query()?.get("update");
  /** `?agents=deep|none` — AGENTS.md panel fixtures (012 T118). */
  private readonly agentsKnob = query()?.get("agents");
  /** Set by a successful envInstall / envSetPath: releases the setup gate
   *  on the next envDetect (012 T124). */
  private setupInstalled = false;
  /** `?setup=error1` fails the first envDetect only (retry path, T122). */
  private setupErrorShown = false;
  /** Provider names with stored credentials; writes mutate it (012 T128). */
  private authProviders = ["mock-provider"];
  /** `?authwrite=fail` makes every credential write fail (012 T133). */
  private readonly authWriteKnob = query()?.get("authwrite");
  /** Q8 default: the provider-setup skip persists in prefs. */
  private providerSetupSkipped = false;

  // -- Message queue (spec 005) ----------------------------------------------
  //
  // The mock plays BOTH roles the production system splits in two: pi (the
  // text arrays) and the Kotlin queue service (the mirror with ids/images).
  // `syncQueue` is the alignment point and emits the "queue" event the store
  // listens on, exactly like the real service's queue_state push.
  private queueItems: Array<{
    id: string;
    mode: "steer" | "followUp";
    text: string;
    images: Array<{ data: string; mimeType: string }>;
    status: "queued" | "failed";
    error?: string;
    createdAt: number;
  }> = [];
  private piSteering: string[] = [];
  private piFollowUp: string[] = [];
  private queuePaused = false;
  private queuePauseReason: string | null = null;
  private queueDrift = false;
  private queueIdSeq = 0;
  /** `?queuedrift=1` — an external writer touches pi's queue once. */
  private readonly queueDriftKnob = query()?.get("queuedrift") === "1";
  private driftInjected = false;
  /** `?queuefail=<cmd>` — first call of that queue command fails. */
  private readonly queueFailPlan = parseFailPlan(query()?.get("queuefail"));
  private queueFailServed = new Map<string, number>();
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

  /**
   * Consumes one unit of the failure budget for `name`. Returns false once the
   * budget is spent, so a retry genuinely succeeds instead of failing forever.
   */
  private shouldFail(name: string): boolean {
    const budget = this.failPlan.get(name) ?? 0;
    const used = this.failServed.get(name) ?? 0;
    if (used >= budget) return false;
    this.failServed.set(name, used + 1);
    return true;
  }

  /**
   * Single place where the query-string knobs apply, so "unsupported" cannot be
   * counted as "failed" (FR-009) and a slow response still respects its budget.
   */
  private gate(source: string): { error?: string; wait: Promise<void> } {
    if (this.unsupported.has(source)) {
      return {
        error: this.pad(`not_implemented: ${source} is not available`),
        wait: Promise.resolve(),
      };
    }
    if (this.shouldFail(source)) {
      return {
        error: this.pad(`${source} failed: pi is still loading its configuration`),
        wait: Promise.resolve(),
      };
    }
    const ms = this.slowPlan.get(source) ?? 0;
    const served = this.slowServed.get(source) ?? 0;
    if (ms <= 0 || served >= 1) return { wait: Promise.resolve() };
    this.slowServed.set(source, served + 1);
    return { wait: delay(ms) };
  }

  /**
   * Real bridge errors carry stack-ish detail. `?longerror=1` reproduces that
   * so the 200-character summary limit has something to cut.
   */
  private pad(message: string): string {
    if (!this.longErrors) return message;
    return `${message} · ${"upstream detail ".repeat(40)}`;
  }

  constructor() {
    // Seed the queue from sessionStorage so a webview reload (F5 in the tool
    // window, or an e2e page.reload) restores entries — the contract T027
    // pins for the real Kotlin-backed service.
    try {
      if (typeof sessionStorage !== "undefined") {
        const raw = sessionStorage.getItem("mock-queue-state");
        if (raw) {
          const seeded = JSON.parse(raw) as {
            items?: Array<{
              id: string;
              mode: "steer" | "followUp";
              text: string;
              images: Array<{ data: string; mimeType: string }>;
              status: "queued" | "failed";
              error?: string;
              createdAt: number;
            }>;
            steering?: string[];
            followUp?: string[];
            paused?: boolean;
            pauseReason?: string | null;
            drift?: boolean;
          };
          this.queueItems = seeded.items ?? [];
          this.piSteering = seeded.steering ?? [];
          this.piFollowUp = seeded.followUp ?? [];
          this.queuePaused = Boolean(seeded.paused);
          this.queuePauseReason = seeded.pauseReason ?? null;
          this.queueDrift = Boolean(seeded.drift);
        }
      }
    } catch {
      // Storage unavailable (vitest, privacy settings): start empty.
    }
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.seq += 1;
    if (method === "ping") return { pong: true } as T;
    const source = METHOD_SOURCE[method];
    if (source) {
      const gate = this.gate(source);
      if (gate.error) throw new Error(gate.error);
      await gate.wait;
    }
    if (method === "files.list") {
      this.fileReads += 1;
      // `?files=volatile`: the second read is missing a file, so "refresh picks
      // up a deletion" can be asserted without a moving file system.
      const files =
        this.volatileFiles && this.fileReads > 1
          ? MOCK_FILES.filter((f) => f !== "src/store/store.ts")
          : MOCK_FILES;
      return { files } as T;
    }
    if (method === "ide.repaint") {
      return Promise.resolve({ ok: true } as T);
    }
    if (method === "ide.saveImage") {
      const p = params as { suggestedName?: string } | undefined;
      const knob = query()?.get("saveimg");
      if (knob === "fail") return Promise.resolve({ ok: false, error: "could not write the file (mock)" } as T);
      if (knob === "cancel") return Promise.resolve({ ok: false, cancelled: true, error: "save cancelled" } as T);
      return Promise.resolve({ ok: true, path: `/tmp/mock-home/Downloads/${p?.suggestedName ?? "image.png"}` } as T);
    }
    if (method === "ide.copyImage") {
      const knob = query()?.get("saveimg");
      if (knob === "fail") return Promise.resolve({ ok: false, error: "the clipboard is unavailable (mock)" } as T);
      return Promise.resolve({ ok: true } as T);
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
        // e2e simulates a Chinese IDE with ?locale=zh (spec 008 US1).
        locale: query()?.get("locale") ?? "en",
      } as T);
    }
    if (method === "sessions.list") {
      const resp = this.handleCommand({ type: "sessions.list" }) as { success: boolean; data: T };
      return resp.success ? Promise.resolve(resp.data) : Promise.reject(new Error("sessions.list failed"));
    }
    if (method === "sessions.search") {
      const query = String((params as { query?: string } | undefined)?.query ?? "");
      return Promise.resolve(this.searchSessions(query) as T);
    }
    if (method === "config.getLastModel") {
      return Promise.resolve({ provider: "mock", model: "mock-model-pro" } as T);
    }
    if (method === "config.setLastModel") {
      return Promise.resolve({ ok: true } as T);
    }
    if (method === "config.getPrefs") {
      return Promise.resolve({
        ...(this.autoRetryEnabled == null ? {} : { autoRetry: this.autoRetryEnabled }),
        theme: this.themePreference,
        language: this.languagePreference,
        providerSetupSkipped: this.providerSetupSkipped,
      } as T);
    }
    if (method === "config.setPrefs") {
      const prefs = params as {
        autoRetry?: boolean;
        theme?: string;
        language?: string;
        providerSetupSkipped?: boolean;
      } | undefined;
      if (typeof prefs?.autoRetry === "boolean") this.autoRetryEnabled = prefs.autoRetry;
      if (prefs?.theme === "system" || prefs?.theme === "light" || prefs?.theme === "dark") {
        this.themePreference = prefs.theme;
      }
      if (typeof prefs?.language === "string") this.languagePreference = prefs.language;
      if (typeof prefs?.providerSetupSkipped === "boolean") this.providerSetupSkipped = prefs.providerSetupSkipped;
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
    if (method.startsWith("manage.") || method.startsWith("trust.")) {
      return Promise.resolve(this.handleManage(method, params) as T);
    }
    if (method.startsWith("queue.")) {
      return Promise.resolve(this.handleQueue(method.slice("queue.".length), params) as T);
    }
    if (method !== "rpc.request") {
      return Promise.reject(new Error(`mock bridge: unsupported method ${method}`));
    }
    const command = (params as { command?: Record<string, unknown> })?.command ?? {};
    const commandSource = COMMAND_SOURCE[String(command["type"] ?? "")];
    if (commandSource) {
      const gate = this.gate(commandSource);
      if (gate.error) return { success: false, error: gate.error } as T;
      await gate.wait;
    }
    return this.handleCommand(command) as T;
  }

  private handleManage(method: string, params?: unknown): unknown {
    switch (method) {
      case "manage.env":
        return {
          ok: true,
          found: true,
          path: "/usr/local/bin/pi",
          version: this.piVersion,
          agentDir: "/tmp/mock-home/.pi/agent",
        };
      // Standalone/mock runs already have pi unless the e2e suite asks for a
      // broken machine via `?setup=missing|nonode`; the setup card's states are
      // otherwise exercised by the dedicated component tests instead.
      case "manage.envDetect": {
        const setup = query()?.get("setup");
        if (setup === "error" || setup === "error1") {
          // 012 T122: a failed detection must NOT lock the main UI — the gate
          // falls back to "ready + main UI + visible error". `error` fails
          // forever; `error1` fails once and then recovers, so the retry
          // button has an observable effect.
          if (setup === "error") {
            return { ok: false, error: "detection failed (mock)", needsSetup: false };
          }
          if (!this.setupErrorShown) {
            this.setupErrorShown = true;
            return { ok: false, error: "detection failed (mock)", needsSetup: false };
          }
          return mockSetup("missing", query()?.get("npmregistry") ?? "");
        }
        if (setup) {
          const detected = mockSetup(setup, query()?.get("npmregistry") ?? "");
          if (this.setupInstalled) {
            // A completed install / manual path releases the gate (T124).
            detected.needsSetup = false;
            detected.pi = { found: true, path: "/usr/local/bin/pi", version: "1.5.0-mock" };
          }
          return detected;
        }
        return {
          ok: true,
          node: { found: true, path: "/usr/local/bin/node", version: "v22.0.0" },
          npm: { found: true, path: "/usr/local/bin/npm", version: "10.0.0" },
          pi: { found: true, path: "/usr/local/bin/pi", version: this.piVersion },
          nodeMajor: 22,
          nodeOk: true,
          minNodeMajor: 18,
          canInstall: true,
          piPackage: "@earendil-works/pi-coding-agent",
          agentDir: "/tmp/mock-home/.pi/agent",
          customPath: "",
          sources: mockSources(),
          defaultSource: "default",
          customSource: "custom",
          npmRegistry: "https://registry.npmjs.org/",
          needsSetup: false,
        };
      }
      case "manage.envInstall": {
        // Echo the registry back so e2e can prove which value left the UI:
        // "npm default" means no --registry flag was passed at all.
        const payload = params as { source?: string; registry?: string } | undefined;
        const registry =
          payload?.source === "custom" ? payload.registry : MOCK_REGISTRIES[payload?.source ?? ""];
        const line = `mock: npm install -g @earendil-works/pi-coding-agent${
          registry ? ` --registry=${registry}` : " (npm default registry)"
        }`;
        this.setupInstalled = true; // success path only — fail/hang never reach here
        if (query()?.get("install") === "fail") {
          return {
            ok: false,
            exitCode: 1,
            output: `${line}\nnpm ERR! code EAI_AGAIN`,
            error: "The registry was unreachable. Try the other source, or install pi yourself and set its path.",
          };
        }
        if (query()?.get("install") === "hang") {
          // Never resolves on its own — only `manage.envCancelInstall` ends it,
          // which is exactly what the Stop button has to be tested against.
          this.pendingInstall = { output: line };
          return new Promise((resolve) => {
            this.pendingInstall!.resolve = (cancelled: boolean) => {
              this.pendingInstall = null;
              resolve(
                cancelled
                  ? {
                      ok: false,
                      cancelled: true,
                      output: `${line}\n(npm stopped by the user)`,
                      error: "Install stopped. Nothing was uninstalled.",
                    }
                  : { ok: true, found: true, exitCode: 0, output: line, version: this.piVersion },
              );
            };
          });
        }
        return { ok: true, found: true, exitCode: 0, output: line, version: this.piVersion };
      }
      case "manage.envCancelInstall": {
        if (!this.pendingInstall?.resolve) {
          return { ok: false, error: "no install is running" };
        }
        this.pendingInstall.resolve(true);
        return { ok: true, cancelled: true };
      }
      case "manage.envSetPath": {
        this.setupInstalled = true;
        return { ok: true, found: true, path: "/usr/local/bin/pi", version: this.piVersion };
      }
      case "manage.mcpList":
        return {
          ok: true,
          raw: { servers: this.mcpServers.map((s) => ({ ...s })), errors: [] },
        };
      case "manage.mcpSetEnabled": {
        const p = (params ?? {}) as { name?: string; scope?: string; enabled?: boolean };
        if (this.shouldFail("mcp")) {
          return { ok: false, error: "mcp.json is not valid JSON (unexpected token at line 3)" };
        }
        const target = this.mcpServers.find(
          (s) => s.name === p.name && (p.scope == null || s.scope === p.scope),
        );
        if (!target) {
          return { ok: false, error: `no MCP server named "${p.name}" at ${p.scope ?? "global"} scope` };
        }
        target.enabled = p.enabled !== false;
        // pi reports a disabled entry as state "disabled" and keeps listing it.
        target.state = target.enabled ? "connected" : "disabled";
        return {
          ok: true,
          name: p.name,
          scope: target.scope,
          enabled: target.enabled,
          error: "",
          warning: this.mcpOverride && p.enabled === false
            ? "This project's .pi/mcp.json overrides the setting; the server stays enabled here."
            : "",
        };
      }
      case "manage.mcpAdd":
      case "manage.mcpRemove":
      case "manage.mcpLogin":
      case "manage.mcpLogout":
      case "manage.packageInstall":
      case "manage.packageRemove":
      case "manage.skillCreate":
        return { ok: true, output: "mock: done" };
      case "manage.packageUpdate": {
        const p = (params ?? {}) as { source?: string };
        if (!p.source) return { ok: false, error: "missing source" };
        if (this.shouldFail("update")) {
          return {
            ok: false,
            exitCode: 1,
            output:
              "npm error code E404\nnpm error 404 '@example/pi-extra@latest' is not in the npm registry",
          };
        }
        const idx = this.packages.findIndex((l) => l.includes(p.source!));
        if (idx < 0) return { ok: false, exitCode: 1, output: `not installed: ${p.source}` };
        // A successful update changes the version the list reports, so the
        // "update refreshes the version" e2e can assert on the row text.
        const bumped = this.packages[idx].replace(
          /(\d+)\.(\d+)\.(\d+)/,
          (_m, a: string, b: string, c: string) => `${a}.${Number(b) + 1}.${c}`,
        );
        this.packages[idx] = bumped;
        return { ok: true, exitCode: 0, output: `updated ${p.source} -> ${bumped}` };
      }
      case "manage.envUpdate": {
        if (this.updateKnob === "garbled") {
          this.piVersion = "1.5.0-mock";
          return {
            ok: true,
            exitCode: 0,
            output:
              "安装完成 → pi 1.5.0-mock（安装路径 D:\\软件\\nodejs 显示正常）\nadded 1 package in 12.4s ✅",
            version: this.piVersion,
          };
        }
        if (this.updateKnob === "failgarbled") {
          return {
            ok: false,
            exitCode: 1,
            version: this.piVersion,
            output:
              "npm error code EACCES\nnpm warn 已跳过可选依赖 fsevents@2.3.3（安装路径含中文）\nnpm error 权限不足：/usr/local/lib/node_modules",
          };
        }
        if (this.shouldFail("update")) {
          return {
            ok: false,
            exitCode: 1,
            version: this.piVersion,
            output:
              "npm error code EACCES\nnpm error mkdir /usr/local/lib/node_modules: permission denied",
          };
        }
        this.piVersion = "1.5.0-mock";
        return { ok: true, exitCode: 0, output: "pi updated to 1.5.0-mock", version: this.piVersion };
      }
      case "manage.packagesList":
        return { ok: true, lines: [...this.packages, "No packages installed."] };
      case "manage.agentsList":
        return agentsListFixture(this.agentsKnob);
      case "manage.agentsOpen":
        return { ok: true, path: (params as { path?: string } | undefined)?.path ?? "" };
      case "manage.agentsCreate": {
        const path = (params as { path?: string } | undefined)?.path ?? "/tmp/mock-project/AGENTS.md";
        return { ok: true, path, created: this.agentsKnob !== "exists" };
      }
      case "manage.skillsList":
        return {
          ok: true,
          skills: [
            {
              name: "pdf-tools",
              description: "Extract text and tables from PDF files.",
              path: "/tmp/mock-home/.pi/agent/skills/pdf-tools/SKILL.md",
              scope: "user",
              disableModelInvocation: false,
            },
            {
              name: "project-conventions",
              description: "House rules for this repository.",
              path: `${MOCK_PROJECT_PATH}/.pi/skills/project-conventions`,
              scope: "project",
              disableModelInvocation: false,
            },
          ],
        };
      case "manage.authOverview": {
        const base = {
          ok: true,
          providers: [...this.authProviders],
          withCredentials: [...this.authProviders],
        };
        if (this.modelsKnob === "broken") {
          return {
            ...base,
            modelsState: "corrupt",
            modelsPath: "/tmp/mock-home/.pi/agent/models.json",
            modelsError:
              "models.json is not valid JSON (Unexpected JSON token at offset 42: Expected ',' or '}') (line 3, column 8)",
          };
        }
        if (this.modelsKnob === "missing") {
          return {
            ...base,
            modelsState: "missing",
            modelsPath: "/tmp/mock-home/.pi/agent/models.json",
          };
        }
        return { ...base, modelsState: "ok", modelsPath: "/tmp/mock-home/.pi/agent/models.json" };
      }
      case "manage.modelsReadProvider": {
        if (this.modelsKnob === "broken") {
          return {
            ok: false,
            error:
              "models.json is not valid JSON (Unexpected JSON token at offset 42: Expected ',' or '}') (line 3, column 8)",
          };
        }
        if (this.modelsKnob === "missing") {
          return {
            ok: false,
            missing: true,
            error: "models.json not found at /tmp/mock-home/.pi/agent/models.json",
          };
        }
        const p = (params ?? {}) as { name?: string };
        const name = p.name ?? "";
        if (name !== "mock-provider") {
          return { ok: false, error: `no provider named "${name}" in models.json` };
        }
        return {
          ok: true,
          name,
          path: "/tmp/mock-home/.pi/agent/models.json",
          // The values at sensitive keys are already booleans on the wire —
          // the secret never crosses the bridge (spec 001 T019).
          config: {
            type: "openai_completions",
            baseUrl: "https://api.mock.dev/v1",
            apiKey: true,
            headers: { Authorization: false },
            models: [
              { id: "mock-model-pro", contextWindow: 200000 },
              { id: "mock-model-mini", contextWindow: 128000 },
            ],
          },
        };
      }
      case "manage.modelsOpenFile":
        return {
          ok: true,
          path: "/tmp/mock-home/.pi/agent/models.json",
          created: this.modelsKnob === "missing",
        };
      case "manage.authCheck":
        return { ok: true, status: "ready", detail: { provider: "mock-provider" } };
      case "manage.authSet":
      case "manage.providerSetKey": {
        const p = (params ?? {}) as { provider?: string; key?: string };
        if (this.authWriteKnob === "fail") {
          return { ok: false, error: "invalid or rejected key (mock)" };
        }
        if (!p.provider || !p.key) return { ok: false, error: "missing provider or key" };
        // The mock keeps provider names only — it models the contract that the
        // key material never round-trips (012 T133).
        if (!this.authProviders.includes(p.provider)) this.authProviders.push(p.provider);
        return { ok: true, provider: p.provider };
      }
      case "manage.authDelete": {
        const p = (params ?? {}) as { provider?: string };
        if (p.provider === "mock-provider") return { ok: false, error: "the default credential cannot be removed (mock)" };
        this.authProviders = this.authProviders.filter((n) => n !== p.provider);
        return { ok: true, provider: p.provider ?? "" };
      }
      case "manage.settingsRead":
        return { ok: true, path: "/tmp/mock-home/.pi/agent/settings.json", text: "{\n  \"theme\": \"dark\"\n}" };
      case "manage.settingsWrite":
        return { ok: true, output: "saved" };
      case "trust.get": {
        if (this.trustBroken) {
          return {
            ok: false,
            error: "trust.json is not valid JSON (unexpected token at line 1)",
            trusted: false,
            path: MOCK_PROJECT_PATH,
            store: MOCK_TRUST_STORE,
            exists: true,
            resources: [],
          };
        }
        return {
          ok: true,
          trusted: this.projectTrusted,
          path: MOCK_PROJECT_PATH,
          store: MOCK_TRUST_STORE,
          exists: true,
          resources: MOCK_TRUST_RESOURCES.map((r) => ({
            type: r.type,
            label: r.label,
            scope: "project" as const,
            active: this.projectTrusted,
            path: r.path,
            ...(this.projectTrusted ? {} : { reason: "project is not trusted" }),
          })),
        };
      }
      case "trust.grant": {
        if ((params as { confirmed?: boolean } | undefined)?.confirmed !== true) {
          return { ok: false, error: "confirmation required" };
        }
        if (this.trustBroken) {
          return { ok: false, error: "trust.json is not valid JSON; fix or delete it first" };
        }
        this.projectTrusted = true;
        return { ok: true, trusted: true, path: MOCK_PROJECT_PATH, restartRequired: false };
      }
      case "trust.revoke": {
        if ((params as { confirmed?: boolean } | undefined)?.confirmed !== true) {
          return { ok: false, error: "confirmation required" };
        }
        if (this.trustBroken) {
          return { ok: false, error: "trust.json is not valid JSON; fix or delete it first" };
        }
        this.projectTrusted = false;
        return { ok: true, trusted: false, path: MOCK_PROJECT_PATH, restartRequired: false };
      }
      default:
        return { ok: false, error: `mock bridge: unsupported method ${method}` };
    }
  }

  // -- queue machinery (the Kotlin service's stand-in) -----------------------

  private shouldFailQueue(cmd: string): boolean {
    const budget = this.queueFailPlan.get(cmd) ?? 0;
    const used = this.queueFailServed.get(cmd) ?? 0;
    if (used >= budget) return false;
    this.queueFailServed.set(cmd, used + 1);
    return true;
  }

  private newQueueItem(
    mode: "steer" | "followUp",
    text: string,
    images: Array<{ data: string; mimeType: string }>,
  ): {
    id: string;
    mode: "steer" | "followUp";
    text: string;
    images: Array<{ data: string; mimeType: string }>;
    status: "queued" | "failed";
    error?: string;
    createdAt: number;
  } {
    this.queueIdSeq += 1;
    return {
      id: `q-${this.queueIdSeq}`,
      mode,
      text,
      images: images.map((img) => ({ ...img })),
      status: "queued" as const,
      createdAt: Date.now(),
    };
  }

  /** Canonical display order: steering (fires during the run) first. */
  private normalizeQueue() {
    this.queueItems.sort((a, b) => (a.mode === "steer" ? 0 : 1) - (b.mode === "steer" ? 0 : 1));
  }

  /** pi's arrays, re-derived from the queued mirror items. */
  private rebuildPiFromMirror() {
    this.piSteering = this.queueItems
      .filter((i) => i.status === "queued" && i.mode === "steer")
      .map((i) => i.text);
    this.piFollowUp = this.queueItems
      .filter((i) => i.status === "queued" && i.mode === "followUp")
      .map((i) => i.text);
  }

  private emitQueueUpdate() {
    this.emit("pi", {
      type: "queue_update",
      steering: [...this.piSteering],
      followUp: [...this.piFollowUp],
    });
  }

  /**
   * Aligns the mirror against pi's arrays (by text, item by item — spec 005
   * plan decision 3), then pushes a full queue_state snapshot. This is the
   * exact contract the Kotlin service implements against a real pi.
   */
  private syncQueue() {
    if (this.queueDriftKnob && !this.driftInjected) {
      this.driftInjected = true;
      // Someone queued from another terminal; the mirror cannot know it yet.
      this.piFollowUp = [...this.piFollowUp, "queued from another terminal"];
    }
    // While paused the mirror intentionally diverges (pi's queue is empty by
    // design) — an alignment here would wipe it, exactly what the service
    // guards against.
    if (!this.queuePaused) {
      const piOrder = [
        ...this.piSteering.map((text) => ({ text, mode: "steer" as const })),
        ...this.piFollowUp.map((text) => ({ text, mode: "followUp" as const })),
      ];
      const queued = this.queueItems.filter((i) => i.status === "queued");
      const equal =
        queued.length === piOrder.length &&
        queued.every((item, i) => item.text === piOrder[i].text && item.mode === piOrder[i].mode);
      if (!equal) {
        // Rebuild from pi: no images, fresh ids (identical texts cannot be
        // matched reliably); failed items survive in their section.
        const failed = this.queueItems.filter((i) => i.status === "failed");
        const rebuilt = piOrder.map((p) => this.newQueueItem(p.mode, p.text, []));
        for (const f of failed) {
          const sectionEnd = rebuilt.map((r) => r.mode).lastIndexOf(f.mode) + 1;
          rebuilt.splice(sectionEnd, 0, f);
        }
        this.queueItems = rebuilt;
        this.queueDrift = true;
      }
    }
    this.persistQueue();
    this.emit("queue", {
      type: "queue_state",
      items: this.queueItems.map((i) => ({ ...i, images: i.images.map((img) => ({ ...img })) })),
      paused: this.queuePaused,
      pauseReason: this.queuePauseReason,
      drift: this.queueDrift,
    });
  }

  private persistQueue() {
    try {
      if (typeof sessionStorage === "undefined") return;
      sessionStorage.setItem(
        "mock-queue-state",
        JSON.stringify({
          items: this.queueItems,
          steering: this.piSteering,
          followUp: this.piFollowUp,
          paused: this.queuePaused,
          pauseReason: this.queuePauseReason,
          drift: this.queueDrift,
        }),
      );
    } catch {
      // Storage unavailable; the queue still works in memory.
    }
  }

  /** Follow-ups run one at a time, each as its own turn after the previous settles. */
  private scheduleFollowUp() {
    if (this.queuePaused || this.piFollowUp.length === 0) return;
    const next = this.piFollowUp.shift()!;
    this.emitQueueUpdate();
    this.syncQueue();
    this.timers.push(
      setTimeout(() => {
        const take = (this.promptCounts.get(next) ?? 0) + 1;
        this.promptCounts.set(next, take);
        this.entrySeq += 1;
        const entryId = `entry-${this.entrySeq}`;
        this.history.push({ role: "user", content: next, entryId });
        this.forkEntries.push({ entryId, text: next });
        void this.startRun(next, take);
      }, 250),
    );
  }

  /** abort parks the queue: pi's own queue state after abort is untrustworthy. */
  private pauseQueueOnAbort() {
    const queued = this.queueItems.filter((i) => i.status === "queued");
    if (queued.length === 0 || this.queuePaused) return;
    this.piSteering = [];
    this.piFollowUp = [];
    this.queuePaused = true;
    this.queuePauseReason = "aborted";
    this.syncQueue();
  }

  private handleQueue(cmd: string, params?: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "get":
        return {
          items: this.queueItems.map((i) => ({ ...i, images: i.images.map((img) => ({ ...img })) })),
          paused: this.queuePaused,
          pauseReason: this.queuePauseReason,
          drift: this.queueDrift,
        };
      case "enqueue": {
        const mode = p.mode === "steer" ? "steer" : "followUp";
        const text = String(p.text ?? "");
        const images = Array.isArray(p.images)
          ? (p.images as Array<{ data?: unknown; mimeType?: unknown }>).map((img) => ({
              data: String(img.data ?? ""),
              mimeType: String(img.mimeType ?? "image/png"),
            }))
          : [];
        const item = this.newQueueItem(mode, text, images);
        if (this.shouldFailQueue(cmd)) {
          // Production contract: the entry is retained and marked failed, the
          // raw error stays visible (US5-4) — never a silent loss.
          item.status = "failed";
          item.error = "steer failed: the model endpoint is unavailable (?queuefail)";
          this.queueItems.push(item);
          this.normalizeQueue();
          this.syncQueue();
          return { ok: false, retained: true, id: item.id, error: item.error };
        }
        this.queueItems.push(item);
        if (mode === "steer") this.piSteering = [...this.piSteering, text];
        else this.piFollowUp = [...this.piFollowUp, text];
        this.normalizeQueue();
        this.emitQueueUpdate();
        this.syncQueue();
        return { ok: true, id: item.id };
      }
      case "move": {
        if (this.shouldFailQueue(cmd)) return { ok: false, error: "queue.move failed (?queuefail)" };
        const id = String(p.id ?? "");
        const delta = Number(p.delta ?? 0);
        const idx = this.queueItems.findIndex((i) => i.id === id);
        if (idx < 0) return { ok: false, error: `no queue item ${id}` };
        const target = idx + delta;
        if (
          target < 0 ||
          target >= this.queueItems.length ||
          this.queueItems[target].mode !== this.queueItems[idx].mode
        ) {
          // Edge (or section crossing): pi untouched (T016).
          return { ok: false, error: "at edge" };
        }
        const swapped = [...this.queueItems];
        [swapped[idx], swapped[target]] = [swapped[target], swapped[idx]];
        this.queueItems = swapped;
        if (this.queuePaused) {
          // Parked: the mirror is the only truth — same guard as the service.
          this.syncQueue();
          return { ok: true };
        }
        this.rebuildPiFromMirror();
        this.emitQueueUpdate();
        this.syncQueue();
        return { ok: true };
      }
      case "remove": {
        if (this.shouldFailQueue(cmd)) return { ok: false, error: "queue.remove failed (?queuefail)" };
        const id = String(p.id ?? "");
        const target = this.queueItems.find((i) => i.id === id);
        if (!target || target.status === "failed") return { ok: false, error: `no queue item ${id}` };
        this.queueItems = this.queueItems.filter((i) => i.id !== id);
        if (this.queuePaused) {
          this.syncQueue();
          return { ok: true };
        }
        this.rebuildPiFromMirror();
        this.emitQueueUpdate();
        this.syncQueue();
        return { ok: true };
      }
      case "restore": {
        if (this.shouldFailQueue(cmd)) return { ok: false, error: "queue.restore failed (?queuefail)" };
        const id = String(p.id ?? "");
        const target = this.queueItems.find((i) => i.id === id);
        if (!target) return { ok: false, error: `no queue item ${id}` };
        this.queueItems = this.queueItems.filter((i) => i.id !== id);
        if (!this.queuePaused) {
          this.rebuildPiFromMirror();
          this.emitQueueUpdate();
        }
        this.syncQueue();
        return { ok: true, id, text: target.text, images: target.images.map((img) => ({ ...img })) };
      }
      case "promote": {
        if (this.shouldFailQueue(cmd)) return { ok: false, error: "queue.promote failed (?queuefail)" };
        const id = String(p.id ?? "");
        const target = this.queueItems.find((i) => i.id === id);
        if (!target) return { ok: false, error: `no queue item ${id}` };
        if (target.mode === "steer") return { ok: true };
        target.mode = "steer";
        if (this.queuePaused) {
          this.normalizeQueue();
          this.syncQueue();
          return { ok: true };
        }
        this.rebuildPiFromMirror();
        this.emitQueueUpdate();
        this.syncQueue();
        return { ok: true };
      }
      case "pause": {
        if (this.shouldFailQueue(cmd)) return { ok: false, error: "queue.pause failed (?queuefail)" };
        this.queuePaused = true;
        this.queuePauseReason = typeof p.reason === "string" ? p.reason : "manual";
        // pi's queue is truly empty now; the mirror keeps everything.
        this.piSteering = [];
        this.piFollowUp = [];
        this.syncQueue();
        return { ok: true };
      }
      case "resume": {
        if (this.shouldFailQueue(cmd)) return { ok: false, error: "queue.resume failed (?queuefail)" };
        this.queuePaused = false;
        this.queuePauseReason = null;
        this.rebuildPiFromMirror();
        this.emitQueueUpdate();
        this.syncQueue();
        if (!this.isStreaming) this.scheduleFollowUp();
        return { ok: true };
      }
      case "clear": {
        if (this.shouldFailQueue(cmd)) return { ok: false, error: "queue.clear failed (?queuefail)" };
        this.queueItems = [];
        this.piSteering = [];
        this.piFollowUp = [];
        this.queuePaused = false;
        this.queuePauseReason = null;
        this.queueDrift = false;
        this.emitQueueUpdate();
        this.syncQueue();
        return { ok: true };
      }
      default:
        return { ok: false, error: `mock bridge: unsupported queue method ${cmd}` };
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
            sessionId: "session-aaa", // matches mockSessions[0]: the live session row (012 title editing)
            sessionFile: "/tmp/mock-project/session.jsonl",
            autoCompactionEnabled: this.autoCompactionEnabled,
            messageCount: this.messageCount,
            pendingMessageCount: 0,
          },
        };
      case "get_available_models":
        return { success: true, data: { models: pickerModels(this.pickerKnob) } };
      case "get_available_thinking_levels":
        return { success: true, data: { levels: ["off", "minimal", "low", "medium", "high"] } };
      case "get_session_stats":
        return {
          success: true,
          data: {
            sessionId: "session-aaa", // matches mockSessions[0]: the live session row (012 title editing)
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
      case "get_messages":
        return {
          success: true,
          data: {
            messages: this.history.map(({ role, content }) => ({ role, content })),
          },
        };
      case "get_fork_messages":
        // pi 1.5.0 wraps the list — {data:{messages:[{entryId,text}]}} — and
        // reports user entries only; measured in
        // specs/007-message-fork/fork-semantics.json.
        return { success: true, data: { messages: this.forkEntries.map((e) => ({ ...e })) } };
      case "prompt": {
        const message = String(command["message"] ?? "");
        if (this.shouldFail("prompt")) {
          return { success: false, error: "the model endpoint is unavailable" };
        }
        if (this.isStreaming && !command["streamingBehavior"]) {
          return { success: false, error: "agent is streaming; specify streamingBehavior" };
        }
        // `?skillref=1` (011 T017): pi rewrites a `/skill:<name> …` prompt into
        // the expanded single-text-block message before it reaches the
        // transcript — emulate that so the folding path is exercised end to
        // end. Raw `/skill:` text is never stored, matching the real jsonl.
        const wireMessage = this.skillrefKnob ? expandSkillCommand(message) : message;
        const disposition = this.isStreaming ? "queued" : "started";
        if (!this.isStreaming) {
          // First prompt of a session: give the transcript a file so a later
          // fork can keep this branch on "disk" (007 US1-6).
          if (!this.currentFile) this.currentFile = "/tmp/mock-sessions/live-session.jsonl";
          const take = (this.promptCounts.get(wireMessage) ?? 0) + 1;
          this.promptCounts.set(wireMessage, take);
          this.entrySeq += 1;
          const entryId = `entry-${this.entrySeq}`;
          this.history.push({ role: "user", content: wireMessage, entryId });
          this.forkEntries.push({ entryId, text: wireMessage });
          void this.startRun(wireMessage, take);
        } else {
          this.emit("pi", { type: "queue_update", steering: [wireMessage], followUp: [] });
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
        this.saveSnapshot();
        this.messageCount = 0;
        this.currentFile = null;
        this.resetBranch();
        return { success: true, data: { cancelled: false } };
      case "switch_session": {
        const target = String(command["sessionPath"] ?? "");
        this.saveSnapshot();
        this.messageCount = 0;
        this.currentFile = target || null;
        const snapshot = target ? this.snapshots.get(target) : undefined;
        this.resetBranch();
        if (snapshot) {
          this.history = [...snapshot.history];
          this.forkEntries = [...snapshot.forkEntries];
          this.messageCount = this.history.length;
        }
        return { success: true, data: { cancelled: false } };
      }
      case "fork": {
        // Verbatim pi 1.5.0 semantics (fork-semantics.json): {entryId} branches
        // *before* that user entry — the entry itself is not in the new
        // session — and the response is { text, cancelled } with the text of
        // the message that was left behind. No sessionPath, no sessionId.
        const entryId = String(command["entryId"] ?? "");
        const entryIndex = this.forkEntries.findIndex((e) => e.entryId === entryId);
        const historyIndex = this.history.findIndex((m) => m.entryId === entryId);
        if (!entryId || entryIndex < 0 || historyIndex < 0) {
          return { success: false, error: "Invalid entry ID for forking" };
        }
        const text = this.forkEntries[entryIndex].text;
        if (this.cancelFork) return { success: true, data: { cancelled: true } };
        // Snapshot + new session row first: pushBranchSession files the tree we
        // are leaving under its own file, and only then does the transcript get
        // truncated to the branch point.
        this.pushBranchSession("fork");
        this.history = this.history.slice(0, historyIndex);
        this.forkEntries = this.forkEntries.slice(0, entryIndex);
        // The row was created while the transcript was still complete.
        this.mockSessions[0].messageCount = this.history.length;
        return { success: true, data: { text, cancelled: false } };
      }
      case "clone": {
        // pi 1.5.0: clone duplicates the whole active branch into a new session
        // file (new sessionId, stats recomputed, queue not carried over). The
        // in-process session keeps its transcript, so only the session list has
        // to change here; the response carries no path for the UI to follow.
        if (this.cancelFork) return { success: true, data: { cancelled: true } };
        this.pushBranchSession("clone");
        return { success: true, data: { cancelled: false } };
      }
      case "set_session_name": {
        // pi rejects empty names (T101 evidence) and echoes the change as an
        // event; the list row follows on the next sessions.list.
        const name = String(command["name"] ?? "");
        if (!name) return { success: false, error: "Session name cannot be empty" };
        if (this.mockSessions[0]) this.mockSessions[0] = { ...this.mockSessions[0], name };
        this.emit("pi", { type: "session_info_changed", name });
        return { success: true };
      }
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

  /** Empties the simulated transcript (new / switch session). */
  private resetBranch() {
    this.history = [];
    this.forkEntries = [];
    this.promptCounts.clear();
  }

  /**
   * Keeps the live session on disk the way pi does: forking must not destroy
   * the branch it came from, and switching back has to show that branch again
   * (spec 007 US1-6).
   */
  private saveSnapshot() {
    if (!this.currentFile) return;
    this.snapshots.set(this.currentFile, {
      history: [...this.history],
      forkEntries: [...this.forkEntries],
    });
    if (!this.mockSessions.some((s) => s.file === this.currentFile)) {
      this.mockSessions = [
        {
          file: this.currentFile,
          id: `session-previous-${this.sessionSeq}`,
          timestamp: new Date().toISOString(),
          name: "Previous session",
          preview: "Branched away from here",
          modifiedAt: Date.now(),
          messageCount: this.history.length,
        },
        ...this.mockSessions,
      ];
    }
  }

  /**
   * Full-text scan over every mock session's transcript (spec 006 US3):
   * the live session reads `history`, the others their saved snapshots.
   * Same shape as the Kotlin side — results, scanned, truncated.
   */
  private searchSessions(raw: string): unknown {
    const needle = raw.trim().toLowerCase();
    if (!needle) return { results: [], scanned: 0, truncated: false };
    const results: Array<Record<string, unknown>> = [];
    let scanned = 0;
    // The live session is searchable even before its first snapshot puts it
    // into mockSessions.
    const entries = this.mockSessions.map((s) => ({
      file: s.file,
      id: s.id,
      name: s.name,
      modifiedAt: s.modifiedAt,
    }));
    if (this.currentFile && !entries.some((e) => e.file === this.currentFile)) {
      entries.unshift({ file: this.currentFile, id: "live", name: "Current session", modifiedAt: Date.now() });
    }
    for (const entry of entries) {
      scanned++;
      const history =
        entry.file === this.currentFile
          ? this.history
          : (this.snapshots.get(entry.file)?.history ?? []);
      let hitCount = 0;
      const hits: Array<Record<string, unknown>> = [];
      for (const { role, content } of history) {
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .filter((b) => (b as { type?: string })?.type === "text")
                  .map((b) => String((b as { text?: string }).text ?? ""))
                  .join("\n")
              : "";
        let from = 0;
        for (;;) {
          const at = text.toLowerCase().indexOf(needle, from);
          if (at < 0) break;
          if (hits.length < 2) {
            const start = Math.max(0, at - 60);
            const end = Math.min(text.length, at + needle.length + 60);
            hits.push({
              role,
              snippet:
                (start > 0 ? "…" : "") +
                text.slice(start, end).replace(/\s+/g, " ").trim() +
                (end < text.length ? "…" : ""),
              hitIndex: hitCount,
            });
          }
          hitCount++;
          from = at + needle.length;
        }
      }
      if (hitCount > 0) {
        results.push({
          file: entry.file,
          id: entry.id,
          name: entry.name,
          modifiedAt: entry.modifiedAt,
          hitCount,
          hits,
        });
      }
    }
    // The e2e suite asks for the truncation path explicitly (?searchtruncate=1).
    return { results, scanned, truncated: query()?.get("searchtruncate") === "1" && scanned > 0 };
  }

  /** fork / clone land in a new session file; the list has to show it. */
  private pushBranchSession(kind: "fork" | "clone") {
    // The branch we are leaving stays on disk with its own transcript.
    this.saveSnapshot();
    this.sessionSeq += 1;
    const id = `session-${kind}-${this.sessionSeq}`;
    const file = `/tmp/mock-sessions/2026-10-29T09-00-00_${id}.jsonl`;
    this.currentFile = file;
    this.mockSessions = [
      {
        file,
        id,
        timestamp: new Date().toISOString(),
        name: kind === "clone" ? "Cloned session" : "Forked session",
        preview: "Branched conversation",
        modifiedAt: Date.now(),
        messageCount: this.history.length,
      },
      ...this.mockSessions,
    ];
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

  private async startRun(prompt: string, take = 1) {
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

    // pi injects one queued steering message at the next turn boundary; the
    // mock reproduces that so the queue bar can be watched draining (US5).
    if (!this.aborted && this.piSteering.length > 0) {
      const injected = this.piSteering.shift()!;
      this.entrySeq += 1;
      const entryId = `entry-${this.entrySeq}`;
      this.history.push({ role: "user", content: injected, entryId });
      this.forkEntries.push({ entryId, text: injected });
      emit({
        type: "message_start",
        message: { role: "user", content: injected, timestamp: Date.now() },
      });
      emit({
        type: "message_end",
        message: { role: "user", content: injected, timestamp: Date.now() },
      });
      this.emitQueueUpdate();
      this.syncQueue();
    }

    // second turn: final text (with a fenced code block for the copy button)
    await sleep(40);
    emit({ type: "turn_start" });
    // Sending the same prompt again (regenerate) must produce a visibly
    // different answer, otherwise an e2e cannot tell "regenerated" from "the
    // old reply never went away".
    const finalText =
      (take > 1 ? `Regenerated answer, take ${take}.\n\n` : "") +
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

    // An aborted run never made it into the transcript, so neither does it here.
    if (!this.aborted) {
      this.history.push(
        { role: "assistant", content: assistantMessage.content },
        { role: "assistant", content: finalMessage.content },
      );
    }

    if (!this.emittedForPrompt) {
      this.emittedForPrompt = true;
      this.isStreaming = false;
      this.messageCount += 2;
      emit({ type: "agent_settled", aborted: this.aborted });
      // Queue continuation (spec 005): an aborted run parks the queue; a
      // settled one hands the next follow-up to pi as a fresh turn.
      if (this.aborted) {
        this.pauseQueueOnAbort();
      } else {
        this.scheduleFollowUp();
      }
    }
  }

  private emit(name: BridgeEventName, data: unknown) {
    this.listeners.forEach((l) => l(name, data));
  }

  onEvent(listener: Listener) {
    this.listeners.push(listener);
    if (!this.reportPiState) return;
    // The real bridge reports the process lifecycle; the mock is silent by
    // default so a `?fail=` fixture is not healed by auto-recovery (FR-005)
    // before a test can look at the failed state.
    this.timers.push(setTimeout(() => this.emit("pi-state", { status: "starting" }), 0));
    this.timers.push(
      setTimeout(() => this.emit("pi-state", { status: "running", version: "1.4.0-mock" }), 300),
    );
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

/**
 * Model-picker fixtures (011 T005), selected with `?picker=`. Every variant
 * keeps `mock/mock-model-pro` (the mock's current model) present so the
 * picker's "locate current on open" path has a real target. The default list
 * is untouched so existing chat.spec model assertions stay meaningful.
 */
/** Bodies for the `?skillref=1` fixture skills; the expansion below mirrors
 *  pi's `_expandSkillCommand` output (T001 evidence): frontmatter stripped,
 *  body trimmed, references line first. */
const MOCK_SKILL_BODIES: Record<string, string> = {
  "demo-skill": "# Demo Skill\n\nMOCK-SKILL-DEMO-BODY-MARKER-XYZ\n\nStep-by-step usage instructions.",
  "second-skill": "# Second Skill\n\nMOCK-SKILL-SECOND-BODY-MARKER-XYZ",
};

/**
 * Emulates pi's `/skill:` expansion (011 T017): the raw command never reaches
 * the transcript — it is replaced by one text block with the SKILL.md body
 * between `<skill>` tags and the user's question appended after. A message
 * without the prefix (and an unknown skill name, like the real CLI passes
 * unmatched commands through) keeps its raw form: no boundary, no folding.
 */
function expandSkillCommand(message: string): string {
  const match = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(message.trim());
  if (!match) return message;
  const name = match[1];
  const args = (match[2] ?? "").trim();
  const body = MOCK_SKILL_BODIES[name] ?? `# ${name}\n\nMOCK-SKILL-BODY-MARKER-${name}`;
  const dir = `/tmp/mock-project/.pi/skills/${name}`;
  const block = `<skill name="${name}" location="${dir}/SKILL.md">\nReferences are relative to ${dir}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

function pickerModels(knob: string | null | undefined): MockModel[] {
  if (!knob || knob === "default") return MOCK_MODELS;
  const mk = (provider: string, id: string, name: string): MockModel => ({
    id,
    name,
    provider,
    contextWindow: 128000,
    reasoning: false,
  });

  if (knob === "g12") {
    // 3 providers × 12 models; pi order alpha → beta → mock, current model in
    // the mock group so "current group pinned first" is observable.
    return [
      mk("alpha", "alpha-1", "Alpha One"),
      mk("alpha", "alpha-2", "Alpha Two"),
      mk("alpha", "alpha-3", "Alpha Three"),
      mk("alpha", "alpha-4", "Alpha Four"),
      mk("beta", "beta-1", "Beta One"),
      mk("beta", "beta-2", "Beta Two"),
      mk("beta", "beta-3", "Beta Three"),
      mk("mock", "mock-1", "Mock One"),
      mk("mock", "mock-model-pro", "Mock Model Pro"),
      mk("mock", "mock-3", "Mock Three"),
      mk("mock", "mock-4", "Mock Four"),
      mk("mock", "mock-5", "Mock Five"),
    ];
  }

  if (knob === "ep") {
    // One model without a provider → the fallback group, rendered last.
    return [
      mk("mock", "mock-model-pro", "Mock Model Pro"),
      mk("alpha", "alpha-1", "Alpha One"),
      { ...mk("", "orphan-1", "orphan-1") },
    ];
  }

  if (knob === "long") {
    // 205 entries with the current model buried at index 180: open-locate and
    // cap behavior ("…and 5 more") both need a list larger than the cap.
    const models: MockModel[] = [];
    for (let i = 0; i < 205; i++) {
      if (i === 180) {
        models.push(mk("mock", "mock-model-pro", "Mock Model Pro"));
      } else {
        const n = String(i).padStart(3, "0");
        models.push(mk("bulk", `bulk-${n}`, `Bulk Model ${n}`));
      }
    }
    return models;
  }

  return MOCK_MODELS;
}

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

/**
 * AGENTS.md panel fixture (012 T118), driven by `?agents=`. Default mirrors a
 * realistic machine: global file missing, root file present, two subdirs with
 * files; `?agents=none` strips everything (root exists=false); `?agents=deep`
 * adds a nested directory. Order = pi's load order (global → root → subdirs).
 */
function agentsListFixture(knob: string | null | undefined): {
  ok: boolean;
  agentDir: string;
  candidates: string[];
  entries: Array<{
    scope: string;
    dir: string;
    relativePath?: string;
    fileName: string;
    path: string;
    exists: boolean;
    priority: number;
  }>;
} {
  const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const entries: AgentsEntryShape[] = [
    {
      scope: "global",
      dir: "/tmp/mock-home/.pi/agent",
      fileName: "AGENTS.md",
      path: "/tmp/mock-home/.pi/agent/AGENTS.md",
      exists: knob === "deep" || knob === "none" ? false : true,
      priority: 0,
    },
    {
      scope: "root",
      dir: "/tmp/mock-project",
      fileName: "AGENTS.md",
      path: "/tmp/mock-project/AGENTS.md",
      exists: knob !== "none",
      priority: 1,
    },
  ];
  if (knob !== "none") {
    entries.push(
      {
        scope: "subdirectory",
        dir: "/tmp/mock-project/packages/web",
        relativePath: "packages/web",
        fileName: "AGENTS.md",
        path: "/tmp/mock-project/packages/web/AGENTS.md",
        exists: true,
        priority: 2,
      },
      {
        scope: "subdirectory",
        dir: "/tmp/mock-project/packages/web/src",
        relativePath: "packages/web/src",
        fileName: "AGENTS.md",
        path: "/tmp/mock-project/packages/web/src/AGENTS.md",
        exists: knob === "deep",
        priority: 3,
      },
    );
  }
  return { ok: true, agentDir: "/tmp/mock-home/.pi/agent", candidates, entries };
}

type AgentsEntryShape = {
  scope: string;
  dir: string;
  relativePath?: string;
  fileName: string;
  path: string;
  exists: boolean;
  priority: number;
};
