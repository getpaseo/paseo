# Skill log

- MIC-750 E: built debug and production APKs locally on the lab. Worked: user-level SDK plus Temurin 21, scripted wrapper around Expo prebuild and Gradle. Didn't: `npm ci --ignore-scripts` plus npm's `allowScripts` skipped native-asset postinstalls (Gradle failed on missing grammars); fixed in the script. Repeat candidate: a "bootstrap Android toolchain on a fresh Linux box" script (this was done by hand twice: SDK, then JDK).
- MIC-750 A: mapped the Paseo voice flow, speech seams and plugin APIs by reading the source; wrote `DESIGN.md`. Worked: grepping for handler names then reading line ranges. Repeat candidate: a one-page "where do I plug in" map for any upstream fork.
