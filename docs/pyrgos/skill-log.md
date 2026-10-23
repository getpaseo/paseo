# Skill log

- MIC-750 D: lab TTS/STT providers. Worked: wrapping the stock services (they become the fallback) kept the core diff to one call; a loopback `ws` server is a good fake lab. Didn't: `npm ci` needs the workspace packages built before the full speech suite and typecheck run, so verify with the lab test file and a filtered `tsc` until then. Candidate: a script that builds workspace packages in a fresh worktree.
