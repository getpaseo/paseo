# investigative.md — run BEFORE scoping any fork work. No code until checks are green.

## 1. List assumptions. Grade each one.
- `verified-in-code` (file:line), `unverified`, or `folklore`. Unverified ones become checks below, never plans.

## 2. Bias sweep.
- Am I favoring the requester's preferred path? State the alternative in one line and what fact would flip you to it.
- Is "small" actually small? Count files, count lines. If you can't name both, it's not small.
- Name the one fact that kills the plan if false.

## 3. Better-path search.
- Find the closest existing precedent (mermaid fence, favicon post-processor, lightbox). Extend precedent; don't invent mechanism.
- Check the trigger content ever reaches your hook. Classic miss: bare URLs never become fence blocks, so a fence-registry-only patch fires on nothing. Trace caller → callee, not memory.

## 4. Ripple sweep.
- Grep every caller of each touched function. For platform branches (`isWeb`/`isNative`): state what changes on the OTHER platform.
- Name the user capability that dies as a side effect (e.g. text selection). If it has an alternative path (copy via menu), say so; if not, flag it.

## 5. Grunt delegation (TinyCat).
- Hand it narrow verify-questions, evidence-required (`file:line`), hard line cap. Trust nothing unverified.
- Re-check its claims on the two load-bearing facts yourself. Grain of salt everywhere else.

## Output
Corrected file list + open verifications. That output feeds `docs.md`.

## Worked example — Paseo media fork (2026-10-15)
Assumptions, graded:
1. Long-press dead on iOS Safari — `verified-in-code` (`context-menu.tsx` early-return) + Safari docs.
2. Bare URLs never reach fence renderers — `verified-in-code` (callers at `renderer.tsx:616`, `message.tsx:1767` are fence-node paths; parser runs `linkify: true`) + independent second opinion. This catch reshaped the plan: file #3 does the real work, fence registry is secondary.
3. WebView needs no new deps — `verified-in-code` (`react-native-webview@^13.16.0`, used by terminal + mermaid). Props gotchas noted, not plan-risk.
4. Daemon mount vs manifest scope — was `unverified`, closed to `verified-in-code` (`bootstrap.ts:527` mounts at `/`). PWA safe.
5. Anchor coords present on iOS touch events — was `unverified`. Code-level verification: `coerceEventPoint` handles MouseEvent + RN gesture shapes only; DOM TouchEvent carries coords on `changedTouches[0]`, not itself → returns null → silent no-open. Fix (same file #4): coerce `changedTouches[0]` + row-anchor fallback. This is the save: without it the long-press fix fails silently on the exact device it targets.
Bias note: requester leaned fork; alternatives priced each round, flip condition named (stock mobile must show cards → keep plugin).
Ripple notes: `user-select:none` kills filename text-selection (copy via menu survives); deleting the early-return also changes touchscreen-laptop behavior (acceptable, same menu).
