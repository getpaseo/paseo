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

`UIKeyCommand` takes one character plus a modifier mask, so only single combos with a literal character survive the crossing. Chords, the `Digit` wildcard, and named keys such as Backspace are filtered out in `keyboard/native-shortcuts.ts`.

The combo string registered with the command rides back on `UIKeyCommand.propertyList` when it fires. JS reparses it into a synthetic key event rather than mapping the press to an action natively — one binding table, one matcher, and user rebinds work on iOS for free.

Which bindings go native is an explicit allowlist, `NATIVE_HARDWARE_SHORTCUT_BINDING_IDS`. It has to be, for two reasons:

- **A registered command is consumed before the focused surface sees it.** This is why Escape is not on the list. It would interrupt the agent, and it would also swallow the Escape that vim inside a terminal tab is waiting for. Native has no focus-scope signal to tell those apart — `resolveKeyboardFocusScope` reads DOM ancestors and returns `"other"` when there is no `document`. Escape can join the list once the command set can follow terminal focus.
- **Half the desktop map has no native counterpart.** Every `workspace.pane.*` binding needs split panes, and `supportsDesktopPaneSplits()` is web-only.

UIKit caches `keyCommands` per responder. The list is set once at startup and only changes when someone rebinds a shortcut in settings, so a stale cache costs at most one press.

Changing the module means a native rebuild. Shortcut changes do not ship over the air.
