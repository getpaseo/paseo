# Lessons

## 2026-04-06

- Match the source checkout to the installed desktop release before verifying daemon behavior. The installed app was `0.1.48`, and using a `0.1.43` daemon caused protocol drift during runtime checks.
- For Copilot ACP autopilot permission issues, the narrow fix point is `ACPAgentSession.requestPermission()`. Bypassing the emitted `permission_requested` event there keeps the change provider-specific and low risk.
- In this release line, run `npm run build --workspace=@getpaseo/highlight` before repo-wide `npm run typecheck` if the workspace has not been built yet, otherwise downstream packages may fail to resolve `@getpaseo/highlight` types.
