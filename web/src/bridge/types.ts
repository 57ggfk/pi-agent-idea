/**
 * Wire types for the Java bridge envelope protocol.
 *
 * JS → Java request : { t: method, id: reqId, p: params }
 * Java → JS response: { t: "resp", id: reqId, ok: boolean, data? , error? }
 * Java → JS event   : { t: "event", name: eventName, data }
 */

export type BridgeEventName = "pi" | "pi-state";

export interface EnvInfo {
  projectName: string;
  projectPath: string;
  theme: "light" | "dark";
  editorFontFamily: string;
}

export interface PiStateEvent {
  status: "notStarted" | "starting" | "running" | "exited";
  version?: string;
  message?: string;
  stderr?: string;
}

export interface Bridge {
  readonly kind: "jcef" | "mock";
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
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
