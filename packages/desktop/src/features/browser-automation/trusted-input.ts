import type { ActionablePoint } from "./actionability.js";
import type { CdpCommandSender } from "./cdp-session-queue.js";

export type MouseButton = "left" | "right" | "middle";
export type InputModifier = "Alt" | "Control" | "Meta" | "Shift";

export interface ClickInputOptions {
  button?: MouseButton;
  doubleClick?: boolean;
  modifiers?: InputModifier[];
}

const MODIFIER_MASKS: Record<InputModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const SPECIAL_KEY_DEFINITIONS: Record<
  string,
  { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};

export async function dispatchTrustedClick(
  send: CdpCommandSender,
  point: ActionablePoint,
  options: ClickInputOptions = {},
): Promise<void> {
  const button = options.button ?? "left";
  const modifiers = modifierMask(options.modifiers);
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    modifiers,
  });
  if (options.doubleClick) {
    await dispatchTrustedMouseClick(send, point, button, modifiers, 1);
    await dispatchTrustedMouseClick(send, point, button, modifiers, 2);
    return;
  }
  await dispatchTrustedMouseClick(send, point, button, modifiers, 1);
}

async function dispatchTrustedMouseClick(
  send: CdpCommandSender,
  point: ActionablePoint,
  button: MouseButton,
  modifiers: number,
  clickCount: number,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button,
    buttons: mouseButtonMask(button),
    clickCount,
    modifiers,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button,
    buttons: 0,
    clickCount,
    modifiers,
  });
}

export async function dispatchTrustedHover(
  send: CdpCommandSender,
  point: ActionablePoint,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
  });
}

export async function dispatchTrustedDrag(
  send: CdpCommandSender,
  source: ActionablePoint,
  target: ActionablePoint,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: source.x,
    y: source.y,
    button: "none",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: source.x,
    y: source.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: (source.x + target.x) / 2,
    y: (source.y + target.y) / 2,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function dispatchTrustedScroll(
  send: CdpCommandSender,
  point: ActionablePoint,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX,
    deltaY,
  });
}

export async function dispatchTrustedText(send: CdpCommandSender, text: string): Promise<void> {
  if (text.length === 0) {
    return;
  }
  await send("Input.insertText", { text });
}

export async function dispatchTrustedKey(send: CdpCommandSender, key: string): Promise<void> {
  const definition = keyDefinition(key);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
    ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}),
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode,
  });
}

function keyDefinition(key: string): {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
} {
  const special = SPECIAL_KEY_DEFINITIONS[key];
  if (special) {
    return special;
  }
  const text = key.length === 1 ? key : "";
  const upper = text.toUpperCase();
  return {
    key,
    code: upper ? `Key${upper}` : key,
    windowsVirtualKeyCode: upper ? upper.charCodeAt(0) : 0,
    ...(text ? { text, unmodifiedText: text } : {}),
  };
}

function modifierMask(modifiers: InputModifier[] | undefined): number {
  return (modifiers ?? []).reduce((mask, modifier) => mask | MODIFIER_MASKS[modifier], 0);
}

function mouseButtonMask(button: MouseButton): number {
  if (button === "right") {
    return 2;
  }
  if (button === "middle") {
    return 4;
  }
  return 1;
}
