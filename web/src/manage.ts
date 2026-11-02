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
  enabled?: boolean;
  state?: string;
  [key: string]: unknown;
}

export interface McpListResult extends CliOutcome {
  raw?: { servers?: McpServerInfo[]; errors?: unknown[] };
  text?: string;
}

export interface PackagesListResult extends CliOutcome {
  lines?: string[];
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
}

export interface EnvironmentResult extends CliOutcome {
  found?: boolean;
  path?: string;
  version?: string;
  agentDir?: string;
}

export interface SettingsReadResult extends CliOutcome {
  path?: string;
  text?: string;
}

/** Typed helpers over the bridge for management operations. */
export function manageApi(bridge: Bridge) {
  const call = <T>(method: BridgeMethod, params?: unknown) =>
    bridge.request<T>(method, params) as Promise<T>;

  return {
    environment: () => call<EnvironmentResult>("manage.env"),
    mcpList: () => call<McpListResult>("manage.mcpList"),
    mcpAdd: (p: { name: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; local?: boolean }) =>
      call<CliOutcome>("manage.mcpAdd", p),
    mcpRemove: (p: { name: string; local?: boolean }) => call<CliOutcome>("manage.mcpRemove", p),
    mcpLogin: (p: { name: string }) => call<CliOutcome>("manage.mcpLogin", p),
    mcpLogout: (p: { name: string }) => call<CliOutcome>("manage.mcpLogout", p),
    packagesList: () => call<PackagesListResult>("manage.packagesList"),
    packageInstall: (p: { source: string }) => call<CliOutcome>("manage.packageInstall", p),
    packageRemove: (p: { source: string }) => call<CliOutcome>("manage.packageRemove", p),
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
