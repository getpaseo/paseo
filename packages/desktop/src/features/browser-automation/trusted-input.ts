import type { KeyboardInputEvent } from "electron";
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

export interface IsolatedKeyboardInputEvent extends KeyboardInputEvent {
  type: "char" | "keyDown" | "keyUp";
  // Electron accepts this NativeWebKeyboardEvent flag even though its public
  // TypeScript declarations omit it. It stops an unhandled webview key from
  // being redispatched to the embedder's active DOM element or application menu.
  skipIfUnhandled: true;
}

type KeyboardInputSender = (event: IsolatedKeyboardInputEvent) => void;

const ELECTRON_KEY_CODE_ALIASES: Record<string, string> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
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

export function dispatchTrustedKey(send: KeyboardInputSender, key: string): void {
  const keyCode = ELECTRON_KEY_CODE_ALIASES[key] ?? key;
  send({
    type: "keyDown",
    keyCode,
    skipIfUnhandled: true,
  });
  if (key.length === 1) {
    send({
      type: "char",
      keyCode,
      skipIfUnhandled: true,
    });
  }
  send({
    type: "keyUp",
    keyCode,
    skipIfUnhandled: true,
  });
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
