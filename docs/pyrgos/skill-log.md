# Skill log

One entry per task: what was tried, what worked, what didn't, what could become a skill.

- MIC-751 C2 (voice panel): oxlint react-perf rejects inline handlers and nested ternaries, so build handlers with `useCallback` and tiny child components from the start. Candidate: a note in the plugin template listing the lint rules.

- MIC-750 C (action-item ledger): tests-first TS port of a Python feed module worked well; `npm ci` in a fresh worktree took far longer than the code (several parallel installs). Candidate: a script that symlinks `node_modules` from a sibling worktree.
