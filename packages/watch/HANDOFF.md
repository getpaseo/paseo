# Wear OS handoff

Working state for whoever picks this up next. Transient by nature — delete it once
the open work below is done. Durable facts live in [README.md](README.md) and
[design/README.md](design/README.md); read both, they are short.

Branch: `assembly-wear-os` on remote `fork` (local checkout may be named
`wearos-voice-transcription`). Assembly recipe: `~/Projects/paseo-assembly`.

## It works end to end

The phone→watch Wearable Data Layer hop is **confirmed working on real hardware**:
live workspaces, project icons, provider, and status render on a Pixel Watch 3 from
the user's actual daemons. Everything below assumes that baseline.

## The one rule that will waste your day if you miss it

**The Data Layer only routes between a phone app and a watch app that share BOTH
`applicationId` and signing certificate.** Get either wrong and nothing crosses:
puts succeed, listeners register, node discovery works, and Play Services reports
**no error to either side**. The watch just waits forever.

This is why the watch's `applicationId` is a Gradle property, not a fixed value
(`app/build.gradle.kts`). Default `sh.paseo.debug`; the F-Droid pipeline passes
`-PpaseoApplicationId=sh.paseo.assembly` and signs with the phone's key. The Kotlin
`namespace` stays `sh.paseo.watch` — only the install identity varies, so the launch
component is `<applicationId>/sh.paseo.watch.MainActivity`.

If the watch shows **"waiting for phone"**, no snapshot has ever arrived. If it shows
**"No workspaces on your connected hosts"**, the hop works and the problem is
upstream in snapshot content. That split exists specifically to tell those apart —
trust it instead of inferring from log silence, because both sides only log failures.

## Connecting to the devices

Both are on the user's home LAN, DHCP moves them, and **the watch's wireless-debug
port changes whenever the toggle is cycled**. Last known good:

| Device         | Address               | Notes                                                                               |
| -------------- | --------------------- | ----------------------------------------------------------------------------------- |
| Pixel Watch 3  | `192.168.0.10:36963`  | also seen at `.53`; paired already (`adb-47291JEAYW08L5-B5vEF3`), so no code needed |
| Pixel 9 Pro XL | `192.168.0.241:45753` | also reachable over tailscale as `100.127.119.119`                                  |

When the address is stale, sweep and rescan rather than asking:

```bash
for i in $(seq 1 254); do (ping -c1 -W1 192.168.0.$i >/dev/null 2>&1 && echo 192.168.0.$i) & done; wait
nmap -p 30000-50000 --open -T5 -n 192.168.0.<candidate>    # via: nix run nixpkgs#nmap --
adb connect 192.168.0.<ip>:<port>
```

Gotchas that cost real time:

- **Wear OS powers WiFi down when the screen is off and the phone is in Bluetooth
  range.** `ping` gives 100% loss and `adb connect` says _No route to host_. Not a
  config problem — put it on the charger or wake it.
- **`adb pair` ports die when the pairing dialog closes.** Need port + 6-digit code
  together, in one shot. Pairing is already done, so this shouldn't recur.
- **The Bluetooth tunnel** (`adb forward tcp:4444 localabstract:/adb-hub`, then
  `adb connect 127.0.0.1:4444`) is immune to WiFi sleep and IP churn, but needs
  _Wear OS app → Advanced → Debug over Bluetooth_ on the phone. Never got enabled;
  worth preferring if WiFi keeps fighting you.
- **`screencap` returns a 1772-byte black PNG** when the screen is asleep, even
  though `dumpsys window` reports `mAwake=true`. Fix:
  ```bash
  adb -s $W shell settings put system screen_off_timeout 600000
  adb -s $W shell input keyevent 224; adb -s $W shell input swipe 225 300 225 200
  ```

## Build and install

Toolchain is nix-store paths, and **nix GC deleted the SDK mid-session once** —
there is a GC root at `~/.paseo-wear-gcroots/androidsdk`, but re-resolve if it
vanishes (`ls -d /nix/store/*androidsdk*/libexec/android-sdk`).

```bash
export JAVA_HOME=/nix/store/102gxd1lf8cniz9zzsxn7mdmnar8w0jz-openjdk-21.0.12+2
export ANDROID_HOME=/nix/store/hdzxpm2dgj342sjlgygdivzvwgbaisnj-androidsdk/libexec/android-sdk
export PATH="$JAVA_HOME/bin:/run/current-system/sw/bin:$PATH"
cd packages/watch && ./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Use `./gradlew`, never a system `gradle`. Install to the watch with the identity
that matches the installed phone app — for the F-Droid phone build that means
downloading the signed watch artifact from CI, not a local debug build:

```bash
gh run download <fdroid-run-id> -D /tmp/fd   # in ~/Projects/paseo-assembly, inside nix develop
# artifacts: paseo-assembly-<code> (phone), paseo-watch-assembly-<code> (watch)
adb -s $W install -r /tmp/fd/paseo-watch-assembly-*/*.apk
```

`find -L` is required for anything under `$ANDROID_HOME/build-tools` — each version
dir is a symlink into its own store path, and an unfollowed `find` silently finds
nothing. Also: `apksigner` needs `java` on PATH or it fails with `exec: java: not found`.

## Landing a change in the user's build

`assembled` is **compiled output — never hand-commit to it or base work on it.**
Read `~/.agents/project-guides/paseo-assembly.md` and the assembly repo's
`AGENTS.md` before touching it; the full fork-fold guide loads with
`nix eval --no-write-lock-file --raw .#lib.forkFoldAgentGuide`.

The cycle, all from `~/Projects/paseo-assembly` inside `nix develop`:

```bash
git push fork HEAD:refs/heads/assembly-wear-os      # from the paseo worktree first
fork-fold update assembly-wear-os && fork-fold build
.worktrees/build/scripts/update-nix.sh --check      # see hash note below
fork-fold build --locked                            # must reproduce the lock's tree
git -C .worktrees/source push --force-with-lease=refs/heads/assembled:<old> mine <new>:refs/heads/assembled
git add manifest.lock.json && git commit && git push origin HEAD:main   # this triggers CI
```

`assembled` gets **force-pushed** — a rebuild rewrites every commit after the edited
entry. That is normal; use `--force-with-lease`.

Two traps here:

- **Any change to `package-lock.json` invalidates `patches/assembled-npm-deps-hash.patch`**,
  which is a function of the whole assembled dependency tree. Symptom: desktop CI
  fails with `npmDepsHash is out of date`. Fix by taking the value
  `scripts/update-nix.sh` writes into the build tree (self-consistent by
  construction), then `fork-fold update assembled-npm-deps-hash` and rebuild. Do
  **not** copy a hash out of a `--check` message; one run reported a different value
  than the two either side of it.
- **Never hand-edit `package-lock.json`, and never commit one produced by a bare
  `npm install` on this machine.** `npm config get omit` is `dev` and
  `NODE_ENV=production`, so a plain install rewrites the lock destructively (~847
  insertions / 1358 deletions, pruning platform-specific optional deps that would
  break macOS). Use `scripts/update-nix.sh`, which runs `scripts/fix-lockfile.mjs`.

Unrelated pre-existing breakage you will hit: the lefthook pre-commit hook fails on
`packages/expo-two-way-audio` typecheck (`Cannot find type definition file for
'jest-require'`) because that package's tsconfig looks for `expo-module-scripts`
package-locally while npm hoists it. Not caused by this work; `--no-verify` after
checking your own code is clean.

CI lives in the assembly repo (the fork has Actions disabled — 0 runs ever):
`watch.yml` (build + tests, ~6min), `desktop.yml` (~6min), `fdroid.yml` (~21–25min,
produces both signed APKs).

## Done so far

- Wear app: workspace list, agent picker, agent detail, permission approve/deny,
  one-tap voice reply. Workspaces are the browsing unit; `Workspace.destination()`
  in `model/Models.kt` is the **single** place the "1 agent skips the picker, 0 agents
  goes to voice" rule lives.
- Voice/typing via Wear's system input sheet (`RecognizerIntent`,
  `EXTRA_PREFER_OFFLINE`). No audio code, no `RECORD_AUDIO`. Paseo's daemon-side
  dictation is deliberately unused.
- Bridge: `packages/expo-wear-bridge` (Expo module) + `packages/app/src/wear/`.
  Snapshots over `DataClient`, commands over `MessageClient`.
- `use-wear-bridge.android.ts` + a no-op base keeps the Android-only native module
  out of non-Android bundles (Metro platform split, per CLAUDE.md).
- **Conversation scrollback** on the agent screen: `requestTranscript` command,
  `/paseo/transcript/<agentId>` DataItems, and a `ScalingLazyColumn` that opens at
  the newest turn with the actions at the end of the list. An open agent screen
  re-sends `requestTranscript` every 60s to renew the phone's ~150s push lease —
  the reactive re-request is keyed on the snapshot row, and a continuously busy
  agent's row never changes, so without the keepalive live output would stop after
  150s.
- **Text entry** via `RemoteInputIntentHelper` (`androidx.wear:wear-input`), so the
  keyboard button opens the system input picker instead of the recognizer sheet.
- **Reply composes in place.** The reply route is deleted. Reply on the agent screen
  launches `ACTION_RECOGNIZE_SPEECH` directly and sends the result; `Type` next to it
  launches the remote-input picker directly. Both launchers come from
  `rememberComposerLaunchers` in `ui/Composer.kt`, shared with `ui/NewAgentScreen.kt`
  (the one composer screen left, since a new agent has no conversation to hang buttons
  off). Canned replies are gone with the screen.
- **Action row is Reply alone on top, `Type` and `Stop` as 38dp satellites below** —
  three abreast does not fit inside a 450px round screen's insets without eating the
  gaps that keep Stop away from Reply.
- Watch APK built and signed by the F-Droid pipeline with the phone's key
  (`scripts/fdroid-build-watch.sh`); version code uses ABI slot 5 so it cannot
  collide with the phone's 1–4.
- Launcher icon is the real Paseo butterfly, path copied byte-identical from
  `packages/app/assets/images/butterfly-white.svg`.
- **Real project icons.** The phone publishes each project's icon file as a
  `DataClient` Asset at `/paseo/icon/<Uri.encode(projectKey)>`; the watch reads it
  with `getFdForAsset`, screens out formats `BitmapFactory` can't decode (SVG, ICO),
  and draws it clipped to the same rounded square the initial used. No icon or an
  undecodable one falls back to the colored initial, so the pre-existing look is the
  failure mode. A third DataItem prefix means a third listener object — see the
  README; that gotcha now applies three times.
- 27 phone-side tests, 47 watch unit tests, 1 on-device instrumented test.

## Open work

All of the user's UI asks are built. What remains is verification on hardware:

1. **The one-tap reply has never been tapped on a watch.** Reply now launches the
   recognizer from inside the agent screen's `ScalingLazyColumn` rather than from a
   dedicated screen, and that is the thing to check first: that the recognizer sheet
   actually comes up on the first tap, that the spoken string lands in the
   conversation, and that returning from the sheet leaves the list where it was
   instead of re-anchoring. `Type` on the same row needs the same pass.
2. **Nothing about the transcript has run on a real phone+watch pair.** The watch
   half is unit-tested against pinned JSON and the phone half against its own tests,
   but the hop carrying a `/paseo/transcript/<agentId>` DataItem has not been
   exercised. Worth watching for specifically: DataItem size against the ~100 KB
   Data Layer cap if the phone's projection ever stops capping entries, and whether
   the initial scroll actually lands at the bottom on a round 450×450 display.
3. **`RemoteInputIntentHelper` is untested on device.** It resolves to a system
   activity; if a watch has no input picker the launch would fail. The mic path is
   unchanged and still works.
4. **No project icon has crossed the hop.** The watch half is unit-tested and the
   phone half publishes, but nothing has confirmed a real icon rendering on a wrist.
   Check specifically: that the projectKey survives `Uri.encode`/`Uri.decode` intact
   (a wrong key silently shows the initial forever — indistinguishable from "this
   project has no icon"), that assets actually sync over Bluetooth rather than
   waiting on WiFi, that a 32 KB PNG scaled into a 26dp square is still legible, and
   that a project whose icon is an SVG falls back cleanly rather than drawing blank.

### Transcript shape as built

Projection, not transport, was the whole problem — a Paseo timeline is tool calls,
file reads, diffs, and terminal output, and one `Bash` result can exceed the ~100 KB
DataItem cap alone. The resolved answers to what were open questions:

- **An entry** is `{kind, text}` with `kind` ∈ `user` | `assistant` | `tool` |
  `error`. Tool calls collapse to a single line (`Bash: git push origin …`) rather
  than being dropped, so the watch can show that work is happening. The kind set is
  open: the watch renders an unknown kind as muted plain text.
- **How far back**: up to 100 entries in one round trip, no paging. `truncated: true`
  tells the watch to say "earlier history on your phone" instead of pretending it can
  fetch more.
- **Source** on the phone is `client.fetchAgentTimeline(agentId, {…, projection})`
  with `projection: "projected"` — the daemon's own collapsed view, per
  `docs/timeline-sync.md`. Prefer it over re-deriving.
