/**
 * Wire types for the Java bridge envelope protocol.
 *
 * JS → Java request : { t: method, id: reqId, p: params }
 * Java → JS response: { t: "resp", id: reqId, ok: boolean, data? , error? }
 * Java → JS event   : { t: "event", name: eventName, data }
 */

export type BridgeEventName = "pi" | "pi-state" | "ide" | "theme" | "queue";

/**
 * Every method the Java side dispatches (keep in sync with
 * `BridgeService.dispatch`). Typing the name here makes a typo in a caller a
 * compile error instead of a runtime "unknown bridge method".
 */
export type BridgeMethod =
  | "ping"
  | "env"
  | "rpc.request"
  | "rpc.restart"
  | "sessions.list"
  | "sessions.search"
  | "sessions.delete"
  | "sessions.exportHtml"
  | "files.list"
  | "ide.repaint"
  | "ide.openFile"
  | "ide.showFileDiff"
  | "ide.openTerminal"
  | "config.getLastModel"
  | "config.setLastModel"
  | "config.getPrefs"
  | "config.setPrefs"
  | "approval.getPolicy"
  | "approval.setPolicy"
  | "manage.env"
  | "manage.envDetect"
  | "manage.envInstall"
  | "manage.envCancelInstall"
  | "manage.envSetPath"
  | "manage.mcpList"
  | "manage.mcpAdd"
  | "manage.mcpRemove"
  | "manage.mcpLogin"
  | "manage.mcpLogout"
  | "manage.mcpSetEnabled"
  | "manage.packagesList"
  | "manage.packageInstall"
  | "manage.packageRemove"
  | "manage.packageUpdate"
  | "manage.envUpdate"
  | "manage.modelsReadProvider"
  | "manage.modelsOpenFile"
  | "manage.agentsList"
  | "manage.agentsOpen"
  | "manage.agentsCreate"
  | "manage.skillsList"
  | "manage.skillCreate"
  | "manage.authOverview"
  | "manage.authCheck"
  | "manage.authSet"
  | "manage.authDelete"
  | "manage.providerSetKey"
  | "manage.settingsRead"
  | "manage.settingsWrite"
  | "trust.get"
  | "trust.grant"
  | "trust.revoke"
  | "queue.get"
  | "queue.enqueue"
  | "queue.move"
  | "queue.remove"
  | "queue.restore"
  | "queue.promote"
  | "queue.pause"
  | "queue.resume"
  | "queue.clear";

export type AppTheme = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";

export interface EnvInfo {
  projectName: string;
  projectPath: string;
  theme: AppTheme;
  editorFontFamily: string;
  /** IDE language (Locale.getDefault().language), e.g. "en" / "zh" (008). */
  locale?: string;
}

export interface ThemeEventData {
  theme: AppTheme;
}

export interface PiStateEvent {
  status: "notStarted" | "starting" | "running" | "exited";
  version?: string;
  message?: string;
  stderr?: string;
}

export interface Bridge {
  readonly kind: "jcef" | "mock";
  /** [timeoutMs] overrides the default deadline; 0 waits indefinitely. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  onEvent(listener: (name: BridgeEventName, data: unknown) => void): void;
}

/** Send an rpc command through the bridge and unwrap the pi response. */
export async function rpc<T = unknown>(
  bridge: Bridge,
  command: Record<string, unknown>,
): Promise<T> {
  const resp = await bridge.request<{ command?: string; success?: boolean; data?: T; error?: string }>(
    "rpc.request",
    { command },
  );
  if (!resp.success) {
    throw new Error(resp.error ?? "rpc command failed");
  }
  return resp.data as T;
}
