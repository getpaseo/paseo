// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentBrowser } from "./use-agent-browser";

const host = vi.hoisted(() => ({ local: true, supported: true, open: vi.fn(), reveal: vi.fn() }));
// Host connectivity and Electron detection are external to this hook's operation state.
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ openWorkspaceAgentBrowser: host.open }),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => host.supported }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => host.local }));
vi.mock("@/workspace-tabs/agent-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workspace-tabs/agent-browser")>()),
  openWorkspaceAgentBrowser: (...args: unknown[]) => host.reveal(...args),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
beforeEach(() => {
  host.local = true;
  host.supported = true;
  host.open.mockReset();
  host.reveal.mockReset().mockReturnValue({ ok: true });
});
afterEach(cleanup);

it("explains remote hosts and older daemons before sending an RPC", async () => {
  host.local = false;
  const { result, rerender } = renderHook(() =>
    useAgentBrowser("host", "workspace", "host:workspace"),
  );
  await act(() => result.current.open());
  expect(result.current.error).toBe("workspace.browser.agentBrowser.localOnly");
  host.local = true;
  host.supported = false;
  rerender();
  await act(() => result.current.open());
  expect(result.current.error).toBe("workspace.browser.agentBrowser.updateHost");
  expect(host.open).not.toHaveBeenCalled();
});

it("blocks double clicks, keeps a startup error and recovers on retry", async () => {
  let finish!: (result: { url: null; error: string }) => void;
  host.open.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = renderHook(() => useAgentBrowser("host", "workspace", "host:workspace"));
  let opening!: Promise<void>;
  act(() => {
    opening = result.current.open();
  });
  expect(result.current.loading).toBe(true);
  await act(() => result.current.open());
  expect(host.open).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ url: null, error: "tool_missing" });
    await opening;
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBe("workspace.browser.agentBrowser.toolMissing");
  expect(host.reveal).not.toHaveBeenCalled();
  host.open.mockResolvedValueOnce({ url: "http://127.0.0.1:1234", error: null });
  await act(() => result.current.open());
  expect(result.current.error).toBeNull();
  expect(host.reveal).toHaveBeenCalledExactlyOnceWith("host:workspace", "http://127.0.0.1:1234");
});
