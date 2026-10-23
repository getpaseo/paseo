# How it was built (Pyrgos Paseo)

Entries are in build order, without dates. Each carries a status: verified (with evidence) or assumed (with what would settle it).

## Lab speech providers (MIC-750 D)

- **Decided:** speak and listen through the lab's local TTS/STT WebSockets by default, with Paseo's stock provider as the fallback. The orchestrator specified it; Claude chose the shape.
- **Shape:** new `providers/lab/` directory plus one call in `speech-runtime.ts` that wraps whatever the stock path built. Rejected: a new `SpeechProviderId` and config schema entries (touches core types, config persistence and the UI, and makes upstream merges harder). Consequence: lab is selected by env vars, not by the settings UI, and the effective-provider label for TTS still reads as the stock one.
- **Fallback:** TTS falls back only before the first audio frame, so a sentence never switches voice midway. STT falls back at `connect()` and resamples 16 kHz to the fallback's rate with linear interpolation.
- **Status:** verified. Provider tests with a fake loopback WebSocket server pass (13 tests). A headless script spoke "The quick brown fox jumps over the lazy dog." through the lab TTS and the lab STT returned the same text; first audio took 542 ms on that cold-ish call.
- **Status:** assumed. The settings UI and the "effective provider" readout do not know about the lab; settle by wiring a provider id once ticket A's design says where it should surface. Linear-interpolation resampling is adequate for speech recognition; settle with a fallback-path accuracy test against the stock STT.

## Open questions

- Should the lab become a first-class provider id in settings and the readiness snapshot?
- First-audio latency on the first call after idle (542 ms here, against 44 ms p50 measured warm in the lab docs): is the cause server warm-up or the new connection per sentence? A persistent TTS socket would settle it.

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
