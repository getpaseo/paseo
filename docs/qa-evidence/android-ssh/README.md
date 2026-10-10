# Android SSH QA

## Phone workflow

Installed the signed `0.11.1-preview.13` APK on a physical Pixel 9 Pro using
`adb install -r`. Its source is `bf3c940408053f8b5a6ff4abf94c1a488e4e5f58`.
Ryan confirmed importing his private key and connecting to his SSH host successfully.
No private key or passphrase is included in this evidence.

[Android screenshot](android-form.png) and [recording](android-form.mp4) show the
real native form, empty-target validation, and dismissal. The recording does not
show authentication. The APK contains the native SSH module and all four ABIs;
its bundle hash, preview signer, package ID, and version code passed the build's
verification gates.

The later review fixes have not been installed on the phone. Their form lifecycle
is exercised in Chromium and their native classes are compiled and exercised in
the isolated SSH harness below. Do not treat the phone test as proof of those fixes.

## Reviewed form and transport

The existing Chromium suite uses the real form and editing primitives, with
injected Android picker and bridge boundaries. Nine tests cover approval,
retry, target changes, dismissal during inspection, late picker results,
cancelled staging and probes, overlapping imports for one destination, and
dismissal after durable commit begins.

[Approval capture](chromium-approval.png) and [desktop form capture](chromium-desktop-form.png)
come from this harness. They use its test theme and mocked native boundaries;
they are interaction evidence, not real Electron or Android rendering evidence.
The desktop capture confirms imported-key fields stay absent from desktop.

```text
npm run test:browser --workspace=@getpaseo/app -- src/components/add-remote-ssh-host-modal.browser.test.tsx --bail=1
  1 file passed, 9 tests passed
npm run test --workspace=@getpaseo/app -- src/utils/test-daemon-connection.test.ts --bail=1
  1 file passed, 13 tests passed
npm run test --workspace=@getpaseo/app -- src/desktop/daemon/desktop-daemon-transport.test.ts --bail=1
  1 file passed, 8 tests passed
npm run test --workspace=@getpaseo/app -- src/i18n/resources.test.ts --bail=1
  1 file passed, 39 tests passed
```

Raw output: [form](form-tests.txt), [probe](probe-tests.txt),
[desktop transport](desktop-transport-tests.txt), [translations](translation-tests.txt).

## Native checks

AGP 8.11.0 and Kotlin 2.1.20 compiled the exact module sources in a disposable
Android SDK 36 container. `testDebugUnitTest --offline --no-daemon --max-workers=2`
passed the existing six writer/lifecycle tests. [Raw output](native-tests.txt).

An isolated OpenSSH server and WebSocket echo endpoint exercised those compiled
classes with generated, encrypted Ed25519 and PEM RSA keys. Text and binary
messages, reconnect, changed-fingerprint rejection, and incorrect-passphrase
rejection passed. This JVM harness does not exercise Android Keystore or the picker.

For teardown, a bidirectional TCP proxy passed setup traffic, then dropped all
traffic without closing either socket. Calling `SshSession.close()` exceeded the
two-second limit with the pre-fix classes ([raw failure](teardown-before.txt));
the corrected classes closed in 1 ms ([raw result](ssh-smoke.txt)).

## Platform coverage

| Platform                    | Coverage                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Android                     | Signed APK installed, user-confirmed key import and real host connection, native UI capture; later review fixes covered by Chromium and exact-source native harness |
| Browser web                 | Chromium interaction tests and captures with injected platform boundaries; ordinary browsers do not expose SSH                                                      |
| Desktop Linux/Windows/macOS | Shared bridge transport automated suite; desktop form captured in Chromium, no manual Electron SSH connection test                                                  |
| iOS                         | Not manually tested; SSH remains unavailable                                                                                                                        |

Repository-wide quality output: [typecheck](typecheck.txt), [lint](lint.txt),
[format](format.txt). No full local test suite was run.
