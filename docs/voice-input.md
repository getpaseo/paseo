# Voice microphone commands

With local speech recognition, say **“mute microphone”** or **“unmute microphone”** as a separate short utterance. Wait for the confirmation tone before continuing. Mute plays two descending notes; unmute plays two ascending notes. The voice panel shows the persistent mute state, the command to resume, and the existing tappable microphone control.

The commands use ordinary STT vocabulary rather than a product wake word, whose spelling can vary in transcription. Only a complete utterance matches, ignoring case and sentence punctuation; mentioning the command inside dictation does not activate it. The recognizer also accepts “un mute microphone”. Commands are English even when the app UI uses another language.

## What muted means

This is an **agent input mute**, not a hardware microphone switch. Capture and the encrypted connection to the host stay active. On the host, local VAD continues listening and the already loaded local STT model checks short utterances for “unmute microphone”. Other speech is discarded: no transcript event, activity entry, spoken agent input, or barge-in interruption. Muting does not cancel an agent's existing work or silence its replies. Stop voice to stop microphone capture entirely.

Muted recognition uses a 750 ms onset buffer and bounds an utterance to six seconds; longer speech is discarded. It does not continuously decode partial transcripts while muted and does not load an additional model. A pause separates the unmute command from private conversation. Muted speech is never replayed after unmuting.

## Ownership and compatibility

- `packages/server/src/server/session/voice/voice-session.ts` owns mute state and consumes commands before transcript logging or agent submission.
- `voice-turn-controller.ts` owns the bounded command audio and replaces lightweight recognition sessions when mute changes, rejecting delayed results from the previous session while retaining the loaded model.
- `packages/app/src/voice/voice-runtime.ts` keeps capture alive, synchronizes the tap control, preserves mute on reconnect, and plays local PCM earcons. Failed mute acknowledgements or recognition failures pause uploads and show recovery text.
- `server_info.features.voiceVerbalMute` advertises support. A client opts in with optional `set_voice_mode.voiceCommandsEnabled`; the response enables it only with local STT and local turn detection. Cloud STT and old hosts retain the existing tap-only mute, with the verbal feature shown as unavailable.
- `voice.input.set_muted.request` / `.response` handle taps. Optional `voice_input_state.isMuted` synchronizes verbal transitions without introducing an outbound event old clients cannot parse.

Focused checks: voice session, command parser, turn controller, app voice runtime, and `packages/protocol/src/messages.voice-mute.test.ts`. No shared daemon restart is needed for these tests. Physical microphone recognition and acoustic echo behavior still need a device smoke test when deploying a new build.
