# Keyboard shortcuts

Define shortcuts in [the shared binding table](../packages/app/src/keyboard/keyboard-shortcuts.ts). Platforms contribute key sources, not separate action maps, so matching and user rebinds stay consistent across runtimes. Add a shortcut through a binding; add platform support through a key source.

## Badges and routing

Routing runs whenever the app mounts its key sources, independently of layout.
Use `useHardwareKeyboardPresent()` for hints and the Shortcuts settings section.
iOS reads `GCKeyboard.coalesced` and connection notifications. Android watches input
devices and hardware keyboard configuration. Web starts with a fine hover pointer and recognizes the first modified
keydown, including on touch devices. Compact Electron keeps its bindings.

Keyboard navigation needs the sidebar's filtered workspace model even when its visual
panel is hidden. Retain that model while keyboard navigation is active; gating it on
panel visibility leaves number shortcuts with no targets after a compact startup.

Composer send-key customization remains a separate capability. Native retains its
existing Return submission path; advertising its web-only customization would expose
settings the native composer does not implement.

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
Simulator also reserves Cmd+1…4, Cmd+Shift+A and Cmd+comma. Exercise those actions
through rebinds. For numeric injection, use AppleScript physical key codes (for example
25 for 9); `keystroke "9"` did not deliver a digit in the QA session.
Simulator exposes a virtual `GCKeyboard` even with Connect Hardware Keyboard off.
Verify the iOS absence case on a physical iPhone.

Never register Backspace: it would take deletion away from text fields. Changes
to the native module require a native rebuild; an over-the-air JavaScript update
cannot deliver them.

## Overlay ownership

Register keyboard handling with `useOverlayRegistration` from `@/keyboard`.
Pass the surface's open state, layer, handled keys and `onKeyDown`. The highest
layer gets first refusal; the latest registration wins a tie. Native registration
does not need a DOM ref. Web adds focus trapping and restoration through its adapter.

Capture a global overlay’s layer in state for its opening lifetime. Memo caches can
be discarded or removed by React Compiler; recomputing against the registry lets an
open modal rise above its own children and creates competing focus traps.

Declare Enter and arrow keys only while the surface owns them. Native sources
use the top overlay's declarations to take those keys before text controls edit.
Backspace stays with the focused input. Composition confirmation must not select
an overlay row or submit the composer.

Android modals have their own windows. Observe them through React Native's
`ExtraWindowEventListener` as well as the activity window. The dev client bypasses
Expo's root-container handler, so an activity root-view wrapper misses presses.
A modal can forward an unhandled event into the activity window. Observe the event
once across that nested delivery without retaining recycled Android `KeyEvent`s.
Keep an overlay-owned press consumed through key-up, even if its key-down closes
the overlay; otherwise the modal's default Escape handler can close a second layer.

iOS scene startup installs the observing window after Expo creates its root view.
Keep that integration in the hardware keyboard module's config plugin. Its window
owns both the press stream and the text-control key commands, including above modals.

## Focus scopes

The composer and terminal declare focus with `useKeyboardFocusSurface`. Native
scope derives from those declarations and command-center state. Releasing an old
surface must not clear a newer owner's declaration during a tab switch. Web keeps
its DOM-derived scope.

Escape interrupts an agent only in the message input or an unclaimed surface.
A focused terminal excludes that binding. The source leaves terminal Escape alone;
terminal Escape/Ctrl forwarding is a separate feature.

Terminal arrows never pass through the shortcut pipeline. The Android hardware
module claims them while the terminal's hidden input (`nativeID`) owns the focus.
`TextInput.onKeyPress` only sees IME keys, and an arrow that falls through moves
the hidden caret and desyncs the next text change, so the pipeline cannot own them.

## Keys shared with text editing

A binding on a key the platform already uses for editing, such as Cmd/Ctrl+Z for
workspace archive undo, declares `editable: false` and registers its handler with
`isActive` true only while it has work. An inactive handler leaves the key
unhandled, so the pipeline skips `preventDefault` and the platform's own undo runs.
