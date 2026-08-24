/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMouseNavigationButtons } from "./use-mouse-navigation-buttons";

const electronState = vi.hoisted(() => ({ isElectron: true }));
const navState = vi.hoisted(() => ({
  pathname: "/welcome",
  pushCalls: [] as string[],
  workspaceCalls: [] as Array<{ serverId: string; workspaceId: string }>,
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  getIsElectron: () => electronState.isElectron,
}));

vi.mock("expo-router", () => ({
  usePathname: () => navState.pathname,
  useRouter: () => ({
    push: (route: string) => {
      navState.pushCalls.push(route);
    },
  }),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: (input: { serverId: string; workspaceId: string }) => {
    navState.workspaceCalls.push(input);
    return `${input.serverId}/${input.workspaceId}`;
  },
}));

function press(button: number): { downDefaultPrevented: boolean; upDefaultPrevented: boolean } {
  // jsdom lacks PointerEvent; the handlers only read .button, so a MouseEvent
  // dispatched under the pointerdown/pointerup type is enough.
  const down = new MouseEvent("pointerdown", { button, cancelable: true });
  const up = new MouseEvent("pointerup", { button, cancelable: true });
  window.dispatchEvent(down);
  window.dispatchEvent(up);
  return { downDefaultPrevented: down.defaultPrevented, upDefaultPrevented: up.defaultPrevented };
}

/** Wait out the tracker's settle delay so a pathname gets recorded. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
}

function renderWithPathname(pathname: string) {
  navState.pathname = pathname;
  return renderHook(() => useMouseNavigationButtons());
}

async function navigateTo(
  hook: ReturnType<typeof renderWithPathname>,
  pathname: string,
  options?: { commit?: boolean },
) {
  navState.pathname = pathname;
  hook.rerender();
  if (options?.commit !== false) {
    await settle();
  }
}

describe("useMouseNavigationButtons", () => {
  afterEach(() => {
    cleanup();
    electronState.isElectron = true;
    navState.pathname = "/welcome";
    navState.pushCalls = [];
    navState.workspaceCalls = [];
  });

  it("walks back and forward through recorded views", async () => {
    const hook = renderWithPathname("/welcome");
    await settle();
    await navigateTo(hook, "/h/srv_1/workspace/ws_1");
    await navigateTo(hook, "/settings/general");

    press(3);
    expect(navState.workspaceCalls).toEqual([{ serverId: "srv_1", workspaceId: "ws_1" }]);

    // The back navigation commits: pathname lands on the tracker target and
    // must not be re-recorded (or the forward stack would be truncated).
    await navigateTo(hook, "/h/srv_1/workspace/ws_1", { commit: false });

    press(3);
    expect(navState.pushCalls).toEqual(["/welcome"]);

    await navigateTo(hook, "/welcome", { commit: false });

    press(4);
    expect(navState.workspaceCalls).toHaveLength(2);
    await navigateTo(hook, "/h/srv_1/workspace/ws_1", { commit: false });
    press(4);
    expect(navState.pushCalls).toEqual(["/welcome", "/settings/general"]);
  });

  it("prevents the Chromium default navigation on both pointerdown and pointerup", async () => {
    renderWithPathname("/welcome");
    await settle();

    const result = press(3);

    expect(result.downDefaultPrevented).toBe(true);
    expect(result.upDefaultPrevented).toBe(true);
  });

  it("does nothing at the oldest entry", async () => {
    renderWithPathname("/welcome");
    await settle();

    press(3);

    expect(navState.workspaceCalls).toEqual([]);
    expect(navState.pushCalls).toEqual([]);
  });

  it("ignores primary, middle, and secondary buttons", async () => {
    renderWithPathname("/welcome");
    await settle();

    press(0);
    press(1);
    press(2);

    expect(navState.workspaceCalls).toEqual([]);
    expect(navState.pushCalls).toEqual([]);
  });

  it("does not record transient redirect routes", async () => {
    const hook = renderWithPathname("/");
    await settle();
    await navigateTo(hook, "/h/srv_1");
    await navigateTo(hook, "/h/srv_1/agent/agent_1");
    await navigateTo(hook, "/h/srv_1/workspace/ws_1");

    press(3);

    // "/", the host index, and the agent redirector were skipped, so the
    // first recorded view is the workspace itself and there is nowhere to go.
    expect(navState.workspaceCalls).toEqual([]);
    expect(navState.pushCalls).toEqual([]);
  });

  it("does not record pathnames that redirect away before settling", async () => {
    const hook = renderWithPathname("/open-project");
    await settle();
    // /settings immediately replaces itself with /settings/general.
    await navigateTo(hook, "/settings", { commit: false });
    await navigateTo(hook, "/settings/general");

    press(3);

    // Back goes straight to /open-project, not the /settings redirector.
    expect(navState.pushCalls).toEqual(["/open-project"]);
  });

  it("truncates the forward stack when a fresh view is visited after going back", async () => {
    const hook = renderWithPathname("/h/srv_1/workspace/ws_1");
    await settle();
    await navigateTo(hook, "/h/srv_1/workspace/ws_2");

    press(3);
    expect(navState.workspaceCalls).toEqual([{ serverId: "srv_1", workspaceId: "ws_1" }]);
    await navigateTo(hook, "/h/srv_1/workspace/ws_1", { commit: false });

    // User navigates somewhere new instead of going forward.
    await navigateTo(hook, "/h/srv_1/workspace/ws_3");

    press(4);
    expect(navState.workspaceCalls).toHaveLength(1);
    expect(navState.pushCalls).toEqual([]);
  });

  it("does not intercept the buttons in a plain browser", async () => {
    electronState.isElectron = false;
    renderWithPathname("/welcome");
    await settle();

    const result = press(3);

    expect(result.downDefaultPrevented).toBe(false);
    expect(result.upDefaultPrevented).toBe(false);
    expect(navState.workspaceCalls).toEqual([]);
    expect(navState.pushCalls).toEqual([]);
  });

  it("removes the listeners on unmount", async () => {
    const hook = renderWithPathname("/welcome");
    await settle();
    hook.unmount();

    const result = press(3);

    expect(result.downDefaultPrevented).toBe(false);
  });
});
