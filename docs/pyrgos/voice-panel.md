# Voice panel (MIC-750 C2)

A second panel in the `pyrgos-action-ledger` plugin: voice settings (speed, pitch, preset) and word-by-word highlighting synced to TTS playback. Same code on desktop and Android. The plugin cannot touch the TTS stream, so it talks to the provider through files.

## File contract (for the TTS provider, ticket D2)

All files live in the voice directory: `$ALCHEMIST_HARNESS/.agents/feedback/voice` (falls back to the OS temp dir when the variable is unset).

| File | Writer | Reader | Content |
|---|---|---|---|
| `voice-capabilities.json` | provider, at startup | panel | `{"speed":true,"pitch":false,"presets":["warm"]}`. Missing file means speed only. |
| `voice-settings.json` | panel (atomic tmp + rename) | provider, once per utterance | `{"speed":1.0,"pitch":0,"preset":null}`. Speed 0.5 to 2, pitch -6 to 6. Values are clamped to the capabilities. |
| `<session>.words.jsonl` | provider, one row per utterance | panel (newest file, last valid row) | `{"id","text","words":[{"word","start","end"}],"startedAt"}`. `start` and `end` are seconds from utterance start; `startedAt` is epoch milliseconds when audio began. |

An utterance expires 2 seconds after its last word's `end`; after that the panel shows "Nothing spoken yet". Settings writes are serialized and use a unique temp file per write.

The panel polls playback every 500 ms and advances the highlight every 50 ms. Elapsed time is `(serverNow - startedAt)` plus local time since the response, so a phone with a skewed clock still highlights correctly.

## Run the tests

Linux:

```sh
export ALCHEMIST_HARNESS=~/Alchemist
cd plugin-examples/pyrgos-action-ledger && npx vitest run
```

Windows (PowerShell):

```powershell
$env:ALCHEMIST_HARNESS = "$HOME\Alchemist"
Set-Location plugin-examples\pyrgos-action-ledger; npx vitest run
```

## Same settings on lab and PC

`voice-settings.json` is a plain file in the repo-relative voice directory, so syncing the directory (or copying that one file) gives both machines identical settings. The directory path comes from `ALCHEMIST_HARNESS` on each machine; no hostnames or addresses are stored.
