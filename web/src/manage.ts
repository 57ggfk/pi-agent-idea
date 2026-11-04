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

export interface PackagesListResult extends CliOutcome {
  lines?: string[];
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
  /** "ok" | "missing" | "corrupt" — drives the Auth panel's models.json notice. */
  modelsState?: string;
  modelsPath?: string;
  modelsError?: string;
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
  /** False when node or npm is missing: the manual path is the only option. */
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

/** Typed helpers over the bridge for management operations. */
export function manageApi(bridge: Bridge) {
  const call = <T>(method: BridgeMethod, params?: unknown, timeoutMs?: number) =>
    bridge.request<T>(method, params, timeoutMs) as Promise<T>;

  return {
    environment: () => call<EnvironmentResult>("manage.env"),
    envDetect: () => call<EnvDetectResult>("manage.envDetect"),
    /** No deadline: the user stops this one with [envCancelInstall]. */
    envInstall: (p: { source: string; registry?: string }) =>
      call<EnvInstallResult>("manage.envInstall", p, 0),
    envCancelInstall: () => call<{ ok: boolean; cancelled?: boolean; error?: string }>("manage.envCancelInstall"),
    envSetPath: (p: { path: string }) => call<EnvInstallResult>("manage.envSetPath", p),
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
    packagesList: () => call<PackagesListResult>("manage.packagesList"),
    packageInstall: (p: { source: string }) => call<CliOutcome>("manage.packageInstall", p),
    packageRemove: (p: { source: string }) => call<CliOutcome>("manage.packageRemove", p),
    packageUpdate: (p: { source: string }) => call<CliOutcome>("manage.packageUpdate", p),
    envUpdate: () => call<EnvUpdateResult>("manage.envUpdate"),
    modelsReadProvider: (p: { name: string }) => call<ProviderInfoResult>("manage.modelsReadProvider", p),
    modelsOpenFile: (p: { provider: string }) => call<ModelsOpenResult>("manage.modelsOpenFile", p),
    skillsList: () => call<{ ok: boolean; skills: SkillInfo[] }>("manage.skillsList"),
    skillCreate: (p: { name: string; description: string; body?: string }) => call<CliOutcome>("manage.skillCreate", p),
    authOverview: () => call<AuthOverviewResult>("manage.authOverview"),
    authCheck: (p: { provider: string }) => call<{ ok: boolean; status: string; detail?: unknown }>("manage.authCheck", p),
    settingsRead: () => call<SettingsReadResult>("manage.settingsRead"),
    settingsWrite: (p: { text: string }) => call<CliOutcome>("manage.settingsWrite", p),
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
