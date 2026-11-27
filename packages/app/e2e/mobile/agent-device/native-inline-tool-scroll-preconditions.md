# Inline tool detail scrolling on iPad

Use a task-owned iPad Pro 11-inch (M5) simulator in portrait (834×1210 points),
with the development bundle already loaded and a connected isolated mock host.
Set Chat display to Collapse turns. Prepare a finished turn containing a tool
named `scroll_probe`, with unknown detail: `input` is 80 newline-separated
`input-line-N` lines (N=0…79), and `output` is `SCROLL_REACHED_OUTPUT`.

Expand the turn, scroll chat to its start, and expand Scroll probe. The tool's
header must be at y=613…644 and its 400-point body below it. The fixed pan path
starts inside that body and stays inside it. Output starts below the cap.
These are replay preconditions, not asserted pixel sizes. Close other expanded
tools so the Scroll probe selector identifies this disclosure.

Replay `native-inline-tool-scroll.ios.yaml --maestro` on that explicit simulator
through the existing mobile runner or agent-device. In Expo's development menu,
turn off Tools button, then dismiss the known notification entitlement toast
with its bottom-right close button. Their transparent accessibility windows
otherwise mark app text covered. Another overlay must fail the visibility
assertions. Pass `--platform ios` and the prepared session's `--state-dir` when
replaying in that session.

The flow first asserts Input is visible and the output marker is not. After
panning it requires Output and its marker to be visible, then requires closing
the tool to hide its contents and reopening it to show Input again. Presence in
the accessibility tree is insufficient. A negative control with the passive
wrapper retained and only the detail's scrolling disabled must fail at Output
visibility. The browser disclosure suite checks tab navigation.
