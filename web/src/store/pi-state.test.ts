import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 051: pi 的进程状态由桥接以 `pi-state` 事件推给前端。两件事在这里落地：
 *
 * 1. 退出横幅的标题要用 pi 自己的错误行（`cause`），而不是壳话
 *    「pi process closed stdout (exit code 1)」——真机：cmfc-fis 的
 *    `Unknown provider "ds"` 原本被折在「查看详情」里，用户得展开才知道
 *    该做什么。
 * 2. provider 被删时插件会改用默认模型启动，并把这件事告诉用户
 *    （`notice`）——原来只有一条红色退出横幅，用户既不知道发生了什么，
 *    也无法自救（点「重启」会拿同一份陈旧偏好再失败一次）。
 */

const h = vi.hoisted(() => {
  const state = {
    /** Registered by init(); tests dispatch bridge events through it. */
    piHandler: null as ((name: string, data: unknown) => void) | null,
  };
  const bridge = {
    kind: "mock" as const,
    request: () => Promise.resolve({}),
    onEvent(handler: (name: string, data: unknown) => void) {
      state.piHandler = handler;
    },
  };
  return { state, bridge };
});

vi.mock("../bridge", () => ({ getBridge: () => Promise.resolve(h.bridge) }));

import { usePiStore } from "./store";

function emit(data: Record<string, unknown>): void {
  h.state.piHandler?.("pi-state", data);
}

describe("pi-state: exit cause and stale-model notice", () => {
  beforeEach(async () => {
    await usePiStore.getState().init();
  });

  it("shows pi's own error line instead of the shell message", () => {
    emit({
      status: "exited",
      message: "pi process closed stdout (exit code 1)",
      cause: 'Unknown provider "ds". Use --list-models to see available providers/models.',
      stderr: 'Error: Unknown provider "ds".',
    });

    const s = usePiStore.getState();
    expect(s.piStatus).toBe("exited");
    expect(s.exitMessage).toContain('Unknown provider "ds"');
    expect(s.exitMessage).not.toContain("pi process closed stdout");
  });

  it("falls back to the shell message when there is no cause", () => {
    emit({ status: "exited", message: "pi process closed stdout (exit code 1)", stderr: "" });

    expect(usePiStore.getState().exitMessage).toBe("pi process closed stdout (exit code 1)");
  });

  it("carries the stale-model notice to the panel", () => {
    emit({
      status: "running",
      version: "1.6.0",
      notice: { kind: "staleModel", provider: "ds", model: "deepseek-flash" },
    });

    expect(usePiStore.getState().piNotice).toEqual({
      kind: "staleModel",
      provider: "ds",
      model: "deepseek-flash",
    });
  });

  it("clears the notice when a later state carries none", () => {
    emit({ status: "running", version: "1.6.0", notice: { kind: "staleModel", provider: "ds", model: "m" } });
    expect(usePiStore.getState().piNotice).not.toBeNull();

    emit({ status: "running", version: "1.6.0" });
    expect(usePiStore.getState().piNotice).toBeNull();
  });

  it("has no notice before pi reports anything", () => {
    expect(usePiStore.getState().piNotice).toBeNull();
  });
});
