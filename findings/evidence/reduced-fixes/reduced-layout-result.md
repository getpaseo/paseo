# Layout and history implementation

Implemented FP1/CR1-1 and FP13/CR1-11; awaiting independent verification.

Files: packages/app/src/stores/workspace-layout-store.ts, packages/app/src/stores/workspace-layout-persistence.test.ts, packages/app/src/navigation/history/recorder.tsx, packages/app/src/navigation/history/record-location.test.ts, packages/app/src/navigation/history/recorder.test.tsx.

FP1: added background_activity and background_thread (optional requestId) schemas plus optional StateStorage adapter argument defaulting to existing AsyncStorage. Public store operations write through actual validated persistence adapter, then recreate/rehydrate store preserving two workspaces, split panes, focus, Explorer visibility. Test covers activity and thread with/without requestId.

FP13: extracted synchronous recording operation within recorder.tsx, keeping React sampling untouched. Skip workspace observations lacking selected tab/target. No added state/lifecycle. Tests drive real layout/history/goHistory through navigation adapter: first visit before layout, Back twice then Forward twice; settled empty New tab and composer focus; same-id retarget and closed-file reopening. Existing JSDOM suite only adjusted old route test to initialize actual workspace tab; no new mocks.

Evidence: /tmp/fp1-red-final.log exit1 (actual persisted envelope null); /tmp/fp1-green-final.log exit0 3 passed. /tmp/fp13-red.log exit1 (Back twice stays first workspace instead of Settings); /tmp/fp13-green.log exit0 3 passed. /tmp/fp13-recorder.log 8 passed. Targeted npm lint zero issues; app typecheck /tmp/fp1-fp13-typecheck.log exit0. Own files formatted with npm run format:files; git diff --check passed.

Actual size production +36/-20, tests +213/-1. Net product +16; most recorder movement. No caller obligation added (storage injection optional), no dependencies, no protocol change. Test count slightly above 110-190 guideline due real replay and persistence setup.

Limitation: actual Electron React timing unverified. Normal browser intentionally reserves Ctrl/Cmd+[ for browser history so a browser spec would not drive goHistory. No fake Electron flag or test-only product hook added. No commits/ledger edits.
