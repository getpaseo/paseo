# Android Voice Recording Fix – Code Review

## Correctness
- Using Expo's recorder instance as the single source of truth is the right direction, but the new guard in `stop()` (`src/hooks/use-audio-recorder.native.ts:247-254`) now throws as soon as Expo's `isRecording` flag is `false`, even if **we** initiated a session (`recordingStartTime` is still set) and the OS stopped it for us (focus loss, phone call, permission revocation, etc.). In that situation we still have to call `stop()` to fetch the URI/work around the SDK bug, but the hook now exits early with “Not recording”, so the audio file is lost and UI state machines (e.g. dictation) never advance. Previously we relied on our own `isRecording` state, so callers could still finalize the recording even if Expo toggled its flag behind our back.
- The dictation modal relies on the recorder object changing identity to re-run its cleanup effects. After memoizing the hook's return value, `dictationRecorder` no longer changes when recording starts or stops. When the user closes the modal while `dictationRecorder.start()` is still awaiting (permission prompt, slow prepare), the effect at `src/components/create-agent-modal.tsx:1164-1170` runs **once**, sees `isRecording?.()` as `false`, and returns. When the native recorder finally transitions to recording there is no dependency change, so we never auto-stop; the microphone keeps running in the background until unmount. The previous implementation re-rendered when `isRecording` state flipped, so the cleanup path executed. This is a regression introduced by the memoization/state removal.

## Edge Cases
- Similar races exist anywhere we call `dictationRecorder.stop()` conditionally (`src/components/create-agent-modal.tsx:923-925`, `1172-1178`). Those guards now consult the asynchronous native flag; if the OS toggles it before we read it, we skip cleanup entirely (and `stop()` would throw even if we tried). We need a fallback based on our own intent (e.g., `recordingStartTime !== null`) to ensure we always clean up sessions we started.

## Performance
- The metering effect (`src/hooks/use-audio-recorder.native.ts:175-193`) now depends on `recorderState.metering` *and* spins up a `setInterval`. `useAudioRecorderState` already polls every 100 ms and triggers a render. Because `recorderState.metering` is a dependency, this effect is torn down and recreated at that same cadence, so the interval almost never fires and we constantly allocate/clear timers. At best this starves the audio-level callback, at worst it's extra work on every render. We should either remove the interval and invoke the callback directly when `recorderState.metering` changes, or keep the interval but depend only on `recorderState.isRecording`/`configRef`.

## Code Quality
- `recordingOptions` still depends on `config?.onAudioLevel` by reference (`src/hooks/use-audio-recorder.native.ts:141-164`). That means any caller that passes an inline callback will recreate the entire recorder on every render, reintroducing the race this fix aims to solve. The hook already captures the callback in a ref; the dependency only needs the boolean `!!config?.onAudioLevel` to flip metering on/off. Requiring every consumer to remember to wrap their callback in `useCallback` makes this API fragile and hard to use correctly.

## Completeness
- Only two call sites were updated to stabilize the callback, but `useAudioRecorder` is exported for general use (`src/app/audio-test.tsx`, future flows). Unless we address the dependency noted above, any new screen that passes `onAudioLevel={level => …}` will regress immediately. Consider hardening the hook so callers cannot accidentally reintroduce the bug.

## Testing Recommendations
- Start dictation, dismiss the modal (or navigate away) while the permission prompt is still showing, and verify that recording stops automatically once the modal is gone.
- Force Android to interrupt recording (receive a phone call / unplug the mic) and ensure `stop()` still returns a blob instead of throwing “Not recording”.
- Verify the audio level meter updates smoothly for a prolonged recording session (the current interval churn may cause it to freeze).
- Confirm the new error-handling path actually resets `isDictating`, `isDictationProcessing`, and UI affordances after simulated failures (permission denied, `sendAgentAudio` rejection).

## Potential Improvements
- Treat `!!config?.onAudioLevel` as the dependency in `recordingOptions` (and/or derive metering enablement internally) so callers no longer need to memoize callbacks.
- Rework metering to emit directly from `useAudioRecorderState` updates (or keep a ref to `recorderState`), avoiding the redundant timer and ensuring the callback fires consistently.
- Augment `stop()` to fall back to `recordingStartTime`/`recorder.uri` even if Expo's `isRecording` flag is already false so we can always deliver/clean up recordings we initiated.
