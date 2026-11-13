# Tool-call details empty state — #9128

## Before and after

These screenshots come from the app's Chromium browser E2E flow. The flow opens a real workspace, sends a message to the mock agent, and opens the normal **Read** tool-call details sheet. For this QA scenario, the read result is left without file content so the sheet shows its empty state.

**Before:** the empty message starts at the sheet edge, while the header has a 16px inset.

![Before: empty message flush with the sheet edge](before.png)

**After:** the empty message has the same 16px horizontal inset as the sheet header.

![After: empty message inset from the sheet edge](after.png)

## Verification

- The browser regression test checks the message and both 16px horizontal paddings. It failed before the fix and passed after it.
- The app E2E flow opened the real tool-call sheet and captured both visual states in Chromium. Its temporary screenshot harness is not part of the PR changes.
- Repository typecheck, lint, format check, and server build passed; the captured command results are in [validation.txt](validation.txt).

## Platform coverage

| Surface                    | Result                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| App browser UI in Chromium | Verified; before and after screenshots above                                                     |
| Android SM-F741N (API 37)  | Not verified; first-run Gradle dependency downloads did not finish, so the app was not installed |
| iOS and desktop            | Not tested                                                                                       |
