# Keyboard shortcuts

`packages/app/src/keyboard/keyboard-shortcuts.ts` holds every binding. Nothing else defines a shortcut. A platform contributes a _key source_ — a way to turn a physical press into `KeyboardShortcutInput` — and the shared resolver does the rest: match the combo, check the `when` conditions, route the action, dispatch it.

Add a shortcut by adding a binding. Add a platform by adding a key source.

## The three key sources

| Runtime              | Source                                               | Where                             |
| -------------------- | ---------------------------------------------------- | --------------------------------- |
| Web and Electron     | `window` keydown/keyup                               | `hooks/use-keyboard-shortcuts.ts` |
| Electron `<webview>` | IPC from the browser pane, synthesized into an input | `desktop/browser/shortcuts.ts`    |
| iOS                  | `UIKeyCommand` on the root view controller           | `modules/paseo-hardware-keyboard` |

The webview and iOS sources both call the resolver with `domEvent: null`, because neither has a DOM event to `preventDefault`. Android has no source; the `.ts` stub of `native/ios-hardware-keyboard-shortcuts` no-ops there, so nothing registers and nothing fires.

## Two availability questions, not one

`keyboard/availability.ts` answers them separately, and conflating them is the mistake to avoid:

- `keyboardShortcutsAvailable` — should the UI render ⌘ badges. False on native, because a phone with no keyboard attached would be advertising shortcuts nobody can press.
- `keyboardShortcutRoutingAvailable` — does this runtime have a key source at all. True on native.

So an iPad with a Magic Keyboard runs the shortcuts without showing the badges. Making the badges follow `GCKeyboard.coalesced` is the fix, and it hasn't been done.

## iOS specifics

`UIKeyCommand` takes one input plus a modifier mask, so only single combos survive the crossing. Chords and the `Digit` wildcard are filtered out in `keyboard/native-shortcuts.ts`.

A key UIKit has no character for is spelled as a sentinel input string (`UIKeyCommand.inputEscape`). JS has no business hardcoding those, so a code-only combo crosses as its DOM `code` in `namedKey` and the Swift module's `namedKeyInputs` resolves it. `NATIVE_NAMED_KEY_CODES` bounds what JS will send; anything outside it is dropped rather than registered under a character iOS never delivers. Both sides have to know a key for it to work — adding one means editing both tables.

The combo string registered with the command rides back on `UIKeyCommand.propertyList` when it fires. That property is read-only, so the combo goes in through `UIKeyCommand(title:image:action:input:modifierFlags:propertyList:)` — assigning after construction does not compile. JS reparses the combo into a synthetic key event rather than mapping the press to an action natively — one binding table, one matcher, and user rebinds work on iOS for free.

Which bindings go native is an explicit allowlist, `NATIVE_HARDWARE_SHORTCUT_BINDING_IDS`, because half the desktop map has no native counterpart: every `workspace.pane.*` binding needs split panes, and `supportsDesktopPaneSplits()` is web-only.

UIKit registers keys, not bindings, so bindings that resolve to the same press produce one command. `buildNativeKeyCommands` dedupes on input plus modifiers; the press comes back as its combo string and the resolver sorts out which binding wins by `when`.

Because the registered set changes while the app runs, `setKeyCommands` calls `UIMenuSystem.main.setNeedsRebuild()`. UIKit serves key commands from a menu it builds once, so the rebuild is what stops the previous list from answering the next press.

### Overlay keys

On web, `dispatchTopWebOverlayKeyDown` gives the topmost overlay first refusal on every key before the shortcut engine runs, so a modal, menu, or the command center answers its own Escape, Enter, and arrows. That dispatcher never runs on native, and every `useWebOverlayRegistration` call site is gated on `isWeb` — so an iOS press used to fall straight through to the binding table, where the only Escape binding is `agent.interrupt`. Nothing closed and nothing navigated.

`lib/overlay-root.ts` holds the native counterpart. An overlay registers while it is open, the iOS key path offers a bare key to `dispatchTopNativeOverlayKey` before resolving, and an unhandled key falls through to the shortcut engine — the same contract web has. The layer-then-order rule picks the target, so a menu inside a modal closes before the modal.

Two hooks, because most overlays only need one key:

- `useNativeOverlayDismiss` — Escape closes it. What a modal, menu, or host chooser wants.
- `useNativeOverlayKeys` — declares the keys this overlay wants on top of Escape, and one handler for all of them. The command center, the add-project flow, and the combobox ask for `ArrowUp`, `ArrowDown`, and `Enter`.

Keys are **declared, not inferred**, and registered only while that overlay is topmost. A `UIKeyCommand` is taken from whatever holds focus, so a permanently registered Enter would stop every text field submitting and permanent arrows would stop the caret moving. `NATIVE_OVERLAY_KEY_CODES` bounds what an overlay may ask for. Backspace is deliberately excluded — the palette pops its scope with it on web, and registering it would stop the search field deleting text.

Escape arrives without being asked for, since it is registered for `agent.interrupt` anyway.

What decides whether a surface can offer more than Escape is whether its handler needs the DOM. The command center, the add-project flow, and the combobox all navigate off React state — the combobox's `dispatchDesktopKey` takes its event only to `preventDefault` — so the full set crosses. The menu overlay reads `event.target` and queries `[data-menu-item]` for its rows, so it registers a dismiss only.

The combobox registers in the parent rather than in either body: the popover and the bottom sheet both render an active-row highlight, and the sheet is what a compact layout shows.

The `active` flag is a separate question from the web hook's: that one wants a DOM scope and never registers without a `document`, so the command center registers a web scope only when it is _not_ the bottom sheet, while native shows exactly that sheet.

Enter carries two native guards, because it is the one key something else already registers.

`handleHardwareKeyboardShortcut` drops it while the first responder has marked text, or confirming a CJK IME candidate would submit the half-composed query instead.

And the composer's submit command yields to it. `useIosHardwareKeyboardSubmit` registers an unmodified Return for as long as the composer holds focus, which includes while a picker is open over it — so `keyCommands` skips the submit command when something registered has already claimed plain Return. Without that, two commands sit on one press and the composer wins: on the New Workspace screen, Enter created the workspace instead of choosing the highlighted project.

### The terminal carve-out

A registered command is consumed before the focused surface sees it. Escape has to interrupt the agent without swallowing the Escape vim inside a terminal tab is waiting for, and filtering after the fact is not available — the press never arrives at the terminal. So the key leaves the registered list while a terminal holds focus. `TERMINAL_RESERVED_NATIVE_KEY_CODES` names what goes, keyed by DOM `code` rather than by binding id: leave one Escape binding registered and the key stays registered, however many others were dropped.

The focus signal is `keyboard/native-terminal-keyboard.ts`, not `resolveKeyboardFocusScope`, which reads DOM ancestors and returns `"other"` when there is no `document`. `TerminalPane` claims while it is presented and focused. Claims are keyed rather than counted: panes overlap during a tab switch and the outgoing pane's cleanup runs after the incoming pane's effect, so a boolean would be cleared by the pane that already lost the keyboard. An open overlay outranks a claim — it paints above the pane and owns Escape until it closes.

The consequence to know: with a focused terminal on screen and nothing over it, Escape does not interrupt the agent. The stop button does.

Changing the module means a native rebuild. Shortcut changes do not ship over the air.
