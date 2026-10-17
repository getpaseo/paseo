# Mac capture requests

On macOS 14 or later, the desktop app owns the global modifier shortcut and the
hold gesture. Hold Option + Control to speak and paint a trail with the pointer,
then release either modifier to send. Escape or an extra key cancels. No mouse
button is needed, and the foreground application keeps focus. A transparent native
overlay follows the pointer; the screenshot taken on release excludes helper
windows and receives the same trail plus a crop.

A preloaded hidden renderer records through the existing dictation pipeline and
joins the final transcript with the screenshot before creating exactly one agent.
It uses the local daemon identity independently of the host selected in the main
window, enrolling that connection even on first launch. It never participates in
workspace restoration. The request panel opens only to recover an error or empty
dictation; success shows a short inactive confirmation.
Use **File → Capture** to request macOS permissions or change the modifier chord.
The alternative chord applies to the current app session.

The Swift helper is compiled for the target architecture during `afterPack` and
signed as an explicit additional binary. Keep it outside `app.asar`; launch it
only on supported macOS versions. Its pipe carries screenshots and accessible
content: never log complete messages or image data.

The opt-in workflow plugin owns classification and creation. JEV receives only
request text, OCR, window context and project candidates. Images go to the agent.
The two-second deadline includes key lookup, HTTP and response decoding; aborting
HTTP alone does not bound a stalled request. A durable decision precedes resource
creation. Never reclassify a retry or move a failed worktree request to PARA.
Without the plugin, the client uses the same idempotent agent creation in the
shared PARA workspace.

Desktop control is attached to the capture's device and agent. Registration and
responses belong to one physical client source. The daemon checks the agent's
current Plan mode before dispatch, including after waiting for its turn. The
native **Arrêter** panel revokes locally before contacting the daemon. Disconnect,
unknown outcome and timeout revoke the session; actions are never replayed.
A completed agent turn releases the controller. Another agent waits for release.

## Verification

Run the new capture cases in `packages/desktop/e2e/desktop-capture.spec.ts` and the
`desktop host commands` case in `owned-subscriptions.e2e.test.ts`. They use isolated
daemons. The renderer fixture proves hold-to-dictate, release-to-send, annotation and
draft retention, not global keyboard delivery, macOS permissions or packaged signing.

Compile and run `native/desktop-capture/ShortcutTests.swift` with
`ModifierShortcut.swift` to check the modifier state machine without sending keys
to the user's applications. Test permission denial, fullscreen and mixed-scale
monitors on a signed app before claiming complete local delivery.
