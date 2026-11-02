# Native user message preview

Open a chat with a user message containing 16 newline-separated lines of
`Preview line N`, with N from 1 to 16. Scroll the message into view on a
phone-sized Android emulator or iOS simulator. Its text must exceed the 240-point preview cap,
while its expanded bubble and toggle fit in the chat viewport. Close any other
expanded messages so the toggle labels identify this message.

Replay `native-user-message-preview.android.ad` or
`native-user-message-preview.ios.ad` through the existing mobile runner or
agent-device. It checks that a clipped message offers Show more and
that two expand/collapse round trips keep both controls reachable. Before the
fix, the first Show more assertion fails because native layout reports the
capped height as the full content height.
