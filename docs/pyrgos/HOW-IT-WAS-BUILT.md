# How Pyrgos Paseo was built

Decision log for the voice conversation agent in this fork. Ordered by build sequence; no dates.

## Local Android and desktop builds (MIC-750 E)

- **Decided:** build the APKs locally with Gradle through scripted wrappers (`scripts/pyrgos/build-android.sh` and `.ps1`), not through EAS cloud. **Who:** the overseer set the ticket; Claude implemented.
- **Rejected:** EAS cloud (needs an account and signing credentials; the hard rules forbid both). Using the Android Studio JBR as the JDK: it is Java 25 here and the Gradle/React Native toolchain wants 17-21, so a user-local Temurin 21 is used instead.
- **Chosen:** the production APK is a release build signed with a throwaway debug keystore, generated outside git. It is for sideloading, not for stores.
- **Found by failing:** a first build died because npm blocks native-asset postinstalls (`allowScripts`) for `react-native-enriched-markdown` and `@shopify/react-native-skia`. The build script now runs those two itself.
- **Chosen:** the Windows desktop installer script is written but never run on the lab; the PC builds it.
- **Consequence:** one command per platform; the first lab build takes about 10 minutes for both variants.
- **Status:** verified for Android: both APKs built on the lab and `aapt2 dump badging` reports package `sh.paseo` for each; the PowerShell twin was run under `pwsh` on the lab. **Assumed:** install and launch on a device (none attached), and the Windows desktop build (untested on PC).

## Open questions

- Does the APK start and reach a daemon over the tailnet? Settle with `adb install` on a phone.
- Does `build-desktop.ps1` pass on the Windows PC? Settle with the PC-CHECK steps in the PR.

## 1. Design note first (MIC-750 A)

- **Decided:** write `docs/pyrgos/DESIGN.md` before B (conversation agent), C (ledger and overseer feed) and D (lab speech) start, so the three can be built in parallel against fixed interfaces.
- **Who:** the overseer session set the plan; Claude drafted the note.
- **Chosen:** a direct "voice brain" hook on `VoiceSession` instead of binding voice mode to a Paseo agent. **Rejected:** the stock path (agent turn plus MCP `speak` call per reply), because it adds latency against the 2 s target.
- **Chosen:** a new `lab` speech provider id, which needs a small edit to the closed enum in `speech-types.ts`. **Rejected:** a plugin-only route, because plugins cannot register speech providers (`packages/plugin/src/server/contracts.ts`).
- **Consequence:** about three small core edits; everything else is under `pyrgos/` and `plugins/pyrgos-ledger/`.
- **Status:** verified for the cited seams (files and symbols read in this checkout). The latency claim for the stock path is **assumed**; B settles it by measuring.

## Open questions

- Is the stock bound-agent path fast enough to drop core change 2? B measures time-to-first-audio.
- Does the ledger plugin need a core change to see the ledger, or is reading the shared JSONL enough?
