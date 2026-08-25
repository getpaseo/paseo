/**
 * Chrome DevTools Protocol input payloads, shared by every Paseo browser host.
 * The Electron host drives a `<webview>` debugger and the headless host drives a
 * remote CDP endpoint, but both speak the same `Input.*` domain, so the payload
 * shapes live here rather than in either host.
 */

export type CdpCommandSender = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export type MouseButton = "left" | "right" | "middle";
export type InputModifier = "Alt" | "Control" | "Meta" | "Shift";
export type MousePhase = "down" | "move" | "up" | "hover";

export interface CdpInputPoint {
  x: number;
  y: number;
}

export interface ClickInputOptions {
  button?: MouseButton;
  doubleClick?: boolean;
  modifiers?: InputModifier[];
}

export interface MousePhaseInputOptions {
  phase: MousePhase;
  button: MouseButton;
  clickCount: number;
  modifiers: InputModifier[];
}

const MODIFIER_MASKS: Record<InputModifier, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

const CDP_MOUSE_PHASE_TYPES: Record<MousePhase, string> = {
  down: "mousePressed",
  move: "mouseMoved",
  up: "mouseReleased",
  hover: "mouseMoved",
};

export async function dispatchTrustedClick(
  send: CdpCommandSender,
  point: CdpInputPoint,
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
  point: CdpInputPoint,
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

/**
 * One half of a mouse gesture. A viewer that owns a real pointer sends the
 * phases itself, so a press followed by moves is a drag in the guest rather
 * than the isolated click dispatchTrustedClick produces.
 */
export async function dispatchTrustedMousePhase(
  send: CdpCommandSender,
  point: CdpInputPoint,
  options: MousePhaseInputOptions,
): Promise<void> {
  // Hover and release both hold nothing; a hover also names no button, or the
  // guest starts a selection from wherever the pointer passed over.
  const isPressed = options.phase !== "up" && options.phase !== "hover";
  await send("Input.dispatchMouseEvent", {
    type: CDP_MOUSE_PHASE_TYPES[options.phase],
    x: point.x,
    y: point.y,
    button: options.phase === "hover" ? "none" : options.button,
    buttons: isPressed ? mouseButtonMask(options.button) : 0,
    clickCount: options.phase === "hover" ? 0 : options.clickCount,
    modifiers: modifierMask(options.modifiers),
  });
}

export async function dispatchTrustedHover(
  send: CdpCommandSender,
  point: CdpInputPoint,
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
  source: CdpInputPoint,
  target: CdpInputPoint,
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
  point: CdpInputPoint,
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

interface CdpControlKey {
  code: string;
  windowsVirtualKeyCode: number;
  /** Chromium hangs newline insertion and implicit form submit off the char. */
  text?: string;
}

const CDP_CONTROL_KEYS: Record<string, CdpControlKey> = {
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  End: { code: "End", windowsVirtualKeyCode: 35 },
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Home: { code: "Home", windowsVirtualKeyCode: 36 },
  PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
};

// A held Alt, Control or Meta produces a shortcut, not a character; carrying
// text as well would type into the page instead of running the shortcut.
const SHORTCUT_MODIFIER_MASK = MODIFIER_MASKS.Alt | MODIFIER_MASKS.Control | MODIFIER_MASKS.Meta;

interface CdpKeyFields {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
}

/**
 * A key press in a guest that is parked off-screen, where sendInputEvent's
 * keyDown/char/keyUp triple typed the character three times. CDP inserts the
 * character from the keyDown itself, so one press is one character while the
 * page still sees real keydown and keypress handlers run.
 */
export async function dispatchTrustedKeyEvent(
  send: CdpCommandSender,
  key: string,
  modifiers: InputModifier[] = [],
): Promise<void> {
  const fields = cdpKeyFields(key, modifierMask(modifiers));
  const isShortcut = (fields.modifiers & SHORTCUT_MODIFIER_MASK) !== 0;
  const text = CDP_CONTROL_KEYS[key]?.text ?? (key.length === 1 ? key : undefined);
  const textFields = isShortcut || text === undefined ? {} : { text };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...fields, ...textFields });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...fields });
}

function cdpKeyFields(key: string, modifiers: number): CdpKeyFields {
  const control = CDP_CONTROL_KEYS[key];
  if (control) {
    return {
      key,
      code: control.code,
      windowsVirtualKeyCode: control.windowsVirtualKeyCode,
      modifiers,
    };
  }
  if (key.length !== 1) {
    return { key, code: "", windowsVirtualKeyCode: 0, modifiers };
  }
  const upper = key.toUpperCase();
  return { key, code: printableCode(upper), windowsVirtualKeyCode: upper.charCodeAt(0), modifiers };
}

function printableCode(upperKey: string): string {
  if (upperKey >= "A" && upperKey <= "Z") {
    return `Key${upperKey}`;
  }
  if (upperKey >= "0" && upperKey <= "9") {
    return `Digit${upperKey}`;
  }
  return "";
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
