import { afterEach, describe, expect, it } from "vitest";
import { isMessageInputTargetEmpty, resolveKeyboardFocusScope } from "./focus-scope";

const mountedRoots: HTMLElement[] = [];

function mountElement<T extends HTMLElement>(element: T): T {
  document.body.appendChild(element);
  mountedRoots.push(element);
  return element;
}

afterEach(() => {
  while (mountedRoots.length > 0) {
    mountedRoots.pop()?.remove();
  }
});

describe("resolveKeyboardFocusScope (browser DOM)", () => {
  it("resolves terminal scope from direct target and activeElement inside terminal containers", () => {
    const surface = mountElement(document.createElement("div"));
    surface.setAttribute("data-testid", "terminal-surface");
    const textarea = document.createElement("textarea");
    surface.appendChild(textarea);

    expect(
      resolveKeyboardFocusScope({
        target: textarea,
        commandCenterOpen: false,
      }),
    ).toBe("terminal");

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    expect(
      resolveKeyboardFocusScope({
        target: null,
        commandCenterOpen: false,
      }),
    ).toBe("terminal");

    const xtermRoot = mountElement(document.createElement("div"));
    xtermRoot.className = "xterm";
    const xtermInput = document.createElement("textarea");
    xtermRoot.appendChild(xtermInput);

    expect(
      resolveKeyboardFocusScope({
        target: xtermInput,
        commandCenterOpen: false,
      }),
    ).toBe("terminal");
  });

  it("resolves message-input, editable, and command-center scopes from real DOM elements", () => {
    const composerRoot = mountElement(document.createElement("div"));
    composerRoot.setAttribute("data-testid", "message-input-root");
    const composerTextarea = document.createElement("textarea");
    composerRoot.appendChild(composerTextarea);

    expect(
      resolveKeyboardFocusScope({
        target: composerTextarea,
        commandCenterOpen: false,
      }),
    ).toBe("message-input");

    const genericInput = mountElement(document.createElement("input"));
    const genericTextarea = mountElement(document.createElement("textarea"));
    const editableDiv = mountElement(document.createElement("div"));
    editableDiv.contentEditable = "true";

    for (const element of [genericInput, genericTextarea, editableDiv]) {
      expect(
        resolveKeyboardFocusScope({
          target: element,
          commandCenterOpen: false,
        }),
      ).toBe("editable");
      expect(
        resolveKeyboardFocusScope({
          target: element,
          commandCenterOpen: true,
        }),
      ).toBe("command-center");
    }

    genericInput.focus();
    expect(document.activeElement).toBe(genericInput);
    expect(
      resolveKeyboardFocusScope({
        target: null,
        commandCenterOpen: false,
      }),
    ).toBe("editable");

    const panel = mountElement(document.createElement("div"));
    panel.setAttribute("data-testid", "command-center-panel");
    const panelButton = document.createElement("button");
    panel.appendChild(panelButton);
    expect(
      resolveKeyboardFocusScope({
        target: panelButton,
        commandCenterOpen: true,
      }),
    ).toBe("command-center");
  });
});

describe("isMessageInputTargetEmpty (browser DOM)", () => {
  it("reports emptiness for textarea and contentEditable composer controls and rejects non-composer inputs", () => {
    const composerRoot = mountElement(document.createElement("div"));
    composerRoot.setAttribute("data-testid", "message-input-root");

    const emptyTextarea = document.createElement("textarea");
    emptyTextarea.value = "";
    composerRoot.appendChild(emptyTextarea);
    expect(isMessageInputTargetEmpty(emptyTextarea)).toBe(true);

    emptyTextarea.focus();
    expect(document.activeElement).toBe(emptyTextarea);
    expect(isMessageInputTargetEmpty(null)).toBe(true);

    emptyTextarea.value = " ";
    expect(isMessageInputTargetEmpty(emptyTextarea)).toBe(false);

    emptyTextarea.value = "draft";
    expect(isMessageInputTargetEmpty(emptyTextarea)).toBe(false);

    const emptyEditable = document.createElement("div");
    emptyEditable.contentEditable = "true";
    emptyEditable.textContent = "";
    composerRoot.appendChild(emptyEditable);
    expect(isMessageInputTargetEmpty(emptyEditable)).toBe(true);

    emptyEditable.textContent = "draft";
    expect(isMessageInputTargetEmpty(emptyEditable)).toBe(false);

    const nonComposerTextarea = mountElement(document.createElement("textarea"));
    nonComposerTextarea.value = "";
    expect(isMessageInputTargetEmpty(nonComposerTextarea)).toBe(false);
  });
});
