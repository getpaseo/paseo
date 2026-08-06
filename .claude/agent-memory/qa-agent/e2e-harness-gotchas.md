---
name: e2e-harness-gotchas
description: Paseo Playwright e2e traps — explorer double-open hang, daemon PASEO_HOME env, hand-installing plugins without a daemon restart
metadata:
  type: project
---

Traps in `packages/app/e2e/` that cost a full 2-minute test run each to discover.

**`openFileExplorer()` hangs if the explorer is already open.** It clicks `getByRole("button", { name: "Open explorer" })`, and that button only exists while the explorer is closed. The explorer stays open across `page.goto` inside one test, so a test that opens it, navigates elsewhere, and opens it again times out at 60s. Guard on `getByTestId("explorer-header").isVisible()` first.

**Why:** the failure surfaces as an unrelated 60s `locator.click` timeout, not as "already open".
**How to apply:** any spec that visits a workspace twice in one test.

**The test daemon's home is `process.env.E2E_PASEO_HOME`,** exported by `e2e/global-setup.ts` (a fresh mkdtemp per run, or a fork of `.dev/paseo-home` for `*.real.spec.ts`). Specs can write into it directly from Node before navigating.

**Plugins hand-installed into `$E2E_PASEO_HOME/plugins/<id>/` need no daemon restart** — `PluginStore.list()` rescans the directory on every `plugins.list` RPC. This is what makes plugin e2e possible against the single shared daemon that all specs use. Clean up in `afterAll`, or the example plugin keeps claiming `.txt` for every later spec in the run.

See [[plugin-system-qa]].
