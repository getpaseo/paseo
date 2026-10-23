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
