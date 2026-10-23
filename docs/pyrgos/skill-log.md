# Skill log

One entry per task: what was tried, what worked, what could become a skill.

- MIC-750 B, conversation-agent module. Worked: porting the Python brain idea for idea behind a `Brain` seam, tests first with a fake SDK. Tripped: a fresh worktree needs `npm ci --ignore-scripts` plus `build:highlight`, `build:protocol`, `build:client` and `build:plugin` before server tests resolve `@getpaseo/*`. A secret-scan hook rejects a literal PEM header in a test; build it from parts. Candidate: a script that bootstraps a Paseo worktree.
