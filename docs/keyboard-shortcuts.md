# Keyboard shortcuts

Define shortcuts in [the shared binding table](../packages/app/src/keyboard/keyboard-shortcuts.ts). Platforms contribute key sources, not separate action maps, so matching and user rebinds stay consistent across runtimes. Add a shortcut through a binding; add platform support through a key source.

## Badges and routing

Keep badge visibility separate from key routing. Hiding badges on a phone without a keyboard must not disable shortcuts when a hardware keyboard is attached. See [availability.ts](../packages/app/src/keyboard/availability.ts) for the current policy.

## Native sources

Use the iOS window press stream for hardware keys. `UIKeyCommand` only takes keys
that must bypass the focused text control: composer Return and the top overlay's
Enter and arrows. Keep the stream as the sole shortcut emitter: a command-owned
press is still observed by the window.

The source spike used an iPad Pro 11-inch (M4) simulator on iOS 18.6 with a
`UITextView` first responder. Both `UIWindow.sendEvent` and the root controller's
`pressesBegan` received Cmd+B, Cmd+P and Escape. With Escape registered as a
`UIKeyCommand`, the window observed it and the command handler also ran.

Simulator reserves Cmd+K for Toggle Software Keyboard. Injecting it produced
HID 184 with empty characters rather than K; plain K, Cmd+B and Cmd+P arrived
normally. Keep Simulator input capture off: Send Keyboard Input to Device
prevented synthetic AppleScript input from arriving, including plain text.
For simulator QA, use Cmd+B/P to check delivery and rebind the command center to
Cmd+J to check toggle and rebind behavior. Cmd+K delivery needs a physical iPad.

Never register Backspace: it would take deletion away from text fields. Changes
to the native module require a native rebuild; an over-the-air JavaScript update
cannot deliver them.

## Overlays and text input

The topmost overlay must have first refusal before global shortcuts run, on both web and native. Otherwise Escape can interrupt an agent instead of closing the surface above it. Keep this contract across [overlay-root.ts](../packages/app/src/lib/overlay-root.ts) and the platform key sources.

Native overlay navigation must work without DOM focus or row queries, including when the surface renders as a compact bottom sheet. Scope extra keys to the overlay that needs them so text controls retain their normal editing behavior.

Coordinate overlay Enter handling with composer submission and IME composition. Choosing a highlighted item must not submit the composer underneath it, and confirming an IME candidate must not submit unfinished text.

## Terminal focus

A focused terminal needs keys such as Escape for terminal applications. On iOS, those keys must be released from native command registration; filtering them after dispatch is too late. Native focus cannot be inferred from DOM ancestors. See [native-terminal-keyboard.ts](../packages/app/src/keyboard/native-terminal-keyboard.ts) for focus ownership and tab-switch lifetime handling.

An overlay above the terminal owns its keys until it closes. With a focused terminal and no overlay, Escape goes to the terminal; use the stop button to interrupt the agent.
