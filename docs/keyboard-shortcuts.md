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

## Overlay ownership

Register keyboard handling with `useOverlayRegistration` from `@/keyboard`.
Pass the surface's open state, layer, handled keys and `onKeyDown`. The highest
layer gets first refusal; the latest registration wins a tie. Native registration
does not need a DOM ref. Web adds focus trapping and restoration through its adapter.

Declare Enter and arrow keys only while the surface owns them. Native sources
use the top overlay's declarations to take those keys before text controls edit.
Backspace stays with the focused input. Composition confirmation must not select
an overlay row or submit the composer.

Android modals have their own windows. Observe them through React Native's
`ExtraWindowEventListener` as well as the activity window. The dev client bypasses
Expo's root-container handler, so an activity root-view wrapper misses presses.
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
