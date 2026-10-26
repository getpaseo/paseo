# TH1-1802 blocking P2 fix

PASEO_AGENT_ID is unset; use dispatcher task 6e8a18bb5d984362bacd591694e1f735 as checklist identity. Scope: the single stylesheet-growth finding; no other fixes, upstream writes, extra lanes or merge. Serial validation (one Playwright and one Metro worker).

- [x] Reproduce stylesheet growth with one assertion in the existing sidebar spec on unchanged production code. before-e2e.txt: exit 1, 1 failed, 69→79 rules.
- [x] Route dynamic row geometry through inlineUnistylesStyle and prove the assertion passes on the real headless path. after-resize.json: 119→199px, 67→67 rules; persistence and touch checks pass.
- [x] Run the touched spec once, app typecheck, scoped root lint and scoped root formatting; record commands, exits and counts. Full touched spec: 7 passed/2 baseline label failures; typecheck/format/lint exit 0, lint 0 warnings/errors. Both failing label tests reproduced on original production source.
- [x] Inspect the focused diff, update issue-scoped status/blockers, commit and push only the existing fork feature branch. Source fix 8efa9f2dd pushed to fork/feat/sidebar-nav-group-resize; ls-remote exactly matched local HEAD. Serial pre-commit format/lint/all-workspace typecheck passed. Final handoff checkpoint follows on the same branch.
