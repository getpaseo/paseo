# Skill log

- MIC-750 D: lab TTS/STT providers. Worked: wrapping the stock services (they become the fallback) kept the core diff to one call; a loopback `ws` server is a good fake lab. Didn't: `npm ci` needs the workspace packages built before the full speech suite and typecheck run, so verify with the lab test file and a filtered `tsc` until then. Candidate: a script that builds workspace packages in a fresh worktree.

- MIC-750 E: built debug and production APKs locally on the lab. Worked: user-level SDK plus Temurin 21, scripted wrapper around Expo prebuild and Gradle. Didn't: `npm ci --ignore-scripts` plus npm's `allowScripts` skipped native-asset postinstalls (Gradle failed on missing grammars); fixed in the script. Repeat candidate: a "bootstrap Android toolchain on a fresh Linux box" script (this was done by hand twice: SDK, then JDK).
- MIC-750 A: mapped the Paseo voice flow, speech seams and plugin APIs by reading the source; wrote `DESIGN.md`. Worked: grepping for handler names then reading line ranges. Repeat candidate: a one-page "where do I plug in" map for any upstream fork.
