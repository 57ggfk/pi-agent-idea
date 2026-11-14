import { rpc } from "./bridge/types";
import type { Bridge, BridgeMethod } from "./bridge/types";

export interface CliOutcome {
  ok: boolean;
  error?: string;
  output?: string;
  exitCode?: number;
}

/** Where a resource lives: the user's pi dir, or this project. */
export type Scope = "user" | "project";

export interface ProjectResource {
  type: "skills" | "mcp" | "settings" | "extensions";
  /** Human label from the backend; falls back to [type] in the UI. */
  label?: string;
  scope: Scope;
  /** False while the project is untrusted: the files exist but pi ignores them. */
  active: boolean;
  path?: string;
  reason?: string;
}

export interface TrustState {
  /** False when trust.json exists but cannot be parsed. */
  ok: boolean;
  error?: string;
  trusted: boolean;
  /** Normalised project path, for display only. */
  path: string;
  /** Absolute path of trust.json. */
  store?: string;
  /** False on a first run: no trust.json yet is not an error. */
  exists?: boolean;
  resources?: ProjectResource[];
}

export interface TrustWriteResult extends CliOutcome {
  trusted?: boolean;
  path?: string;
  /** True when a pi process is already running with the old trust state. */
  restartRequired?: boolean;
}

export interface McpServerInfo {
  name?: string;
  /**
   * Effective state, as pi resolved it: a project entry overrides a user-level
   * one, so this is not simply the value in `mcp.json`.
   */
  enabled?: boolean;
  state?: string;
  /** `global` (the user file) or `project` (`.pi/mcp.json`). */
  scope?: string;
  /** File that defines the server. */
  source?: string;
  /** Set when a project entry overrides a user-level server. */
  override?: string;
  transport?: string;
  tools?: unknown[];
  error?: string;
  [key: string]: unknown;
}

export interface McpListResult extends CliOutcome {
  raw?: { servers?: McpServerInfo[]; errors?: unknown[]; note?: string };
  text?: string;
}

export interface McpSetEnabledResult extends CliOutcome {
  name?: string;
  scope?: string;
  enabled?: boolean;
  /**
   * The write landed but another layer still decides the effective value
   * (e.g. a project override keeps a user-level server running here).
   */
  warning?: string;
}

/** One configured package, structured from `pi list` output (033 FR-001/FR-002). */
export interface PackageEntry {
  source: string;
  /** "user" | "project" — the section header pi printed, lowercased. */
  scope: string;
  /** Resolved install path; absent = declared but not installed / files missing. */
  path?: string;
  /** From the path's package.json; absent = unknown (unreadable or broken). */
  version?: string;
  /** Source line without a path line (probe P13/P18): offer a reinstall. */
  broken: boolean;
}

export interface PackagesListResult extends CliOutcome {
  entries?: PackageEntry[];
}

/**
 * One-shot version check (033 FR-003). `state` is the three-way verdict;
 * `reason` explains an "unknown": offline | auth | not-found | bad-response |
 * git-ref | local.
 */
export interface PackageCheckResult extends CliOutcome {
  source?: string;
  installed?: string;
  latest?: string;
  state?: "up-to-date" | "upgradable" | "unknown";
  reason?: string;
}

/** One gallery card from the npm `pi-package` search (033 FR-006). */
export interface MarketPackage {
  name: string;
  version: string;
  description: string;
  author: string;
  downloads: number;
  updated: string;
  badges: string[];
  linkNpm: string;
  linkRepo: string;
}

export interface MarketSearchResult extends CliOutcome {
  total?: number;
  page?: number;
  pageSize?: number;
  /** True when the registry ignored the `keywords:` filter (npmmirror, P19). */
  degraded?: boolean;
  packages?: MarketPackage[];
  /** Set with ok:false: offline | auth | unavailable (endpoint missing). */
  code?: "offline" | "auth" | "unavailable";
}

/** `pi update` reports the outcome itself; the plugin only relays it. */
export interface EnvUpdateResult extends CliOutcome {
  /** Version after the update, re-read from the located binary. */
  version?: string;
}

export interface ProviderInfoResult extends CliOutcome {
  name?: string;
  /** Absolute path of models.json. */
  path?: string;
  /** True when models.json does not exist (nothing configured yet). */
  missing?: boolean;
  /** Provider entry with every sensitive value replaced by a boolean. */
  config?: Record<string, unknown>;
}

export interface ModelsOpenResult extends CliOutcome {
  path?: string;
  /** True when the file did not exist and the skeleton was just created. */
  created?: boolean;
}

// -- 027: custom provider definition ------------------------------------------

export interface CustomProviderModel {
  id: string;
  name?: string;
  reasoning: boolean;
  inputImage: boolean;
  /** Levels the model supports (pi's thinkingLevelMap, value != null). */
  thinkingLevels: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderPayload {
  name: string;
  displayName?: string;
  api: string;
  baseUrl: string;
  /** Omitted/blank on edit = keep the stored key (it never comes back). */
  apiKey?: string;
  thinkingFormat?: string;
  models: CustomProviderModel[];
}

export interface CustomProviderGetResult extends CliOutcome {
  exists?: boolean;
  name?: string;
  path?: string;
  provider?: {
    name: string;
    displayName?: string;
    baseUrl?: string;
    api?: string;
    models: CustomProviderModel[];
    hasKey: boolean;
    keyMasked: string | null;
  };
}

export interface CustomProviderSaveResult extends CliOutcome {
  name?: string;
  path?: string;
  /** Refusal code: "builtin" | "exists" | "badName" | "badApi" | "badUrl" | … */
  code?: string;
  /** False = the write landed but the 017 reload failed (restart to apply). */
  reloaded?: boolean;
  reloadError?: string;
}

export interface CustomProviderTestResult extends CliOutcome {
  status?: number;
  ms?: number;
}

/** One AGENTS.md location pi loads (012 US3); order = pi's load order. */
export interface AgentsEntry {
  /** "global" (agent dir) | "root" (project root) | "subdirectory". */
  scope: string;
  dir: string;
  relativePath?: string;
  /** The candidate that wins in this directory (pi's per-dir order). */
  fileName: string;
  path: string;
  exists: boolean;
  /** pi's load order rank: global 0, root 1, deeper subdirs 2+. */
  priority: number;
}

export interface AgentsListResult extends CliOutcome {
  agentDir?: string;
  candidates?: string[];
  entries?: AgentsEntry[];
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  /** User skills always load; project skills only when the project is trusted. */
  scope: Scope;
  disableModelInvocation: boolean;
}

export interface AuthOverviewResult extends CliOutcome {
  providers?: string[];
  withCredentials?: string[];
  /** auth.json entry types per provider ("oauth" | "api_key"); untyped/unknown entries omitted. */
  credentialTypes?: Record<string, string>;
  /** "ok" | "missing" | "corrupt" — drives the Auth panel's models.json notice. */
  modelsState?: string;
  modelsPath?: string;
  modelsError?: string;
}

/**
 * One pi AuthEvent mirrored through the `auth` bridge event (spec 014).
 * info/auth_url/device_code/progress — exactly pi's wire shape, so the UI
 * stays forward-compatible with new providers.
 */
export interface AuthLoginEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
}

/** One interaction.prompt from the helper (text/secret/select/manual_code). */
export interface AuthLoginPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

/** The `data` of an `auth` bridge event. */
export interface AuthLoginEventData {
  kind: "started" | "event" | "prompt" | "done";
  provider?: string;
  ev?: AuthLoginEvent;
  /** Set by the backend when it opened the system browser for the URL. */
  browserOpened?: boolean;
  id?: number;
  p?: AuthLoginPrompt;
  ok?: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface EnvironmentResult extends CliOutcome {
  found?: boolean;
  path?: string;
  version?: string;
  agentDir?: string;
}

/** One detected tool: node, npm or pi. */
export interface ToolStatus {
  found: boolean;
  path: string;
  version: string;
}

/** npm registry offered during first-run setup. */
export interface InstallSourceInfo {
  id: string;
  registry: string;
}

/**
 * First-run environment report. Detection only reports; installing is a
 * separate, explicit call so the user always sees what will be touched.
 */
export interface EnvDetectResult extends CliOutcome {
  node?: ToolStatus;
  npm?: ToolStatus;
  pi?: ToolStatus;
  nodeMajor?: number | null;
  nodeOk?: boolean;
  minNodeMajor?: number;
  // 028: the corrected gate and its presentation fields.
  nodeVersion?: string;
  minNode?: string;
  /** "no-node" | "node-version" | "no-npm" — why the npm install is off. */
  installBlocker?: string;
  scriptSupported?: boolean;
  /** False when node is missing or below 22.19: the manual path is the only option. */
  canInstall?: boolean;
  piPackage?: string;
  agentDir?: string;
  customPath?: string;
  sources?: InstallSourceInfo[];
  defaultSource?: string;
  /** Id of the "paste your own registry" option; the URL travels separately. */
  customSource?: string;
  /** `npm config get registry` — what "npm default" would actually use. */
  npmRegistry?: string;
  /** True when pi itself is missing — the setup card keys off this. */
  needsSetup?: boolean;
}

export interface EnvInstallResult extends CliOutcome {
  /** True when the user pressed Stop; carries partial output, not a failure. */
  cancelled?: boolean;
  found?: boolean;
  path?: string;
  version?: string;
  registry?: string;
}

export interface SettingsReadResult extends CliOutcome {
  path?: string;
  text?: string;
}

/** 032: what the IDE would append to pi's system prompt this turn (Q6-b). */
export interface EnvSnapshotResult extends CliOutcome {
  enabled?: boolean;
  collectedAt?: string;
  text?: string;
  file?: string;
}

/** Typed helpers over the bridge for management operations. */
export function manageApi(bridge: Bridge) {
  const call = <T>(method: BridgeMethod, params?: unknown, timeoutMs?: number) =>
    bridge.request<T>(method, params, timeoutMs) as Promise<T>;

  return {
    environment: () => call<EnvironmentResult>("manage.env"),
    envDetect: () => call<EnvDetectResult>("manage.envDetect"),
    /** No deadline: the user stops this one with [envCancelInstall]. */
    envInstall: (p: { source?: string; registry?: string; method?: "script" }) =>
      call<EnvInstallResult>("manage.envInstall", p, 0),
    envCancelInstall: () => call<{ ok: boolean; cancelled?: boolean; error?: string }>("manage.envCancelInstall"),
    envSetPath: (p: { path: string }) => call<EnvInstallResult>("manage.envSetPath", p),
    /** 028: the explicit Node interpreter; empty clears back to discovery. */
    envSetNodePath: (p: { path: string }) => call<EnvInstallResult>("manage.envSetNodePath", p),
    mcpList: () => call<McpListResult>("manage.mcpList"),
    mcpAdd: (p: { name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; local?: boolean }) =>
      call<CliOutcome>("manage.mcpAdd", p),
    mcpRemove: (p: { name: string; local?: boolean }) => call<CliOutcome>("manage.mcpRemove", p),
    mcpLogin: (p: { name: string }) => call<CliOutcome>("manage.mcpLogin", p),
    mcpLogout: (p: { name: string }) => call<CliOutcome>("manage.mcpLogout", p),
    /**
     * Enables or disables a server without touching its configuration: pi keeps
     * the entry and honours `enabled: false` (there is no `mcp disable` command).
     */
    mcpSetEnabled: (p: { name: string; scope: string; enabled: boolean }) =>
      call<McpSetEnabledResult>("manage.mcpSetEnabled", p),
    /**
     * 033: the explicit registry override travels with the network-touching
     * calls; empty/absent = "follow npm config" (the backend resolves the
     * chain and never rewrites .npmrc).
     */
    packagesList: () => call<PackagesListResult>("manage.packagesList"),
    packageInstall: (p: { source: string; registry?: string }) => call<CliOutcome>("manage.packageInstall", p),
    packageRemove: (p: { source: string }) => call<CliOutcome>("manage.packageRemove", p),
    packageCheck: (p: { source: string; registry?: string }) => call<PackageCheckResult>("manage.packageCheck", p),
    marketSearch: (p: { query?: string; page?: number; pageSize?: number; registry?: string; type?: string }) =>
      call<MarketSearchResult>("manage.marketSearch", p),
    packageUpdateAll: (p?: { registry?: string }) => call<CliOutcome>("manage.packageUpdateAll", p ?? {}),
    prefsGet: () =>
      call<{ autoRetry?: boolean; theme?: string; language?: string; registryOverride?: string }>("config.getPrefs"),
    prefsSet: (p: { registryOverride?: string | null }) => call<{ ok: boolean }>("config.setPrefs", p),
    envUpdate: () => call<EnvUpdateResult>("manage.envUpdate"),
    modelsReadProvider: (p: { name: string }) => call<ProviderInfoResult>("manage.modelsReadProvider", p),
    /** 027: custom provider definition (models.json form). The key never
     *  crosses back; providerGet answers with hasKey + a mask only. */
    providerGet: (p: { name: string }) => call<CustomProviderGetResult>("manage.providerGet", p),
    providerSave: (p: { provider: CustomProviderPayload; overwrite?: boolean }) =>
      call<CustomProviderSaveResult>("manage.providerSave", p),
    providerDelete: (p: { name: string }) => call<CliOutcome & { name?: string }>("manage.providerDelete", p),
    providerTest: (p: { baseUrl: string; api: string; apiKey?: string }) =>
      call<CustomProviderTestResult>("manage.providerTest", p),
    modelsOpenFile: (p: { provider: string }) => call<ModelsOpenResult>("manage.modelsOpenFile", p),
    /** Forces a full JCEF frame repaint (OSR frame-lag workaround, 0.5.4
     *  real-machine find): call after view-level DOM swaps. */
    repaint: () => call<{ ok: boolean }>("ide.repaint"),
    agentsList: () => call<AgentsListResult>("manage.agentsList"),
    /** Writes a provider credential. Responses carry the provider name only —
     *  the key material never crosses the bridge (012 T127). */
    authSet: (p: { provider: string; key: string }) => call<CliOutcome & { provider?: string }>("manage.authSet", p),
    /** spec 014: browser OAuth through the pi-login helper (one at a time). */
    authLoginStart: (p: { provider: string }) =>
      call<CliOutcome & { provider?: string }>("manage.authLoginStart", p),
    authLoginAnswer: (p: { id: number; value: string }) => call<CliOutcome>("manage.authLoginAnswer", p),
    authLoginCancel: () => call<CliOutcome & { wasActive?: boolean }>("manage.authLoginCancel"),
    authDelete: (p: { provider: string }) => call<CliOutcome & { provider?: string }>("manage.authDelete", p),
    providerSetKey: (p: { provider: string; key: string }) =>
      call<CliOutcome & { provider?: string }>("manage.providerSetKey", p),
    agentsOpen: (p: { path: string }) => call<CliOutcome>("manage.agentsOpen", p),
    agentsCreate: (p: { path: string }) => call<ModelsOpenResult>("manage.agentsCreate", p),
    skillsList: () => call<{ ok: boolean; skills: SkillInfo[] }>("manage.skillsList"),
    skillCreate: (p: { name: string; description: string; body?: string }) => call<CliOutcome>("manage.skillCreate", p),
    authOverview: () => call<AuthOverviewResult>("manage.authOverview"),
    /**
     * Opens an IDE terminal and runs [command] there (013 US2). The backend
     * reports which path it took: `typed` = executed in a fresh terminal
     * session, `ok` without `typed` = terminal activated and the command
     * copied to the clipboard (user pastes it), `ok:false` = both failed.
     */
    openTerminal: (p: { command: string }) =>
      call<{ ok: boolean; typed?: boolean; error?: string }>("ide.openTerminal", p),
    authCheck: (p: { provider: string }) => call<{ ok: boolean; status: string; detail?: unknown }>("manage.authCheck", p),
    settingsRead: () => call<SettingsReadResult>("manage.settingsRead"),
    settingsWrite: (p: { text: string }) => call<CliOutcome>("manage.settingsWrite", p),
    // 032 Q6-b: read-only view of the environment snapshot; the call also
    // refreshes it, so what the user sees is what the next turn injects.
    envSnapshot: () => call<EnvSnapshotResult>("manage.envSnapshot"),
    trustGet: () => call<TrustState>("trust.get"),
    // `confirmed` is mandatory: an unconfirmed write must be refused by the
    // backend, not merely hidden in the UI.
    trustGrant: () => call<TrustWriteResult>("trust.grant", { confirmed: true }),
    trustRevoke: () => call<TrustWriteResult>("trust.revoke", { confirmed: true }),
  };
}

/** Runs an rpc command (e.g. after config changes, to reload the process). */
export async function restartPiProcess(bridge: Bridge): Promise<void> {
  try {
    await rpc(bridge, { type: "get_state" });
  } catch {
    // the process manager restarts on demand
  }
}
