# iOS background audio

## Intent

Keep audio submitted through Paseo's shared client playback queue playing when the iOS app is backgrounded or the screen locks. This fixes the host audio layer so the existing Read Aloud plugin can use it; plugin UI and speech generation remain unchanged in this first step.

## Goals and boundaries

- Enable background playback for encoded audio on iOS, including consecutive Read Aloud chunks.
- Keep web, Electron, and Android behavior as it is today.
- Keep the current shared queue, in-app controls, voice selection, and playback interruption behavior.
- Defer porting Read Aloud into Paseo and adding lock-screen media controls until background playback works.

## Approaches

1. Change the app host's native audio playback mode. **Chosen.** `client.playAudio` already feeds the shared queue, so this is the smallest app-level change that covers plugins as well as other encoded audio sources.
2. Change only the Read Aloud plugin. Rejected: the plugin calls the host's `playAudio`; the app owns the native audio session and Expo player lifecycle.
3. Add a persistent iOS media player with lock-screen controls. Deferred: iOS can continue background playback without that UI, and it adds player state and remote-control handling.

## Design

Set `shouldPlayInBackground` for iOS in `packages/app/src/audio/audio-engine.native.ts` before creating the encoded-audio player. The current Expo Audio config plugin already enables the native background capability by default, so no app-config change is needed. Keep the runtime change iOS-specific; other platforms use their current behavior. No lock-screen controls or app UI changes are included.

## Validation

Use an iOS build with the existing Read Aloud plugin to speak a reply containing multiple chunks, background Paseo or lock the screen, and confirm playback continues across chunk handoffs. Return to Paseo and confirm its current stop/play controls still work. This requires a rebuilt native app. If playback fails only at chunk handoffs, revisit player/session lifetime before expanding scope.
