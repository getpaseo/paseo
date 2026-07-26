import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, desktopState, inputState } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { sm: 13, base: 15 },
    fontWeight: { medium: "500" },
    borderRadius: { lg: 8 },
    colors: { surface2: "#222", foreground: "#fff", foregroundMuted: "#aaa" },
  },
  inputState: { onChangeText: null as ((v: string) => void) | null },
  desktopState: {
    handlers: [] as ((payload: unknown) => void)[],
    submitted: [] as { requestId: string; secret: string | null }[],
    unsubscribed: 0,
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onPress,
      testID,
    }: {
      children: React.ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      ReactModule.createElement(
        "button",
        { type: "button", "data-testid": testID, onClick: onPress },
        children,
      ),
  };
});

vi.mock("./adaptive-modal-sheet", async () => {
  const ReactModule = await import("react");
  return {
    AdaptiveModalSheet: ({
      visible,
      header,
      children,
      testID,
    }: {
      visible: boolean;
      header: { title: string };
      children: React.ReactNode;
      testID?: string;
    }) =>
      visible
        ? ReactModule.createElement(
            "div",
            { "data-testid": testID, "data-title": header.title },
            children,
          )
        : null,
    AdaptiveTextInput: (props: Record<string, unknown>) => {
      const p = props as { testID?: string; onChangeText?: (v: string) => void; value?: string };
      inputState.onChangeText = p.onChangeText ?? null;
      return ReactModule.createElement("input", {
        "data-testid": p.testID,
        readOnly: true,
        value: p.value ?? "",
      });
    },
  };
});

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    events: {
      on: (_event: string, handler: (payload: unknown) => void) => {
        desktopState.handlers.push(handler);
        return Promise.resolve(() => {
          desktopState.unsubscribed += 1;
        });
      },
    },
    ssh: {
      submitPassword: (payload: { requestId: string; secret: string | null }) => {
        desktopState.submitted.push(payload);
        return Promise.resolve();
      },
    },
  }),
}));

import { SshPasswordPromptHost } from "./ssh-password-prompt-host";

let dom: JSDOM;
let container: HTMLElement;
let root: Root;

function emit(payload: unknown): void {
  act(() => {
    for (const handler of desktopState.handlers) handler(payload);
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

beforeEach(async () => {
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>");
  // JSX compiles to React.createElement in this setup, so component modules
  // resolve React from the global — same as the other component tests here.
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  desktopState.handlers.length = 0;
  desktopState.submitted.length = 0;
  desktopState.unsubscribed = 0;
  inputState.onChangeText = null;
  container = dom.window.document.getElementById("root") as HTMLElement;
  root = createRoot(container);
  // Mount with no add-host flow in sight — this component lives at the app
  // root precisely so a prompt can arrive at any time.
  await act(async () => {
    root.render(React.createElement(SshPasswordPromptHost));
  });
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SshPasswordPromptHost", () => {
  it("renders nothing until SSH actually asks for something", () => {
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("shows a prompt that arrives outside any add-host flow", () => {
    emit({
      requestId: "r1",
      host: "server.example.com",
      prompt: "alice@server.example.com's password:",
      kind: "password",
    });

    const modal = query("ssh-password-prompt");
    expect(modal).not.toBeNull();
    // SSH's own prompt is shown verbatim: it names the host or the key file.
    expect(modal?.textContent).toContain("alice@server.example.com's password:");
    expect(modal?.getAttribute("data-title")).toBe("pairing.ssh.prompt.password");
  });

  it("titles a key passphrase differently from an account password", () => {
    emit({
      requestId: "r1",
      host: "h",
      prompt: "Enter passphrase for key '/home/a/.ssh/id_ed25519':",
      kind: "passphrase",
    });
    expect(query("ssh-password-prompt")?.getAttribute("data-title")).toBe(
      "pairing.ssh.prompt.passphrase",
    );
  });

  it("returns the typed secret to the waiting ssh process", () => {
    emit({ requestId: "r1", host: "h", prompt: "p", kind: "password" });
    act(() => {
      inputState.onChangeText?.("hunter2");
    });
    act(() => {
      (query("ssh-password-submit") as HTMLElement).click();
    });

    expect(desktopState.submitted).toEqual([{ requestId: "r1", secret: "hunter2" }]);
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("reports a declined prompt as a null secret", () => {
    emit({ requestId: "r1", host: "h", prompt: "p", kind: "password" });
    act(() => {
      (query("ssh-password-cancel") as HTMLElement).click();
    });

    // Null is what aborts the attempt; an empty string would be tried as a
    // password and SSH would simply ask again.
    expect(desktopState.submitted).toEqual([{ requestId: "r1", secret: null }]);
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("ignores malformed events instead of opening an empty prompt", () => {
    emit({ nope: true });
    emit(null);
    expect(query("ssh-password-prompt")).toBeNull();
  });

  it("does not drop a second prompt that arrives while the first is open", () => {
    // Two hosts reconnecting at once is normal at startup: ensureConnectedAll
    // fans out over every controller.
    emit({ requestId: "r1", host: "one", prompt: "one's password:", kind: "password" });
    emit({ requestId: "r2", host: "two", prompt: "two's password:", kind: "password" });

    act(() => {
      (query("ssh-password-cancel") as HTMLElement).click();
    });
    // Answering the first must not strand the second: ssh is blocked on it and
    // would sit there until the channel's timeout.
    expect(query("ssh-password-prompt")).not.toBeNull();
    expect(query("ssh-password-prompt")?.textContent).toContain("two's password:");

    act(() => {
      (query("ssh-password-cancel") as HTMLElement).click();
    });
    expect(desktopState.submitted.map((s) => s.requestId)).toEqual(["r1", "r2"]);
  });
});
