<!--
Please follow this template. The PR template applies whether you opened the PR via the web UI, `gh pr create`, or any other tool.

If you're fixing an objective bug or a small focused issue, this should be quick. Big PRs without a prior issue or design discussion are likely to be closed or scoped down. See CONTRIBUTING.md.
-->

### Linked issue

Closes #

<!-- Bug fixes and behavior changes should reference an issue. Pure docs and refactors can skip this. -->

### Type of change

- [ ] Bug fix
- [ ] New feature (with prior issue + design alignment)
- [ ] Refactor / code improvement
- [ ] Docs

### What does this PR do

<!-- A short description of the change in your own words. What was wrong, what you changed, why it works. If you can't explain this briefly, the PR is probably too big. -->

### How did you verify it

<!--
This is the section I read most carefully. I need to see that *you* tested this, not that the diff looks plausible.

- For UI changes: a screenshot or short video on every affected platform (mobile, web, desktop). UI claims without visual proof are not enough.
- For behavior changes: the actual steps you ran, and what you observed.
- For bug fixes: how you reproduced the bug before, and confirmed it's fixed after.

AI-generated PR descriptions are fine in principle. AI-generated *verification claims* with no actual testing behind them are not, and they're easy to spot.
-->

### Checklist

- [ ] One focused change. Unrelated cleanups split out.
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run format` ran (Biome)
- [ ] UI changes include screenshots or video for every affected platform
- [ ] Tests added or updated where it made sense
