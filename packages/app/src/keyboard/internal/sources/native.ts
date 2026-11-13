import { matchesKeyboardShortcutContext } from "../../keyboard-shortcuts";
import { focusSurfaces } from "../focus-surfaces";
import { overlays } from "../overlays";
import {
  nativeKeyboardInput,
  type KeyboardPolicyInput,
  type KeyboardSourceHandlers,
} from "./contract";
import type { ClaimedShortcut, HardwareKeyboardEvent } from "./hardware";
interface HardwareKeySource {
  subscribe(handler: (event: HardwareKeyboardEvent) => void): () => void;
  setOverlayKeys(keys: readonly string[]): void;
  setClaimedShortcuts(shortcuts: readonly ClaimedShortcut[]): void;
}

const DIGIT_CODES = Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`);

/**
 * The shortcuts a focused text control would otherwise type or act on.
 *
 * The native window observes every press but cannot wait for the pipeline to
 * decide, so it has to claim these keys up front: without a claim, Shift+Tab
 * cycles the agent mode and the composer also inserts a tab. Cmd and Ctrl
 * combos do not type, and the platform's own editing combos stay with the text
 * control through `editable: false`. Unmodified keys belong to overlays and the
 * composer's Return.
 */
function claimedShortcuts(
  policy: KeyboardPolicyInput | null,
  commandCenterOpen: boolean,
): ClaimedShortcut[] {
  if (!policy?.enabled) return [];
  const context = {
    isMac: policy.isMac,
    usesDesktopBindings: policy.usesDesktopBindings,
    commandCenterOpen,
    focusScope: focusSurfaces.resolve(commandCenterOpen, true),
  };
  const claimed = new Map<string, ClaimedShortcut>();
  for (const binding of policy.bindings) {
    const combo = binding.parsedChord[0];
    if (!combo || binding.preventDefault === false) continue;
    if (combo.meta || combo.ctrl || combo.mod || !(combo.shift || combo.alt)) continue;
    if (!matchesKeyboardShortcutContext(binding.when, context)) continue;
    const shift = combo.shift === true;
    const alt = combo.alt === true;
    for (const code of combo.code === "Digit" ? DIGIT_CODES : [combo.code]) {
      claimed.set(`${code}:${shift}:${alt}`, { code, shift, alt });
    }
  }
  return [...claimed.values()];
}

export function createHardwareKeyboardSource(source: HardwareKeySource) {
  let policy: KeyboardPolicyInput | null = null;
  let updateClaims = () => {};
  return {
    publishPolicy(next: KeyboardPolicyInput) {
      policy = next;
      updateClaims();
    },
    attach(handlers: KeyboardSourceHandlers): () => void {
      const updateKeys = () => source.setOverlayKeys(overlays.getKeys());
      updateClaims = () =>
        source.setClaimedShortcuts(claimedShortcuts(policy, handlers.commandCenterOpen()));
      updateKeys();
      updateClaims();
      const unsubscribeOverlays = overlays.subscribe(updateKeys);
      const unsubscribeFocus = focusSurfaces.subscribe(() => updateClaims());
      const unsubscribeCommandCenter = handlers.subscribeCommandCenter(() => updateClaims());
      const unsubscribeHardware = source.subscribe((input) => {
        const event = { ...input, preventDefault() {}, stopPropagation() {} };
        if (input.phase === "up") {
          handlers.keyUp(event);
          return;
        }
        handlers.keyDown(
          nativeKeyboardInput(event, focusSurfaces.resolve(handlers.commandCenterOpen())),
        );
      });
      return () => {
        unsubscribeHardware();
        unsubscribeFocus();
        unsubscribeCommandCenter();
        unsubscribeOverlays();
        updateClaims = () => {};
        source.setOverlayKeys([]);
        source.setClaimedShortcuts([]);
      };
    },
  };
}
