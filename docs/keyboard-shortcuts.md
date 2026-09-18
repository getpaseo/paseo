# Keyboard shortcuts

Define shortcuts in [the shared binding table](../packages/app/src/keyboard/keyboard-shortcuts.ts). Platforms contribute key sources, not separate action maps, so matching and user rebinds stay consistent across runtimes. Add a shortcut through a binding; add platform support through a key source.

## Badges and routing

Keep badge visibility separate from key routing. Hiding badges on a phone without a keyboard must not disable shortcuts when a hardware keyboard is attached. See [availability.ts](../packages/app/src/keyboard/availability.ts) for the current policy.

## Native constraints

The iOS bridge carries key combinations back to the shared resolver. Keep JavaScript named-key support and Swift mappings aligned when extending it; UIKit-specific key values belong in Swift. The supported combinations and binding filters live in [native-shortcuts.ts](../packages/app/src/keyboard/native-shortcuts.ts), with UIKit registration in [PaseoHardwareKeyboardModule.swift](../packages/app/modules/paseo-hardware-keyboard/ios/PaseoHardwareKeyboardModule.swift).

Native command registration affects the focused control before JavaScript can decide what to do with a press. Treat registration as keyboard ownership: registering Enter, arrows, or Backspace can take submission, caret movement, or deletion away from a text field. Do not register a key globally merely because one surface needs it.

Changes to the native module require a native rebuild; an over-the-air JavaScript update cannot deliver them.

## Overlays and text input

The topmost overlay must have first refusal before global shortcuts run, on both web and native. Otherwise Escape can interrupt an agent instead of closing the surface above it. Keep this contract across [overlay-root.ts](../packages/app/src/lib/overlay-root.ts) and the platform key sources.

Native overlay navigation must work without DOM focus or row queries, including when the surface renders as a compact bottom sheet. Scope extra keys to the overlay that needs them so text controls retain their normal editing behavior.

Coordinate overlay Enter handling with composer submission and IME composition. Choosing a highlighted item must not submit the composer underneath it, and confirming an IME candidate must not submit unfinished text.

## Terminal focus

A focused terminal needs keys such as Escape for terminal applications. On iOS, those keys must be released from native command registration; filtering them after dispatch is too late. Native focus cannot be inferred from DOM ancestors. See [native-terminal-keyboard.ts](../packages/app/src/keyboard/native-terminal-keyboard.ts) for focus ownership and tab-switch lifetime handling.

An overlay above the terminal owns its keys until it closes. With a focused terminal and no overlay, Escape goes to the terminal; use the stop button to interrupt the agent.
