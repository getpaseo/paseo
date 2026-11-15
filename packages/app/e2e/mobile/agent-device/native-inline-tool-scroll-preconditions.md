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

Replay `native-inline-tool-scroll.ios.ad` on that explicit simulator through the
existing mobile runner or agent-device. It scrolls to the separate Output
section, then collapses and reopens the tool. Before the passive hover wrapper
fix, these pans move the timeline and Output remains unreachable. The browser
disclosure suite separately checks tab navigation and mouse hover reporting.

The simulator development build's Expo gear overlay can mark all app nodes
covered in accessibility, so this flow uses the measured coordinates for taps
and pans. Section labels are separate native text nodes after the fix. During
QA, the exact script commands were run in the prepared device session to retain
its runner lease; no screenshot is used as an assertion.
