import { userEvent } from "@vitest/browser/context";
import React from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import "@/styles/unistyles";
import { SettingsTextArea } from "./settings-textarea";

interface Mounted {
  host: HTMLDivElement;
  root: Root;
  getValue: () => string;
  extraNodes?: HTMLElement[];
}

const mounted: Mounted[] = [];

function flush(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitFor<T>(predicate: () => T | null | undefined, timeoutMs = 4000): Promise<T> {
  const start = performance.now();
  let value = predicate();
  while (!value) {
    if (performance.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
    await flush();
    value = predicate();
  }
  return value;
}

function mount(): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  let current = "";
  const Harness = () => {
    const [value, setValue] = React.useState("");
    current = value;
    return React.createElement(SettingsTextArea, {
      accessibilityLabel: "Append system prompt",
      value,
      onChangeText: setValue,
      testID: "settings-textarea",
    });
  };

  root.render(React.createElement(Harness));
  const result: Mounted = { host, root, getValue: () => current };
  mounted.push(result);
  return result;
}

// Portals the field outside the React root container, like AdaptiveModalSheet's
// overlay root — where RN-Web's delegated onChange misses native input events
// (Electron's Cmd+V paste). Regression guard for #1602.
function mountInOverlayPortal(): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const overlay = document.createElement("div");
  document.body.appendChild(overlay);
  const root = createRoot(host);

  let current = "";
  const Harness = () => {
    const [value, setValue] = React.useState("");
    current = value;
    return createPortal(
      React.createElement(SettingsTextArea, {
        accessibilityLabel: "Append system prompt",
        value,
        onChangeText: setValue,
        testID: "settings-textarea",
      }),
      overlay,
    );
  };

  root.render(React.createElement(Harness));
  const result: Mounted = { host, root, getValue: () => current, extraNodes: [overlay] };
  mounted.push(result);
  return result;
}

async function copyTextToClipboard(text: string): Promise<void> {
  const source = document.createElement("textarea");
  source.value = text;
  document.body.appendChild(source);
  source.focus();
  source.select();
  await userEvent.copy();
  source.remove();
}

afterEach(async () => {
  for (const m of mounted) {
    m.root.unmount();
    m.host.remove();
    for (const node of m.extraNodes ?? []) node.remove();
  }
  mounted.length = 0;
});

it("updates the value when text is pasted into the textarea", async () => {
  const { host, getValue } = mount();

  const textarea = await waitFor(() => host.querySelector("textarea"));

  await copyTextToClipboard("pasted prompt text");

  textarea.focus();
  await userEvent.paste();
  await flush();

  expect(getValue()).toBe("pasted prompt text");
});

it("updates the value when multi-line text is pasted into the textarea", async () => {
  const { host, getValue } = mount();

  const textarea = await waitFor(() => host.querySelector("textarea"));

  const multiline = "first line\nsecond line\nthird line";
  await copyTextToClipboard(multiline);

  textarea.focus();
  await userEvent.paste();
  await flush();

  expect(getValue()).toBe(multiline);
});

it("syncs the value when a native input event lands on a textarea portaled outside the React root", async () => {
  const { extraNodes, getValue } = mountInOverlayPortal();
  const overlay = extraNodes?.[0];
  if (!overlay) throw new Error("overlay not created");

  const textarea = await waitFor(() => overlay.querySelector("textarea"));

  // Electron's menu paste: DOM value changes + native input event React misses.
  textarea.value = "pasted via electron menu";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();

  expect(getValue()).toBe("pasted via electron menu");
});

it("does not push the in-progress value during IME composition", async () => {
  const { extraNodes, getValue } = mountInOverlayPortal();
  const overlay = extraNodes?.[0];
  if (!overlay) throw new Error("overlay not created");

  const textarea = await waitFor(() => overlay.querySelector("textarea"));

  // Mid-composition input events must not sync; only the committed value should.
  textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  textarea.value = "ni";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  expect(getValue()).toBe("");

  textarea.value = "你好";
  textarea.dispatchEvent(new Event("compositionend", { bubbles: true }));
  await flush();
  expect(getValue()).toBe("你好");
});
